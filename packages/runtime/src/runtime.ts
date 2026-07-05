import type { LanguageClient } from '@synax-ai/core';
import type {
  AgentDurableRunStore,
  AgentEvent,
  AgentRuntimeExtensions,
  LanguageMessage,
  Logger,
  RuntimeAgentEventEnvelope,
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
import { createWorkspaceTools, parseWorkspaceToolMode, type WorkspaceToolMode } from './tool-mount.js';
import { resolveWorkspace } from './workspace.js';
import {
  SubAgentSessionStore,
  createDefaultSafetyExtensions,
  createSkillExtensions,
  createSubAgentTool,
  discoverSkills,
} from './capabilities/index.js';
import { loadAgentSpecFile, parseAgentSpec, type AgentSpec } from './assets/agent-spec.js';
import { resolveSkillPack } from './assets/skill-pack.js';
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
  RuntimeSessionCreateRequest,
  RuntimeSessionInfo,
  RuntimeSessionLocalState,
} from './session.js';

export interface CortxRuntimeOptions {
  appName?: string;
  language: LanguageClient;
  model: string;
  system?: string;
  maxIterations?: number;
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  tools?: Tool[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  capabilities?: RuntimeDefaultCapabilities;
  defaultWorkingDirectory?: string;
  allowedWorkspaceRoots?: string[];
  maxSessions?: number;
  maxEventsPerSession?: number;
  idleTimeoutMs?: number;
  logger?: Logger;
  durableStore?: AgentDurableRunStore;
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

function eventError(error: unknown): AgentEvent {
  return {
    type: 'error',
    error: error instanceof Error ? error : new Error(String(error)),
    code: 'stream_error',
  };
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

export class CortxRuntime {
  private readonly sessions = new Map<string, ManagedRuntimeSession>();
  private readonly appName: string;
  private readonly language: LanguageClient;
  private readonly model: string;
  private readonly system?: string;
  private readonly maxIterations?: number;
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

  constructor(options: CortxRuntimeOptions) {
    this.appName = options.appName ?? 'cortx';
    this.language = options.language;
    this.model = options.model;
    this.system = options.system;
    this.maxIterations = options.maxIterations;
    this.registry = options.registry;
    this.plugins = options.plugins;
    this.tools = options.tools ?? [];
    this.toolMode = options.toolMode ?? 'all';
    this.approvalMode = options.approvalMode ?? 'deny';
    this.capabilities = options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
    this.defaultWorkingDirectory = options.defaultWorkingDirectory ?? process.cwd();
    this.allowedWorkspaceRoots = options.allowedWorkspaceRoots ?? [this.defaultWorkingDirectory];
    this.maxSessions = options.maxSessions ?? 10;
    this.maxEventsPerSession = options.maxEventsPerSession ?? 2_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.logger = options.logger ?? noopLogger;
    this.durableStore = options.durableStore;
  }

  async createSession(request: RuntimeSessionCreateRequest = {}): Promise<RuntimeSessionInfo> {
    if (this.sessions.size >= this.maxSessions) {
      throw new RuntimeError('capacity_exceeded', 'Maximum concurrent sessions reached');
    }

    const workspace = await resolveWorkspace({
      requested: request.workingDirectory,
      defaultWorkingDirectory: this.defaultWorkingDirectory,
      allowedRoots: this.allowedWorkspaceRoots,
    });
    const id = request.id ?? createSessionId();
    if (this.sessions.has(id)) throw new RuntimeError('invalid_request', `Session already exists: ${id}`);

    const model = request.model ?? this.model;
    const maxIterations = request.maxIterations ?? this.maxIterations;
    const toolMode = parseWorkspaceToolMode(request.toolMode, this.toolMode);
    const approvalMode = parseApprovalMode(request.approvalMode, this.approvalMode);
    const requestedCapabilities = request.capabilities ?? this.capabilities;
    const capabilities =
      approvalMode === 'full-access'
        ? { ...requestedCapabilities, approval: false }
        : requestedCapabilities;
    const skillPaths = request.skillPaths;
    const system = request.system ?? this.system;
    const agentSessions = new SubAgentSessionStore();
    const mountedTools = [
      ...this.tools,
      ...createWorkspaceTools(workspace.workingDirectory, toolMode),
      ...(request.tools ?? []),
    ];
    const officialExtensions = await this.createOfficialExtensions({
      workingDirectory: workspace.workingDirectory,
      capabilities,
      skillPaths: request.skillPaths,
    });
    let session: ManagedRuntimeSession;
    if (capabilities.subAgents !== false) {
      mountedTools.push(
        createSubAgentTool({
          language: this.language,
          model,
          registry: request.registry ?? this.registry,
          plugins: request.plugins ?? this.plugins,
          agentSessions,
          getTools: () => mountedTools,
          getExtensions: () => officialExtensions,
          onAgentEvent: (event) => this.broadcast(session, event),
        }),
      );
    }
    const cortx = new Cortx(this.language, {
      appName: this.appName,
      model,
      system,
      maxIterations,
      registry: request.registry ?? this.registry,
      plugins: request.plugins ?? this.plugins,
      tools: mountedTools,
      extensions: officialExtensions,
      workingDirectory: workspace.workingDirectory,
      sessionId: id,
      durableStore: this.durableStore,
      askUser: approvalMode === 'deny' ? async () => 'no' : undefined,
      logger: this.logger,
    });

    const now = Date.now();
    session = {
      id,
      cortx,
      createdAt: now,
      lastActivityAt: now,
      workingDirectory: workspace.workingDirectory,
      model,
      system,
      maxIterations,
      toolMode,
      approvalMode,
      capabilities,
      skillPaths,
      events: [],
      eventEnvelopes: [],
      subscribers: new Set(),
      envelopeSubscribers: new Set(),
      idleTimer: undefined,
      isRunning: false,
      runId: 0,
      nextEventSequence: 0,
      agentSessions,
      metadata: request.metadata,
    };

    cortx.onAgentEvent = (event: AgentEvent) => {
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
      const checkpoint = await this.durableStore?.loadCheckpoint(snapshot.id);
      if (!checkpoint || checkpoint.schemaVersion !== AGENT_RUN_CHECKPOINT_SCHEMA_VERSION || checkpoint.state.terminal) {
        continue;
      }

      const info = await this.createSession({
        id: snapshot.id,
        workingDirectory: snapshot.workingDirectory,
        model: snapshot.model,
        system: snapshot.system,
        maxIterations: snapshot.maxIterations,
        toolMode: snapshot.toolMode,
        approvalMode: snapshot.approvalMode,
        capabilities: snapshot.capabilities,
        skillPaths: snapshot.skillPaths,
        metadata: snapshot.metadata,
      });
      const session = this.requireSession(info.id);
      session.createdAt = snapshot.createdAt;
      session.lastActivityAt = snapshot.lastActivityAt;
      session.runId = snapshot.runId;
      session.nextEventSequence = snapshot.nextEventSequence;
      session.agentSessions.hydrate(await store.listSubAgentSessions(snapshot.id));
      this.restoreSessionEventHistory(session, await store.listEventEnvelopes(snapshot.id));
      await this.persistRuntimeSession(session);
      restored.push(this.info(session));

      if (options.autoResume) {
        await this.resume(session.id);
      }
    }
    return restored;
  }

  async launchAgentSpec(value: unknown): Promise<RuntimeSessionInfo> {
    const spec = parseAgentSpec(value);
    const skillPaths = [...(spec.skillPaths ?? [])];
    for (const packPath of spec.skillPacks ?? []) {
      const pack = await resolveSkillPack(packPath);
      skillPaths.push(...pack.skillPaths);
    }
    const session = await this.createSession({
      workingDirectory: spec.workingDirectory,
      model: spec.model,
      system: spec.system,
      tools: spec.tools,
      toolMode: spec.toolMode,
      approvalMode: spec.approvalMode,
      capabilities: spec.capabilities,
      skillPaths,
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

  getEventHistory(sessionId: string): AgentEvent[] {
    return [...this.requireSession(sessionId).events];
  }

  getEventEnvelopeHistory(sessionId: string): RuntimeAgentEventEnvelope[] {
    return [...this.requireSession(sessionId).eventEnvelopes];
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
    await this.startRun(session, () => session.cortx.run(message));
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
    session.cortx.controller.followUp(message);
    this.resetIdleTimer(session);
  }

  answer(sessionId: string, toolCallId: string, response: string): void {
    const session = this.requireSession(sessionId);
    session.cortx.controller.answerUser(toolCallId, response);
    this.broadcast(session, { type: 'user_response', requestId: toolCallId, response });
    this.broadcast(session, { type: 'user_answer', toolCallId, response });
  }

  abort(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.cortx.abort('User aborted via runtime');
    session.agentSessions.abortRunning('Session aborted');
    session.cortx.controller.rejectPendingQuestions('Session aborted');
    session.runId++;
    session.isRunning = false;
    session.lastActivityAt = Date.now();
    void this.persistRuntimeSession(session);
    this.resetIdleTimer(session);
  }

  deleteSession(sessionId: string): void {
    const session = this.requireSession(sessionId);
    this.destroy(session, { deleteDurable: true });
    this.logger.info(`[runtime] Session deleted: ${sessionId}`);
  }

  subscribe(sessionId: string, callback: (event: AgentEvent) => void, options: SubscribeOptions = {}): () => void {
    const session = this.requireSession(sessionId);
    if (options.replay ?? true) {
      for (const event of [...session.events]) callback(event);
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
      for (const event of [...session.eventEnvelopes]) callback(event);
    }
    session.envelopeSubscribers.add(callback);
    return () => session.envelopeSubscribers.delete(callback);
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) this.destroy(session);
  }

  private async startRun(
    session: ManagedRuntimeSession,
    createGenerator: () => AsyncGenerator<AgentEvent>,
  ): Promise<void> {
    if (session.isRunning) throw new RuntimeError('session_busy', 'Agent is already running');

    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);
    session.isRunning = true;
    const runId = ++session.runId;
    session.cortx.setRunId(runId);
    void this.persistRuntimeSession(session);

    (async () => {
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
        void this.persistRuntimeSession(session);
      }
    })();
  }

  private broadcast(session: ManagedRuntimeSession, event: AgentEvent): void {
    if (!this.sessions.has(session.id)) return;
    session.lastActivityAt = Date.now();
    const envelope: RuntimeAgentEventEnvelope = {
      sequence: ++session.nextEventSequence,
      timestamp: session.lastActivityAt,
      sessionId: session.id,
      runId: session.runId,
      event,
      parent: parentAttributionFor(session, event),
    };
    session.events.push(event);
    session.eventEnvelopes.push(envelope);
    if (session.events.length > this.maxEventsPerSession) {
      session.events.splice(0, session.events.length - this.maxEventsPerSession);
    }
    if (session.eventEnvelopes.length > this.maxEventsPerSession) {
      session.eventEnvelopes.splice(0, session.eventEnvelopes.length - this.maxEventsPerSession);
    }
    void this.persistRuntimeSession(session);
    void this.persistEventEnvelope(envelope);
    void this.persistSubAgentSession(session, event);
    for (const subscriber of session.subscribers) {
      try {
        subscriber(event);
      } catch {
        /* subscriber errors should not break the runtime */
      }
    }
    for (const subscriber of session.envelopeSubscribers) {
      try {
        subscriber(envelope);
      } catch {
        /* subscriber errors should not break the runtime */
      }
    }
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

  private destroy(session: ManagedRuntimeSession, options: { deleteDurable?: boolean } = {}): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.cortx.abort('Session cleaned up');
    session.agentSessions.abortRunning('Session cleaned up');
    session.cortx.controller.rejectPendingQuestions('Session destroyed');
    session.subscribers.clear();
    session.envelopeSubscribers.clear();
    session.isRunning = false;
    this.sessions.delete(session.id);
    if (options.deleteDurable) {
      void this.runtimeDurableStore()?.deleteRuntimeSession(session.id);
    } else {
      void this.persistRuntimeSession(session);
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
      system: session.system,
      maxIterations: session.maxIterations,
      toolMode: session.toolMode,
      approvalMode: session.approvalMode,
      capabilities: session.capabilities,
      skillPaths: session.skillPaths,
      isRunning: session.isRunning,
      eventCount: session.events.length,
      metadata: session.metadata,
    };
  }

  private runtimeDurableStore(): RuntimeDurableRunStore | undefined {
    return isRuntimeDurableRunStore(this.durableStore) ? this.durableStore : undefined;
  }

  private sessionSnapshot(session: ManagedRuntimeSession): RuntimeSessionSnapshot {
    return {
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: session.id,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      workingDirectory: session.workingDirectory,
      model: session.model,
      system: session.system,
      maxIterations: session.maxIterations,
      toolMode: session.toolMode,
      approvalMode: session.approvalMode,
      capabilities: session.capabilities,
      skillPaths: session.skillPaths,
      runId: session.runId,
      nextEventSequence: session.nextEventSequence,
      metadata: session.metadata,
    };
  }

  private restoreSessionEventHistory(session: ManagedRuntimeSession, snapshots: RuntimeEventEnvelopeSnapshot[]): void {
    const bounded = snapshots.slice(-this.maxEventsPerSession);
    session.eventEnvelopes = bounded.map((snapshot) => ({
      sequence: snapshot.sequence,
      timestamp: snapshot.timestamp,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      event: snapshot.event,
      parent: snapshot.parent,
    }));
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
    try {
      await store.saveRuntimeSession(this.sessionSnapshot(session));
    } catch (error) {
      this.logger.warn(`Failed to persist runtime session "${session.id}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async persistEventEnvelope(envelope: RuntimeAgentEventEnvelope): Promise<void> {
    const store = this.runtimeDurableStore();
    if (!store) return;
    try {
      await store.saveEventEnvelope(this.eventEnvelopeSnapshot(envelope));
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
    const snapshot = session.agentSessions.snapshot(event.toolCallId);
    if (!snapshot) return;
    try {
      await store.saveSubAgentSession(snapshot);
    } catch (error) {
      this.logger.warn(
        `Failed to persist sub-agent session "${event.toolCallId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async createOfficialExtensions(input: {
    workingDirectory: string;
    capabilities: RuntimeDefaultCapabilities;
    skillPaths?: string[];
  }): Promise<AgentRuntimeExtensions> {
    const sets: AgentRuntimeExtensions[] = [createEmptyAgentRuntimeExtensions()];
    if (input.capabilities.skills !== false) {
      const skills = await discoverSkills(input.workingDirectory, { skillPaths: input.skillPaths }, this.logger);
      if (skills.length) sets.push(createSkillExtensions(skills));
    }
    if (input.capabilities.approval !== false) {
      sets.push(createDefaultSafetyExtensions());
    }
    return mergeAgentRuntimeExtensions(...sets);
  }
}
