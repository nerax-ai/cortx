import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  parseCortxContributionReference,
  noopLogger,
  type AgentEvent,
  type CortxContributionConfig,
  type RuntimeAgentEventEnvelope,
  type RuntimeAgentStreamEnvelope,
  type SkillInfo,
} from '@cortx/sdk';
import {
  CortxPluginAdminService,
  CortxRuntime,
  OFFICIAL_TOOL_PROFILE_ALIASES,
  discoverAgentSpecs,
  installSkillPack,
  isRuntimeError,
  listInstalledSkillPacks,
  loadAgentSpecFile,
  parseAgentSpec,
  resolveWorkspace,
  RuntimeError,
  type AgentSpec,
  type DiscoveredAgentSpec,
  type InstalledSkillPack,
  type RuntimeApprovalMode,
  type RuntimeDefaultCapabilities,
  type RuntimeToolProfile,
  type RuntimeSessionCreateRequest,
  type RuntimeSessionInfo,
  type RuntimeSessionUpdateRequest,
  type SessionSummaryProjection,
  type WorkspaceToolMode,
} from '@cortx/runtime';
import type { PluginAdminService } from '@synax-ai/sdk';
import type { ServerConfig } from './types.js';
import {
  createAuthMiddleware,
  getAuthPrincipal,
  principalContributionConfigs,
  type AuthPrincipal,
} from './auth.js';
import { buildFileEditDetails } from './file-edit-details.js';
import {
  isPluginAdminHttpPath,
  mountPluginAdminHttp,
  pluginAdminErrorResponse,
  pluginAdminHttpAction,
} from './plugin-admin-http.js';
import {
  assertServerRequestSecurity,
  isAllowedOrigin,
  pluginAdminGrantIsCurrent,
} from './security.js';
import { assertOptionalString } from './http.js';
import { mountCatalogRoutes } from './routes/catalog-routes.js';
import { mountEventRoutes } from './routes/event-routes.js';
import { mountSessionRoutes } from './routes/session-routes.js';

export interface ServerRuntimeHandle {
  app: Hono;
  runtime: CortxRuntime;
  pluginAdminService: PluginAdminService;
  close(): Promise<void>;
}

interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
}

interface WorkspaceDirectoryListing {
  roots: string[];
  current: string;
  parent?: string;
  entries: WorkspaceDirectoryEntry[];
}

interface WebSkillInfo {
  name: string;
  description: string;
  arguments?: string[];
  dirPath: string;
}

interface WebReasoningEffortOption {
  value: string;
  label: string;
}

interface WebModelInfo {
  id: string;
  name: string;
  contextWindowTokens?: number;
  reasoningEfforts?: WebReasoningEffortOption[];
}

interface WebChildSession {
  runId: string;
  parentSessionId: string;
  parentRunId?: number;
  toolCallId: string;
  description: string;
  isBackground: boolean;
  status: 'running' | 'completed' | 'error' | 'interrupted' | 'cancelled';
  output: string;
  iterations: number;
  toolCallCount: number;
  startedAt: number;
  completedAt?: number;
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Light',
  light: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  'extra-high': 'Extra High',
};

