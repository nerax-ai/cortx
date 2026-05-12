import type { AgentEvent } from '@cortx/sdk';
import type { Cortx } from '@cortx/core';
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
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly language: LanguageClient;
  private readonly model: string;
  private readonly system?: string;
  private readonly logger: Logger;

  constructor(opts: {
    maxSessions?: number;
    idleTimeoutMs?: number;
    language: LanguageClient;
    model: string;
    system?: string;
    logger: Logger;
  }) {
    this.maxSessions = opts.maxSessions ?? 10;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    this.language = opts.language;
    this.model = opts.model;
    this.system = opts.system;
    this.logger = opts.logger;
  }

  async create(): Promise<{ id: string } | { error: string; status: number }> {
    if (this.sessions.size >= this.maxSessions) {
      return { error: 'Maximum concurrent sessions reached', status: 429 };
    }

    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cortx = new CortxClass(this.language, {
      model: this.model,
      system: this.system,
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
    };

    // Wire onAgentEvent to capture sub-agent events
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

    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session);

    // Run agent loop in background, streaming events
    (async () => {
      try {
        for await (const event of session.cortx.run(message)) {
          this.broadcast(session, event);
        }
      } catch (e) {
        const errEvent: AgentEvent = {
          type: 'error',
          error: e instanceof Error ? e : new Error(String(e)),
          code: 'stream_error',
        };
        this.broadcast(session, errEvent);
      }
    })();

    return null;
  }

  abort(sessionId: string): { error: string; status: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: 'Session not found', status: 404 };
    session.cortx.abort('User aborted via API');
    return null;
  }

  answer(sessionId: string, toolCallId: string, response: string): { error: string; status: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: 'Session not found', status: 404 };
    session.cortx.controller.answerUser(toolCallId, response);
    // Emit user_answer event for store consumers
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
    session.events.push(event);
    for (const sub of session.subscribers) {
      try { sub(event); } catch { /* subscriber error, ignore */ }
    }
  }

  private resetIdleTimer(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.logger.info(`[server] Session idle timeout: ${session.id}`);
      this.destroy(session);
    }, this.idleTimeoutMs);
  }

  private destroy(session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.cortx.abort('Session cleaned up');
    session.subscribers.clear();
    this.sessions.delete(session.id);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.destroy(session);
    }
  }
}
