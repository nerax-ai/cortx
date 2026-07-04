import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, LanguageMessage, Logger, Tool } from '@cortx/sdk';
import { noopLogger } from '@cortx/sdk';
import { Cortx, type CortxRegistry, type PluginConfig } from '@cortx/core';
import { RuntimeError, toRuntimeError } from './errors.js';
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  toCoreCapabilities,
  type RuntimeDefaultCapabilities,
} from './default-capabilities.js';
import { createWorkspaceTools, type WorkspaceToolMode } from './tool-mount.js';
import { resolveWorkspace } from './workspace.js';
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
}

export interface SubscribeOptions {
  replay?: boolean;
}

function createSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function eventError(error: unknown): AgentEvent {
  return {
    type: 'error',
    error: error instanceof Error ? error : new Error(String(error)),
    code: 'stream_error',
  };
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
    const toolMode = request.toolMode ?? this.toolMode;
    const approvalMode = request.approvalMode ?? this.approvalMode;
    const mountedTools = createWorkspaceTools(workspace.workingDirectory, toolMode);
    const cortx = new Cortx(this.language, {
      appName: this.appName,
      model,
      system: request.system ?? this.system,
      maxIterations,
      registry: request.registry ?? this.registry,
      plugins: request.plugins ?? this.plugins,
      tools: [...this.tools, ...mountedTools, ...(request.tools ?? [])],
      workingDirectory: workspace.workingDirectory,
      capabilities: toCoreCapabilities(request.capabilities ?? this.capabilities),
      askUser: approvalMode === 'deny' ? async () => 'no' : undefined,
      logger: this.logger,
    });

    const now = Date.now();
    const session: ManagedRuntimeSession = {
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
      subscribers: new Set(),
      idleTimer: undefined,
      isRunning: false,
      runId: 0,
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

  getSession(sessionId: string): RuntimeSessionInfo {
    return this.info(this.requireSession(sessionId));
  }

  getEventHistory(sessionId: string): AgentEvent[] {
    return [...this.requireSession(sessionId).events];
  }

  getLocalState(sessionId: string): RuntimeSessionLocalState {
    const session = this.requireSession(sessionId);
    return {
      agentSessions: session.cortx.agentSessions,
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
    session.events.push(event);
    if (session.events.length > this.maxEventsPerSession) {
      session.events.splice(0, session.events.length - this.maxEventsPerSession);
    }
    for (const subscriber of session.subscribers) {
      try {
        subscriber(event);
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
}