const DEFAULT_REASONING_EFFORTS: WebReasoningEffortOption[] = [
  { value: 'low', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

function serializeEvent(event: AgentEvent): string {
  if (event.type === 'error' && event.error instanceof Error) {
    return JSON.stringify({ ...event, error: { message: event.error.message, name: event.error.name } });
  }
  return JSON.stringify(event);
}

function serializeEnvelope(envelope: RuntimeAgentStreamEnvelope): string {
  if (envelope.event.type === 'error' && envelope.event.error instanceof Error) {
    return JSON.stringify({
      ...envelope,
      event: {
        ...envelope.event,
        error: { message: envelope.event.error.message, name: envelope.event.error.name },
      },
    });
  }
  return JSON.stringify(envelope);
}

function serializeEventData(event: AgentEvent): AgentEvent {
  return JSON.parse(serializeEvent(event)) as AgentEvent;
}

function serializeEnvelopeData(envelope: RuntimeAgentEventEnvelope): RuntimeAgentEventEnvelope {
  return JSON.parse(serializeEnvelope(envelope)) as RuntimeAgentEventEnvelope;
}

function serializeSkillInfo(skill: SkillInfo): WebSkillInfo {
  return {
    name: skill.name,
    description: skill.description,
    arguments: skill.arguments,
    dirPath: skill.dirPath,
  };
}

function serializeChildSession(child: ReturnType<CortxRuntime['getChildSession']>): WebChildSession {
  return {
    runId: child.runId,
    parentSessionId: child.parentSessionId,
    parentRunId: child.parentRunId,
    toolCallId: child.toolCallId,
    description: child.description,
    isBackground: child.isBackground,
    status: child.status,
    output: child.output,
    iterations: child.iterations,
    toolCallCount: child.toolCallCount,
    startedAt: child.startedAt,
    completedAt: child.completedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseToolInput(input: unknown): Record<string, unknown> | undefined {
  if (isRecord(input)) return input;
  if (typeof input !== 'string') return undefined;
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().split(/[.:/]/).pop() ?? toolName.toLowerCase();
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

async function hydrateHistoricalFileEditDetails(
  envelopes: RuntimeAgentEventEnvelope[],
  workingDirectory: string,
): Promise<RuntimeAgentEventEnvelope[]> {
  const toolInputs = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  const fileSnapshots = new Map<string, string>();
  let result = envelopes;

  function replaceEvent(index: number, event: AgentEvent): void {
    if (result === envelopes) result = [...envelopes];
    result[index] = { ...envelopes[index], event };
  }

  envelopes.forEach((envelope, index) => {
    const event = envelope.event;
    if (event.type === 'tool_use') {
      const input = parseToolInput(event.toolCall.input);
      if (input) {
        toolInputs.set(event.toolCall.toolCallId, {
          toolName: normalizedToolName(event.toolCall.toolName),
          input,
        });
      }
      return;
    }

    if (event.type !== 'tool_result' || event.isError) return;
    const toolUse = toolInputs.get(event.toolCallId);
    if (!toolUse) return;

    if (toolUse.toolName === 'write') {
      const path = stringField(toolUse.input, 'path');
      const content = stringField(toolUse.input, 'content');
      if (path && content !== undefined) fileSnapshots.set(path, content);
      return;
    }

    if (toolUse.toolName !== 'edit') return;
    const path = stringField(toolUse.input, 'path');
    const oldText = stringField(toolUse.input, 'oldText');
    const newText = stringField(toolUse.input, 'newText');
    if (!path || oldText === undefined || newText === undefined) return;

    const before = fileSnapshots.get(path);
    if (before === undefined || !before.includes(oldText)) return;
    const after = before.replace(oldText, newText);
    fileSnapshots.set(path, after);

    if (event.details !== undefined) return;
    replaceEvent(index, {
      ...event,
      details: buildFileEditDetails(path, before, after),
    });
  });

  const reverseFileStates = new Map<string, string | undefined>();
  const attemptedFileLoads = new Set<string>();

  async function loadCurrentFile(path: string): Promise<string | undefined> {
    if (attemptedFileLoads.has(path)) return reverseFileStates.get(path);
    attemptedFileLoads.add(path);
    try {
      const workspace = await resolveWorkspace({
        requested: path,
        defaultWorkingDirectory: workingDirectory,
        allowedRoots: [workingDirectory],
      });
      const content = await readFile(workspace.workingDirectory, 'utf8');
      reverseFileStates.set(path, content);
      return content;
    } catch {
      reverseFileStates.set(path, undefined);
      return undefined;
    }
  }

  function replaceUnique(content: string, oldText: string, newText: string): string | undefined {
    const first = content.indexOf(oldText);
    if (first === -1 || first !== content.lastIndexOf(oldText)) return undefined;
    return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
  }

  for (let index = result.length - 1; index >= 0; index--) {
    const envelope = result[index]!;
    const event = envelope.event;
    if (event.type !== 'tool_result' || event.isError) continue;
    const toolUse = toolInputs.get(event.toolCallId);
    if (!toolUse) continue;

    if (toolUse.toolName === 'write') {
      const path = stringField(toolUse.input, 'path');
      if (path) reverseFileStates.set(path, undefined);
      continue;
    }

    if (toolUse.toolName !== 'edit') continue;
    const path = stringField(toolUse.input, 'path');
    const oldText = stringField(toolUse.input, 'oldText');
    const newText = stringField(toolUse.input, 'newText');
    if (!path || oldText === undefined || newText === undefined) continue;

    const after = reverseFileStates.has(path) ? reverseFileStates.get(path) : await loadCurrentFile(path);
    if (after === undefined) continue;
    const before = replaceUnique(after, newText, oldText);
    if (before === undefined) continue;
    reverseFileStates.set(path, before);

    if (event.details !== undefined) continue;
    replaceEvent(index, {
      ...event,
      details: buildFileEditDetails(path, before, after),
    });
  }

  return result;
}

function readModelContextWindow(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const limits = value.limits;
  if (isRecord(limits)) {
    const context = readPositiveInteger(limits.context);
    if (context !== undefined) return context;
  }
  const nestedModel = value.model;
  if (isRecord(nestedModel)) {
    const context = readModelContextWindow(nestedModel);
    if (context !== undefined) return context;
  }
  const metadata = value.metadata;
  if (isRecord(metadata)) {
    const context = readModelContextWindow({ limits: metadata.limits });
    if (context !== undefined) return context;
  }
  return undefined;
}

function normalizeReasoningEffortOption(value: unknown): WebReasoningEffortOption | undefined {
  if (typeof value === 'string' && value.trim()) {
    const effort = value.trim();
    return { value: effort, label: REASONING_EFFORT_LABELS[effort] ?? effort };
  }
  if (!isRecord(value)) return undefined;
  const rawValue = value.value ?? value.id ?? value.effort ?? value.name;
  if (typeof rawValue !== 'string' || !rawValue.trim()) return undefined;
  const effort = rawValue.trim();
  const rawLabel = value.label ?? value.name ?? value.title;
  return {
    value: effort,
    label: typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : REASONING_EFFORT_LABELS[effort] ?? effort,
  };
}

function normalizeReasoningEffortOptions(value: unknown): WebReasoningEffortOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map(normalizeReasoningEffortOption)
    .filter((option): option is WebReasoningEffortOption => option !== undefined);
  const seen = new Set<string>();
  const deduped = options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
  return deduped.length ? deduped : undefined;
}

function readReasoningEffortOptionsFromRecord(record: Record<string, unknown>): WebReasoningEffortOption[] | undefined {
  const direct =
    normalizeReasoningEffortOptions(record.reasoningEfforts) ??
    normalizeReasoningEffortOptions(record.reasoningEffortOptions) ??
    normalizeReasoningEffortOptions(record.thinkingEfforts) ??
    normalizeReasoningEffortOptions(record.thinkingEffortOptions);
  if (direct) return direct;

  for (const key of ['reasoning', 'thinking']) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const nestedOptions =
      normalizeReasoningEffortOptions(nested.efforts) ??
      normalizeReasoningEffortOptions(nested.options) ??
      normalizeReasoningEffortOptions(nested.levels);
    if (nestedOptions) return nestedOptions;
  }

  for (const key of ['metadata', 'options', 'model']) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const nestedOptions = readReasoningEffortOptionsFromRecord(nested);
    if (nestedOptions) return nestedOptions;
  }

  return undefined;
}

function modelSupportsReasoning(record: Record<string, unknown>): boolean {
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  if (capabilities?.reasoning === true) return true;
  const model = isRecord(record.model) ? record.model : undefined;
  const modelCapabilities = model && isRecord(model.capabilities) ? model.capabilities : undefined;
  if (modelCapabilities?.reasoning === true) return true;
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  if (metadata?.reasoning === true || metadata?.thinking === true) return true;
  return Boolean(readReasoningEffortOptionsFromRecord(record));
}

function serializeModelInfo(value: unknown): WebModelInfo | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : undefined;
  if (!id) return undefined;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
  const explicitReasoningEfforts = readReasoningEffortOptionsFromRecord(value);
  const reasoningEfforts = explicitReasoningEfforts ?? (modelSupportsReasoning(value) ? DEFAULT_REASONING_EFFORTS : undefined);
  return {
    id,
    name,
    contextWindowTokens: readModelContextWindow(value),
    reasoningEfforts,
  };
}

function mergeModelInfo(current: WebModelInfo | undefined, next: WebModelInfo): WebModelInfo {
  if (!current) return next;
  return {
    id: current.id,
    name: current.name || next.name,
    contextWindowTokens: current.contextWindowTokens ?? next.contextWindowTokens,
    reasoningEfforts: current.reasoningEfforts ?? next.reasoningEfforts,
  };
}

function listServerModels(config: ServerConfig): WebModelInfo[] {
  const byId = new Map<string, WebModelInfo>();
  const candidates = [...(config.modelCatalog ?? []), ...(config.models ?? [])];
  for (const candidate of candidates) {
    const info = serializeModelInfo(candidate);
    if (!info) continue;
    byId.set(info.id, mergeModelInfo(byId.get(info.id), info));
  }
  if (!byId.has(config.model)) {
    byId.set(config.model, {
      id: config.model,
      name: config.model,
      contextWindowTokens: config.contextWindowTokens,
    });
  }
  return [...byId.values()];
}

function getDefaultWorkingDirectory(config: ServerConfig): string {
  return config.defaultWorkingDirectory ?? process.cwd();
}

function getServerAllowedWorkspaceRoots(config: ServerConfig): string[] {
  const defaultWorkingDirectory = getDefaultWorkingDirectory(config);
  return config.allowedWorkspaceRoots?.length ? config.allowedWorkspaceRoots : [defaultWorkingDirectory];
}

function getRuntimeAllowedWorkspaceRoots(config: ServerConfig): string[] {
  return [
    ...new Set([
      ...getServerAllowedWorkspaceRoots(config),
      ...(config.apiKeys ?? []).flatMap((entry) => entry.allowedWorkspaceRoots ?? []),
    ]),
  ];
}

function getSkillPackRegistryPath(config: ServerConfig): string {
  return config.skillPackRegistryPath ?? resolve(getDefaultWorkingDirectory(config), '.cortx', 'skill-packs', 'registry.json');
}

function getPrincipalAllowedWorkspaceRoots(config: ServerConfig, principal: AuthPrincipal | undefined): string[] {
  return principal?.allowedWorkspaceRoots?.length ? principal.allowedWorkspaceRoots : getServerAllowedWorkspaceRoots(config);
}

function getAgentSpecDiscoveryRoots(config: ServerConfig, principal: AuthPrincipal | undefined): string[] {
  if (config.agentSpecRoots?.length) return config.agentSpecRoots.map((root) => resolve(root));
  const workspaceRoots = principal?.allowedWorkspaceRoots?.length
    ? principal.allowedWorkspaceRoots
    : [getDefaultWorkingDirectory(config)];
  return [
    resolve(homedir(), '.cortx', 'agents'),
    resolve(homedir(), '.cortx', 'agent-specs'),
    ...workspaceRoots.flatMap((root) => [
      resolve(root, '.cortx', 'agents'),
      resolve(root, '.cortx', 'agent-specs'),
    ]),
  ];
}

function isPathLikeReference(reference: string): boolean {
  return isAbsolute(reference) || reference.startsWith('.') || reference.includes('/') || reference.includes('\\');
}

function resolveSourceRootReference(sourceRoot: string, reference: string): string {
  return isAbsolute(reference) ? resolve(reference) : resolve(sourceRoot, reference);
}

async function authorizeWorkspace(
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
  requested?: string,
): ReturnType<typeof resolveWorkspace> {
  try {
    return await resolveWorkspace({
      requested,
      defaultWorkingDirectory: getDefaultWorkingDirectory(config),
      allowedRoots: getPrincipalAllowedWorkspaceRoots(config, principal),
    });
  } catch (error) {
    if (principal?.allowedWorkspaceRoots?.length && isRuntimeError(error) && error.kind === 'invalid_workspace') {
      throw new RuntimeError('permission_denied', 'workspace is outside the current API key scope', {
        requested,
        principal: principal.id,
        allowedRoots: principal.allowedWorkspaceRoots,
      });
    }
    throw error;
  }
}

const APPROVAL_MODE_RANK: Record<RuntimeApprovalMode, number> = {
  deny: 0,
  interactive: 1,
  'full-access': 2,
};

function filterToolProfilesForPrincipal(
  profiles: RuntimeToolProfile[],
  principal: AuthPrincipal | undefined,
): RuntimeToolProfile[] {
  if (!principal?.allowedToolProfiles) return profiles;
  const allowed = new Set(principal.allowedToolProfiles);
  return profiles.filter((profile) => allowed.has(profile.use));
}

function assertWithinApprovalScope(
  requested: RuntimeApprovalMode | undefined,
  allowed: RuntimeApprovalMode | undefined,
  principal: AuthPrincipal,
): void {
  if (!requested || !allowed) return;
  const requestedRank = (APPROVAL_MODE_RANK as Record<string, number | undefined>)[requested];
  if (requestedRank === undefined) {
    throw new RuntimeError('invalid_request', 'approvalMode must be one of: deny, interactive, full-access', {
      approvalMode: requested,
    });
  }
  if (requestedRank <= APPROVAL_MODE_RANK[allowed]) return;
  throw new RuntimeError('permission_denied', 'approvalMode is outside the current API key scope', {
    requested,
    allowed,
    principal: principal.id,
  });
}

function applyPrincipalSessionBounds<T extends RuntimeSessionCreateRequest | AgentSpec>(
  request: T,
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
  profiles: RuntimeToolProfile[],
): T {
  const next = { ...request };
  next.toolMode = resolveAuthorizedToolProfile(next.toolMode ?? config.toolMode ?? 'none', principal, profiles);
  next.approvalMode = resolveAuthorizedApproval(next.approvalMode, config, principal);
  next.capabilities = resolveAuthorizedCapabilities(next.capabilities, config.capabilities, principal);
  return next as T;
}

async function buildAuthorizedSessionRequest(
  c: Context,
  config: ServerConfig,
  body: Record<string, unknown>,
  profiles: RuntimeToolProfile[],
): Promise<RuntimeSessionCreateRequest> {
  const principal = getAuthPrincipal(c);
  const requested = assertOptionalString(body.workingDirectory, 'workingDirectory');
  const workspace = await authorizeWorkspace(config, principal, requested);
  const request = applyPrincipalSessionBounds(
    {
      ...body,
      creatorPrincipalId: principal?.id,
      workingDirectory: workspace.workingDirectory,
      contributions: resolveAuthorizedContributions(body.contributions, config, principal),
    } as RuntimeSessionCreateRequest,
    config,
    principal,
    profiles,
  ) as RuntimeSessionCreateRequest;
  return request;
}

function buildAuthorizedSessionUpdateRequest(
  c: Context,
  config: ServerConfig,
  body: Record<string, unknown>,
  profiles: RuntimeToolProfile[],
): RuntimeSessionUpdateRequest {
  const principal = getAuthPrincipal(c);
  const request = { ...body } as RuntimeSessionUpdateRequest;
  if (request.toolMode !== undefined) request.toolMode = resolveAuthorizedToolProfile(request.toolMode, principal, profiles);
  if (request.approvalMode !== undefined) request.approvalMode = resolveAuthorizedApproval(request.approvalMode, config, principal);
  if (request.capabilities !== undefined) {
    request.capabilities = resolveAuthorizedCapabilities(request.capabilities, config.capabilities, principal);
  }
  return request;
}

function resolveAuthorizedToolProfile(
  requested: WorkspaceToolMode,
  principal: AuthPrincipal | undefined,
  profiles: RuntimeToolProfile[],
): WorkspaceToolMode {
  const canonical = OFFICIAL_TOOL_PROFILE_ALIASES[requested as keyof typeof OFFICIAL_TOOL_PROFILE_ALIASES] ?? requested;
  if (canonical !== OFFICIAL_TOOL_PROFILE_ALIASES.none && !profiles.some((profile) => profile.use === canonical)) {
    throw new RuntimeError('invalid_request', `toolMode profile not found: ${requested}`, {
      toolMode: requested,
      availableToolModes: profiles.map((profile) => profile.use),
    });
  }
  if (principal?.allowedToolProfiles && !principal.allowedToolProfiles.includes(canonical)) {
    throw new RuntimeError('permission_denied', 'toolMode is outside the current principal scope', {
      requested: canonical,
      allowed: principal.allowedToolProfiles,
      principal: principal.id,
    });
  }
  return canonical;
}

function resolveAuthorizedApproval(
  requested: RuntimeApprovalMode | undefined,
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
): RuntimeApprovalMode {
  const serverCeiling = config.approvalMode ?? 'interactive';
  const ceiling =
    principal?.approvalMode && APPROVAL_MODE_RANK[principal.approvalMode] < APPROVAL_MODE_RANK[serverCeiling]
      ? principal.approvalMode
      : serverCeiling;
  const value = requested ?? ceiling;
  if (principal) assertWithinApprovalScope(value, ceiling, principal);
  else if (APPROVAL_MODE_RANK[value] > APPROVAL_MODE_RANK[ceiling]) {
    throw new RuntimeError('permission_denied', 'approvalMode exceeds the Server ceiling');
  }
  return value;
}

function resolveAuthorizedCapabilities(
  requested: RuntimeDefaultCapabilities | undefined,
  serverCeiling: RuntimeDefaultCapabilities | undefined,
  principal: AuthPrincipal | undefined,
): RuntimeDefaultCapabilities {
  const principalCeiling = principal?.capabilities;
  const allowed: Required<RuntimeDefaultCapabilities> = {
    skills: serverCeiling?.skills !== false && principalCeiling?.skills !== false,
    subAgents: serverCeiling?.subAgents !== false && principalCeiling?.subAgents !== false,
    approval: serverCeiling?.approval !== false && principalCeiling?.approval !== false,
  };
  const value = requested ?? allowed;
  for (const key of ['skills', 'subAgents', 'approval'] as const) {
    if (value[key] === true && allowed[key] === false) {
      throw new RuntimeError('permission_denied', `capability is outside the current principal scope: ${key}`, {
        capability: key,
        principal: principal?.id,
      });
    }
  }
  return {
    skills: value.skills ?? allowed.skills,
    subAgents: value.subAgents ?? allowed.subAgents,
    approval: value.approval ?? allowed.approval,
  };
}

function resolveAuthorizedContributions(
  requested: unknown,
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
): CortxContributionConfig[] {
  const configured = principalContributionConfigs(config.contributions ?? [], principal);
  if (requested === undefined) return configured;
  if (!Array.isArray(requested)) throw new RuntimeError('invalid_request', 'contributions must be an array');
  const globallyAllowed = new Set((config.contributions ?? []).map((entry) => entry.use));
  const principalAllowed = principal?.allowedContributions ? new Set(principal.allowedContributions) : undefined;
  return requested.map((value, index) => {
    if (!isRecord(value) || typeof value.use !== 'string') {
      throw new RuntimeError('invalid_request', `contributions[${index}].use must be canonical`);
    }
    const canonical = parseCortxContributionReference(value.use).canonicalId;
    if (!globallyAllowed.has(canonical) || (principalAllowed && !principalAllowed.has(canonical))) {
      throw new RuntimeError('permission_denied', 'contribution is outside the current principal scope', {
        contribution: canonical,
        principal: principal?.id,
      });
    }
    if (value.options !== undefined && !isRecord(value.options)) {
      throw new RuntimeError('invalid_request', `contributions[${index}].options must be an object`);
    }
    return { use: canonical, options: value.options } as CortxContributionConfig;
  });
}

async function assertSessionAccess(c: Context, config: ServerConfig, session: RuntimeSessionInfo): Promise<void> {
  const principal = getAuthPrincipal(c);
  if (!principal?.isAdmin && (!session.creatorPrincipalId || session.creatorPrincipalId !== principal?.id)) {
    throw new RuntimeError('permission_denied', 'Session access is limited to its creator or an administrator', {
      sessionId: session.id,
      principal: principal?.id,
    });
  }
  await authorizeWorkspace(config, principal, session.workingDirectory);
}

async function getAuthorizedSession(
  runtime: CortxRuntime,
  c: Context,
  config: ServerConfig,
  id: string,
): Promise<RuntimeSessionInfo> {
  let session: RuntimeSessionInfo;
  try {
    session = runtime.getSession(id);
  } catch (error) {
    if (!isRuntimeError(error) || error.kind !== 'session_not_found') throw error;
    await runtime.restoreDurableSessions({ autoResume: false });
    session = runtime.getSession(id);
  }
  await assertSessionAccess(c, config, session);
  return session;
}

async function listAuthorizedSessions(runtime: CortxRuntime, c: Context, config: ServerConfig): Promise<RuntimeSessionInfo[]> {
  await runtime.restoreDurableSessions({ autoResume: false });
  const visible: RuntimeSessionInfo[] = [];
  for (const session of runtime.listSessions()) {
    try {
      await assertSessionAccess(c, config, session);
      visible.push(session);
    } catch (error) {
      if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) continue;
      throw error;
    }
  }
  return visible;
}

