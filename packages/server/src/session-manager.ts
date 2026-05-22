import type { AgentEvent } from '@cortx/sdk';
import type { Cortx, CortxPluginRegistry, PluginEntry } from '@cortx/core';
import type { LanguageClient } from '@synax-ai/core';
import type { Logger } from '@cortx/sdk';
import type { SessionInfo } from './types.js';
import { Cortx as CortxClass } from '@cortx/core';

interface ManagedSession {
  id: string;
  cortx: Cortx;
  createdAt: number;
  lastActivityAt: number;
  events: AgentEvent[];
  subscribers: Set<(event: AgentEvent) => void>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  isRunning: boolean;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly language: LanguageClient;
  private readonly model: string;
  private readonly system?: string;
  private readonly registry?: CortxPluginRegistry;
  private readonly plugins?: PluginEntry[];
  private readonly logger: Logger;

  constructor(opts: {
    maxSessions?: number;
    idleTimeoutMs?: number;
    language: LanguageClient;
    model: string;
    system?: string;
    registry?: CortxPluginRegistry;
    plugins?: PluginEntry[];
    logger: Logger;
  }) {
    this.maxSessions = opts.maxSessions ?? 10;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    this.language = opts.language;
    this.model = opts.model;
    this.system = opts.system;
    this.registry = opts.registry;
    this.plugins = opts.plugins;
    this.logger = opts.logger;
  }

  async create(): Promise<{ id: string } | { error: string; status: number }> {
    if (this.sessions.size >= this.maxSessions) {
      return { error: 'Maximum concurrent sessions reached', status: 429 };
    }

    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cortx = new CortxClass(this.language, {
      appName: 'cortx',
      model: this.model,
      system: this.system,
      registry: this.registry,
      plugins: this.plugins,
      logger: this.logger,
    });

    const session: ManagedSession = {
      id,
      cortx,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      events: [],
      subscribers: new Set(),
      idleTimer: undefined,
      isRunning: false,
    };

    cortx.onAgentEvent = (event: AgentEvent) => {
      this.broadcast(session, event);
    };

    this.resetIdleTimer(session);
    this.sessions.set(id, session);
    this.logger.info(`[server] Session created: ${id}`);
    return { id };
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
    }));
  }

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  async prompt(sessionId: string, message: string): Promise<{ error: string; status: number } | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: 'Session not found', status: 404 };
    if (!message?.trim()) return { error: 'Message is required', status: 400 };
    if (session.isRunning) return { error: 'Agent is already running', status: 409 };

    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);
    session.isRunning = true;

    (async () => {
      try {
        for await (const event of session.cortx.run(message)) {
          if (!this.sessions.has(session.id)) break;
          this.broadcast(session, event);
        }
      } catch (e) {
        if (!this.sessions.has(session.id)) return;
        const error = e instanceof Error ? e : new Error(String(e));
        const errEvent: AgentEvent = {
          type: 'error',
          error,
          code: 'stream_error',
        };
        this.broadcast(session, errEvent);
      } finally {
        session.isRunning = false;
      }
    })();

    return null;
  }

  abort(sessionId: string): { error: string; status: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: 'Session not found', status: 404 };
    session.cortx.abort('User aborted via API');
    session.cortx.controller.rejectPendingQuestions('Session aborted');
    return null;
  }

  answer(sessionId: string, toolCallId: string, response: string): { error: string; status: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: 'Session not found', status: 404 };
    session.cortx.controller.answerUser(toolCallId, response);
    const answerEvent: AgentEvent = { type: 'user_answer', toolCallId, response };
    this.broadcast(session, answerEvent);
    return null;
  }

  delete(sessionId: string): { error: string; status: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: 'Session not found', status: 404 };
    this.destroy(session);
    this.logger.info(`[server] Session deleted: ${sessionId}`);
    return null;
  }

  subscribe(sessionId: string, callback: (event: AgentEvent) => void): (() => void) | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.subscribers.add(callback);
    return () => session.subscribers.delete(callback);
  }

  private broadcast(session: ManagedSession, event: AgentEvent): void {
    if (!this.sessions.has(session.id)) return;
    session.events.push(event);
    for (const sub of session.subscribers) {
      try { sub(event); } catch { /* subscriber error, ignore */ }
    }
  }

  private resetIdleTimer(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (this.sessions.has(session.id)) {
        this.logger.info(`[server] Session idle timeout: ${session.id}`);
        this.destroy(session);
      }
    }, this.idleTimeoutMs);
  }

  private destroy(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.cortx.abort('Session cleaned up');
    session.cortx.controller.rejectPendingQuestions('Session destroyed');
    session.subscribers.clear();
    session.isRunning = false;
    this.sessions.delete(session.id);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.destroy(session);
    }
  }
}
