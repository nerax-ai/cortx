import type { AgentEvent } from '@cortx/sdk';
import {
  RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeSubAgentSessionSnapshot,
} from '../../durable/types.js';

export interface SubAgentSession {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly parentRunId?: number;
  readonly toolCallId: string;
  readonly description: string;
  readonly isBackground: boolean;
  status: 'running' | 'completed' | 'error' | 'interrupted' | 'cancelled';
  events: AgentEvent[];
  output: string;
  iterations: number;
  toolCallCount: number;
  startedAt: number;
  completedAt?: number;
}

export class SubAgentSessionStore {
  private sessions = new Map<string, SubAgentSession>();
  private aborters = new Map<string, (reason?: string) => void>();
  private pendingAborts = new Map<string, string>();
  private waiters = new Map<string, Set<(session: SubAgentSession) => void>>();
  private changeListeners = new Set<() => void>();
  private readonly maxCompleted: number;

  constructor(maxCompleted = 20) {
    this.maxCompleted = maxCompleted;
  }

  remove(toolCallId: string): void {
    const session = this.sessions.get(toolCallId);
    this.sessions.delete(toolCallId);
    this.aborters.delete(toolCallId);
    this.pendingAborts.delete(toolCallId);
    if (session) this.resolveWaiters(session);
    this.notify();
  }

  create(
    toolCallId: string,
    description: string,
    isBackground: boolean,
    parentSessionId = 'unknown',
    parentRunId?: number,
  ): SubAgentSession {
    const session: SubAgentSession = {
      runId: `${parentSessionId}:${toolCallId}`,
      parentSessionId,
      parentRunId,
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
    return cloneSession(session);
  }

  hydrate(snapshots: RuntimeSubAgentSessionSnapshot[]): void {
    for (const snapshot of snapshots) {
      const wasRunning = snapshot.status === 'running';
      this.sessions.set(snapshot.toolCallId, {
        runId: snapshot.runId,
        parentSessionId: snapshot.parentSessionId,
        parentRunId: snapshot.parentRunId,
        toolCallId: snapshot.toolCallId,
        description: snapshot.description,
        isBackground: snapshot.isBackground,
        status: wasRunning ? 'interrupted' : snapshot.status,
        events: [],
        output: snapshot.output,
        iterations: snapshot.iterations,
        toolCallCount: snapshot.toolCallCount,
        startedAt: snapshot.startedAt,
        completedAt: wasRunning ? Date.now() : snapshot.completedAt,
      });
    }
    this.notify();
  }

  snapshot(toolCallId: string): RuntimeSubAgentSessionSnapshot | undefined {
    const session = this.sessions.get(toolCallId);
    if (!session) return undefined;
    return {
      schemaVersion: RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
      runId: session.runId,
      parentSessionId: session.parentSessionId,
      parentRunId: session.parentRunId,
      toolCallId: session.toolCallId,
      description: session.description,
      isBackground: session.isBackground,
      status: session.status,
      output: session.output,
      iterations: session.iterations,
      toolCallCount: session.toolCallCount,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    };
  }

  registerAbort(toolCallId: string, abort: (reason?: string) => void): void {
    this.aborters.set(toolCallId, abort);
    const pending = this.pendingAborts.get(toolCallId);
    if (pending !== undefined && this.sessions.get(toolCallId)?.status === 'running') {
      this.pendingAborts.delete(toolCallId);
      abort(pending);
    }
  }

  clearAbort(toolCallId: string): void {
    this.aborters.delete(toolCallId);
  }

  recordEvent(toolCallId: string, event: AgentEvent): void {
    const session = this.sessions.get(toolCallId);
    if (!session || session.status !== 'running') return;
    session.events.push(event);
    if (event.type === 'turn_start') session.iterations = event.iteration;
    if (event.type === 'tool_use') session.toolCallCount++;
    if (event.type === 'text') session.output += event.content;
    this.notify();
  }

  async abortRunning(reason = 'parent aborted', timeoutMs = 10_000): Promise<void> {
    const pending: Promise<SubAgentSession>[] = [];
    for (const [toolCallId, session] of [...this.sessions]) {
      if (session.status === 'running') pending.push(this.abort(toolCallId, reason, timeoutMs));
    }
    const results = await Promise.allSettled(pending);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Sub-agent shutdown failed',
      );
  }