function canReadSessionSummary(
  c: Context,
  config: ServerConfig,
  summary: SessionSummaryProjection,
): boolean {
  const principal = getAuthPrincipal(c);
  if (!principal?.isAdmin && (!summary.creatorPrincipalId || summary.creatorPrincipalId !== principal?.id)) {
    return false;
  }
  const workingDirectory = resolve(summary.workingDirectory);
  return getPrincipalAllowedWorkspaceRoots(config, principal).some((root) => {
    const pathFromRoot = relative(resolve(root), workingDirectory);
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
  });
}

async function listAuthorizedAgentSpecs(c: Context, config: ServerConfig): Promise<DiscoveredAgentSpec[]> {
  const principal = getAuthPrincipal(c);
  const discovered = await discoverAgentSpecs({
    roots: getAgentSpecDiscoveryRoots(config, principal),
    installedSkillPackRegistryPath: getSkillPackRegistryPath(config),
    strict: false,
  });
  const visible: DiscoveredAgentSpec[] = [];
  for (const spec of discovered) {
    try {
      await authorizeWorkspace(config, principal, dirname(spec.path));
      if (spec.workingDirectory) await authorizeWorkspace(config, principal, spec.workingDirectory);
      visible.push(spec);
    } catch (error) {
      if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) continue;
      throw error;
    }
  }
  return visible;
}

