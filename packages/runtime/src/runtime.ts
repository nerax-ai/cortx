import type { LanguageClient } from '@synax-ai/core';
import type {
  AgentDurableRunStore,
  AgentDoneUsage,
  AgentEvent,
  AgentRunCheckpoint,
  AgentRuntimeExtensions,
  ContextUsageBreakdownEntry,
  ContextUsageFacts,
  ContextUsageSource,
  LanguageMessage,
  Logger,
  RuntimeAgentEventEnvelope,
  SkillInfo,
  Tool,
} from '@cortx/sdk';
import {
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  createEmptyAgentRuntimeExtensions,
  mergeAgentRuntimeExtensions,
  noopLogger,
} from '@cortx/sdk';
import { Cortx, type CortxRegistry, type PluginConfig } from '@cortx/core';
import { RuntimeError, toRuntimeError } from './errors.js';
import { DEFAULT_RUNTIME_CAPABILITIES, type RuntimeDefaultCapabilities } from './default-capabilities.js';
import { createWorkspaceToolPluginEntries, listRuntimeToolProfiles, parseWorkspaceToolMode } from './tool-mount.js';
import type { WorkspaceToolMode } from './workspace-tool-mode.js';
import { resolveWorkspace } from './workspace.js';
import {
  SubAgentSessionStore,
  createDefaultSafetyExtensions,
  createSkillExtensions,
  createSubAgentTool,
  discoverSkills,
  renderSkillSummary,
} from './capabilities/index.js';
import { loadAgentSpecFile, parseAgentSpec } from './assets/agent-spec.js';
import { resolveSkillPackReferences } from './assets/skill-pack-registry.js';
import {
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  isRuntimeDurableRunStore,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeDurableRunStore,
  type RuntimeSessionSnapshot,
} from './durable/types.js';
import type {
  ManagedRuntimeSession,
  RuntimeApprovalMode,
  RuntimeSessionContextMetadata,
  RuntimeSessionCreateRequest,
  RuntimeSessionInfo,
  RuntimeSessionLocalState,
  RuntimeSessionUpdateRequest,
} from './session.js';

