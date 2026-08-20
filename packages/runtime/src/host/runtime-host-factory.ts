import type { LanguageClient } from '@synax-ai/core';
import { createHash } from 'node:crypto';
import { Cortx } from '@cortx/core';
import type {
  AgentDurableRunStore,
  AgentRuntimeExtensions,
  ContextUsageSource,
  CortxContributionConfig,
  LanguageMessage,
  Logger,
  Tool,
} from '@cortx/sdk';
import {
  createEmptyAgentRuntimeExtensions,
  mergeAgentRuntimeExtensions,
  parseCortxContributionReference,
} from '@cortx/sdk';
import {
  SubAgentSessionStore,
  createDefaultSafetyExtensions,
  createSkillExtensions,
  createSubAgentTool,
  discoverSkills,
  renderSkillSummary,
} from '../capabilities/index.js';
import type { RuntimeDefaultCapabilities } from '../default-capabilities.js';
import { RuntimeError } from '../errors.js';
import type { CortxHostScope } from '../host-scope.js';
import type { ProjectDomain } from '../project-domain.js';
import type {
  RuntimeApprovalMode,
  RuntimeSessionContextMetadata,
} from '../session.js';
import type { RuntimeInputSource } from '../sessions/runtime-input-source.js';
import { createWorkspaceToolPluginEntries } from '../tool-mount.js';

export interface RuntimeHostFactoryInput {
  id: string;
  workingDirectory: string;
  model: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  toolProfile: string;
  approvalMode: RuntimeApprovalMode;
  requestedCapabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  requestTools: Tool[];
  contributions: CortxContributionConfig[];
  scope: CortxHostScope;
  projectScope?: CortxHostScope;
  mountProjectContributions?: boolean;
  runId?: number;
  getRunScope(): CortxHostScope | undefined;
  agentSessions: SubAgentSessionStore;
  inputSource: RuntimeInputSource;
  onAgentEvent: NonNullable<Cortx['onAgentEvent']>;
}

export interface RuntimeHost {
  cortx: Cortx;
  scope: CortxHostScope;
  capabilities: RuntimeDefaultCapabilities;
  contextMetadata: RuntimeSessionContextMetadata;
  pluginGeneration: string;
}

export interface RuntimeHostFactoryOptions {
  language: LanguageClient;
  tools: Tool[];
  projectDomain?: ProjectDomain;
  durableStore?: AgentDurableRunStore;
  logger: Logger;
  closeScope(scope: CortxHostScope, owner: string): Promise<void>;
}

interface RuntimeOfficialExtensions {
  extensions: AgentRuntimeExtensions;
  skillCount: number;
  skillSummaryTokens: number;
}

/**
 * Owns capability/profile/plugin assembly and constructs Core Hosts.
 * Session and run state stay outside this class.
 */
export class RuntimeHostFactory {
  readonly #language: LanguageClient;
  readonly #tools: Tool[];
  readonly #projectDomain?: ProjectDomain;
  readonly #durableStore?: AgentDurableRunStore;
  readonly #logger: Logger;
  readonly #closeScope: RuntimeHostFactoryOptions['closeScope'];

  constructor(options: RuntimeHostFactoryOptions) {
    this.#language = options.language;
    this.#tools = options.tools;
    this.#projectDomain = options.projectDomain;
    this.#durableStore = options.durableStore;
    this.#logger = options.logger;
    this.#closeScope = options.closeScope;
  }

