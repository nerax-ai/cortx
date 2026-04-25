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

  pushEvent(toolCallId: string, event: AgentEvent): void {
    const session = this.sessions.get(toolCallId);
    if (!session) return;
    session.events.push(event);
    if (event.type === 'turn_start') session.iterations = event.iteration;
    if (event.type === 'tool_use') session.toolCallCount++;
    if (event.type === 'text') session.output += event.content;
  }

  complete(toolCallId: string, isError: boolean): void {
    const session = this.sessions.get(toolCallId);
    if (!session) return;
    session.status = isError ? 'error' : 'completed';
    session.completedAt = Date.now();
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
    for (const fn of this.changeListeners) fn();
  }
}
