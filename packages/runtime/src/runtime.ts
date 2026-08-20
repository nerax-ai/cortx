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
  CortxContributionConfig,
  LanguageMessage,
  Logger,
  RuntimeAgentEventEnvelope,
  RuntimeAgentStreamEnvelope,
  RuntimeAgentStreamFrameEnvelope,
  SkillInfo,
  Tool,
} from '@cortx/sdk';
import {
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  createEmptyAgentRuntimeExtensions,
  mergeAgentRuntimeExtensions,
  noopLogger,
  parseCortxContributionReference,
} from '@cortx/sdk';
import { Cortx } from '@cortx/core';
import { RuntimeError, toRuntimeError } from './errors.js';
import { DEFAULT_RUNTIME_CAPABILITIES, type RuntimeDefaultCapabilities } from './default-capabilities.js';
import { createWorkspaceToolPluginEntries, listRuntimeToolProfiles, parseWorkspaceToolMode, resolveRuntimeToolProfile } from './tool-mount.js';
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
import type { SubAgentSession } from './capabilities/sub-agent/session-store.js';
import { loadAgentSpecFile, parseAgentSpec } from './assets/agent-spec.js';
import { resolveSkillPackReferences } from './assets/skill-pack-registry.js';
import {
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  isRuntimeDurableRunStore,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeDurableRunStore,
  type RuntimeSessionSnapshot,
  type RuntimeSubAgentSessionSnapshot,
} from './durable/types.js';
import type {
  ManagedRuntimeSession,
  RuntimeApprovalMode,
  RuntimeFollowUpAdmission,
  RuntimeSessionContextMetadata,
  RuntimeSessionCreateRequest,
  RuntimeSessionInfo,
  RuntimeSessionLocalState,
  RuntimeSessionUpdateRequest,
} from './session.js';
import { CortxHostScope } from './host-scope.js';
import type { ProjectDomain } from './project-domain.js';
import { RuntimeEventJournal } from './event-journal/event-journal.js';

export interface CortxRuntimeOptions {
  language: LanguageClient;
  model: string;
  models?: unknown[];
  modelCatalog?: unknown[];
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  projectDomain?: ProjectDomain;
  contributions?: CortxContributionConfig[];
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

export interface RuntimeCleanupFailureInfo {
  id: string;
  owner: string;
  message: string;
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
  onAgentEvent(event: AgentEvent): void;
}

interface RuntimeCortxHost {
  cortx: Cortx;
  scope: CortxHostScope;
  capabilities: RuntimeDefaultCapabilities;
  contextMetadata: RuntimeSessionContextMetadata;
}

interface RuntimeOfficialExtensions {
  extensions: AgentRuntimeExtensions;
  skillCount: number;
  skillSummaryTokens: number;
}

interface RuntimeSessionHostConfiguration {
  model: string;
  reasoningEffort?: string;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  toolMode: WorkspaceToolMode;
  toolProfile: string;
  approvalMode: RuntimeApprovalMode;
  requestedCapabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  metadata?: import('./session.js').RuntimeSessionMetadata;
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

function normalizeContributionConfigs(value: readonly CortxContributionConfig[]): CortxContributionConfig[] {
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.use !== 'string') {
      throw new RuntimeError('invalid_request', `contributions[${index}].use must be canonical`);
    }
    const use = parseCortxContributionReference(entry.use).canonicalId;
    if (entry.options !== undefined && (!entry.options || typeof entry.options !== 'object' || Array.isArray(entry.options))) {
      throw new RuntimeError('invalid_request', `contributions[${index}].options must be an object`);
    }
    return { use, ...(entry.options === undefined ? {} : { options: structuredClone(entry.options) }) };
  });
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

function isTransientAgentEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'text_delta' | 'thinking_delta' | 'tool_progress' | 'agent_progress' }> {
  return event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'tool_progress' ||
    event.type === 'agent_progress';
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
  readonly runtimeIncarnation = crypto.randomUUID();
  private readonly sessions = new Map<string, ManagedRuntimeSession>();
  private readonly deletedSessionIds = new Set<string>();
  private readonly applicationScope = new CortxHostScope(`runtime:${crypto.randomUUID()}`, 'application');
  private readonly language: LanguageClient;
  private readonly model: string;
  private readonly modelCatalog: unknown[];
  private readonly system?: string;
  private readonly maxIterations?: number;
  private readonly contextWindowTokens?: number;
  private readonly contextWindowSource?: ContextUsageSource;
  private readonly projectDomain?: ProjectDomain;
  private readonly contributions: CortxContributionConfig[];
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
  private readonly eventJournal: RuntimeEventJournal;
  private readonly restoringSessionIds = new Set<string>();
  private readonly skillPackRegistryPath?: string;
  private accepting = true;
  private closePromise?: Promise<void>;
  private readonly cleanupFailures = new Map<string, { retry: () => Promise<void>; info: RuntimeCleanupFailureInfo }>();

  constructor(options: CortxRuntimeOptions) {
    this.language = options.language;
    this.model = options.model;
    this.modelCatalog = [...(options.models ?? []), ...(options.modelCatalog ?? [])];
    this.system = options.system;
    this.maxIterations = options.maxIterations;
    this.contextWindowTokens = parseOptionalPositiveInteger(options.contextWindowTokens, 'contextWindowTokens');
    this.contextWindowSource = options.contextWindowSource;
    this.projectDomain = options.projectDomain;
    this.contributions = options.contributions ?? [];
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
    const runtimeDurableStore = this.runtimeDurableStore();
    runtimeDurableStore?.acquireOwnership?.();
    this.eventJournal = new RuntimeEventJournal(runtimeDurableStore, {
      onFailure: (sessionId, error) => this.markDurabilityFailure(sessionId, error),
      onRetention: (sessionId, retention) => {
        const session = this.sessions.get(sessionId);
        if (session) session.eventRetention = retention;
      },
    });
    this.skillPackRegistryPath = options.skillPackRegistryPath;
  }

  async createSession(request: RuntimeSessionCreateRequest = {}): Promise<RuntimeSessionInfo> {
    if (!this.accepting) throw new RuntimeError('invalid_request', 'Runtime is closing');
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
    const toolProfile = (await resolveRuntimeToolProfile(toolMode, this.projectDomain)).use;
    const approvalMode = parseApprovalMode(request.approvalMode, this.approvalMode);
    const requestedCapabilities = request.capabilities ?? this.capabilities;
    const { skillPaths, skillPacks } = await this.resolveRequestedSkillMounts(request);
    const system = request.system ?? this.system;
    const agentSessions = new SubAgentSessionStore();
    const scope = this.applicationScope.child(`session:${id}`, 'session');
    const contributions = normalizeContributionConfigs(request.contributions ?? this.contributions);
    let session: ManagedRuntimeSession;
    let host: RuntimeCortxHost;
    try {
      host = await this.createCortxHost({
        id,
        workingDirectory: workspace.workingDirectory,
        model,
        reasoningEffort,
        system,
        maxIterations,
        contextWindowTokens,
        contextWindowSource,
        toolMode,
        toolProfile,
        approvalMode,
        requestedCapabilities,
        skillPaths,
        requestTools: request.tools ?? [],
        contributions,
        scope,
        mountProjectContributions: false,
        getRunScope: () => session?.runScope,
        agentSessions,
        onAgentEvent: (event) => this.broadcast(session, event),
      });
    } catch (error) {
      await scope.close(error).catch(() => undefined);
      throw error;
    }

    const now = Date.now();
    session = {
      id,
      creatorPrincipalId: request.creatorPrincipalId,
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
      toolProfile,
      approvalMode,
      requestedCapabilities,
      capabilities: host.capabilities,
      skillPaths,
      skillPacks,
      promptHistory: [],
      requestTools: request.tools ?? [],
      contributions,
      scope: host.scope,
      events: [],
      eventEnvelopes: [],
      usage: undefined,
      subscribers: new Set(),
      envelopeSubscribers: new Set(),
      streamSubscribers: new Set(),
      idleTimer: undefined,
      isRunning: false,
      runPhase: 'idle',
      sessionHealth: 'healthy',
      pendingInteraction: undefined,
      resumable: false,
      followUpAdmissions: new Map(),
      runPromise: undefined,
      runId: 0,
      nextEventSequence: 0,
      streamOffset: 0,
      eventRetention: { oldestAvailableSequence: null, lastAvailableSequence: 0 },
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
    await this.eventJournal.drainAll();

    const restored: RuntimeSessionInfo[] = [];
    for (const snapshot of await store.listRuntimeSessions()) {
      if (this.sessions.has(snapshot.id)) continue;
      if (this.deletedSessionIds.has(snapshot.id)) continue;
      this.restoringSessionIds.add(snapshot.id);
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
          contributions: snapshot.contributions,
          creatorPrincipalId: snapshot.creatorPrincipalId,
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
        session.streamOffset = 0;
        session.eventRetention = snapshot.eventRetention;
        session.promptHistory = snapshot.promptHistory?.slice(-100) ?? [];
        session.followUpAdmissions = new Map(
          snapshot.queuedInputs.map((input) => [
            input.inputId,
            input.state === 'queued' ? { ...input, state: 'interrupted' } : { ...input },
          ]),
        );
        session.agentSessions.hydrate(await store.listSubAgentSessions(snapshot.id));
        const eventSnapshots = store.listEventEnvelopes ? await store.listEventEnvelopes(snapshot.id) : [];
        session.usage = this.aggregateUsageFromEventSnapshots(session, eventSnapshots) ?? snapshot.usage;
        const unfinished =
          snapshot.runPhase !== 'idle' ||
          snapshot.pendingInteraction !== undefined ||
          snapshot.queuedInputs.some((input) => input.state === 'queued');
        this.restoreSessionEventHistory(session, eventSnapshots, unfinished || Boolean(resumableCheckpoint), Boolean(resumableCheckpoint));
        session.sessionHealth = snapshot.sessionHealth;
        if (unfinished || resumableCheckpoint) {
          session.isRunning = false;
          session.runPhase = 'interrupted';
          session.resumable = Boolean(resumableCheckpoint);
          session.pendingInteraction = undefined;
        }
        this.restoringSessionIds.delete(snapshot.id);
        const lastDurableSequence = eventSnapshots.at(-1)?.sequence ?? 0;
        const restoredTerminalEnvelope = session.eventEnvelopes.at(-1);
        await this.persistRuntimeSession(
          session,
          restoredTerminalEnvelope && restoredTerminalEnvelope.sequence > lastDurableSequence
            ? restoredTerminalEnvelope
            : undefined,
        );
        restored.push(this.info(session));

        if (options.autoResume && resumableCheckpoint && session.sessionHealth !== 'durability_failed') {
          await this.resume(session.id);
        }
      } catch (error) {
        this.logger.warn(
          `Failed to restore runtime session "${snapshot.id}": ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.restoringSessionIds.delete(snapshot.id);
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
    this.assertSessionMutable(session);
    this.assertSessionIdle(session);
    const model = normalizeModelId(request.model, session.model);
    const modelChanged = model !== session.model;
    const reasoningEffort =
      'reasoningEffort' in request ? normalizeReasoningEffort(request.reasoningEffort) : session.reasoningEffort;
    const toolMode = parseWorkspaceToolMode(request.toolMode, session.toolMode);
    const toolProfile = (await resolveRuntimeToolProfile(toolMode, this.projectDomain)).use;
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

    const configuration: RuntimeSessionHostConfiguration = {
      model,
      reasoningEffort,
      contextWindowTokens,
      contextWindowSource,
      toolMode,
      toolProfile,
      approvalMode,
      requestedCapabilities,
      skillPaths,
      skillPacks,
      metadata: request.metadata ?? session.metadata,
    };
    const candidate = await this.createSessionCandidate(session, configuration);
    if (session.runPhase !== 'idle') {
      await this.closeScope(candidate.scope, `discarded busy session candidate:${session.id}`);
      this.assertSessionIdle(session);
    }
    session.lastActivityAt = Date.now();
    await this.cutoverSessionHost(session, candidate, configuration);
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
    return listRuntimeToolProfiles(this.projectDomain);
  }

  getLocalState(sessionId: string): RuntimeSessionLocalState {
    const session = this.requireSession(sessionId);
    return {
      agentSessions: session.agentSessions,
      getMessages: () => session.cortx.messages,
      replaceMessages: (messages: LanguageMessage[]) => session.cortx.replaceMessages(messages),
    };
  }

  listChildSessions(sessionId: string): SubAgentSession[] {
    return [...this.requireSession(sessionId).agentSessions.getAll().values()];
  }

  getChildSession(sessionId: string, toolCallId: string): SubAgentSession {
    const child = this.requireSession(sessionId).agentSessions.get(toolCallId);
    if (!child) throw new RuntimeError('session_not_found', 'Child session not found', { sessionId, toolCallId });
    return child;
  }

  abortChild(sessionId: string, toolCallId: string, reason = 'Child aborted by runtime'): Promise<SubAgentSession> {
    return this.requireSession(sessionId).agentSessions.abort(toolCallId, reason);
  }

  waitForChild(sessionId: string, toolCallId: string, timeoutMs?: number): Promise<SubAgentSession> {
    return this.requireSession(sessionId).agentSessions.wait(toolCallId, timeoutMs);
  }

  listCleanupFailures(): RuntimeCleanupFailureInfo[] {
    return [...this.cleanupFailures.values()].map((entry) => entry.info);
  }

  async retryCleanup(id: string): Promise<void> {
    const failure = this.cleanupFailures.get(id);
    if (!failure) throw new RuntimeError('invalid_request', 'Cleanup operation not found', { id });
    await failure.retry();
    this.cleanupFailures.delete(id);
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    await this.startRun(session, () => session.cortx.run(message), () => {
      session.promptHistory = appendPromptHistory(session.promptHistory, message);
      this.broadcast(session, { type: 'user_message', message, source: 'prompt' });
    });
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    await this.startRun(session, () => session.cortx.continue());
  }

  steer(sessionId: string, message: string): void {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    session.lastActivityAt = Date.now();
    session.cortx.controller.steer(message);
    this.resetIdleTimer(session);
  }

  followUp(sessionId: string, message: string, inputId = crypto.randomUUID()): RuntimeFollowUpAdmission {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    if (session.runPhase !== 'running' && session.runPhase !== 'waiting_user' && session.runPhase !== 'waiting_approval') {
      throw new RuntimeError('invalid_request', 'Follow-up requires a running session', {
        sessionId,
        runPhase: session.runPhase,
      });
    }
    const existing = session.followUpAdmissions.get(inputId);
    if (existing) {
      if (existing.message !== message) {
        throw new RuntimeError('invalid_request', 'Follow-up input id was already used with a different payload', {
          sessionId,
          inputId,
        });
      }
      return { ...existing };
    }
    if (session.followUpAdmissions.size >= 256) {
      const delivered = [...session.followUpAdmissions.entries()].find(([, input]) => input.state === 'delivered');
      if (delivered) session.followUpAdmissions.delete(delivered[0]);
      else {
        throw new RuntimeError('capacity_exceeded', 'Maximum queued follow-ups reached', {
          sessionId,
          maxQueuedInputs: 256,
        });
      }
    }
    session.lastActivityAt = Date.now();
    session.promptHistory = appendPromptHistory(session.promptHistory, message);
    const admission: RuntimeFollowUpAdmission = {
      inputId,
      message,
      acceptedAt: session.lastActivityAt,
      admissionSequence: session.nextEventSequence + 1,
      state: 'queued',
    };
    session.followUpAdmissions.set(inputId, admission);
    this.broadcast(session, { type: 'user_message', message, source: 'follow_up' });
    session.cortx.controller.followUp(message);
    this.resetIdleTimer(session);
    return { ...admission };
  }

  answer(sessionId: string, toolCallId: string, response: string): boolean {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    const answered = session.cortx.controller.answerUser(toolCallId, response);
    if (!answered) return false;
    if (session.pendingInteraction?.requestId === toolCallId) session.pendingInteraction = undefined;
    if (session.runPhase === 'waiting_user' || session.runPhase === 'waiting_approval') session.runPhase = 'running';
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

  subscribeStream(
    sessionId: string,
    callback: (event: RuntimeAgentStreamEnvelope) => void,
    options: SubscribeEnvelopeOptions = {},
  ): () => void {
    const session = this.requireSession(sessionId);
    if (options.replay ?? true) {
      for (const event of [...session.eventEnvelopes]) this.safeNotify(() => callback(event));
    }
    session.streamSubscribers.add(callback);
    return () => session.streamSubscribers.delete(callback);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      for (const session of [...this.sessions.values()]) {
        try {
          await this.destroy(session);
        } catch (error) {
          errors.push(error);
        }
      }
      await this.eventJournal.drainAll();
      try {
        await this.applicationScope.close(new Error('Runtime closed'));
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.runtimeDurableStore()?.releaseOwnership?.();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Cortx Runtime close failed');
    })();
    return this.closePromise;
  }

  private async startRun(
    session: ManagedRuntimeSession,
    createGenerator: () => AsyncGenerator<AgentEvent>,
    onStarted?: () => void,
  ): Promise<void> {
    this.assertSessionMutable(session);
    if (session.runPhase !== 'idle' && session.runPhase !== 'interrupted') {
      throw new RuntimeError('session_busy', 'Agent is already running', { runPhase: session.runPhase });
    }
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
    const runId = ++session.runId;
    session.streamOffset = 0;
    const runScope = session.scope.child(`run:${session.id}:${runId}`, 'run');
    session.runScope = runScope;
    try {
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
        toolProfile: session.toolProfile,
        approvalMode: session.approvalMode,
        requestedCapabilities: session.requestedCapabilities,
        skillPaths: session.skillPaths,
        requestTools: session.requestTools,
        contributions: session.contributions,
        scope: session.scope,
        projectScope: runScope,
        mountProjectContributions: true,
        runId,
        getRunScope: () => session.runScope,
        agentSessions: session.agentSessions,
        onAgentEvent: (event) => this.broadcast(session, event),
      });
      host.cortx.replaceMessages(session.cortx.messages);
      session.cortx = host.cortx;
      session.capabilities = host.capabilities;
      session.contextMetadata = host.contextMetadata;
    } catch (error) {
      if (session.runScope === runScope) session.runScope = undefined;
      await this.closeScope(runScope, `failed run host:${session.id}:${runId}`);
      throw error;
    }
    session.isRunning = true;
    session.runPhase = 'running';
    session.sessionHealth = 'healthy';
    session.pendingInteraction = undefined;
    session.resumable = false;
    for (const [inputId, input] of session.followUpAdmissions) {
      if (input.state !== 'delivered') session.followUpAdmissions.delete(inputId);
    }
    session.cortx.setRunId(runId);
    onStarted?.();
    try {
      await this.persistRuntimeSession(session);
    } catch (error) {
      session.isRunning = false;
      session.runPhase = 'interrupted';
      if (session.runScope === runScope) session.runScope = undefined;
      await this.closeScope(runScope, `failed durable run admission:${session.id}:${runId}`);
      throw new RuntimeError('runtime_failure', `Failed to persist run admission for session "${session.id}"`, {
        sessionId: session.id,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!this.sessions.has(session.id) || this.deletedSessionIds.has(session.id)) {
      session.isRunning = false;
      session.runPhase = 'idle';
      if (session.runScope === runScope) session.runScope = undefined;
      await this.closeScope(runScope, `cancelled deleted run admission:${session.id}:${runId}`);
      throw new RuntimeError('session_not_found', 'Session was deleted while the run admission was being persisted', {
        sessionId: session.id,
      });
    }

    const runPromise = this.consumeRun(session, runId, runScope, createGenerator);
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

  private currentHostConfiguration(session: ManagedRuntimeSession): RuntimeSessionHostConfiguration {
    return {
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      contextWindowTokens: session.contextWindowTokens,
      contextWindowSource: session.contextWindowSource,
      toolMode: session.toolMode,
      toolProfile: session.toolProfile,
      approvalMode: session.approvalMode,
      requestedCapabilities: session.requestedCapabilities,
      skillPaths: session.skillPaths,
      skillPacks: session.skillPacks,
      metadata: session.metadata,
    };
  }

  private async createSessionCandidate(
    session: ManagedRuntimeSession,
    configuration: RuntimeSessionHostConfiguration,
  ): Promise<RuntimeCortxHost> {
    const scope = this.applicationScope.child(`session:${session.id}:candidate:${crypto.randomUUID()}`, 'session');
    try {
      return await this.createCortxHost({
      id: session.id,
      workingDirectory: session.workingDirectory,
      model: configuration.model,
      reasoningEffort: configuration.reasoningEffort,
      system: session.system,
      maxIterations: session.maxIterations,
      contextWindowTokens: configuration.contextWindowTokens,
      contextWindowSource: configuration.contextWindowSource,
      toolMode: configuration.toolMode,
      toolProfile: configuration.toolProfile,
      approvalMode: configuration.approvalMode,
      requestedCapabilities: configuration.requestedCapabilities,
      skillPaths: configuration.skillPaths,
      requestTools: session.requestTools,
      contributions: session.contributions,
      scope,
      mountProjectContributions: false,
      getRunScope: () => session.runScope,
      agentSessions: session.agentSessions,
      onAgentEvent: (event) => this.broadcast(session, event),
      });
    } catch (error) {
      await scope.close(error).catch(() => undefined);
      throw error;
    }
  }

  private async cutoverSessionHost(
    session: ManagedRuntimeSession,
    host: RuntimeCortxHost,
    configuration: RuntimeSessionHostConfiguration,
  ): Promise<void> {
    host.cortx.replaceMessages(session.cortx.messages);
    const previousScope = session.scope;
    session.cortx = host.cortx;
    session.scope = host.scope;
    session.model = configuration.model;
    session.reasoningEffort = configuration.reasoningEffort;
    session.contextWindowTokens = configuration.contextWindowTokens;
    session.contextWindowSource = configuration.contextWindowSource;
    session.toolMode = configuration.toolMode;
    session.toolProfile = configuration.toolProfile;
    session.approvalMode = configuration.approvalMode;
    session.requestedCapabilities = configuration.requestedCapabilities;
    session.skillPaths = configuration.skillPaths;
    session.skillPacks = configuration.skillPacks;
    session.metadata = configuration.metadata;
    session.capabilities = host.capabilities;
    session.contextMetadata = host.contextMetadata;
    await this.closeScope(previousScope, `replaced session host:${session.id}`);
  }

  private async closeScope(scope: CortxHostScope, owner: string): Promise<void> {
    try {
      await scope.close(new Error(owner));
    } catch (error) {
      this.recordCleanupFailure(owner, error, () => scope.retryFailedCleanup());
    }
  }

  private recordCleanupFailure(owner: string, error: unknown, retry: () => Promise<void>): void {
    const id = `cleanup:${crypto.randomUUID()}`;
    this.cleanupFailures.set(id, {
      retry,
      info: { id, owner, message: error instanceof Error ? error.message : String(error) },
    });
  }

  private async consumeRun(
    session: ManagedRuntimeSession,
    runId: number,
    runScope: CortxHostScope,
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
      await this.closeScope(runScope, `settled run:${session.id}:${runId}`);
      if (session.runScope === runScope) session.runScope = undefined;
      if (session.runId === runId) {
        session.isRunning = false;
        session.runPhase = 'idle';
        session.pendingInteraction = undefined;
        session.resumable = false;
        for (const [inputId, input] of session.followUpAdmissions) {
          if (input.state === 'queued') session.followUpAdmissions.set(inputId, { ...input, state: 'interrupted' });
        }
      }
      if (session.runPromise && session.runId === runId) session.runPromise = undefined;
      void this.persistRuntimeSession(session).catch(() => undefined);
    }
  }

  private broadcast(session: ManagedRuntimeSession, event: AgentEvent): void {
    if (!this.sessions.has(session.id)) return;
    session.lastActivityAt = Date.now();
    const enrichedEvent = this.enrichEvent(session, event);
    this.applyEventProjection(session, enrichedEvent);
    if (isTransientAgentEvent(enrichedEvent)) {
      const frame: RuntimeAgentStreamFrameEnvelope = {
        kind: 'frame',
        offset: ++session.streamOffset,
        timestamp: session.lastActivityAt,
        sessionId: session.id,
        runId: session.runId,
        runtimeIncarnation: this.runtimeIncarnation,
        event: enrichedEvent,
      };
      for (const subscriber of session.subscribers) {
        this.safeNotify(() => subscriber(enrichedEvent));
      }
      for (const subscriber of session.streamSubscribers) {
        this.safeNotify(() => subscriber(frame));
      }
      if (enrichedEvent.type === 'agent_progress') {
        const subAgent = session.agentSessions.snapshot(enrichedEvent.toolCallId);
        if (subAgent) void this.persistRuntimeSession(session, undefined, subAgent).catch(() => undefined);
      }
      return;
    }
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
    session.eventRetention = {
      oldestAvailableSequence: session.eventRetention.oldestAvailableSequence ?? envelope.sequence,
      lastAvailableSequence: envelope.sequence,
    };
    const subAgentSnapshot =
      enrichedEvent.type === 'agent_started' ||
      enrichedEvent.type === 'agent_completed'
        ? session.agentSessions.snapshot(enrichedEvent.toolCallId)
        : undefined;
    void this.persistRuntimeSession(session, envelope, subAgentSnapshot).catch(() => undefined);
    for (const subscriber of session.subscribers) {
      this.safeNotify(() => subscriber(enrichedEvent));
    }
    for (const subscriber of session.envelopeSubscribers) {
      this.safeNotify(() => subscriber(envelope));
    }
    for (const subscriber of session.streamSubscribers) {
      this.safeNotify(() => subscriber(envelope));
    }
  }

  private applyEventProjection(session: ManagedRuntimeSession, event: AgentEvent): void {
    if (event.type === 'user_request') {
      session.pendingInteraction = {
        requestId: event.request.requestId,
        kind: event.request.kind === 'tool_approval' ? 'approval' : 'question',
        prompt: event.request.prompt,
        context: event.request.context,
        allowedResponses: event.request.allowedResponses,
        runId: session.runId,
        runtimeIncarnation: this.runtimeIncarnation,
        createdAt: session.lastActivityAt,
      };
      session.runPhase = event.request.kind === 'tool_approval' ? 'waiting_approval' : 'waiting_user';
      return;
    }
    if (event.type === 'user_question') {
      const existing = session.pendingInteraction;
      if (existing?.requestId !== event.toolCallId) {
        session.pendingInteraction = {
          requestId: event.toolCallId,
          kind: 'question',
          prompt: event.question,
          runId: session.runId,
          runtimeIncarnation: this.runtimeIncarnation,
          createdAt: session.lastActivityAt,
        };
        session.runPhase = 'waiting_user';
      }
      return;
    }
    if (event.type === 'user_answer') {
      if (session.pendingInteraction?.requestId === event.toolCallId) session.pendingInteraction = undefined;
      if (session.isRunning) session.runPhase = 'running';
      return;
    }
    if (event.type === 'follow_up') {
      const queued = [...session.followUpAdmissions.entries()].find(([, input]) =>
        input.state === 'queued' && input.message === event.message,
      );
      if (queued) session.followUpAdmissions.set(queued[0], { ...queued[1], state: 'delivered' });
      return;
    }
    if (event.type === 'error') {
      session.sessionHealth = event.code === 'user_abort' ? 'healthy' : 'run_failed';
      session.pendingInteraction = undefined;
      return;
    }
    if (event.type === 'done') session.pendingInteraction = undefined;
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
      void this.destroy(session).catch((error) => {
        this.recordCleanupFailure(`idle session destroy:${session.id}`, error, () => this.destroy(session));
      });
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
    session.runPhase = 'aborting';
    session.pendingInteraction = undefined;
    session.resumable = false;
    for (const [inputId, input] of session.followUpAdmissions) {
      if (input.state !== 'delivered') session.followUpAdmissions.delete(inputId);
    }
    session.cortx.abort(abortReason);
    const childShutdown = session.agentSessions.abortRunning(pendingQuestionReason);
    session.cortx.controller.rejectPendingQuestions(pendingQuestionReason);
    session.runId++;
    session.lastActivityAt = Date.now();
    void this.persistRuntimeSession(session).catch(() => undefined);

    if (previousRun) {
      try {
        await previousRun;
      } catch {
        /* consumeRun already normalizes stream errors */
      }
    }
    await childShutdown;
    if (!this.sessions.has(session.id)) return;
    if (session.runPromise === previousRun) session.runPromise = undefined;
    session.isRunning = false;
    session.runPhase = 'idle';
    await this.persistRuntimeSession(session).catch(() => undefined);
  }

  private async destroy(session: ManagedRuntimeSession, options: { deleteDurable?: boolean } = {}): Promise<void> {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (options.deleteDurable) this.deletedSessionIds.add(session.id);
    await this.abortSession(session, 'Session cleaned up', 'Session destroyed');
    await this.closeScope(session.scope, `destroyed session:${session.id}`);
    session.subscribers.clear();
    session.envelopeSubscribers.clear();
    session.isRunning = false;
    session.runPhase = 'idle';
    session.pendingInteraction = undefined;
    this.sessions.delete(session.id);
    if (options.deleteDurable) {
      await this.eventJournal.delete(session.id);
    } else {
      await this.persistRuntimeSession(session).catch(() => undefined);
    }
  }

  private requireSession(sessionId: string): ManagedRuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RuntimeError('session_not_found', 'Session not found', { sessionId });
    return session;
  }

  private assertSessionIdle(session: ManagedRuntimeSession): void {
    if (session.runPhase === 'idle') return;
    throw new RuntimeError('session_busy', 'Session configuration can only change while idle', {
      sessionId: session.id,
      runPhase: session.runPhase,
    });
  }

  private assertSessionMutable(session: ManagedRuntimeSession): void {
    if (session.sessionHealth !== 'durability_failed') return;
    throw new RuntimeError('runtime_failure', 'Session durability failed; delete the session before creating new work', {
      sessionId: session.id,
      sessionHealth: session.sessionHealth,
      cause: this.eventJournal.failure(session.id)?.message,
    });
  }

  private info(
    session: ManagedRuntimeSession,
    configuration: RuntimeSessionHostConfiguration = this.currentHostConfiguration(session),
  ): RuntimeSessionInfo {
    return {
      id: session.id,
      creatorPrincipalId: session.creatorPrincipalId,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      workingDirectory: session.workingDirectory,
      model: configuration.model,
      reasoningEffort: configuration.reasoningEffort,
      system: session.system,
      maxIterations: session.maxIterations,
      contextWindowTokens: configuration.contextWindowTokens,
      contextWindowSource: configuration.contextWindowSource,
      toolMode: configuration.toolMode,
      toolProfile: configuration.toolProfile,
      approvalMode: configuration.approvalMode,
      capabilities: configuration.approvalMode === 'full-access'
        ? { ...configuration.requestedCapabilities, approval: false }
        : configuration.requestedCapabilities,
      skillPaths: configuration.skillPaths,
      skillPacks: configuration.skillPacks,
      promptHistory: session.promptHistory,
      usage: session.usage,
      runtimeIncarnation: this.runtimeIncarnation,
      projectionAsOfSequence: session.nextEventSequence,
      eventRetention: { ...session.eventRetention },
      runPhase: session.runPhase,
      sessionHealth: session.sessionHealth,
      resumable: session.resumable,
      acceptsPrompt: session.runPhase === 'idle' && session.sessionHealth !== 'durability_failed',
      pendingInteraction: session.pendingInteraction ? structuredClone(session.pendingInteraction) : null,
      queuedInputs: [...session.followUpAdmissions.values()]
        .filter((input) => input.state !== 'delivered')
        .map((input) => ({ ...input })),
      isRunning: session.isRunning,
      eventCount: session.events.length,
      metadata: configuration.metadata,
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
      creatorPrincipalId: session.creatorPrincipalId,
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
      toolProfile: session.toolProfile,
      approvalMode: session.approvalMode,
      capabilities: session.requestedCapabilities,
      skillPaths: session.skillPaths,
      skillPacks: session.skillPacks,
      promptHistory: session.promptHistory,
      requestTools: session.requestTools,
      contributions: normalizeContributionConfigs(session.contributions),
      usage: session.usage,
      runId: session.runId,
      nextEventSequence: session.nextEventSequence,
      runtimeIncarnation: this.runtimeIncarnation,
      runPhase: session.runPhase,
      sessionHealth: session.sessionHealth,
      resumable: session.resumable,
      pendingInteraction: session.pendingInteraction ? structuredClone(session.pendingInteraction) : undefined,
      queuedInputs: [...session.followUpAdmissions.values()].map((input) => ({ ...input })),
      eventRetention: { ...session.eventRetention },
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
    interrupted: boolean,
    resumable: boolean,
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
    if (interrupted && !isTerminalEvent(session.eventEnvelopes.at(-1)?.event)) {
      const sequence = Math.max(session.nextEventSequence, session.eventEnvelopes.at(-1)?.sequence ?? 0) + 1;
      session.eventEnvelopes.push({
        sequence,
        timestamp: Date.now(),
        sessionId: session.id,
        runId: session.runId,
        event: {
          type: 'error',
          code: 'client_error',
          error: new Error(
            resumable
              ? 'Previous run was interrupted. Use resume to continue from the last checkpoint, or send a new prompt to start a new turn.'
              : 'Previous run was interrupted and cannot be resumed. Send a new prompt to start a new turn.',
          ),
        },
      });
    }
    if (session.eventEnvelopes.length > this.maxEventsPerSession) {
      session.eventEnvelopes.splice(0, session.eventEnvelopes.length - this.maxEventsPerSession);
    }
    session.events = session.eventEnvelopes.map((envelope) => envelope.event);
    const lastSequence = session.eventEnvelopes.at(-1)?.sequence ?? 0;
    session.nextEventSequence = Math.max(session.nextEventSequence, lastSequence);
    session.eventRetention = {
      oldestAvailableSequence: snapshots[0]?.sequence ?? session.eventRetention.oldestAvailableSequence,
      lastAvailableSequence: lastSequence,
    };
  }

  private eventEnvelopeSnapshot(envelope: RuntimeAgentEventEnvelope): RuntimeEventEnvelopeSnapshot {
    return {
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      ...envelope,
    };
  }

  private persistRuntimeSession(
    session: ManagedRuntimeSession,
    envelope?: RuntimeAgentEventEnvelope,
    subAgent?: RuntimeSubAgentSessionSnapshot,
  ): Promise<void> {
    if (!this.runtimeDurableStore()) return Promise.resolve();
    if (this.deletedSessionIds.has(session.id) || this.restoringSessionIds.has(session.id)) return Promise.resolve();
    return this.eventJournal.commit({
      snapshot: this.sessionSnapshot(session),
      envelope: envelope ? this.eventEnvelopeSnapshot(envelope) : undefined,
      subAgent,
    });
  }

  private markDurabilityFailure(sessionId: string, error: Error): void {
    const session = this.sessions.get(sessionId);
    if (session) session.sessionHealth = 'durability_failed';
    this.logger.warn(`Durability failed for runtime session "${sessionId}": ${error.message}`);
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
    const mountProjectContributions = input.mountProjectContributions ?? true;
    const toolProfilePluginEntries = mountProjectContributions
      ? await createWorkspaceToolPluginEntries(input.workingDirectory, input.toolProfile, this.projectDomain)
      : [];
    const contributionEntries = [...toolProfilePluginEntries, ...input.contributions];
    const officialExtensions = await this.createOfficialExtensions({
      workingDirectory: input.workingDirectory,
      capabilities,
      skillPaths: input.skillPaths,
      needsToolApproval: (tool) => (tool ? toolApprovalRequirements.get(tool) ?? workspaceToolNeedsApproval(tool) : true),
    });
    const projectScope = input.projectScope ?? input.scope;
    const projectExtensions = this.projectDomain && mountProjectContributions
      ? await this.projectDomain.createAgentExtensions(contributionEntries, projectScope, {
          instanceId: input.id,
          sessionId: input.id,
          runId: input.runId,
          workingDirectory: input.workingDirectory,
        })
      : createEmptyAgentRuntimeExtensions();
    if (mountProjectContributions && !this.projectDomain && contributionEntries.length > 0) {
      throw new RuntimeError('invalid_request', 'Project contributions require a ProjectDomain');
    }
    const extensions = mergeAgentRuntimeExtensions(officialExtensions.extensions, projectExtensions);

    if (capabilities.subAgents !== false) {
      const subAgentTool = createSubAgentTool({
        language: this.language,
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
            const childProjectExtensions = this.projectDomain
              ? await this.projectDomain.createAgentExtensions(contributionEntries, scope, {
                  instanceId: `${input.id}:${toolCallId}`,
                  sessionId: input.id,
                  runId,
                  workingDirectory: input.workingDirectory,
                })
              : createEmptyAgentRuntimeExtensions();
            return {
              extensions: mergeAgentRuntimeExtensions(officialExtensions.extensions, childProjectExtensions),
              signal: scope.signal,
              close: (reason?: unknown) => this.closeScope(scope, `settled child:${input.id}:${toolCallId}:${String(reason ?? '')}`),
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

    const cortx = new Cortx(this.language, {
      model: input.model,
      reasoning: input.reasoningEffort ? { enabled: true, effort: input.reasoningEffort } : undefined,
      system: input.system,
      maxIterations: input.maxIterations,
      tools: mountedTools,
      extensions,
      workingDirectory: input.workingDirectory,
      sessionId: input.id,
      durableStore: this.durableStore,
      askUser: input.approvalMode === 'deny' ? async () => 'no' : undefined,
      logger: this.logger,
    });
    cortx.onAgentEvent = input.onAgentEvent;
    const abortCortx = () => cortx.abort('Cortx Host scope was revoked');
    if (projectScope.signal.aborted) abortCortx();
    else {
      projectScope.signal.addEventListener('abort', abortCortx, { once: true });
      projectScope.defer(() => projectScope.signal.removeEventListener('abort', abortCortx), 'cortx-controller-abort');
    }
    return { cortx, scope: input.scope, capabilities, contextMetadata };
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
