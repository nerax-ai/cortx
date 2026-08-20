import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  AgentEvent,
  RuntimeAgentEventEnvelope,
  RuntimeAgentStreamEnvelope,
} from '@cortx/sdk';
import type {
  CortxRuntime,
  RuntimeSessionInfo,
  SessionSummaryChange,
  SessionSummaryProjection,
} from '@cortx/runtime';
import { getAuthPrincipal } from '../auth.js';
import {
  errorResponse,
  parseOptionalLimit,
  parseOptionalSequence,
} from '../http.js';

export interface SessionFeedLimits {
  maxConnectionsGlobal?: number;
  maxConnectionsPerPrincipal?: number;
  maxBufferedFramesPerConnection?: number;
}

export interface EventRouteDependencies {
  runtime: CortxRuntime;
  authorizeSession(c: Context, sessionId: string): Promise<RuntimeSessionInfo>;
  canReadSummary(c: Context, summary: SessionSummaryProjection): boolean;
  serializeEvent(event: AgentEvent): string;
  serializeEnvelope(envelope: RuntimeAgentStreamEnvelope): string;
  serializeEventData(event: AgentEvent): AgentEvent;
  serializeEnvelopeData(envelope: RuntimeAgentEventEnvelope): RuntimeAgentEventEnvelope;
  hydrateHistory(
    envelopes: RuntimeAgentEventEnvelope[],
    workingDirectory: string,
  ): Promise<RuntimeAgentEventEnvelope[]>;
  limits?: SessionFeedLimits;
}

export const EVENT_ENDPOINT_POLICIES = [
  { method: 'GET', path: '/sessions/feed/baseline', access: 'principal-filtered' },
  { method: 'GET', path: '/sessions/feed', access: 'principal-filtered' },
  { method: 'GET', path: '/sessions/:id/events/history', access: 'creator-or-admin' },
  { method: 'GET', path: '/sessions/:id/events', access: 'creator-or-admin' },
] as const;

const DEFAULT_MAX_GLOBAL_CONNECTIONS = 128;
const DEFAULT_MAX_PRINCIPAL_CONNECTIONS = 8;
const DEFAULT_MAX_BUFFERED_FRAMES = 256;