async function listAuthorizedSkillPacks(c: Context, config: ServerConfig): Promise<InstalledSkillPack[]> {
  const principal = getAuthPrincipal(c);
  const visible: InstalledSkillPack[] = [];
  for (const pack of await listInstalledSkillPacks(getSkillPackRegistryPath(config))) {
    try {
      await authorizeWorkspace(config, principal, pack.sourcePath);
      visible.push(pack);
    } catch (error) {
      if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) continue;
      throw error;
    }
  }
  return visible;
}

async function findAuthorizedAgentSpecSourceRoot(c: Context, config: ServerConfig, specPath: string): Promise<string> {
  const resolvedSpecPath = resolve(specPath);
  for (const spec of await listAuthorizedAgentSpecs(c, config)) {
    if (resolve(spec.path) === resolvedSpecPath) return spec.sourceRoot;
  }
  return resolve(getDefaultWorkingDirectory(config));
}

async function resolveAgentSpecAssetReferences(
  spec: AgentSpec,
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
  sourceRoot: string,
): Promise<AgentSpec> {
  const skillPaths = spec.skillPaths?.map((path) => resolveSourceRootReference(sourceRoot, path));
  const skillPacks = spec.skillPacks?.map((reference) =>
    isPathLikeReference(reference) ? resolveSourceRootReference(sourceRoot, reference) : reference,
  );
  for (const path of skillPaths ?? []) {
    await authorizeWorkspace(config, principal, path);
  }
  for (const reference of skillPacks ?? []) {
    if (isPathLikeReference(reference)) await authorizeWorkspace(config, principal, reference);
  }
  return {
    ...spec,
    skillPaths,
    skillPacks,
  };
}

