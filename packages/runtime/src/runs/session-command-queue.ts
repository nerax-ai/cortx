import { RuntimeError } from '../errors.js';

export class SessionCommandQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #sealed = new Set<string>();
  #sealedAll = false;

  get size(): number {
    return this.#tails.size;
  }

  run<T>(sessionId: string, command: () => T | Promise<T>): Promise<T> {
    if (this.#sealedAll || this.#sealed.has(sessionId)) {
      return Promise.reject(new RuntimeError('invalid_request', 'Session command boundary is closed', { sessionId }));
    }
    return this.runInternal(sessionId, command);
  }

  runInternal<T>(sessionId: string, command: () => T | Promise<T>): Promise<T> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(command, command);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
    });
    return result;
  }

  seal(sessionId: string): Promise<void> {
    this.#sealed.add(sessionId);
    return this.drain(sessionId);
  }

  sealAll(): Promise<void> {
    this.#sealedAll = true;
    return this.drainAll();
  }

  open(sessionId: string): void {
    if (this.#sealedAll) throw new RuntimeError('invalid_request', 'Runtime command boundary is closed');
    this.#sealed.delete(sessionId);
  }

  async drain(sessionId: string): Promise<void> {
    await this.#tails.get(sessionId);
  }

  async drainAll(): Promise<void> {
    await Promise.all(this.#tails.values());
  }
}
