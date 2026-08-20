import type {
  RuntimeDurableRunStore,
  RuntimeEventEnvelopeSnapshot,
  RuntimeSessionSnapshot,
  RuntimeSubAgentSessionSnapshot,
} from '../durable/types.js';
import type { RuntimeEventRetention } from '../session.js';

interface SessionWriterState {
  tail: Promise<void>;
  failure?: Error;
  deleted: boolean;
}

export interface RuntimeJournalCommit {
  snapshot: RuntimeSessionSnapshot;
  envelope?: RuntimeEventEnvelopeSnapshot;
  subAgent?: RuntimeSubAgentSessionSnapshot;
}

export interface RuntimeEventJournalOptions {
  onFailure?: (sessionId: string, error: Error) => void;
  onRetention?: (sessionId: string, retention: RuntimeEventRetention) => void;
}

/**
 * Serializes all durable facts for a session through one FIFO writer.
 * Event append always precedes the snapshot cursor that observes it.
 */
export class RuntimeEventJournal {
  readonly #store?: RuntimeDurableRunStore;
  readonly #states = new Map<string, SessionWriterState>();
  readonly #onFailure?: (sessionId: string, error: Error) => void;
  readonly #onRetention?: (sessionId: string, retention: RuntimeEventRetention) => void;

  constructor(store?: RuntimeDurableRunStore, options: RuntimeEventJournalOptions = {}) {
    this.#store = store;
    this.#onFailure = options.onFailure;
    this.#onRetention = options.onRetention;
  }

  commit(input: RuntimeJournalCommit): Promise<void> {
    if (!this.#store) return Promise.resolve();
    const sessionId = input.snapshot.id;
    return this.#enqueue(sessionId, async () => {
      if (input.envelope && this.#store?.saveEventEnvelope) {
        await this.#store.saveEventEnvelope(input.envelope);
      }
      if (input.subAgent) await this.#store?.saveSubAgentSession(input.subAgent);

      let snapshot = input.snapshot;
      if (this.#store?.getEventEnvelopeRetention) {
        const eventRetention = await this.#store.getEventEnvelopeRetention(sessionId);
        this.#onRetention?.(sessionId, eventRetention);
        snapshot = {
          ...snapshot,
          eventRetention,
        };
      }
      await this.#store?.saveRuntimeSession(snapshot);
    });
  }

  saveSnapshot(snapshot: RuntimeSessionSnapshot): Promise<void> {
    return this.commit({ snapshot });
  }

  async drain(sessionId: string): Promise<void> {
    await this.#states.get(sessionId)?.tail;
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.#states.values()].map((state) => state.tail));
  }

  async delete(sessionId: string): Promise<void> {
    if (!this.#store) return;
    const state = this.#state(sessionId);
    state.deleted = true;
    await state.tail;
    await this.#store.deleteRuntimeSession(sessionId);
  }

  failure(sessionId: string): Error | undefined {
    return this.#states.get(sessionId)?.failure;
  }

  #enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const state = this.#state(sessionId);
    if (state.deleted) return Promise.reject(new Error(`Durable session is deleted: ${sessionId}`));
    if (state.failure) return Promise.reject(state.failure);

    const work = state.tail.then(async () => {
      if (state.deleted) throw new Error(`Durable session is deleted: ${sessionId}`);
      if (state.failure) throw state.failure;
      await operation();
    });
    state.tail = work.then(
      () => undefined,
      (error) => {
        if (!state.failure) {
          state.failure = asError(error);
          this.#onFailure?.(sessionId, state.failure);
        }
      },
    );
    return work;
  }

  #state(sessionId: string): SessionWriterState {
    let state = this.#states.get(sessionId);
    if (!state) {
      state = { tail: Promise.resolve(), deleted: false };
      this.#states.set(sessionId, state);
    }
    return state;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