async function tryAuthorizeDirectory(
  c: Context,
  config: ServerConfig,
  path: string,
): Promise<string | undefined> {
  try {
    const workspace = await authorizeWorkspace(config, getAuthPrincipal(c), path);
    const info = await stat(workspace.workingDirectory);
    if (!info.isDirectory()) return undefined;
    return workspace.workingDirectory;
  } catch (error) {
    if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) {
      return undefined;
    }
    return undefined;
  }
}

async function listWorkspaceDirectories(c: Context, config: ServerConfig): Promise<WorkspaceDirectoryListing> {
  const principal = getAuthPrincipal(c);
  const roots = getPrincipalAllowedWorkspaceRoots(config, principal).map((root) => resolve(root));
  const requested = c.req.query('path');
  const workspace = await authorizeWorkspace(config, principal, requested || roots[0]);
  const current = workspace.workingDirectory;
  let currentInfo: Awaited<ReturnType<typeof stat>>;
  try {
    currentInfo = await stat(current);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError('invalid_workspace', `workspace path is not accessible: ${current}`, { cause: message });
  }
  if (!currentInfo.isDirectory()) {
    throw new RuntimeError('invalid_workspace', `workspace path is not a directory: ${current}`, { requested: current });
  }
  const parentPath = dirname(current);
  const parent = parentPath === current ? undefined : await tryAuthorizeDirectory(c, config, parentPath);
  const children = await readdir(current, { withFileTypes: true });
  const entries: WorkspaceDirectoryEntry[] = [];

  for (const child of children) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const childPath = resolve(current, child.name);
    const authorized = await tryAuthorizeDirectory(c, config, childPath);
    if (authorized) entries.push({ name: child.name, path: authorized });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { roots, current, parent, entries };
}

