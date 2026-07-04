import type { AgentEvent } from '@cortx/sdk';
import type {
  AgentState,
  AgentSelector,
  SelectorSubscription,
  TurnEntry,
} from './types.js';
import { reduceAgentEvent } from './reducer.js';

interface SelectorEntry {
  listeners: Set<() => void>;
  lastValue: unknown;
}

/**
 * UI-agnostic reactive state store for agent events.
 *
 * Ingests AgentEvents via dispatch() and exposes selector-based subscriptions.
 * This is a plain TypeScript class with no framework dependency — consumers use
 * `useSyncExternalStore` or equivalent to subscribe.
 */
export class AgentStore {
  protected state: AgentState;
  protected turnStartTime = 0;
  protected totalStartTime = 0;
  private selectorSubs: Map<AgentSelector<unknown>, SelectorEntry> = new Map();
  private changeListeners = new Set<() => void>();

  constructor() {
    this.state = this.createInitialState();
  }

  protected createInitialState(): AgentState {
    return {
      sessionId: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messages: { turns: [], currentText: '', currentThinking: '' },
      iteration: 0,
      toolCalls: new Map(),
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalElapsed: 0,
      elapsed: 0,
      status: 'idle',
      error: undefined,
      agentSessions: new Map(),
      pendingQuestion: null,
    };
  }

  /** Read-only snapshot of the current state. */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /**
   * Create a selector-based subscription.
   *
   * Returns { get(), subscribe(listener) } where listener is called only
   * when the selector result changes (shallow equality).
   */
  select<T>(selector: AgentSelector<T>): SelectorSubscription<T> {
    const existing = this.selectorSubs.get(selector as AgentSelector<unknown>);
    if (existing) {
      return {
        get: () => selector(this.state),
        subscribe: (listener: () => void) => {
          existing.listeners.add(listener);
          return () => {
            existing.listeners.delete(listener);
            if (existing.listeners.size === 0) {
              this.selectorSubs.delete(selector as AgentSelector<unknown>);
            }
          };
        },
      };
    }

    const entry: SelectorEntry = {
      listeners: new Set<() => void>(),
      lastValue: selector(this.state),
    };
    this.selectorSubs.set(selector as AgentSelector<unknown>, entry);

    return {
      get: () => selector(this.state),
      subscribe: (listener: () => void) => {
        entry.listeners.add(listener);
        return () => {
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) {
            this.selectorSubs.delete(selector as AgentSelector<unknown>);
          }
        };
      },
    };
  }

  /**
   * Ingest an AgentEvent and update the relevant state slice.
   * Synchronous and lightweight.
   */
  dispatch(event: AgentEvent): void {
    const result = reduceAgentEvent(this.state, event, {
      turnStartTime: this.turnStartTime,
      totalStartTime: this.totalStartTime,
    });
    this.state = result.state;
    this.turnStartTime = result.turnStartTime;
    this.totalStartTime = result.totalStartTime;
    this.notifySelectors();
  }

  /**
   * Add a user message to the turns list (called before prompting).
   */
  addUserMessage(text: string): void {
    const prev = this.state.messages;
    this.state = {
      ...this.state,
      messages: {
        ...prev,
        turns: [...prev.turns, { role: 'user', content: text, timestamp: Date.now() } satisfies TurnEntry],
      },
    };
    this.notifySelectors();
  }

  /**
   * Set the session ID (used during session restore).
   */
  setSessionId(sessionId: string): void {
    this.state = { ...this.state, sessionId };
    this.notifySelectors();
  }

  /**
   * Reset the store to initial state.
   * Generates a new session ID unless one is provided.
   */
  reset(sessionId?: string): void {
    this.turnStartTime = 0;
    this.totalStartTime = 0;
    this.state = {
      sessionId: sessionId ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messages: { turns: [], currentText: '', currentThinking: '' },
      iteration: 0,
      toolCalls: new Map(),
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalElapsed: 0,
      elapsed: 0,
      status: 'idle',
      error: undefined,
      agentSessions: new Map(),
      pendingQuestion: null,
    };
    this.notifySelectors();
  }

  /**
   * Dispose of the store — clear all subscriptions.
   */
  dispose(): void {
    this.selectorSubs.clear();
    this.changeListeners.clear();
  }

  /**
   * Subscribe to any state change. Fires on every dispatch that modifies state.
   * Returns an unsubscribe function.
   */
  onChange(callback: () => void): () => void {
    this.changeListeners.add(callback);
    return () => { this.changeListeners.delete(callback); };
  }

  /**
   * Notify all selector subscriptions whose value has changed.
   */
  protected notifySelectors(): void {
    for (const [selector, entry] of this.selectorSubs) {
      const newValue = selector(this.state);
      if (!shallowEqual(newValue, entry.lastValue)) {
        entry.lastValue = newValue;
        const listeners = [...entry.listeners];
        for (const listener of listeners) {
          listener();
        }
      }
    }
    const changeListeners = [...this.changeListeners];
    for (const cb of changeListeners) {
      cb();
    }
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || b.get(key) !== val) return false;
    }
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      (a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]
    ) {
      return false;
    }
  }
  return true;
}
