import type { LanguageClient } from '@synax-ai/core';
import { createHash } from 'node:crypto';
import type {
  AgentDurableRunStore,
  AgentEvent,
  AgentRunCheckpoint,
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
  noopLogger,
  parseCortxContributionReference,
} from '@cortx/sdk';
import { RuntimeError } from './errors.js';
import { DEFAULT_RUNTIME_CAPABILITIES, type RuntimeDefaultCapabilities } from './default-capabilities.js';
import { listRuntimeToolProfiles, parseWorkspaceToolMode, resolveRuntimeToolProfile } from './tool-mount.js';
import type { WorkspaceToolMode } from './workspace-tool-mode.js';
import { resolveWorkspace } from './workspace.js';
import {
  SubAgentSessionStore,
  discoverSkills,
} from './capabilities/index.js';
import type { SubAgentSession } from './capabilities/sub-agent/session-store.js';
import { loadAgentSpecFile, parseAgentSpec } from './assets/agent-spec.js';
import { resolveSkillPackReferences } from './assets/skill-pack-registry.js';
import {
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  isRuntimeDurableRunStore,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeDurableRunStore,
  type RuntimeSubAgentSessionSnapshot,
} from './durable/types.js';
import type {
  ManagedRuntimeSession,
  RuntimeApprovalMode,
  RuntimeCommandOptions,
  RuntimeFollowUpAdmission,
  RuntimeSessionCreateRequest,
  RuntimeSessionInfo,
  RuntimeSessionLocalState,
  RuntimeSessionUpdateRequest,
} from './session.js';
import { CortxHostScope } from './host-scope.js';
import type { ProjectDomain } from './project-domain.js';
import { RuntimeEventJournal } from './event-journal/event-journal.js';
import { RuntimeSessionRegistry } from './sessions/session-registry.js';
import type {
  SessionSummaryBaseline,
  SessionSummaryChange,
} from './sessions/session-registry.js';
import { RuntimeInputSource } from './sessions/runtime-input-source.js';
import { RuntimeCommandLedger } from './sessions/runtime-command-ledger.js';
import { SessionCommandQueue } from './runs/session-command-queue.js';
import { RuntimeRunCoordinator } from './runs/runtime-run-coordinator.js';
import {
  RuntimeHostFactory,
  type RuntimeHost,
} from './host/runtime-host-factory.js';
import {
  addRuntimeSessionUsage,
  aggregateRuntimeSessionUsage,
  applyRuntimeSessionEventProjection,
  enrichRuntimeSessionEvent,
  projectRuntimeSession,
  snapshotRuntimeSession,
} from './sessions/session-projector.js';

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

interface InFlightRuntimeCommand {
  kind: string;
  payloadHash: string;
  promise: Promise<unknown>;
}

interface RuntimeCommandContext {
  commandId: string;
  kind: string;
  payloadHash: string;
  expectedRuntimeIncarnation?: string;
}

const MAX_IN_FLIGHT_RUNTIME_COMMANDS = 1_024;

function createSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

function commandPayloadHash(kind: string, payload: unknown): string {
  return createHash('sha256').update(stableJson({ kind, payload })).digest('hex');
}