async function installSkillPackFromBody(c: Context, config: ServerConfig, body: Record<string, unknown>): Promise<InstalledSkillPack> {
  const sourcePath = assertOptionalString(body.path, 'path');
  if (!sourcePath?.trim()) throw new RuntimeError('invalid_request', 'path is required');
  const id = assertOptionalString(body.id, 'id');
  const resolvedPath = resolve(getDefaultWorkingDirectory(config), sourcePath);
  await authorizeWorkspace(config, getAuthPrincipal(c), resolvedPath);
  return installSkillPack({
    registryPath: getSkillPackRegistryPath(config),
    sourcePath: resolvedPath,
    id,
  });
}

async function launchAgentSpecPath(runtime: CortxRuntime, config: ServerConfig, c: Context, path: string) {
  const principal = getAuthPrincipal(c);
  const defaultWorkingDirectory = config.defaultWorkingDirectory ?? process.cwd();
  const specPath = resolve(defaultWorkingDirectory, path);
  await authorizeWorkspace(config, principal, dirname(specPath));
  return launchAgentSpecSafely(async () => {
    const sourceRoot = await findAuthorizedAgentSpecSourceRoot(c, config, specPath);
    const spec = await resolveAgentSpecAssetReferences(await loadAgentSpecFile(specPath), config, principal, sourceRoot);
    const requested = assertOptionalString(spec.workingDirectory, 'AgentSpec.workingDirectory');
    const workspace = await authorizeWorkspace(config, principal, requested);
    const authorizedSpec = applyPrincipalSessionBounds(
      { ...spec, workingDirectory: workspace.workingDirectory },
      config,
      principal,
      await runtime.listToolProfiles(),
    ) as AgentSpec;
    return launchAuthorizedAgentSpec(runtime, authorizedSpec, config, principal);
  });
}

