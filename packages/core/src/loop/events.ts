import type { AgentEvent, AgentRuntimeExtensions, Logger } from '@cortx/sdk';

export class AgentEventQueue {
  private readonly events: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.events.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()!({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<AgentEvent>> {
    const event = this.events.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export async function emit(extensions: AgentRuntimeExtensions, event: AgentEvent, logger: Logger): Promise<void> {
  const observerLogger = logger.scope('agent.eventObserver');
  for (const observer of extensions.eventObservers) {
    try {
      await observer.onAgentEvent(event);
    } catch (error) {
      observerLogger.warn(`agent.eventObserver failed for ${event.type}`, error);
    }
  }
}

export async function* drainQueuedEvents<T>(
  operation: Promise<T>,
  queue: AgentEventQueue,
  extensions: AgentRuntimeExtensions,
  logger: Logger,
): AsyncGenerator<AgentEvent, T> {
  let settled: { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | undefined;
  operation.then(
    (value) => {
      settled = { status: 'fulfilled', value };
      queue.close();
    },
    (reason) => {
      settled = { status: 'rejected', reason };
      queue.close();
    },
  );

  while (true) {
    const next = await queue.next();
    if (next.done) break;
    await emit(extensions, next.value, logger);
    yield next.value;
  }

  if (!settled) {
    settled = await operation.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );
  }
  if (settled.status === 'rejected') throw settled.reason;
  return settled.value;
}