  complete(toolCallId: string, isError: boolean): void {
    this.finish(toolCallId, isError ? 'error' : 'completed');
  }

  finish(toolCallId: string, status: Exclude<SubAgentSession['status'], 'running'>): void {
    const session = this.sessions.get(toolCallId);
    if (!session) return;
    session.status = status;
    session.completedAt = Date.now();
    this.aborters.delete(toolCallId);
    this.pendingAborts.delete(toolCallId);
    this.resolveWaiters(session);
    this.evictCompleted();
    this.notify();
  }

  async abort(toolCallId: string, reason = 'child aborted', timeoutMs = 10_000): Promise<SubAgentSession> {
    const session = this.sessions.get(toolCallId);
    if (!session) throw new Error(`Sub-agent session not found: ${toolCallId}`);
    if (session.status !== 'running') return cloneSession(session);
    const wait = this.wait(toolCallId, timeoutMs);
    const aborter = this.aborters.get(toolCallId);
    if (aborter) aborter(reason);
    else this.pendingAborts.set(toolCallId, reason);
    return wait;
  }

  wait(toolCallId: string, timeoutMs = 10_000): Promise<SubAgentSession> {
    const session = this.sessions.get(toolCallId);
    if (!session) return Promise.reject(new Error(`Sub-agent session not found: ${toolCallId}`));
    if (session.status !== 'running') return Promise.resolve(cloneSession(session));
    return new Promise<SubAgentSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(toolCallId);
        waiters?.delete(onDone);
        if (waiters?.size === 0) this.waiters.delete(toolCallId);
        reject(new Error(`Sub-agent did not settle after ${timeoutMs}ms: ${toolCallId}`));
      }, timeoutMs);
      const onDone = (value: SubAgentSession) => {
        clearTimeout(timer);
        resolve(cloneSession(value));
      };
      const waiters = this.waiters.get(toolCallId) ?? new Set();
      waiters.add(onDone);
      this.waiters.set(toolCallId, waiters);
    });
  }

  get(toolCallId: string): SubAgentSession | undefined {
    const session = this.sessions.get(toolCallId);
    return session ? cloneSession(session) : undefined;
  }

  getAll(): ReadonlyMap<string, SubAgentSession> {
    return new Map([...this.sessions].map(([id, session]) => [id, cloneSession(session)]));
  }

  subscribe(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.changeListeners) {
      try {
        fn();
      } catch {
        /* swallow listener errors */
      }
    }
  }

  private evictCompleted(): void {
    const completed: Array<{ id: string; completedAt: number; startedAt: number }> = [];
    for (const [id, s] of this.sessions) {
      if (s.status !== 'running') {
        completed.push({ id, completedAt: s.completedAt ?? s.startedAt, startedAt: s.startedAt });
      }
    }
    const excess = completed.length - this.maxCompleted;
    if (excess <= 0) return;
    completed.sort((a, b) => a.completedAt - b.completedAt || a.startedAt - b.startedAt);
    for (let i = 0; i < excess; i++) {
      this.sessions.delete(completed[i]!.id);
    }
  }

  private resolveWaiters(session: SubAgentSession): void {
    const waiters = this.waiters.get(session.toolCallId);
    if (!waiters) return;
    this.waiters.delete(session.toolCallId);
    for (const resolve of waiters) resolve(session);
  }
}

function cloneSession(session: SubAgentSession): SubAgentSession {
  return {
    ...session,
    events: session.events.map((event) => ({ ...event })),
  };
}