async function launchInlineAgentSpec(runtime: CortxRuntime, config: ServerConfig, c: Context, value: unknown) {
  const principal = getAuthPrincipal(c);
  return launchAgentSpecSafely(async () => {
    const spec = await resolveAgentSpecAssetReferences(
      parseAgentSpec(value),
      config,
      principal,
      resolve(getDefaultWorkingDirectory(config)),
    );
    const workspace = await authorizeWorkspace(config, principal, spec.workingDirectory);
    const authorizedSpec = applyPrincipalSessionBounds(
      { ...spec, workingDirectory: workspace.workingDirectory },
      config,
      principal,
      await runtime.listToolProfiles(),
    ) as AgentSpec;
    return launchAuthorizedAgentSpec(runtime, authorizedSpec, config, principal);
  });
}

async function launchAuthorizedAgentSpec(
  runtime: CortxRuntime,
  spec: AgentSpec,
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
): Promise<RuntimeSessionInfo> {
  const session = await runtime.createSession({
    creatorPrincipalId: principal?.id,
    workingDirectory: spec.workingDirectory,
    model: spec.model,
    system: spec.system,
    tools: spec.tools,
    toolMode: spec.toolMode,
    approvalMode: spec.approvalMode,
    capabilities: spec.capabilities,
    skillPaths: spec.skillPaths,
    skillPacks: spec.skillPacks,
    contributions: resolveAuthorizedContributions(undefined, config, principal),
    metadata: { ...spec.metadata, agentSpec: spec.name ?? 'inline' },
  });
  await runtime.prompt(session.id, spec.prompt);
  return runtime.getSession(session.id);
}

async function launchAgentSpecSafely(fn: () => Promise<Awaited<ReturnType<CortxRuntime['launchAgentSpec']>>>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('AgentSpec.') || error.message.startsWith('AgentSpec '))) {
      throw new RuntimeError('invalid_request', error.message);
    }
    throw error;
  }
}