function normalizeCommandId(commandId: string | undefined): string | undefined {
  if (commandId === undefined) return undefined;
  if (!commandId.trim() || commandId.length > 256) {
    throw new RuntimeError('invalid_request', 'commandId must be a non-empty string of at most 256 characters');
  }
  return commandId;
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
  private readonly sessionRegistry: RuntimeSessionRegistry<ManagedRuntimeSession>;
  private readonly commandQueue = new SessionCommandQueue();
  private readonly inFlightCommands = new Map<string, InFlightRuntimeCommand>();
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
  private readonly hostFactory: RuntimeHostFactory;
  private readonly runCoordinator: RuntimeRunCoordinator;
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
    this.hostFactory = new RuntimeHostFactory({
      language: this.language,
      tools: this.tools,
      projectDomain: this.projectDomain,
      durableStore: this.durableStore,
      logger: this.logger,
      closeScope: (scope, owner) => this.closeScope(scope, owner),
    });
    this.sessionRegistry = new RuntimeSessionRegistry({
      project: (session) => projectRuntimeSession(session, this.runtimeIncarnation),
    });
    this.runCoordinator = new RuntimeRunCoordinator({
      maxSessions: this.maxSessions,
      commandQueue: this.commandQueue,
      hostFactory: this.hostFactory,
      sessionRegistry: this.sessionRegistry,
      effects: {
        isSessionDeleted: (sessionId) => this.deletedSessionIds.has(sessionId),
        assertSessionMutable: (session) => this.assertSessionMutable(session),
        broadcast: (session, event) => this.broadcast(session, event),
        persist: (session) => this.persistRuntimeSession(session),
        publish: (session) => this.sessionRegistry.changed(session),
        resetIdleTimer: (session) => this.resetIdleTimer(session),
        closeScope: (scope, owner) => this.closeScope(scope, owner),
      },
    });
    const runtimeDurableStore = this.runtimeDurableStore();
    runtimeDurableStore?.acquireOwnership?.();
    this.eventJournal = new RuntimeEventJournal(runtimeDurableStore, {
      onFailure: (sessionId, error) => this.markDurabilityFailure(sessionId, error),
      onRetention: (sessionId, retention) => {
        const session = this.sessionRegistry.get(sessionId);
        if (session) {
          session.eventRetention = retention;
          this.sessionRegistry.changed(session);
        }
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
    if (this.sessionRegistry.has(id)) throw new RuntimeError('invalid_request', `Session already exists: ${id}`);
    this.commandQueue.open(id);
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
    const inputSource = new RuntimeInputSource();
    const scope = this.applicationScope.child(`session:${id}`, 'session');
    const contributions = normalizeContributionConfigs(request.contributions ?? this.contributions);
    let session: ManagedRuntimeSession;
    let host: RuntimeHost;
    try {
      host = await this.hostFactory.create({
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
        inputSource,
        onAgentEvent: (event) => {
          void this.broadcast(session, event).catch(() => undefined);
        },
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
      pluginGeneration: host.pluginGeneration,
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
      inputSource,
      commandLedger: new RuntimeCommandLedger(),
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
      void this.broadcast(session, event).catch(() => undefined);
    };

    if (!this.accepting) {
      await this.closeScope(session.scope, `discarded session while runtime closes:${id}`);
      throw new RuntimeError('invalid_request', 'Runtime is closing');
    }
    try {
      await this.persistRuntimeSession(session);
    } catch (error) {
      this.deletedSessionIds.add(id);
      await this.eventJournal.delete(id).catch(() => undefined);
      await this.closeScope(session.scope, `failed initial session persistence:${id}`);
      throw error;
    }
    if (!this.accepting) {
      this.deletedSessionIds.add(id);
      await this.eventJournal.delete(id).catch(() => undefined);
      await this.closeScope(session.scope, `discarded persisted session while runtime closes:${id}`);
      throw new RuntimeError('invalid_request', 'Runtime is closing');
    }
    this.sessionRegistry.add(session);
    this.resetIdleTimer(session);
    this.logger.info(`[runtime] Session created: ${id}`);
    return projectRuntimeSession(session, this.runtimeIncarnation);
  }

  listSessions(): RuntimeSessionInfo[] {
    return Array.from(this.sessionRegistry.values()).map((session) =>
      projectRuntimeSession(session, this.runtimeIncarnation));
  }

  getSessionSummaryBaseline(): SessionSummaryBaseline {
    return this.sessionRegistry.baseline();
  }

  getSessionSummaryChanges(afterCursor: string): SessionSummaryChange[] {
    return this.sessionRegistry.changesAfter(afterCursor);
  }

  subscribeSessionSummaries(
    afterCursor: string,
    callback: (change: SessionSummaryChange) => void,
  ): () => void {
    return this.sessionRegistry.subscribe(afterCursor, callback);
  }

  async restoreDurableSessions(options: RestoreDurableSessionsOptions = {}): Promise<RuntimeSessionInfo[]> {
    const store = this.runtimeDurableStore();
    if (!store) return [];
    await this.eventJournal.drainAll();

    const restored: RuntimeSessionInfo[] = [];
    for (const snapshot of await store.listRuntimeSessions()) {
      if (this.sessionRegistry.has(snapshot.id)) continue;
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
        session.inputSource.replace(
          snapshot.queuedInputs.map((input) =>
            input.state === 'queued' ? { ...input, state: 'interrupted' as const } : { ...input },
          ),
        );
        session.commandLedger = new RuntimeCommandLedger(snapshot.commandReceipts ?? []);
        session.agentSessions.hydrate(await store.listSubAgentSessions(snapshot.id));
        const eventSnapshots = store.listEventEnvelopes ? await store.listEventEnvelopes(snapshot.id) : [];
        session.usage = aggregateRuntimeSessionUsage(session, eventSnapshots) ?? snapshot.usage;
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
        this.sessionRegistry.changed(session);
        this.restoringSessionIds.delete(snapshot.id);
        const lastDurableSequence = eventSnapshots.at(-1)?.sequence ?? 0;
        const restoredTerminalEnvelope = session.eventEnvelopes.at(-1);
        await this.persistRuntimeSession(
          session,
          restoredTerminalEnvelope && restoredTerminalEnvelope.sequence > lastDurableSequence
            ? restoredTerminalEnvelope
            : undefined,
        );
        restored.push(projectRuntimeSession(session, this.runtimeIncarnation));

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
    return projectRuntimeSession(this.requireSession(sessionId), this.runtimeIncarnation);
  }

  async updateSession(
    sessionId: string,
    request: RuntimeSessionUpdateRequest = {},
    options: RuntimeCommandOptions = {},
  ): Promise<RuntimeSessionInfo> {
    return this.runSessionCommand(
      sessionId,
      'update_session',
      request,
      options,
      () => this.updateSessionNow(sessionId, request),
    );
  }

  private async updateSessionNow(
    sessionId: string,
    request: RuntimeSessionUpdateRequest,
  ): Promise<RuntimeSessionInfo> {
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
    this.sessionRegistry.changed(session);
    return projectRuntimeSession(session, this.runtimeIncarnation);
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

  private createCommandContext(
    kind: string,
    payload: unknown,
    options: RuntimeCommandOptions,
  ): RuntimeCommandContext | undefined {
    this.assertRuntimeIncarnation(options.expectedRuntimeIncarnation);
    const commandId = normalizeCommandId(options.commandId);
    if (!commandId) return undefined;
    return {
      commandId,
      kind,
      payloadHash: commandPayloadHash(kind, payload),
      expectedRuntimeIncarnation: options.expectedRuntimeIncarnation,
    };
  }

  private assertRuntimeIncarnation(expectedRuntimeIncarnation: string | undefined): void {
    if (expectedRuntimeIncarnation === undefined || expectedRuntimeIncarnation === this.runtimeIncarnation) return;
    throw new RuntimeError('conflict', 'Runtime incarnation changed; refresh session state before retrying', {
      expectedRuntimeIncarnation,
      currentRuntimeIncarnation: this.runtimeIncarnation,
    });
  }

  private withInFlightCommand<T>(
    sessionId: string,
    context: RuntimeCommandContext | undefined,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (!context) return execute();
    const key = stableJson([sessionId, context.commandId]);
    const existing = this.inFlightCommands.get(key);
    if (existing) {
      if (existing.kind !== context.kind || existing.payloadHash !== context.payloadHash) {
        return Promise.reject(new RuntimeError(
          'conflict',
          'Command id is already in flight with a different command or payload',
          { commandId: context.commandId, existingKind: existing.kind, requestedKind: context.kind },
        ));
      }
      return existing.promise as Promise<T>;
    }
    if (this.inFlightCommands.size >= MAX_IN_FLIGHT_RUNTIME_COMMANDS) {
      return Promise.reject(new RuntimeError('capacity_exceeded', 'Maximum in-flight Runtime commands reached', {
        maxInFlightCommands: MAX_IN_FLIGHT_RUNTIME_COMMANDS,
      }));
    }

    const promise = Promise.resolve().then(execute);
    this.inFlightCommands.set(key, { kind: context.kind, payloadHash: context.payloadHash, promise });
    void promise.then(
      () => this.inFlightCommands.delete(key),
      () => this.inFlightCommands.delete(key),
    );
    return promise;
  }

  private runSessionCommand<T>(
    sessionId: string,
    kind: string,
    payload: unknown,
    options: RuntimeCommandOptions,
    command: () => T | Promise<T>,
  ): Promise<T> {
    let context: RuntimeCommandContext | undefined;
    try {
      context = this.createCommandContext(kind, payload, options);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.withInFlightCommand(sessionId, context, () => this.commandQueue.run(sessionId, async () => {
      const session = this.requireSession(sessionId);
      this.assertRuntimeIncarnation(context?.expectedRuntimeIncarnation ?? options.expectedRuntimeIncarnation);
      if (context) {
        const receipt = session.commandLedger.get(context.commandId, context.kind, context.payloadHash);
        if (receipt) return receipt.result as T;
      }

      const result = await command();
      if (context) {
        session.commandLedger.record({
          commandId: context.commandId,
          kind: context.kind,
          payloadHash: context.payloadHash,
          acceptedAt: Date.now(),
          ...(result === undefined ? {} : { result }),
        });
        await this.persistRuntimeSession(session);
      }
      return result;
    }));
  }

  async prompt(sessionId: string, message: string, options: RuntimeCommandOptions = {}): Promise<void> {
    return this.runSessionCommand(sessionId, 'prompt', { message }, options, () => this.promptNow(sessionId, message));
  }

  private async promptNow(sessionId: string, message: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    await this.runCoordinator.start(session, () => session.cortx.run(message), async () => {
      session.promptHistory = appendPromptHistory(session.promptHistory, message);
      await this.broadcast(session, { type: 'user_message', message, source: 'prompt' });
    });
  }

  async resume(sessionId: string, options: RuntimeCommandOptions = {}): Promise<void> {
    return this.runSessionCommand(sessionId, 'resume', {}, options, () => this.resumeNow(sessionId));
  }

  private async resumeNow(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    await this.runCoordinator.start(session, () => session.cortx.continue());
  }

  steer(sessionId: string, message: string, options: RuntimeCommandOptions = {}): Promise<void> {
    return this.runSessionCommand(sessionId, 'steer', { message }, options, () => this.steerNow(sessionId, message));
  }

  private async steerNow(sessionId: string, message: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    session.lastActivityAt = Date.now();
    session.cortx.controller.steer(message);
    this.resetIdleTimer(session);
    this.sessionRegistry.changed(session);
    await this.persistRuntimeSession(session);
  }

  followUp(
    sessionId: string,
    message: string,
    inputId: string = crypto.randomUUID(),
    options: RuntimeCommandOptions = {},
  ): Promise<RuntimeFollowUpAdmission> {
    return this.runSessionCommand(
      sessionId,
      'follow_up',
      { inputId, message },
      options,
      () => this.followUpNow(sessionId, message, inputId),
    );
  }

  private async followUpNow(
    sessionId: string,
    message: string,
    inputId: string,
  ): Promise<RuntimeFollowUpAdmission> {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    if (!message?.trim()) throw new RuntimeError('invalid_request', 'Message is required');
    if (session.runPhase !== 'running' && session.runPhase !== 'waiting_user' && session.runPhase !== 'waiting_approval') {
      throw new RuntimeError('invalid_request', 'Follow-up requires a running session', {
        sessionId,
        runPhase: session.runPhase,
      });
    }
    const acceptedAt = Date.now();
    const existing = session.inputSource.get(inputId);
    const admission = session.inputSource.admit(
      inputId,
      message,
      session.nextEventSequence + 1,
      acceptedAt,
    );
    if (existing) return admission;
    session.lastActivityAt = acceptedAt;
    session.promptHistory = appendPromptHistory(session.promptHistory, message);
    await this.broadcast(session, { type: 'user_message', message, source: 'follow_up' });
    this.resetIdleTimer(session);
    return { ...admission };
  }

  cancelFollowUp(
    sessionId: string,
    inputId: string,
    options: RuntimeCommandOptions = {},
  ): Promise<boolean> {
    return this.runSessionCommand(
      sessionId,
      'cancel_follow_up',
      { inputId },
      options,
      async () => {
        const session = this.requireSession(sessionId);
        this.assertSessionMutable(session);
        const cancelled = session.inputSource.cancel(inputId);
        if (!cancelled || cancelled.state === 'delivered') return false;
        session.lastActivityAt = Date.now();
        this.sessionRegistry.changed(session);
        await this.persistRuntimeSession(session);
        return true;
      },
    );
  }

  answer(
    sessionId: string,
    toolCallId: string,
    response: string,
    options: RuntimeCommandOptions = {},
  ): Promise<boolean> {
    return this.runSessionCommand(
      sessionId,
      'answer',
      { toolCallId, response },
      options,
      () => this.answerNow(sessionId, toolCallId, response),
    );
  }

  private async answerNow(sessionId: string, toolCallId: string, response: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    const answered = session.cortx.controller.answerUser(toolCallId, response);
    if (!answered) return false;
    if (session.pendingInteraction?.requestId === toolCallId) session.pendingInteraction = undefined;
    if (session.runPhase === 'waiting_user' || session.runPhase === 'waiting_approval') session.runPhase = 'running';
    await this.broadcast(session, { type: 'user_answer', toolCallId, response });
    return true;
  }

  async abort(sessionId: string, options: RuntimeCommandOptions = {}): Promise<void> {
    const context = this.createCommandContext('abort', {}, options);
    await this.withInFlightCommand(sessionId, context, () =>
      this.runCoordinator.abort(sessionId, {
        abortReason: 'User aborted via runtime',
        pendingQuestionReason: 'Session aborted',
        beforeAbort: (session) => {
          if (!context) return true;
          this.assertRuntimeIncarnation(context.expectedRuntimeIncarnation);
          return session.commandLedger.get(context.commandId, context.kind, context.payloadHash) === undefined;
        },
        afterAbort: context
          ? (session) => {
              session.commandLedger.record({
                commandId: context.commandId,
                kind: context.kind,
                payloadHash: context.payloadHash,
                acceptedAt: Date.now(),
              });
            }
          : undefined,
      }));
    const session = this.sessionRegistry.get(sessionId);
    if (session) this.resetIdleTimer(session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.commandQueue.seal(sessionId);
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
      await this.commandQueue.sealAll();
      for (const session of [...this.sessionRegistry.values()]) {
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

  private async createSessionCandidate(
    session: ManagedRuntimeSession,
    configuration: RuntimeSessionHostConfiguration,
  ): Promise<RuntimeHost> {
    const scope = this.applicationScope.child(`session:${session.id}:candidate:${crypto.randomUUID()}`, 'session');
    try {
      return await this.hostFactory.create({
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
      inputSource: session.inputSource,
      onAgentEvent: (event) => {
        void this.broadcast(session, event).catch(() => undefined);
      },
      });
    } catch (error) {
      await scope.close(error).catch(() => undefined);
      throw error;
    }
  }

  private async cutoverSessionHost(
    session: ManagedRuntimeSession,
    host: RuntimeHost,
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
    session.pluginGeneration = host.pluginGeneration;
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

  private async broadcast(session: ManagedRuntimeSession, event: AgentEvent): Promise<void> {
    if (!this.sessionRegistry.has(session.id)) return;
    session.lastActivityAt = Date.now();
    const enrichedEvent = enrichRuntimeSessionEvent(session, event);
    applyRuntimeSessionEventProjection(session, enrichedEvent, this.runtimeIncarnation);
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
        if (subAgent) await this.persistRuntimeSession(session, undefined, subAgent);
      }
      this.sessionRegistry.changed(session);
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
      session.usage = addRuntimeSessionUsage(session.usage, enrichedEvent.usage);
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
    const persistence = this.persistRuntimeSession(session, envelope, subAgentSnapshot);
    this.sessionRegistry.changed(session);
    for (const subscriber of session.subscribers) {
      this.safeNotify(() => subscriber(enrichedEvent));
    }
    for (const subscriber of session.envelopeSubscribers) {
      this.safeNotify(() => subscriber(envelope));
    }
    for (const subscriber of session.streamSubscribers) {
      this.safeNotify(() => subscriber(envelope));
    }
    await persistence;
  }

  private resetIdleTimer(session: ManagedRuntimeSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!this.sessionRegistry.has(session.id)) return;
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

  private async destroy(session: ManagedRuntimeSession, options: { deleteDurable?: boolean } = {}): Promise<void> {
    await this.commandQueue.seal(session.id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (options.deleteDurable) this.deletedSessionIds.add(session.id);
    await this.runCoordinator.abort(session.id, {
      abortReason: 'Session cleaned up',
      pendingQuestionReason: 'Session destroyed',
      internal: true,
    });
    await this.commandQueue.runInternal(session.id, async () => {
      await this.closeScope(session.scope, `destroyed session:${session.id}`);
      session.subscribers.clear();
      session.envelopeSubscribers.clear();
      session.streamSubscribers.clear();
      session.isRunning = false;
      session.runPhase = 'idle';
      session.pendingInteraction = undefined;
      this.sessionRegistry.remove(session.id);
      if (options.deleteDurable) {
        await this.eventJournal.delete(session.id);
      } else {
        await this.persistRuntimeSession(session).catch(() => undefined);
      }
    });
  }

  private requireSession(sessionId: string): ManagedRuntimeSession {
    return this.sessionRegistry.require(sessionId);
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
        event: enrichRuntimeSessionEvent(session, snapshot.event),
        parent: parentAttributionFor(session, snapshot.event) ?? snapshot.parent,
      });
    }

    for (const envelope of session.eventEnvelopes) {
      bySequence.set(envelope.sequence, envelope);
    }

    return backfillUserMessageEnvelopes(session, [...bySequence.values()].sort((a, b) => a.sequence - b.sequence));
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
      event: enrichRuntimeSessionEvent(session, snapshot.event),
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
      snapshot: snapshotRuntimeSession(session, this.runtimeIncarnation),
      envelope: envelope ? this.eventEnvelopeSnapshot(envelope) : undefined,
      subAgent,
    });
  }

  private markDurabilityFailure(sessionId: string, error: Error): void {
    const session = this.sessionRegistry.get(sessionId);
    if (session) {
      session.sessionHealth = 'durability_failed';
      this.sessionRegistry.changed(session);
    }
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

}
