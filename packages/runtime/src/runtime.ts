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
import { createEmptyAgentRuntimeExtensions, mergeAgentRuntimeExtensions, noopLogger } from '@cortx/sdk';
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
import { parseAgentSpec, type AgentSpec } from './assets/agent-spec.js';
import { resolveSkillPack } from './assets/skill-pack.js';
import type {
  ManagedRuntimeSession,
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
  approvalMode?: 'deny' | 'interactive';
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

function createSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseApprovalMode(value: unknown, fallback: 'deny' | 'interactive'): 'deny' | 'interactive' {
  if (value === undefined) return fallback;
  if (value === 'deny' || value === 'interactive') return value;
  throw new RuntimeError('invalid_request', 'approvalMode must be one of: deny, interactive', {
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
  private readonly approvalMode: 'deny' | 'interactive';
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
    const capabilities = request.capabilities ?? this.capabilities;
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
      system: request.system ?? this.system,
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
      maxIterations,
      toolMode,
      approvalMode,
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
    this.logger.info(`[runtime] Session created: ${id}`);
    return this.info(session);
  }

  listSessions(): RuntimeSessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => this.info(session));
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
    return session;
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
    session.cortx.controller.rejectPendingQuestions('Session aborted');
    session.runId++;
    session.isRunning = false;
    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);
  }

  deleteSession(sessionId: string): void {
    const session = this.requireSession(sessionId);
    this.destroy(session);
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

  private destroy(session: ManagedRuntimeSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.cortx.abort('Session cleaned up');
    session.cortx.controller.rejectPendingQuestions('Session destroyed');
    session.subscribers.clear();
    session.envelopeSubscribers.clear();
    session.isRunning = false;
    this.sessions.delete(session.id);
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
      maxIterations: session.maxIterations,
      toolMode: session.toolMode,
      approvalMode: session.approvalMode,
      isRunning: session.isRunning,
      eventCount: session.events.length,
      metadata: session.metadata,
    };
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