export function createServerRuntime(config: ServerConfig): ServerRuntimeHandle {
  const app = new Hono();
  const logger = config.logger ?? noopLogger;

  if (config.host === '0.0.0.0') {
    logger.warn('[server] Binding to 0.0.0.0 — server accessible from network. Ensure TLS is configured.');
  }
  const runtime =
    config.runtime?.value ??
    new CortxRuntime({
      maxSessions: config.maxSessions,
      maxEventsPerSession: config.maxEventsPerSession,
      idleTimeoutMs: config.idleTimeoutMs,
      language: config.language,
      model: config.model,
      models: config.models,
      modelCatalog: config.modelCatalog,
      system: config.system,
      maxIterations: config.maxIterations,
      contextWindowTokens: config.contextWindowTokens,
      contextWindowSource: config.contextWindowSource,
      projectDomain: config.projectDomain,
      contributions: config.contributions,
      capabilities: config.capabilities,
      defaultWorkingDirectory: config.defaultWorkingDirectory,
      allowedWorkspaceRoots: getRuntimeAllowedWorkspaceRoots(config),
      toolMode: config.toolMode,
      approvalMode: config.approvalMode ?? 'interactive',
      durableStore: config.durableStore,
      skillPackRegistryPath: getSkillPackRegistryPath(config),
      logger,
    });
  const ownsRuntime = config.runtime?.ownership !== 'borrowed';
  const pluginAdminService = new CortxPluginAdminService({
    projectDomain: config.projectDomain,
    limits: config.pluginSubscriptions,
    authorize: (context, grant) => pluginAdminGrantIsCurrent(context, config, grant),
  });

  app.use('*', async (c, next) => {
    try {
      assertServerRequestSecurity(c, config);
      await next();
    } catch (error) {
      if (isPluginAdminHttpPath(c.req.path)) {
        return pluginAdminErrorResponse(c, pluginAdminHttpAction(c.req.path), error);
      }
      const source = error as { code?: string; message?: string };
      const status = source.code === 'invalid_request' ? 400 : 403;
      return c.json({ error: source.message ?? 'Request transport rejected' }, status);
    }
  });
  app.use(
    '*',
    cors({
      origin: (origin, c) => (isAllowedOrigin(c, config) ? origin : ''),
    }),
  );
  app.use(
    '*',
    createAuthMiddleware(
      { apiKey: config.apiKey, apiKeys: config.apiKeys },
      {
        errorResponse: (c, error, status) => {
          if (isPluginAdminHttpPath(c.req.path)) {
            return pluginAdminErrorResponse(c, pluginAdminHttpAction(c.req.path), error);
          }
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            status as ContentfulStatusCode,
          );
        },
      },
    ),
  );
  mountPluginAdminHttp(app, { service: pluginAdminService, config });

  // Health check
  app.get('/health', (c) => {
    const sessions = runtime.listSessions();
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      sessions: sessions.length,
      runningSessions: sessions.filter((session) => session.isRunning).length,
      maxSessions: config.maxSessions,
    });
  });

  mountEventRoutes(app, {
    runtime,
    authorizeSession: (c, sessionId) => getAuthorizedSession(runtime, c, config, sessionId),
    canReadSummary: (c, summary) => canReadSessionSummary(c, config, summary),
    serializeEvent,
    serializeEnvelope,
    serializeEventData,
    serializeEnvelopeData,
    hydrateHistory: hydrateHistoricalFileEditDetails,
    limits: config.sessionFeeds,
  });
  mountSessionRoutes(app, {
    runtime,
    authorizeSession: (c, sessionId) => getAuthorizedSession(runtime, c, config, sessionId),
    listSessions: (c) => listAuthorizedSessions(runtime, c, config),
    buildCreateRequest: async (c, body) =>
      buildAuthorizedSessionRequest(c, config, body, await runtime.listToolProfiles()),
    buildUpdateRequest: async (c, body) =>
      buildAuthorizedSessionUpdateRequest(c, config, body, await runtime.listToolProfiles()),
    serializeSkill: serializeSkillInfo,
    serializeChild: serializeChildSession,
  });
  mountCatalogRoutes(app, {
    listModels: () => ({ models: listServerModels(config) }),
    launchAgentSpec: async (c, body) => {
      const session = typeof body.path === 'string'
        ? await launchAgentSpecPath(runtime, config, c, body.path)
        : await launchInlineAgentSpec(runtime, config, c, body.spec ?? body);
      return { sessionId: session.id, session };
    },
    listAgentSpecs: async (c) => ({ agentSpecs: await listAuthorizedAgentSpecs(c, config) }),
    listToolProfiles: async (c) => ({
      toolProfiles: filterToolProfilesForPrincipal(await runtime.listToolProfiles(), getAuthPrincipal(c)),
    }),
    listSkillPacks: async (c) => ({ skillPacks: await listAuthorizedSkillPacks(c, config) }),
    installSkillPack: async (c, body) => ({ skillPack: await installSkillPackFromBody(c, config, body) }),
    listWorkspaceDirectories: (c) => listWorkspaceDirectories(c, config),
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    runtime,
    pluginAdminService,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const errors: unknown[] = [];
        try {
          await pluginAdminService.close();
        } catch (error) {
          errors.push(error);
        }
        if (ownsRuntime) {
          try {
            await runtime.close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Cortx Server close failed');
      })();
      return closePromise;
    },
  };
}

export function createServer(config: ServerConfig): Hono {
  return createServerRuntime(config).app;
}