export function mountEventRoutes(app: Hono, deps: EventRouteDependencies): void {
  const limiter = new PrincipalConnectionLimiter(
    deps.limits?.maxConnectionsGlobal ?? DEFAULT_MAX_GLOBAL_CONNECTIONS,
    deps.limits?.maxConnectionsPerPrincipal ?? DEFAULT_MAX_PRINCIPAL_CONNECTIONS,
  );
  const maxBufferedFrames = deps.limits?.maxBufferedFramesPerConnection ?? DEFAULT_MAX_BUFFERED_FRAMES;

  app.get('/sessions/feed/baseline', async (c) => {
    try {
      const baseline = deps.runtime.getSessionSummaryBaseline();
      return c.json({
        runtimeIncarnation: deps.runtime.runtimeIncarnation,
        cursor: baseline.cursor,
        sessions: baseline.sessions.filter((summary) => deps.canReadSummary(c, summary)).map(publicSummary),
      });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get('/sessions/feed', async (c) => {
    const principalId = getAuthPrincipal(c)?.id ?? 'anonymous';
    const after = c.req.query('after') ?? deps.runtime.getSessionSummaryBaseline().cursor;
    const release = limiter.acquire(principalId);
    if (!release) {
      return c.json(
        { error: 'Session feed connection limit reached', kind: 'capacity_exceeded' },
        429,
      );
    }

    return streamSSE(c, async (stream) => {
      const queue = new BoundedAsyncQueue<SessionSummaryChange>(maxBufferedFrames);
      let unsubscribe: (() => void) | undefined;
      let overflowed = false;
      const abort = () => {
        unsubscribe?.();
        queue.close();
      };
      stream.onAbort(abort);

      try {
        try {
          unsubscribe = deps.runtime.subscribeSessionSummaries(after, (change) => {
            if (!deps.canReadSummary(c, change.summary)) return;
            if (!queue.push(change)) {
              overflowed = true;
              unsubscribe?.();
              queue.close();
            }
          });
        } catch (error) {
          const details = errorResponse(error).body.details;
          await writeFrame(stream, 'reset-required', {
            reason: 'cursor-expired',
            runtimeIncarnation: deps.runtime.runtimeIncarnation,
            currentCursor: details?.currentCursor,
          });
          return;
        }

        for (const change of queue.drain()) {
          await writeFrame(stream, 'session-change', publicChange(change), change.cursor);
        }
        await writeFrame(stream, 'replay-complete', {
          runtimeIncarnation: deps.runtime.runtimeIncarnation,
          cursor: deps.runtime.getSessionSummaryBaseline().cursor,
        });

        while (!overflowed) {
          const change = await queue.next(15_000);
          if (!change) {
            if (queue.isClosed) break;
            await writeFrame(stream, 'heartbeat', {
              runtimeIncarnation: deps.runtime.runtimeIncarnation,
              timestamp: Date.now(),
            });
            continue;
          }
          await writeFrame(stream, 'session-change', publicChange(change), change.cursor);
        }
        if (overflowed) {
          await writeFrame(stream, 'reset-required', {
            reason: 'buffer-overflow',
            runtimeIncarnation: deps.runtime.runtimeIncarnation,
          });
        }
      } catch {
        // Reader closed while a frame was in flight.
      } finally {
        unsubscribe?.();
        queue.close();
        release();
      }
    });
  });

  app.get('/sessions/:id/events/history', async (c) => {
    const id = c.req.param('id');
    try {
      const session = await deps.authorizeSession(c, id);
      const useEnvelope = c.req.query('format') === 'envelope';
      const afterSequence = parseOptionalSequence(c.req.query('after'), 'after');
      const beforeSequence = parseOptionalSequence(c.req.query('before'), 'before');
      const limit = parseOptionalLimit(c.req.query('limit'));
      const oldest = session.eventRetention.oldestAvailableSequence;
      const resetRequired = afterSequence !== undefined && oldest !== null && afterSequence < oldest - 1;

      if (useEnvelope) {
        const page = await deps.runtime.getEventEnvelopeHistoryPage(id, { afterSequence, beforeSequence, limit });
        const events = resetRequired
          ? []
          : (await deps.hydrateHistory(page.events, session.workingDirectory)).map(deps.serializeEnvelopeData);
        return c.json({
          events,
          runtimeIncarnation: deps.runtime.runtimeIncarnation,
          retention: session.eventRetention,
          resetRequired,
          replayComplete: !resetRequired,
          page: {
            hasMoreBefore: page.hasMoreBefore,
            hasMoreAfter: page.hasMoreAfter,
            firstSequence: page.events[0]?.sequence,
            lastSequence: page.events.at(-1)?.sequence,
          },
        });
      }

      return c.json({
        events: deps.runtime.getEventHistory(id).map(deps.serializeEventData),
        runtimeIncarnation: deps.runtime.runtimeIncarnation,
        retention: session.eventRetention,
        resetRequired,
        replayComplete: !resetRequired,
      });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get('/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    let session: RuntimeSessionInfo;
    let afterSequence: number | undefined;
    try {
      session = await deps.authorizeSession(c, id);
      afterSequence = parseOptionalSequence(c.req.query('after'), 'after');
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }

    const useEnvelope = c.req.query('format') === 'envelope';
    const framed = c.req.query('protocol') === 'frames';
    const replay = c.req.query('replay') !== 'false';
    const oldest = session.eventRetention.oldestAvailableSequence;

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | undefined;
      stream.onAbort(() => unsubscribe?.());

      try {
        if (afterSequence !== undefined && oldest !== null && afterSequence < oldest - 1) {
          await writeFrame(stream, 'reset-required', {
            reason: 'history-truncated',
            runtimeIncarnation: deps.runtime.runtimeIncarnation,
            retention: session.eventRetention,
          });
          return;
        }

        if (!useEnvelope) {
          await streamLegacyEvents(stream, deps, id, replay, (value) => {
            unsubscribe = value;
          });
          return;
        }

        const queue = new BoundedAsyncQueue<RuntimeAgentStreamEnvelope>(maxBufferedFrames);
        let overflowed = false;
        unsubscribe = deps.runtime.subscribeStream(id, (item) => {
          if (!queue.push(item)) {
            overflowed = true;
            unsubscribe?.();
            queue.close();
          }
        }, { replay: false });

        const history = deps.runtime.getEventEnvelopeHistory(id).filter((event) => {
          if (afterSequence !== undefined && event.sequence <= afterSequence) return false;
          return replay || afterSequence !== undefined;
        });
        let lastSequence = afterSequence ?? 0;
        for (const envelope of history) {
          await writeStreamItem(stream, deps, envelope, framed);
          lastSequence = Math.max(lastSequence, envelope.sequence);
        }
        for (const item of queue.drain()) {
          if ('sequence' in item && item.sequence <= lastSequence) continue;
          await writeStreamItem(stream, deps, item, framed);
          if ('sequence' in item) lastSequence = item.sequence;
        }

        if (framed) {
          await writeFrame(stream, 'replay-complete', {
            runtimeIncarnation: deps.runtime.runtimeIncarnation,
            lastSequence,
            retention: session.eventRetention,
          });
        } else {
          await stream.writeSSE({ data: '{}' });
        }

        while (!overflowed) {
          const item = await queue.next(15_000);
          if (!item) {
            if (queue.isClosed) break;
            if (framed) {
              await writeFrame(stream, 'heartbeat', { timestamp: Date.now(), lastSequence });
            } else {
              await stream.writeSSE({ data: '{}' });
            }
            continue;
          }
          if ('sequence' in item && item.sequence <= lastSequence) continue;
          await writeStreamItem(stream, deps, item, framed);
          if ('sequence' in item) lastSequence = item.sequence;
        }
        if (overflowed) {
          await writeFrame(stream, 'reset-required', {
            reason: 'buffer-overflow',
            runtimeIncarnation: deps.runtime.runtimeIncarnation,
            lastSequence,
          });
        }
      } catch {
        // Stream closed or timed out.
      } finally {
        unsubscribe?.();
      }
    });
  });
}

async function streamLegacyEvents(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  deps: EventRouteDependencies,
  sessionId: string,
  replay: boolean,
  setUnsubscribe: (unsubscribe: () => void) => void,
): Promise<void> {
  const queue = new BoundedAsyncQueue<AgentEvent>(DEFAULT_MAX_BUFFERED_FRAMES);
  setUnsubscribe(deps.runtime.subscribe(sessionId, (event) => {
    queue.push(event);
  }, { replay: false }));
  let sequence = 0;
  if (replay) {
    for (const event of deps.runtime.getEventHistory(sessionId)) {
      await stream.writeSSE({ data: deps.serializeEvent(event), id: String(++sequence) });
    }
  }
  for (const event of queue.drain()) {
    await stream.writeSSE({ data: deps.serializeEvent(event), id: String(++sequence) });
  }
  await stream.writeSSE({ data: '{}' });
  while (true) {
    const event = await queue.next(15_000);
    if (!event) {
      if (queue.isClosed) return;
      await stream.writeSSE({ data: '{}' });
      continue;
    }
    await stream.writeSSE({ data: deps.serializeEvent(event), id: String(++sequence) });
  }
}

async function writeStreamItem(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  deps: EventRouteDependencies,
  item: RuntimeAgentStreamEnvelope,
  framed: boolean,
): Promise<void> {
  if (!framed) {
    await stream.writeSSE({
      data: deps.serializeEnvelope(item),
      id: 'sequence' in item ? `e:${item.sequence}` : `f:${item.runId}:${item.offset}`,
    });
    return;
  }
  if ('sequence' in item) {
    await writeFrame(stream, 'durable-event', { envelope: deps.serializeEnvelopeData(item) }, `e:${item.sequence}`);
  } else {
    await writeFrame(stream, 'stream-frame', { frame: JSON.parse(deps.serializeEnvelope(item)) }, `f:${item.runId}:${item.offset}`);
  }
}

async function writeFrame(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  type: string,
  payload: Record<string, unknown>,
  id?: string,
): Promise<void> {
  await stream.writeSSE({ data: JSON.stringify({ type, ...payload }), ...(id ? { id } : {}) });
}

function publicSummary(
  summary: SessionSummaryProjection,
): Omit<SessionSummaryProjection, 'creatorPrincipalId' | 'workingDirectory'> {
  const {
    creatorPrincipalId: _creatorPrincipalId,
    workingDirectory: _workingDirectory,
    ...visible
  } = summary;
  return visible;
}

function publicChange(change: SessionSummaryChange): Record<string, unknown> {
  return change.type === 'removed'
    ? { cursor: change.cursor, changeType: change.type, sessionId: change.sessionId }
    : {
        cursor: change.cursor,
        changeType: change.type,
        sessionId: change.sessionId,
        summary: publicSummary(change.summary),
      };
}

class PrincipalConnectionLimiter {
  readonly #byPrincipal = new Map<string, number>();
  #total = 0;

  constructor(
    readonly maxGlobal: number,
    readonly maxPerPrincipal: number,
  ) {}

  acquire(principalId: string): (() => void) | undefined {
    const current = this.#byPrincipal.get(principalId) ?? 0;
    if (this.#total >= this.maxGlobal || current >= this.maxPerPrincipal) return undefined;
    this.#total++;
    this.#byPrincipal.set(principalId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total--;
      const next = (this.#byPrincipal.get(principalId) ?? 1) - 1;
      if (next > 0) this.#byPrincipal.set(principalId, next);
      else this.#byPrincipal.delete(principalId);
    };
  }
}

class BoundedAsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(value: T | undefined) => void> = [];
  #closed = false;

  constructor(readonly capacity: number) {}

  get isClosed(): boolean {
    return this.#closed;
  }

  push(value: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(value);
      return true;
    }
    if (this.#items.length >= this.capacity) return false;
    this.#items.push(value);
    return true;
  }

  drain(): T[] {
    return this.#items.splice(0);
  }

  async next(timeoutMs: number): Promise<T | undefined> {
    const value = this.#items.shift();
    if (value !== undefined) return value;
    if (this.#closed) return undefined;
    return new Promise<T | undefined>((resolve) => {
      let settled = false;
      const done = (next: T | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.#waiters.indexOf(done);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve(next);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.#waiters.push(done);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }
}
