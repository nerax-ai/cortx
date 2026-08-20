import { RuntimeError } from '../errors.js';
import type { RuntimeRunPhase, RuntimeSessionHealth, SessionProjection } from '../session.js';

export interface SessionSummaryProjection {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  model: string;
  toolProfile: string;
  pluginGeneration: string;
  runtimeIncarnation: string;
  projectionAsOfSequence: number;
  runPhase: RuntimeRunPhase;
  sessionHealth: RuntimeSessionHealth;
  resumable: boolean;
  acceptsPrompt: boolean;
  isRunning: boolean;
}

export interface SessionSummaryBaseline {
  sessions: SessionSummaryProjection[];
  cursor: string;
}

export type SessionSummaryChange =
  | { cursor: string; type: 'added' | 'updated'; sessionId: string; summary: SessionSummaryProjection }
  | { cursor: string; type: 'removed'; sessionId: string };

type PendingSessionSummaryChange =
  | { type: 'added' | 'updated'; sessionId: string; summary: SessionSummaryProjection }
  | { type: 'removed'; sessionId: string };

export interface RuntimeSessionRegistryOptions<TSession extends { id: string }> {
  project(session: TSession): SessionProjection;
  maxChanges?: number;
}

type ChangeSubscriber = (change: SessionSummaryChange) => void;

export class RuntimeSessionRegistry<TSession extends { id: string }> {
  readonly #sessions = new Map<string, TSession>();
  readonly #changes: SessionSummaryChange[] = [];
  readonly #subscribers = new Set<ChangeSubscriber>();
  readonly #project: (session: TSession) => SessionProjection;
  readonly #cursorPrefix = `session-feed:${crypto.randomUUID()}`;
  readonly #maxChanges: number;
  #nextPosition = 0;

  constructor(options: RuntimeSessionRegistryOptions<TSession>) {
    this.#project = options.project;
    this.#maxChanges = positiveLimit(options.maxChanges ?? 4_096);
  }

  get size(): number {
    return this.#sessions.size;
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  get(sessionId: string): TSession | undefined {
    return this.#sessions.get(sessionId);
  }

  require(sessionId: string): TSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new RuntimeError('session_not_found', 'Session not found', { sessionId });
    return session;
  }

  values(): IterableIterator<TSession> {
    return this.#sessions.values();
  }

  add(session: TSession): void {
    if (this.#sessions.has(session.id)) {
      throw new RuntimeError('invalid_request', `Session already exists: ${session.id}`);
    }
    this.#sessions.set(session.id, session);
    this.#publish({ type: 'added', sessionId: session.id, summary: this.#summary(session) });
  }

  changed(session: TSession): void {
    if (this.#sessions.get(session.id) !== session) return;
    this.#publish({ type: 'updated', sessionId: session.id, summary: this.#summary(session) });
  }

  remove(sessionId: string): TSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    this.#sessions.delete(sessionId);
    this.#publish({ type: 'removed', sessionId });
    return session;
  }

  baseline(): SessionSummaryBaseline {
    return {
      sessions: [...this.#sessions.values()].map((session) => this.#summary(session)),
      cursor: this.#cursor(this.#nextPosition),
    };
  }

  changesAfter(cursor: string): SessionSummaryChange[] {
    const position = this.#position(cursor);
    return this.#changes.slice(position - this.#oldestPosition()).map(cloneChange);
  }

  subscribe(cursor: string, callback: ChangeSubscriber): () => void {
    const pending = this.changesAfter(cursor);
    let replaying = true;
    const buffered: SessionSummaryChange[] = [];
    const subscriber: ChangeSubscriber = (change) => {
      if (replaying) buffered.push(change);
      else safeNotify(callback, change);
    };
    this.#subscribers.add(subscriber);
    for (const change of pending) safeNotify(callback, change);
    replaying = false;
    for (const change of buffered) safeNotify(callback, change);
    return () => this.#subscribers.delete(subscriber);
  }

  #summary(session: TSession): SessionSummaryProjection {
    return summarizeSessionProjection(this.#project(session));
  }

  #publish(change: PendingSessionSummaryChange): void {
    const cursor = this.#cursor(++this.#nextPosition);
    const committed = { ...change, cursor } as SessionSummaryChange;
    this.#changes.push(committed);
    if (this.#changes.length > this.#maxChanges) this.#changes.splice(0, this.#changes.length - this.#maxChanges);
    for (const subscriber of this.#subscribers) subscriber(cloneChange(committed));
  }

  #cursor(position: number): string {
    return `${this.#cursorPrefix}:${position}`;
  }

  #position(cursor: string): number {
    const prefix = `${this.#cursorPrefix}:`;
    if (!cursor.startsWith(prefix)) {
      throw new RuntimeError('invalid_request', 'Session feed cursor does not belong to this Runtime', { cursor });
    }
    const position = Number(cursor.slice(prefix.length));
    if (!Number.isSafeInteger(position) || position < 0 || position > this.#nextPosition) {
      throw new RuntimeError('invalid_request', 'Session feed cursor is invalid', { cursor });
    }
    const oldestPosition = this.#oldestPosition();
    if (position < oldestPosition) {
      throw new RuntimeError('invalid_request', 'Session feed cursor expired; fetch a new baseline', {
        cursor,
        resetRequired: true,
        currentCursor: this.#cursor(this.#nextPosition),
        oldestCursor: this.#cursor(oldestPosition),
      });
    }
    return position;
  }

  #oldestPosition(): number {
    return this.#nextPosition - this.#changes.length;
  }
}

export function summarizeSessionProjection(projection: SessionProjection): SessionSummaryProjection {
  return {
    id: projection.id,
    createdAt: projection.createdAt,
    lastActivityAt: projection.lastActivityAt,
    model: projection.model,
    toolProfile: projection.toolProfile,
    pluginGeneration: projection.pluginGeneration,
    runtimeIncarnation: projection.runtimeIncarnation,
    projectionAsOfSequence: projection.projectionAsOfSequence,
    runPhase: projection.runPhase,
    sessionHealth: projection.sessionHealth,
    resumable: projection.resumable,
    acceptsPrompt: projection.acceptsPrompt,
    isRunning: projection.isRunning,
  };
}

function cloneChange(change: SessionSummaryChange): SessionSummaryChange {
  return change.type === 'removed' ? { ...change } : { ...change, summary: { ...change.summary } };
}

function safeNotify(callback: ChangeSubscriber, change: SessionSummaryChange): void {
  try {
    callback(cloneChange(change));
  } catch {
    // One feed consumer must not break registry mutation or other consumers.
  }
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('maxChanges must be a positive integer');
  return value;
}
