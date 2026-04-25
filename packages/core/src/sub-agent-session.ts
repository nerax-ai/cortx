import type { AgentEvent } from '@cortx/sdk';

export interface SubAgentSession {
  readonly toolCallId: string;
  readonly description: string;
  readonly isBackground: boolean;
  status: 'running' | 'completed' | 'error';
  events: AgentEvent[];
  output: string;
  iterations: number;
  toolCallCount: number;
  startedAt: number;
  completedAt?: number;
}

export class SubAgentSessionStore {
  private sessions = new Map<string, SubAgentSession>();
  private changeListeners = new Set<() => void>();
  private readonly maxCompleted: number;

  constructor(maxCompleted = 20) {
    this.maxCompleted = maxCompleted;
  }

  remove(toolCallId: string): void {
    this.sessions.delete(toolCallId);
    this.notify();
  }

  create(toolCallId: string, description: string, isBackground: boolean): SubAgentSession {
    const session: SubAgentSession = {
      toolCallId,
      description,
      isBackground,
      status: 'running',
      events: [],
      output: '',
      iterations: 0,
      toolCallCount: 0,
      startedAt: Date.now(),
    };
    this.sessions.set(toolCallId, session);
    this.notify();
    return session;
  }

  complete(toolCallId: string, isError: boolean): void {
    const session = this.sessions.get(toolCallId);
    if (!session) return;
    session.status = isError ? 'error' : 'completed';
    session.completedAt = Date.now();
    this.evictCompleted();
    this.notify();
  }

  get(toolCallId: string): SubAgentSession | undefined {
    return this.sessions.get(toolCallId);
  }

  getAll(): ReadonlyMap<string, SubAgentSession> {
    return this.sessions;
  }

  subscribe(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.changeListeners) {
      try { fn(); } catch { /* swallow listener errors */ }
    }
  }

  private evictCompleted(): void {
    const completed: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.status === 'completed' || s.status === 'error') completed.push(id);
    }
    const excess = completed.length - this.maxCompleted;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      this.sessions.delete(completed[i]);
    }
  }
}