export interface CortxRuntimeOptions {
  appName?: string;
  language: LanguageClient;
  model: string;
  models?: unknown[];
  modelCatalog?: unknown[];
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  tools?: Tool[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  capabilities?: RuntimeDefaultCapabilities;
  defaultWorkingDirectory?: string;
  allowedWorkspaceRoots?: string[];
  /** Maximum sessions allowed to run concurrently. Idle loaded sessions do not count toward this limit. */
  maxSessions?: number;
  maxEventsPerSession?: number;
  idleTimeoutMs?: number;
  logger?: Logger;
  durableStore?: AgentDurableRunStore;
  skillPackRegistryPath?: string;
}

export interface SubscribeOptions {
  replay?: boolean;
}

export interface SubscribeEnvelopeOptions {
  replay?: boolean;
}

export interface RestoreDurableSessionsOptions {
  autoResume?: boolean;
}

export interface RuntimeEventEnvelopeHistoryPageOptions {
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}

export interface RuntimeEventEnvelopeHistoryPage {
  events: RuntimeAgentEventEnvelope[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

interface RuntimeSkillMounts {
  skillPaths?: string[];
  skillPacks?: string[];
}

interface RuntimeCortxHostInput {
  id: string;
  workingDirectory: string;
  model: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  toolMode: WorkspaceToolMode;
  approvalMode: RuntimeApprovalMode;
  requestedCapabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  requestTools: Tool[];
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  agentSessions: SubAgentSessionStore;
  onAgentEvent(event: AgentEvent): void;
}

interface RuntimeCortxHost {
  cortx: Cortx;
  capabilities: RuntimeDefaultCapabilities;
  contextMetadata: RuntimeSessionContextMetadata;
}

interface RuntimeOfficialExtensions {
  extensions: AgentRuntimeExtensions;
  skillCount: number;
  skillSummaryTokens: number;
}

function createSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseApprovalMode(value: unknown, fallback: RuntimeApprovalMode): RuntimeApprovalMode {
  if (value === undefined) return fallback;
  if (value === 'deny' || value === 'interactive' || value === 'full-access') return value;
  throw new RuntimeError('invalid_request', 'approvalMode must be one of: deny, interactive, full-access', {
    approvalMode: value,
  });
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new RuntimeError('invalid_request', `${field} must be an array of strings`, { [field]: value });
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  throw new RuntimeError('invalid_request', `${field} must be a positive number`, { [field]: value });
}

function normalizeHistoryLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function eventError(error: unknown): AgentEvent {
  return {
    type: 'error',
    error: error instanceof Error ? error : new Error(String(error)),
    code: 'stream_error',
  };
}

function isTerminalEvent(event: AgentEvent | undefined): boolean {
  return event?.type === 'done' || event?.type === 'error';
}

function parentAttributionFor(session: ManagedRuntimeSession, event: AgentEvent): RuntimeAgentEventEnvelope['parent'] {
  switch (event.type) {
    case 'agent_started':
    case 'agent_progress':
    case 'agent_completed':
      return { sessionId: session.id, runId: session.runId, toolCallId: event.toolCallId };
    default:
      return undefined;
  }
}

function workspaceToolNeedsApproval(tool: Tool): boolean {
  return tool.sideEffects === 'write' || tool.sideEffects === 'destructive';
}

function requireApprovalForExternalTool(tool: Tool): Tool {
  return {
    ...tool,
    sideEffects: tool.sideEffects === 'destructive' ? 'destructive' : 'write',
  };
}

const CHARS_PER_ESTIMATED_TOKEN = 4;

function estimateTextTokens(value: string | undefined): number {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  return normalized ? Math.ceil(normalized.length / CHARS_PER_ESTIMATED_TOKEN) : 0;
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
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

function estimateMessageTokens(messages: LanguageMessage[]): number {
  return estimateJsonTokens(messages);
}

function percent(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

function usageToken(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function optionalUsageToken(value: number | undefined): number | undefined {
  return value === undefined ? undefined : usageToken(value);
}

function appendPromptHistory(history: string[], message: string): string[] {
  const prompt = message.trim();
  if (!prompt) return history;
  return [...history, prompt].slice(-100);
}

function backfillUserMessageEnvelopes(
  session: ManagedRuntimeSession,
  envelopes: RuntimeAgentEventEnvelope[],
): RuntimeAgentEventEnvelope[] {
  const prompts = session.promptHistory.map((message) => message.trim()).filter(Boolean);
  if (prompts.length === 0) return envelopes;

  const remainingUserMessages = new Map<string, number>();
  for (const envelope of envelopes) {
    if (envelope.event.type !== 'user_message') continue;
    remainingUserMessages.set(envelope.event.message, (remainingUserMessages.get(envelope.event.message) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const prompt of prompts) {
    const remaining = remainingUserMessages.get(prompt) ?? 0;
    if (remaining > 0) {
      remainingUserMessages.set(prompt, remaining - 1);
    } else {
      missing.push(prompt);
    }
  }
  if (missing.length === 0) return envelopes;

  const first = envelopes[0];
  const firstSequence = first?.sequence ?? 1;
  const firstTimestamp = first?.timestamp ?? session.createdAt;
  const synthetic = missing.map((message, index) => ({
    sequence: firstSequence - missing.length + index,
    timestamp: Math.max(session.createdAt, firstTimestamp - missing.length + index),
    sessionId: session.id,
    runId: first?.runId ?? Math.max(1, session.runId),
    event: {
      type: 'user_message',
      message,
      source: index === 0 ? 'prompt' : 'follow_up',
    },
  }) satisfies RuntimeAgentEventEnvelope);

  return [...synthetic, ...envelopes].sort((a, b) => a.sequence - b.sequence);
}

function normalizeModelId(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new RuntimeError('invalid_request', 'model must be a non-empty string', { model: value });
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function addOptionalUsageToken(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + usageToken(next);
}

function addSessionUsage(current: AgentDoneUsage | undefined, next: AgentDoneUsage): AgentDoneUsage {
  const usage: AgentDoneUsage = {
    inputTokens: usageToken(current?.inputTokens) + usageToken(next.inputTokens),
    outputTokens: usageToken(current?.outputTokens) + usageToken(next.outputTokens),
  };
  const noCacheInputTokens = addOptionalUsageToken(current?.noCacheInputTokens, next.noCacheInputTokens);
  const cacheReadTokens = addOptionalUsageToken(current?.cacheReadTokens, next.cacheReadTokens);
  const cacheCreationTokens = addOptionalUsageToken(current?.cacheCreationTokens, next.cacheCreationTokens);
  const reasoningTokens = addOptionalUsageToken(current?.reasoningTokens, next.reasoningTokens);
  if (noCacheInputTokens !== undefined) usage.noCacheInputTokens = noCacheInputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) usage.cacheCreationTokens = cacheCreationTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  if (next.context) usage.context = next.context;
  else if (current?.context) usage.context = current.context;
  return usage;
}

function contextInputTokens(usage: AgentDoneUsage): number | undefined {
  const inputTokens = usageToken(usage.inputTokens);
  const cacheReadTokens = usageToken(usage.cacheReadTokens);
  const cacheCreationTokens = usageToken(usage.cacheCreationTokens);
  const noCacheInputTokens =
    usage.noCacheInputTokens === undefined ? undefined : usageToken(usage.noCacheInputTokens);
  const total =
    noCacheInputTokens === undefined
      ? inputTokens + cacheReadTokens + cacheCreationTokens
      : Math.max(inputTokens, noCacheInputTokens + cacheReadTokens + cacheCreationTokens);
  return total > 0 ? total : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function readModelLimit(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const limits = record.limits;
  if (limits && typeof limits === 'object') {
    const context = readPositiveNumber((limits as Record<string, unknown>).context);
    if (context !== undefined) return context;
  }
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const limitsFromMetadata = readModelLimit({ limits: (metadata as Record<string, unknown>).limits });
    if (limitsFromMetadata !== undefined) return limitsFromMetadata;
  }
  const nestedModel = record.model;
  if (nestedModel && typeof nestedModel === 'object') {
    const nestedLimit = readModelLimit(nestedModel);
    if (nestedLimit !== undefined) return nestedLimit;
  }
  return undefined;
}

function resolveLanguageModelContextWindow(
  language: LanguageClient,
  model: string,
  extraCandidates: unknown[] = [],
): number | undefined {
  const source = language as unknown as {
    listModels?: () => unknown[];
    listModelCatalog?: () => unknown[];
    getModel?: (model: string) => unknown;
    models?: unknown[];
    modelCatalog?: unknown[];
  };
  let direct: unknown;
  try {
    direct = source.getModel?.(model);
  } catch {
    direct = undefined;
  }
  const directLimit = readModelLimit(direct);
  if (directLimit !== undefined) return directLimit;
  const list = (fn: (() => unknown[]) | undefined): unknown[] => {
    if (typeof fn !== 'function') return [];
    try {
      return fn();
    } catch {
      return [];
    }
  };
  const candidates = [
    ...extraCandidates,
    ...list(source.listModels?.bind(source)),
    ...list(source.listModelCatalog?.bind(source)),
    ...(Array.isArray(source.models) ? source.models : []),
    ...(Array.isArray(source.modelCatalog) ? source.modelCatalog : []),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (record.id !== model && record.name !== model) continue;
    const limit = readModelLimit(record);
    if (limit !== undefined) return limit;
  }
  return undefined;
}

export class CortxRuntime {
  private readonly sessions = new Map<string, ManagedRuntimeSession>();
  private readonly deletedSessionIds = new Set<string>();
  private readonly appName: string;
  private readonly language: LanguageClient;
  private readonly model: string;
  private readonly modelCatalog: unknown[];
  private readonly system?: string;
  private readonly maxIterations?: number;
  private readonly contextWindowTokens?: number;
  private readonly contextWindowSource?: ContextUsageSource;
  private readonly registry?: CortxRegistry;
  private readonly plugins?: PluginConfig[];
  private readonly tools: Tool[];
  private readonly toolMode: WorkspaceToolMode;
  private readonly approvalMode: RuntimeApprovalMode;
  private readonly capabilities: RuntimeDefaultCapabilities;
  private readonly defaultWorkingDirectory: string;
  private readonly allowedWorkspaceRoots: string[];
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;
  private readonly idleTimeoutMs: number;
  private readonly logger: Logger;
  private readonly durableStore?: AgentDurableRunStore;
  private readonly skillPackRegistryPath?: string;

  constructor(options: CortxRuntimeOptions) {
    this.appName = options.appName ?? 'cortx';
    this.language = options.language;
    this.model = options.model;
    this.modelCatalog = [...(options.models ?? []), ...(options.modelCatalog ?? [])];
    this.system = options.system;
    this.maxIterations = options.maxIterations;
    this.contextWindowTokens = parseOptionalPositiveInteger(options.contextWindowTokens, 'contextWindowTokens');
    this.contextWindowSource = options.contextWindowSource;
    this.registry = options.registry;
    this.plugins = options.plugins;
    this.tools = options.tools ?? [];
    this.toolMode = options.toolMode ?? 'none';
    this.approvalMode = options.approvalMode ?? 'deny';
    this.capabilities = options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
    this.defaultWorkingDirectory = options.defaultWorkingDirectory ?? process.cwd();
    this.allowedWorkspaceRoots = options.allowedWorkspaceRoots ?? [this.defaultWorkingDirectory];
    this.maxSessions = options.maxSessions ?? 10;
    this.maxEventsPerSession = options.maxEventsPerSession ?? 2_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.logger = options.logger ?? noopLogger;
    this.durableStore = options.durableStore;
    this.skillPackRegistryPath = options.skillPackRegistryPath;
  }

  async createSession(request: RuntimeSessionCreateRequest = {}): Promise<RuntimeSessionInfo> {
    const workspace = await resolveWorkspace({
      requested: request.workingDirectory,
      defaultWorkingDirectory: this.defaultWorkingDirectory,
      allowedRoots: this.allowedWorkspaceRoots,
    });
    const id = request.id ?? createSessionId();
    if (this.sessions.has(id)) throw new RuntimeError('invalid_request', `Session already exists: ${id}`);
    this.deletedSessionIds.delete(id);

    const model = normalizeModelId(request.model, this.model);
    const reasoningEffort = normalizeReasoningEffort(request.reasoningEffort);
    const maxIterations = request.maxIterations ?? this.maxIterations;
    const requestedContextWindowTokens = parseOptionalPositiveInteger(request.contextWindowTokens, 'contextWindowTokens');
    const modelContextWindowTokens = resolveLanguageModelContextWindow(this.language, model, this.modelCatalog);
    const contextWindowTokens = requestedContextWindowTokens ?? this.contextWindowTokens ?? modelContextWindowTokens;
    const contextWindowSource: ContextUsageSource | undefined =
      requestedContextWindowTokens !== undefined
        ? 'configured'
        : this.contextWindowTokens !== undefined
          ? this.contextWindowSource ?? 'configured'
          : modelContextWindowTokens !== undefined
          ? 'model_metadata'
          : undefined;
    const toolMode = parseWorkspaceToolMode(request.toolMode, this.toolMode);
    const approvalMode = parseApprovalMode(request.approvalMode, this.approvalMode);
    const requestedCapabilities = request.capabilities ?? this.capabilities;
    const { skillPaths, skillPacks } = await this.resolveRequestedSkillMounts(request);
    const system = request.system ?? this.system;
    const agentSessions = new SubAgentSessionStore();
    let session: ManagedRuntimeSession;
    const host = await this.createCortxHost({
      id,
      workingDirectory: workspace.workingDirectory,
      model,
      reasoningEffort,
      system,
      maxIterations,
      contextWindowTokens,
      contextWindowSource,
      toolMode,
      approvalMode,
      requestedCapabilities,
      skillPaths,
      requestTools: request.tools ?? [],
      registry: request.registry,
      plugins: request.plugins,
      agentSessions,
      onAgentEvent: (event) => this.broadcast(session, event),
    });

    const now = Date.now();
    session = {
      id,
      cortx: host.cortx,
      createdAt: now,
      lastActivityAt: now,
      workingDirectory: workspace.workingDirectory,
      model,
      reasoningEffort,
      system,
      maxIterations,
      contextWindowTokens,
      contextWindowSource,
      toolMode,
      approvalMode,
      requestedCapabilities,
      capabilities: host.capabilities,
      skillPaths,
      skillPacks,
      promptHistory: [],
      requestTools: request.tools ?? [],
      registry: request.registry,
      plugins: request.plugins,
      events: [],
      eventEnvelopes: [],
      usage: undefined,
      subscribers: new Set(),
      envelopeSubscribers: new Set(),
      idleTimer: undefined,
      isRunning: false,
      runPromise: undefined,
      needsHostRefresh: false,
      runId: 0,
      nextEventSequence: 0,
      agentSessions,
      contextMetadata: host.contextMetadata,
      metadata: request.metadata,
    };

    host.cortx.onAgentEvent = (event: AgentEvent) => {
      this.broadcast(session, event);
    };

    this.sessions.set(id, session);
    this.resetIdleTimer(session);
    await this.persistRuntimeSession(session);
    this.logger.info(`[runtime] Session created: ${id}`);
    return this.info(session);
  }

  listSessions(): RuntimeSessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => this.info(session));
  }

  async restoreDurableSessions(options: RestoreDurableSessionsOptions = {}): Promise<RuntimeSessionInfo[]> {
    const store = this.runtimeDurableStore();
    if (!store) return [];

    const restored: RuntimeSessionInfo[] = [];
    for (const snapshot of await store.listRuntimeSessions()) {
      if (this.sessions.has(snapshot.id)) continue;
      if (this.deletedSessionIds.has(snapshot.id)) continue;
      try {
        const checkpoint = await this.durableStore?.loadCheckpoint(snapshot.id);
        const resumableCheckpoint =
          checkpoint && checkpoint.schemaVersion === AGENT_RUN_CHECKPOINT_SCHEMA_VERSION && !checkpoint.state.terminal
            ? checkpoint
            : undefined;

        const info = await this.createSession({
          id: snapshot.id,
          workingDirectory: snapshot.workingDirectory,
          model: snapshot.model,
          reasoningEffort: snapshot.reasoningEffort,
          system: snapshot.system,
          maxIterations: snapshot.maxIterations,
          tools: snapshot.requestTools,
          toolMode: snapshot.toolMode,
          approvalMode: snapshot.approvalMode,
          capabilities: snapshot.capabilities,
          skillPaths: snapshot.skillPaths,
          skillPacks: snapshot.skillPacks,
          metadata: snapshot.metadata,
        });
        const session = this.requireSession(info.id);
        if (checkpoint?.schemaVersion === AGENT_RUN_CHECKPOINT_SCHEMA_VERSION && checkpoint.state.messages?.length) {
          session.cortx.replaceMessages(checkpoint.state.messages);
        }
        session.createdAt = snapshot.createdAt;
        session.lastActivityAt = snapshot.lastActivityAt;
        session.runId = snapshot.runId;
        session.nextEventSequence = snapshot.nextEventSequence;
        session.promptHistory = snapshot.promptHistory?.slice(-100) ?? [];
        session.agentSessions.hydrate(await store.listSubAgentSessions(snapshot.id));
        const eventSnapshots = store.listEventEnvelopes ? await store.listEventEnvelopes(snapshot.id) : [];
        session.usage = this.aggregateUsageFromEventSnapshots(session, eventSnapshots) ?? snapshot.usage;
        this.restoreSessionEventHistory(session, eventSnapshots, resumableCheckpoint);
        await this.persistRuntimeSession(session);
        restored.push(this.info(session));

        if (options.autoResume && resumableCheckpoint) {
          await this.resume(session.id);
        }
      } catch (error) {
        this.logger.warn(
          `Failed to restore runtime session "${snapshot.id}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return restored;
  }

  async launchAgentSpec(value: unknown): Promise<RuntimeSessionInfo> {
    const spec = parseAgentSpec(value);
    const session = await this.createSession({
      workingDirectory: spec.workingDirectory,
      model: spec.model,
      system: spec.system,
      tools: spec.tools,
      toolMode: spec.toolMode,
      approvalMode: spec.approvalMode,
      capabilities: spec.capabilities,
      skillPaths: spec.skillPaths,
      skillPacks: spec.skillPacks,
      metadata: { ...spec.metadata, agentSpec: spec.name ?? 'inline' },
    });
    await this.prompt(session.id, spec.prompt);
    return this.getSession(session.id);
  }

  async launchAgentSpecFile(path: string): Promise<RuntimeSessionInfo> {
    return this.launchAgentSpec(await loadAgentSpecFile(path));
  }

  getSession(sessionId: string): RuntimeSessionInfo {
    return this.info(this.requireSession(sessionId));
  }

  async updateSession(sessionId: string, request: RuntimeSessionUpdateRequest = {}): Promise<RuntimeSessionInfo> {
    const session = this.requireSession(sessionId);
    const model = normalizeModelId(request.model, session.model);
    const modelChanged = model !== session.model;
    const reasoningEffort =
      'reasoningEffort' in request ? normalizeReasoningEffort(request.reasoningEffort) : session.reasoningEffort;
    const toolMode = parseWorkspaceToolMode(request.toolMode, session.toolMode);
    const approvalMode = parseApprovalMode(request.approvalMode, session.approvalMode);
    const requestedContextWindowTokens = parseOptionalPositiveInteger(request.contextWindowTokens, 'contextWindowTokens');
    const modelContextWindowTokens = resolveLanguageModelContextWindow(this.language, model, this.modelCatalog);
    const shouldRefreshModelWindow =
      modelChanged && (session.contextWindowSource === 'model_metadata' || session.contextWindowSource === undefined);
    const contextWindowTokens =
      requestedContextWindowTokens ??
      (shouldRefreshModelWindow ? modelContextWindowTokens : session.contextWindowTokens);
    const contextWindowSource: ContextUsageSource | undefined =
      requestedContextWindowTokens !== undefined
        ? 'configured'
        : shouldRefreshModelWindow
          ? modelContextWindowTokens !== undefined
            ? 'model_metadata'
            : undefined
          : session.contextWindowSource;
    const requestedCapabilities = request.capabilities ?? session.requestedCapabilities;
    let skillPaths = session.skillPaths;
    let skillPacks = session.skillPacks;
    if (request.skillPaths !== undefined || request.skillPacks !== undefined) {
      const resolved = await this.resolveRequestedSkillMounts(request);
      skillPaths = resolved.skillPaths;
      skillPacks = resolved.skillPacks;
    }

    session.lastActivityAt = Date.now();
    session.model = model;
    session.reasoningEffort = reasoningEffort;
    session.contextWindowTokens = contextWindowTokens;
    session.contextWindowSource = contextWindowSource;
    session.toolMode = toolMode;
    session.approvalMode = approvalMode;
    session.requestedCapabilities = requestedCapabilities;
    session.skillPaths = skillPaths;
    session.skillPacks = skillPacks;
    if (request.metadata !== undefined) session.metadata = request.metadata;
    if (session.isRunning) {
      session.capabilities =
        approvalMode === 'full-access' ? { ...requestedCapabilities, approval: false } : requestedCapabilities;
      session.needsHostRefresh = true;
    } else {
      await this.rebuildSessionHost(session);
    }
    this.resetIdleTimer(session);
    await this.persistRuntimeSession(session);
    return this.info(session);
  }

  getEventHistory(sessionId: string): AgentEvent[] {
    return [...this.requireSession(sessionId).events];
  }

  getEventEnvelopeHistory(sessionId: string): RuntimeAgentEventEnvelope[] {
    return [...this.requireSession(sessionId).eventEnvelopes];
  }

  async getEventEnvelopeHistoryPage(
    sessionId: string,
    options: RuntimeEventEnvelopeHistoryPageOptions = {},
  ): Promise<RuntimeEventEnvelopeHistoryPage> {
    const all = await this.loadEventEnvelopeHistory(sessionId);
    const filtered = all.filter((event) => {
      if (options.afterSequence !== undefined && event.sequence <= options.afterSequence) return false;
      if (options.beforeSequence !== undefined && event.sequence >= options.beforeSequence) return false;
      return true;
    });
    const limit = normalizeHistoryLimit(options.limit);
    const events = limit === undefined ? filtered : filtered.slice(-limit);
    const firstSequence = events[0]?.sequence;
    const lastSequence = events.at(-1)?.sequence;
    return {
      events,
      hasMoreBefore: firstSequence !== undefined && all.some((event) => event.sequence < firstSequence),
      hasMoreAfter: lastSequence !== undefined && all.some((event) => event.sequence > lastSequence),
    };
  }

  async listSessionSkills(sessionId: string): Promise<SkillInfo[]> {
    const session = this.requireSession(sessionId);
    if (session.capabilities.skills === false) return [];
    return discoverSkills(session.workingDirectory, { skillPaths: session.skillPaths }, this.logger);
  }

  async listToolProfiles() {
    return listRuntimeToolProfiles(this.registry);
  }

  getLocalState(sessionId: string): RuntimeSessionLocalState {
    const session = this.requireSession(sessionId);
    return {
      agentSessions: session.agentSessions,
      getMessages: () => session.cortx.messages,
      replaceMessages: (messages: LanguageMessage[]) => session.cortx.replaceMessages(messages),
    };
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    await this.startRun(session, () => session.cortx.run(message), () => {
      session.promptHistory = appendPromptHistory(session.promptHistory, message);
      this.broadcast(session, { type: 'user_message', message, source: 'prompt' });
    });
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.startRun(session, () => session.cortx.continue());
  }

  steer(sessionId: string, message: string): void {
    const session = this.requireSession(sessionId);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    session.lastActivityAt = Date.now();
    session.cortx.controller.steer(message);
    this.resetIdleTimer(session);
  }

  followUp(sessionId: string, message: string): void {
    const session = this.requireSession(sessionId);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    session.lastActivityAt = Date.now();
    session.promptHistory = appendPromptHistory(session.promptHistory, message);
    this.broadcast(session, { type: 'user_message', message, source: 'follow_up' });
    session.cortx.controller.followUp(message);
    this.resetIdleTimer(session);
    void this.persistRuntimeSession(session);
  }

  answer(sessionId: string, toolCallId: string, response: string): boolean {
    const session = this.requireSession(sessionId);
    const answered = session.cortx.controller.answerUser(toolCallId, response);
    if (!answered) return false;
    this.broadcast(session, { type: 'user_answer', toolCallId, response });
    return true;
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.abortSession(session, 'User aborted via runtime', 'Session aborted');
    this.resetIdleTimer(session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.destroy(session, { deleteDurable: true });
    this.logger.info(`[runtime] Session deleted: ${sessionId}`);
  }

  subscribe(sessionId: string, callback: (event: AgentEvent) => void, options: SubscribeOptions = {}): () => void {
    const session = this.requireSession(sessionId);
    if (options.replay ?? true) {
      for (const event of [...session.events]) this.safeNotify(() => callback(event));
    }
    session.subscribers.add(callback);
    return () => session.subscribers.delete(callback);
  }

  subscribeEnvelopes(
    sessionId: string,
    callback: (event: RuntimeAgentEventEnvelope) => void,
    options: SubscribeEnvelopeOptions = {},
  ): () => void {
    const session = this.requireSession(sessionId);
    if (options.replay ?? true) {
      for (const event of [...session.eventEnvelopes]) this.safeNotify(() => callback(event));
    }
    session.envelopeSubscribers.add(callback);
    return () => session.envelopeSubscribers.delete(callback);
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) void this.destroy(session);
  }

  private async startRun(
    session: ManagedRuntimeSession,
    createGenerator: () => AsyncGenerator<AgentEvent>,
    onStarted?: () => void,
  ): Promise<void> {
    if (session.isRunning) throw new RuntimeError('session_busy', 'Agent is already running');
    if (session.needsHostRefresh) await this.rebuildSessionHost(session);
    const runningSessions = this.runningSessionCount();
    if (runningSessions >= this.maxSessions) {
      throw new RuntimeError('capacity_exceeded', 'Maximum concurrent running sessions reached', {
        maxSessions: this.maxSessions,
        runningSessions,
        loadedSessions: this.sessions.size,
      });
    }

    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);
    session.isRunning = true;
    const runId = ++session.runId;
    session.cortx.setRunId(runId);
    onStarted?.();
    void this.persistRuntimeSession(session);

    const runPromise = this.consumeRun(session, runId, createGenerator);
    session.runPromise = runPromise;
    void runPromise;
  }

  private runningSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.isRunning) count++;
    }
    return count;
  }

  private async rebuildSessionHost(session: ManagedRuntimeSession): Promise<void> {
    const messages = session.cortx.messages;
    const host = await this.createCortxHost({
      id: session.id,
      workingDirectory: session.workingDirectory,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      system: session.system,
      maxIterations: session.maxIterations,
      contextWindowTokens: session.contextWindowTokens,
      contextWindowSource: session.contextWindowSource,
      toolMode: session.toolMode,
      approvalMode: session.approvalMode,
      requestedCapabilities: session.requestedCapabilities,
      skillPaths: session.skillPaths,
      requestTools: session.requestTools,
      registry: session.registry,
      plugins: session.plugins,
      agentSessions: session.agentSessions,
      onAgentEvent: (event) => this.broadcast(session, event),
    });
    host.cortx.replaceMessages(messages);
    session.cortx = host.cortx;
    session.capabilities = host.capabilities;
    session.contextMetadata = host.contextMetadata;
    session.needsHostRefresh = false;
  }

  private async consumeRun(
    session: ManagedRuntimeSession,
    runId: number,
    createGenerator: () => AsyncGenerator<AgentEvent>,
  ): Promise<void> {
    try {
      for await (const event of createGenerator()) {
        if (!this.sessions.has(session.id) || session.runId !== runId) break;
        this.broadcast(session, event);
      }
    } catch (error) {
      if (!this.sessions.has(session.id) || session.runId !== runId) return;
      this.broadcast(session, eventError(toRuntimeError(error)));
    } finally {
      if (session.runId === runId) session.isRunning = false;
      if (session.runPromise && session.runId === runId) session.runPromise = undefined;
      void this.persistRuntimeSession(session);
    }
  }

  private broadcast(session: ManagedRuntimeSession, event: AgentEvent): void {
    if (!this.sessions.has(session.id)) return;
    session.lastActivityAt = Date.now();
    const enrichedEvent = this.enrichEvent(session, event);
    const envelope: RuntimeAgentEventEnvelope = {
      sequence: ++session.nextEventSequence,
      timestamp: session.lastActivityAt,
      sessionId: session.id,
      runId: session.runId,
      event: enrichedEvent,
      parent: parentAttributionFor(session, enrichedEvent),
    };
    if (enrichedEvent.type === 'done' && enrichedEvent.usage) {
      session.usage = addSessionUsage(session.usage, enrichedEvent.usage);
    }
    session.events.push(enrichedEvent);
    session.eventEnvelopes.push(envelope);
    if (session.events.length > this.maxEventsPerSession) {
      session.events.splice(0, session.events.length - this.maxEventsPerSession);
    }
    if (session.eventEnvelopes.length > this.maxEventsPerSession) {
      session.eventEnvelopes.splice(0, session.eventEnvelopes.length - this.maxEventsPerSession);
    }
    void this.persistRuntimeSession(session);
    void this.persistEventEnvelope(envelope);
    void this.persistSubAgentSession(session, enrichedEvent);
    for (const subscriber of session.subscribers) {
      this.safeNotify(() => subscriber(enrichedEvent));
    }
    for (const subscriber of session.envelopeSubscribers) {
      this.safeNotify(() => subscriber(envelope));
    }
  }

  private enrichEvent(session: ManagedRuntimeSession, event: AgentEvent): AgentEvent {
    if (event.type !== 'done' || !event.usage) return event;
    return {
      ...event,
      usage: {
        ...event.usage,
        context: this.createContextUsageFacts(session, event.usage, event.usage.context),
      },
    };
  }

  private createContextUsageFacts(
    session: ManagedRuntimeSession,
    usage: AgentDoneUsage,
    existing?: ContextUsageFacts,
  ): ContextUsageFacts {
    const messagesTokens = estimateMessageTokens(session.cortx.messages);
    const metadata = session.contextMetadata;
    const baseBreakdown: ContextUsageBreakdownEntry[] = existing?.breakdown?.length ? existing.breakdown : [
      {
        key: 'messages',
        label: 'Messages',
        tokens: messagesTokens,
        source: 'runtime_estimate',
        count: session.cortx.messages.length,
      },
      {
        key: 'tools',
        label: 'Tools',
        tokens: metadata.toolDefinitionTokens,
        source: 'runtime_estimate',
        count: metadata.toolCount,
      },
      {
        key: 'skills',
        label: 'Skills',
        tokens: metadata.skillSummaryTokens,
        source: 'runtime_estimate',
        count: metadata.skillCount,
      },
      {
        key: 'system_prompt',
        label: 'System Prompt',
        tokens: metadata.systemPromptTokens,
        source: 'runtime_estimate',
      },
    ];
    const knownTokens = baseBreakdown
      .filter((row) => row.key !== 'other')
      .reduce((total, row) => total + row.tokens, 0);
    const providerUsedTokens = contextInputTokens(usage);
    const usedTokens = Math.max(providerUsedTokens ?? 0, knownTokens) || undefined;
    const otherTokens = Math.max(0, (usedTokens ?? 0) - knownTokens);
    const existingOther = baseBreakdown.find((row) => row.key === 'other');
    const breakdown: ContextUsageBreakdownEntry[] = [
      ...baseBreakdown.filter((row) => row.key !== 'other'),
      {
        key: 'other',
        label: existingOther?.label ?? 'Other',
        tokens: otherTokens,
        source: usedTokens === undefined ? 'unknown' : 'provider',
        description:
          existingOther?.description ??
          'Provider-reported input tokens not attributed to runtime-known messages, tools, skills, or system prompt.',
      },
    ];
    return {
      usedTokens,
      requestInputTokens: optionalUsageToken(usage.inputTokens),
      requestOutputTokens: optionalUsageToken(usage.outputTokens),
      requestNoCacheInputTokens: optionalUsageToken(usage.noCacheInputTokens),
      requestCacheReadTokens: optionalUsageToken(usage.cacheReadTokens),
      requestCacheCreationTokens: optionalUsageToken(usage.cacheCreationTokens),
      windowTokens: metadata.contextWindowTokens,
      windowSource: metadata.contextWindowSource,
      model: session.model,
      percentUsed: percent(usedTokens, metadata.contextWindowTokens),
      cacheHitRate: percent(usage.cacheReadTokens, providerUsedTokens ?? usedTokens),
      breakdown,
    };
  }

  private resetIdleTimer(session: ManagedRuntimeSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!this.sessions.has(session.id)) return;
      this.logger.info(`[runtime] Session idle timeout: ${session.id}`);
      this.destroy(session);
    }, this.idleTimeoutMs);
    session.idleTimer.unref?.();
  }

  private safeNotify(callback: () => unknown): void {
    try {
      const result = callback();
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      /* subscriber errors should not break the runtime */
    }
  }

  private async abortSession(
    session: ManagedRuntimeSession,
    abortReason: string,
    pendingQuestionReason: string,
  ): Promise<void> {
    const previousRun = session.runPromise;
    session.cortx.abort(abortReason);
    session.agentSessions.abortRunning(pendingQuestionReason);
    session.cortx.controller.rejectPendingQuestions(pendingQuestionReason);
    session.runId++;
    session.lastActivityAt = Date.now();
    void this.persistRuntimeSession(session);

    if (previousRun) {
      try {
        await previousRun;
      } catch {
        /* consumeRun already normalizes stream errors */
      }
    }

    if (!this.sessions.has(session.id)) return;
    if (session.runPromise === previousRun) session.runPromise = undefined;
    session.isRunning = false;
    await this.persistRuntimeSession(session);
  }

  private async destroy(session: ManagedRuntimeSession, options: { deleteDurable?: boolean } = {}): Promise<void> {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (options.deleteDurable) this.deletedSessionIds.add(session.id);
    await this.abortSession(session, 'Session cleaned up', 'Session destroyed');
    session.subscribers.clear();
    session.envelopeSubscribers.clear();
    session.isRunning = false;
    this.sessions.delete(session.id);
    if (options.deleteDurable) {
      await this.runtimeDurableStore()?.deleteRuntimeSession(session.id);
    } else {
      await this.persistRuntimeSession(session);
    }
  }

  private requireSession(sessionId: string): ManagedRuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RuntimeError('session_not_found', 'Session not found', { sessionId });
    return session;
  }

  private info(session: ManagedRuntimeSession): RuntimeSessionInfo {
    return {
      id: session.id,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      workingDirectory: session.workingDirectory,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      system: session.system,
      maxIterations: session.maxIterations,
      contextWindowTokens: session.contextWindowTokens,
      contextWindowSource: session.contextWindowSource,
      toolMode: session.toolMode,
      approvalMode: session.approvalMode,
      capabilities: session.capabilities,
      skillPaths: session.skillPaths,
      skillPacks: session.skillPacks,
      promptHistory: session.promptHistory,
      usage: session.usage,
      isRunning: session.isRunning,
      eventCount: session.events.length,
      metadata: session.metadata,
    };
  }

  private runtimeDurableStore(): RuntimeDurableRunStore | undefined {
    return isRuntimeDurableRunStore(this.durableStore) ? this.durableStore : undefined;
  }

  private async loadEventEnvelopeHistory(sessionId: string): Promise<RuntimeAgentEventEnvelope[]> {
    const session = this.requireSession(sessionId);
    const bySequence = new Map<number, RuntimeAgentEventEnvelope>();
    const store = this.runtimeDurableStore();
    const snapshots = store?.listEventEnvelopes ? await store.listEventEnvelopes(sessionId) : [];

    for (const snapshot of snapshots) {
      if (snapshot.sessionId !== sessionId) continue;
      bySequence.set(snapshot.sequence, {
        sequence: snapshot.sequence,
        timestamp: snapshot.timestamp,
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        event: this.enrichEvent(session, snapshot.event),
        parent: parentAttributionFor(session, snapshot.event) ?? snapshot.parent,
      });
    }

    for (const envelope of session.eventEnvelopes) {
      bySequence.set(envelope.sequence, envelope);
    }

    return backfillUserMessageEnvelopes(session, [...bySequence.values()].sort((a, b) => a.sequence - b.sequence));
  }

  private sessionSnapshot(session: ManagedRuntimeSession): RuntimeSessionSnapshot {
    return {
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: session.id,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      workingDirectory: session.workingDirectory,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      system: session.system,
      maxIterations: session.maxIterations,
      contextWindowTokens: session.contextWindowTokens,
      contextWindowSource: session.contextWindowSource,
      toolMode: session.toolMode,
      approvalMode: session.approvalMode,
      capabilities: session.requestedCapabilities,
      skillPaths: session.skillPaths,
      skillPacks: session.skillPacks,
      promptHistory: session.promptHistory,
      requestTools: session.requestTools,
      usage: session.usage,
      runId: session.runId,
      nextEventSequence: session.nextEventSequence,
      metadata: session.metadata,
    };
  }

  private aggregateUsageFromEventSnapshots(
    session: ManagedRuntimeSession,
    snapshots: RuntimeEventEnvelopeSnapshot[],
  ): AgentDoneUsage | undefined {
    let usage: AgentDoneUsage | undefined;
    for (const snapshot of snapshots) {
      const event = this.enrichEvent(session, snapshot.event);
      if (event.type === 'done' && event.usage) usage = addSessionUsage(usage, event.usage);
    }
    return usage;
  }

  private restoreSessionEventHistory(
    session: ManagedRuntimeSession,
    snapshots: RuntimeEventEnvelopeSnapshot[],
    resumableCheckpoint?: AgentRunCheckpoint,
  ): void {
    const bounded = snapshots.slice(-this.maxEventsPerSession);
    session.eventEnvelopes = backfillUserMessageEnvelopes(session, bounded.map((snapshot) => ({
      sequence: snapshot.sequence,
      timestamp: snapshot.timestamp,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      event: this.enrichEvent(session, snapshot.event),
      parent: parentAttributionFor(session, snapshot.event) ?? snapshot.parent,
    })));
    if (resumableCheckpoint && !isTerminalEvent(session.eventEnvelopes.at(-1)?.event)) {
      const sequence = Math.max(session.nextEventSequence, session.eventEnvelopes.at(-1)?.sequence ?? 0) + 1;
      session.eventEnvelopes.push({
        sequence,
        timestamp: Date.now(),
        sessionId: session.id,
        runId: session.runId,
        event: {
          type: 'error',
          code: 'client_error',
          error: new Error('Previous run was interrupted. Use resume to continue from the last checkpoint, or send a new prompt to start a new turn.'),
        },
      });
    }
    if (session.eventEnvelopes.length > this.maxEventsPerSession) {
      session.eventEnvelopes.splice(0, session.eventEnvelopes.length - this.maxEventsPerSession);
    }
    session.events = session.eventEnvelopes.map((envelope) => envelope.event);
    const lastSequence = session.eventEnvelopes.at(-1)?.sequence ?? 0;
    session.nextEventSequence = Math.max(session.nextEventSequence, lastSequence);
  }

  private eventEnvelopeSnapshot(envelope: RuntimeAgentEventEnvelope): RuntimeEventEnvelopeSnapshot {
    return {
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      ...envelope,
    };
  }

  private async persistRuntimeSession(session: ManagedRuntimeSession): Promise<void> {
    const store = this.runtimeDurableStore();
    if (!store) return;
    if (this.deletedSessionIds.has(session.id)) return;
    try {
      await store.saveRuntimeSession(this.sessionSnapshot(session));
      if (this.deletedSessionIds.has(session.id)) {
        await store.deleteRuntimeSession(session.id);
      }
    } catch (error) {
      this.logger.warn(`Failed to persist runtime session "${session.id}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async persistEventEnvelope(envelope: RuntimeAgentEventEnvelope): Promise<void> {
    const store = this.runtimeDurableStore();
    if (!store?.saveEventEnvelope) return;
    if (this.deletedSessionIds.has(envelope.sessionId)) return;
    try {
      await store.saveEventEnvelope(this.eventEnvelopeSnapshot(envelope));
      if (this.deletedSessionIds.has(envelope.sessionId)) {
        await store.deleteEventEnvelopes?.(envelope.sessionId);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to persist runtime event "${envelope.sessionId}:${envelope.sequence}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async persistSubAgentSession(session: ManagedRuntimeSession, event: AgentEvent): Promise<void> {
    if (event.type !== 'agent_started' && event.type !== 'agent_progress' && event.type !== 'agent_completed') return;
    const store = this.runtimeDurableStore();
    if (!store) return;
    if (this.deletedSessionIds.has(session.id)) return;
    const snapshot = session.agentSessions.snapshot(event.toolCallId);
    if (!snapshot) return;
    try {
      await store.saveSubAgentSession(snapshot);
      if (this.deletedSessionIds.has(session.id)) {
        await store.deleteSubAgentSessions(session.id);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to persist sub-agent session "${event.toolCallId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveRequestedSkillMounts(request: {
    skillPaths?: unknown;
    skillPacks?: unknown;
  }): Promise<RuntimeSkillMounts> {
    const requestedSkillPaths = parseOptionalStringArray(request.skillPaths, 'skillPaths');
    const requestedSkillPacks = parseOptionalStringArray(request.skillPacks, 'skillPacks');
    const installedSkillPacks = await resolveSkillPackReferences(requestedSkillPacks, {
      registryPath: this.skillPackRegistryPath,
    });
    const resolvedSkillPaths = [
      ...(requestedSkillPaths ?? []),
      ...installedSkillPacks.flatMap((pack) => pack.skillPaths),
    ];
    return {
      skillPaths: resolvedSkillPaths.length ? resolvedSkillPaths : undefined,
      skillPacks: requestedSkillPacks,
    };
  }

  private async createCortxHost(input: RuntimeCortxHostInput): Promise<RuntimeCortxHost> {
    const capabilities =
      input.approvalMode === 'full-access'
        ? { ...input.requestedCapabilities, approval: false }
        : input.requestedCapabilities;
    const toolApprovalRequirements = new WeakMap<Tool, boolean>();
    const runtimeTools = this.tools.map((tool) => {
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
    const toolProfilePluginEntries = await createWorkspaceToolPluginEntries(
      input.workingDirectory,
      input.toolMode,
      input.registry ?? this.registry,
    );
    const pluginEntries = [...toolProfilePluginEntries, ...((input.plugins ?? this.plugins) ?? [])];
    const officialExtensions = await this.createOfficialExtensions({
      workingDirectory: input.workingDirectory,
      capabilities,
      skillPaths: input.skillPaths,
      needsToolApproval: (tool) => (tool ? toolApprovalRequirements.get(tool) ?? workspaceToolNeedsApproval(tool) : true),
    });
    const extensions = officialExtensions.extensions;

    if (capabilities.subAgents !== false) {
      const subAgentTool = createSubAgentTool({
        language: this.language,
        model: input.model,
        reasoning: input.reasoningEffort ? { enabled: true, effort: input.reasoningEffort } : undefined,
        registry: input.registry ?? this.registry,
        plugins: pluginEntries,
        agentSessions: input.agentSessions,
        getTools: () => mountedTools,
        getExtensions: () => extensions,
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
      toolCount: allModelTools.length + toolProfilePluginEntries.length,
      skillSummaryTokens: officialExtensions.skillSummaryTokens,
      skillCount: officialExtensions.skillCount,
    };

    const cortx = new Cortx(this.language, {
      appName: this.appName,
      model: input.model,
      reasoning: input.reasoningEffort ? { enabled: true, effort: input.reasoningEffort } : undefined,
      system: input.system,
      maxIterations: input.maxIterations,
      registry: input.registry ?? this.registry,
      plugins: pluginEntries,
      tools: mountedTools,
      extensions,
      workingDirectory: input.workingDirectory,
      sessionId: input.id,
      durableStore: this.durableStore,
      askUser: input.approvalMode === 'deny' ? async () => 'no' : undefined,
      logger: this.logger,
    });
    cortx.onAgentEvent = input.onAgentEvent;
    return { cortx, capabilities, contextMetadata };
  }

  private async createOfficialExtensions(input: {
    workingDirectory: string;
    capabilities: RuntimeDefaultCapabilities;
    skillPaths?: string[];
    needsToolApproval?: (tool: Tool | undefined, input: Record<string, unknown>) => boolean;
  }): Promise<RuntimeOfficialExtensions> {
    const sets: AgentRuntimeExtensions[] = [createEmptyAgentRuntimeExtensions()];
    let skillCount = 0;
    let skillSummaryTokens = 0;
    if (input.capabilities.skills !== false) {
      const skills = await discoverSkills(input.workingDirectory, { skillPaths: input.skillPaths }, this.logger);
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
