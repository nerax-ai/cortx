import type { EffectDisposer } from '@nerax-ai/plugin';
import type { CortxHostScopeKind } from '@cortx/sdk';

type OwnedEffect = {
  dispose: EffectDisposer;
  label?: string;
  state: 'pending' | 'running' | 'failed' | 'done';
  inFlight?: Promise<void>;
};

export class CortxHostScope {
  readonly signal: AbortSignal;
  readonly kind: CortxHostScopeKind;
  readonly name: string;
  readonly #controller = new AbortController();
  readonly #effects: OwnedEffect[] = [];
  readonly #cleanupTimeoutMs: number;
  readonly #parentSignal?: AbortSignal;
  readonly #onParentAbort: () => void;
  #closed = false;
  #cleanupWork?: Promise<void>;

  constructor(
    name: string,
    kind: CortxHostScopeKind,
    parentSignal?: AbortSignal,
    cleanupTimeoutMs = 10_000,
  ) {
    this.name = name;
    this.kind = kind;
    this.signal = this.#controller.signal;
    this.#parentSignal = parentSignal;
    this.#cleanupTimeoutMs = positiveTimeout(cleanupTimeoutMs);
    this.#onParentAbort = () => this.abort(parentSignal?.reason);
    if (parentSignal?.aborted) this.abort(parentSignal.reason);
    else parentSignal?.addEventListener('abort', this.#onParentAbort, { once: true });
  }

  get active(): boolean {
    return !this.#closed && !this.signal.aborted;
  }

  abort(reason?: unknown): void {
    void this.close(reason).catch(() => undefined);
  }

  child(name: string, kind: CortxHostScopeKind, cleanupTimeoutMs = this.#cleanupTimeoutMs): CortxHostScope {
    const child = new CortxHostScope(name, kind, this.signal, cleanupTimeoutMs);
    this.defer(() => child.close(new Error(`Parent scope closed: ${this.name}`)), `child:${name}`);
    return child;
  }

  defer(dispose: EffectDisposer, label?: string): void {
    if (!this.active) throw new Error(`Cortx host scope is closed: ${this.name}`);
    this.#effects.push({ dispose, label, state: 'pending' });
  }

  async acquire<T>(
    acquire: (signal: AbortSignal) => T | Promise<T>,
    dispose: (resource: T) => void | Promise<void>,
    label?: string,
  ): Promise<T> {
    if (!this.active) throw new Error(`Cortx host scope is closed: ${this.name}`);
    const resource = await acquire(this.signal);
    if (!this.active) {
      await dispose(resource);
      throw new Error(`Cortx host scope closed during acquisition: ${this.name}`);
    }
    this.defer(() => dispose(resource), label);
    return resource;
  }

  close(reason?: unknown): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#parentSignal?.removeEventListener('abort', this.#onParentAbort);
      this.#controller.abort(reason);
      this.#startCleanup(false);
    }
    return this.#awaitCleanup();
  }

  retryFailedCleanup(): Promise<void> {
    if (!this.#closed) throw new Error(`Cannot retry cleanup for an active scope: ${this.name}`);
    if (!this.#cleanupWork && this.#effects.some((effect) => effect.state === 'failed')) this.#startCleanup(true);
    return this.#awaitCleanup();
  }

  async #runCleanup(retryOnly: boolean): Promise<void> {
    const failures: unknown[] = [];
    for (const effect of [...this.#effects].reverse()) {
      if (effect.state === 'done' || (retryOnly && effect.state !== 'failed')) continue;
      try {
        await this.#disposeEffect(effect);
      } catch (error) {
        failures.push(effect.label ? new Error(`${effect.label}: ${asError(error).message}`) : error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Cortx host scope cleanup failed: ${this.name}`);
    }
  }

  #failedResult(): Promise<void> {
    return this.#effects.some((effect) => effect.state === 'failed')
      ? Promise.reject(new Error(`Cortx host scope has failed cleanup: ${this.name}`))
      : this.#effects.some((effect) => effect.state !== 'done')
        ? Promise.reject(new Error(`Cortx host scope cleanup is incomplete: ${this.name}`))
      : Promise.resolve();
  }

  #startCleanup(retryOnly: boolean): void {
    const work = this.#runCleanup(retryOnly);
    this.#cleanupWork = work;
    void work.finally(() => {
      if (this.#cleanupWork === work) this.#cleanupWork = undefined;
    }).catch(() => undefined);
  }

  #awaitCleanup(): Promise<void> {
    const work = this.#cleanupWork;
    return work ? withCleanupTimeout(work, this.#cleanupTimeoutMs, this.name) : this.#failedResult();
  }

  #disposeEffect(effect: OwnedEffect): Promise<void> {
    if (effect.state === 'done') return Promise.resolve();
    if (effect.inFlight) return effect.inFlight;
    effect.state = 'running';
    const work = Promise.resolve()
      .then(() => effect.dispose())
      .then(() => {
        effect.state = 'done';
      }, (error) => {
        effect.state = 'failed';
        throw error;
      })
      .finally(() => {
        if (effect.inFlight === work) effect.inFlight = undefined;
      });
    effect.inFlight = work;
    return work;
  }
}

function withCleanupTimeout(work: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Cortx host cleanup stuck after ${timeoutMs}ms: ${label}`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function positiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('cleanupTimeoutMs must be positive');
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
