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
  private aborters = new Map<string, (reason?: string) => void>();
  private changeListeners = new Set<() => void>();
  private readonly maxCompleted: number;

  constructor(maxCompleted = 20) {
    this.maxCompleted = maxCompleted;
  }

  remove(toolCallId: string): void {
    this.sessions.delete(toolCallId);
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
    return session;
  }

  hydrate(snapshots: RuntimeSubAgentSessionSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.sessions.set(snapshot.toolCallId, {
        runId: snapshot.runId,
        parentSessionId: snapshot.parentSessionId,
        parentRunId: snapshot.parentRunId,
        toolCallId: snapshot.toolCallId,
        description: snapshot.description,
        isBackground: snapshot.isBackground,
        status: snapshot.status,
        events: [],
        output: snapshot.output,
        iterations: snapshot.iterations,
        toolCallCount: snapshot.toolCallCount,
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt,
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
  }

  clearAbort(toolCallId: string): void {
    this.aborters.delete(toolCallId);
  }

  abortRunning(reason = 'parent aborted'): void {
    for (const [toolCallId, abort] of [...this.aborters]) {
      if (this.sessions.get(toolCallId)?.status === 'running') {
        abort(reason);
      }
    }
  }

  complete(toolCallId: string, isError: boolean): void {
    const session = this.sessions.get(toolCallId);
    if (!session) return;
    session.status = isError ? 'error' : 'completed';
    session.completedAt = Date.now();
    this.aborters.delete(toolCallId);
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
      try {
        fn();
      } catch {
        /* swallow listener errors */
      }
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