  async create(input: RuntimeHostFactoryInput): Promise<RuntimeHost> {
    const capabilities =
      input.approvalMode === 'full-access'
        ? { ...input.requestedCapabilities, approval: false }
        : input.requestedCapabilities;
    const toolApprovalRequirements = new WeakMap<Tool, boolean>();
    const runtimeTools = this.#tools.map((tool) => {
      const wrapped = requireApprovalForExternalTool(tool);
      toolApprovalRequirements.set(wrapped, true);
      return wrapped;
    });
    const requestTools = input.requestTools.map((tool) => {
      const wrapped = requireApprovalForExternalTool(tool);
      toolApprovalRequirements.set(wrapped, true);
      return wrapped;
    });
    const mountedTools = [...runtimeTools, ...requestTools];
    const mountProjectContributions = input.mountProjectContributions ?? true;
    const desiredToolProfileEntries = await createWorkspaceToolPluginEntries(
      input.workingDirectory,
      input.toolProfile,
      this.#projectDomain,
    );
    const toolProfilePluginEntries = mountProjectContributions ? desiredToolProfileEntries : [];
    const contributionEntries = [...toolProfilePluginEntries, ...input.contributions];
    const pluginGeneration = await this.#resolvePluginGeneration(input, [
      ...desiredToolProfileEntries,
      ...input.contributions,
    ]);
    const officialExtensions = await this.#createOfficialExtensions({
      workingDirectory: input.workingDirectory,
      capabilities,
      skillPaths: input.skillPaths,
      needsToolApproval: (tool) => (tool ? toolApprovalRequirements.get(tool) ?? workspaceToolNeedsApproval(tool) : true),
    });
    const projectScope = input.projectScope ?? input.scope;
    const projectExtensions = this.#projectDomain && mountProjectContributions
      ? await this.#projectDomain.createAgentExtensions(contributionEntries, projectScope, {
          instanceId: input.id,
          sessionId: input.id,
          runId: input.runId,
          workingDirectory: input.workingDirectory,
        })
      : createEmptyAgentRuntimeExtensions();
    if (mountProjectContributions && !this.#projectDomain && contributionEntries.length > 0) {
      throw new RuntimeError('invalid_request', 'Project contributions require a ProjectDomain');
    }
    const extensions = mergeAgentRuntimeExtensions(officialExtensions.extensions, projectExtensions);

    if (capabilities.subAgents !== false) {
      const subAgentTool = createSubAgentTool({
        language: this.#language,
        model: input.model,
        reasoning: input.reasoningEffort ? { enabled: true, effort: input.reasoningEffort } : undefined,
        agentSessions: input.agentSessions,
        getTools: () => mountedTools,
        getExtensions: () => extensions,
        createChildHost: async ({ toolCallId, runId, isBackground }) => {
          const parentScope = isBackground ? input.scope : input.getRunScope();
          if (!parentScope) throw new RuntimeError('invalid_request', 'Foreground child requires an active run scope');
          const scope = parentScope.child(
            `${isBackground ? 'background' : 'foreground'}-child:${toolCallId}`,
            isBackground ? 'background-child' : 'foreground-child',
          );
          try {
            const childProjectExtensions = this.#projectDomain
              ? await this.#projectDomain.createAgentExtensions(contributionEntries, scope, {
                  instanceId: `${input.id}:${toolCallId}`,
                  sessionId: input.id,
                  runId,
                  workingDirectory: input.workingDirectory,
                })
              : createEmptyAgentRuntimeExtensions();
            return {
              extensions: mergeAgentRuntimeExtensions(officialExtensions.extensions, childProjectExtensions),
              signal: scope.signal,
              close: (reason?: unknown) => this.#closeScope(
                scope,
                `settled child:${input.id}:${toolCallId}:${String(reason ?? '')}`,
              ),
            };
          } catch (error) {
            await scope.close(error).catch(() => undefined);
            throw error;
          }
        },
        onAgentEvent: input.onAgentEvent,
      });
      toolApprovalRequirements.set(subAgentTool, true);
      mountedTools.push(subAgentTool);
    }
    const allModelTools = [...mountedTools, ...extensions.tools];
    const contextMetadata: RuntimeSessionContextMetadata = {
      contextWindowTokens: input.contextWindowTokens,
      contextWindowSource: input.contextWindowSource,
      systemPromptTokens: estimateTextTokens(input.system),
      toolDefinitionTokens: estimateToolDefinitionTokens(allModelTools),
      toolCount: allModelTools.length,
      skillSummaryTokens: officialExtensions.skillSummaryTokens,
      skillCount: officialExtensions.skillCount,
    };

    const cortx = new Cortx(this.#language, {
      model: input.model,
      reasoning: input.reasoningEffort ? { enabled: true, effort: input.reasoningEffort } : undefined,
      system: input.system,
      maxIterations: input.maxIterations,
      tools: mountedTools,
      extensions,
      workingDirectory: input.workingDirectory,
      sessionId: input.id,
      durableStore: this.#durableStore,
      followUpSource: input.inputSource,
      askUser: input.approvalMode === 'deny' ? async () => 'no' : undefined,
      logger: this.#logger,
    });
    cortx.onAgentEvent = input.onAgentEvent;
    const abortCortx = () => cortx.abort('Cortx Host scope was revoked');
    if (projectScope.signal.aborted) abortCortx();
    else {
      projectScope.signal.addEventListener('abort', abortCortx, { once: true });
      projectScope.defer(() => projectScope.signal.removeEventListener('abort', abortCortx), 'cortx-controller-abort');
    }
    return {
      cortx,
      scope: input.scope,
      capabilities,
      contextMetadata,
      pluginGeneration,
    };
  }

  async #resolvePluginGeneration(
    input: RuntimeHostFactoryInput,
    contributions: CortxContributionConfig[],
  ): Promise<string> {
    const pluginIds = new Set<string>();
    pluginIds.add(parseCortxContributionReference(input.toolProfile).pluginId);
    for (const contribution of contributions) {
      pluginIds.add(parseCortxContributionReference(contribution.use).pluginId);
    }
    const snapshot = this.#projectDomain ? await this.#projectDomain.registry.snapshot() : undefined;
    const pluginFacts = [...pluginIds].sort().map((pluginId) => {
      const plugin = snapshot?.plugins[pluginId];
      return {
        pluginId,
        state: plugin?.state ?? 'builtin',
        version: plugin?.version,
        generation: plugin?.generation ?? 0,
      };
    });
    const subAgentModel = input.requestedCapabilities.subAgents === false
      ? undefined
      : { model: input.model, reasoningEffort: input.reasoningEffort };
    const assembly = {
      runtimeDomainId: this.#projectDomain?.runtimeDomainId ?? 'builtin',
      toolProfile: input.toolProfile,
      approvalMode: input.approvalMode,
      capabilities: input.requestedCapabilities,
      skillPaths: input.skillPaths ?? [],
      contributions,
      tools: [...this.#tools, ...input.requestTools].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        sideEffects: tool.sideEffects,
      })),
      subAgentModel,
      pluginFacts,
    };
    return `assembly:${createHash('sha256').update(stableJson(assembly)).digest('hex').slice(0, 24)}`;
  }

  async #createOfficialExtensions(input: {
    workingDirectory: string;
    capabilities: RuntimeDefaultCapabilities;
    skillPaths?: string[];
    needsToolApproval?: (tool: Tool | undefined, input: Record<string, unknown>) => boolean;
  }): Promise<RuntimeOfficialExtensions> {
    const sets: AgentRuntimeExtensions[] = [createEmptyAgentRuntimeExtensions()];
    let skillCount = 0;
    let skillSummaryTokens = 0;
    if (input.capabilities.skills !== false) {
      const skills = await discoverSkills(input.workingDirectory, { skillPaths: input.skillPaths }, this.#logger);
      if (skills.length) {
        skillCount = skills.length;
        skillSummaryTokens = estimateTextTokens(renderSkillSummary(skills));
        sets.push(createSkillExtensions(skills));
      }
    }
    if (input.capabilities.approval !== false) {
      sets.push(createDefaultSafetyExtensions({ needsApproval: input.needsToolApproval }));
    }
    return {
      extensions: mergeAgentRuntimeExtensions(...sets),
      skillCount,
      skillSummaryTokens,
    };
  }
}

const CHARS_PER_ESTIMATED_TOKEN = 4;

function workspaceToolNeedsApproval(tool: Tool): boolean {
  return tool.sideEffects === 'write' || tool.sideEffects === 'destructive';
}

function requireApprovalForExternalTool(tool: Tool): Tool {
  return {
    ...tool,
    sideEffects: tool.sideEffects === 'destructive' ? 'destructive' : 'write',
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

export function estimateTextTokens(value: string | undefined): number {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  return normalized ? Math.ceil(normalized.length / CHARS_PER_ESTIMATED_TOKEN) : 0;
}

function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(safeJson(value));
}

function estimateToolDefinitionTokens(tools: Tool[]): number {
  return tools.reduce(
    (total, tool) =>
      total +
      estimateJsonTokens({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        sideEffects: tool.sideEffects,
      }),
    0,
  );
}

export function estimateMessageTokens(messages: LanguageMessage[]): number {
  return estimateJsonTokens(messages);
}
