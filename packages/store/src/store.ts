import type { AgentEvent } from '@cortx/sdk';
import type {
  AgentState,
  AgentSelector,
  SelectorSubscription,
  TurnEntry,
  ToolCallEntry,
  TokenUsage,
  AgentSessionSummary,
} from './types.js';

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

  constructor() {
    this.state = {
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
    switch (event.type) {
      case 'turn_start': {
        const prev = this.state.messages;
        let turns = [...prev.turns];
        const turnDuration = this.turnStartTime > 0 ? (Date.now() - this.turnStartTime) / 1000 : 0;
        if (prev.currentText.length > 0) {
          turns = [...turns, { role: 'assistant', content: prev.currentText, timestamp: Date.now(), duration: turnDuration } satisfies TurnEntry];
        } else if (turnDuration > 0 && turns.length > 0) {
          const last = turns[turns.length - 1];
          if (!last.duration) turns[turns.length - 1] = { ...last, duration: turnDuration };
        }
        const prevElapsed = this.turnStartTime > 0 ? this.state.elapsed : 0;
        this.state = {
          ...this.state,
          iteration: event.iteration,
          status: 'running',
          messages: { turns, currentText: '', currentThinking: '' },
          toolCalls: new Map(),
          totalElapsed: this.state.totalElapsed + prevElapsed,
          elapsed: 0,
          error: undefined,
        };
        this.turnStartTime = Date.now();
        if (this.totalStartTime === 0) this.totalStartTime = Date.now();
        break;
      }

      case 'text_delta': {
        this.state = {
          ...this.state,
          messages: {
            ...this.state.messages,
            currentText: this.state.messages.currentText + event.delta,
          },
        };
        break;
      }

      case 'thinking_delta': {
        this.state = {
          ...this.state,
          messages: {
            ...this.state.messages,
            currentThinking: this.state.messages.currentThinking + event.delta,
          },
        };
        break;
      }

      case 'text': {
        this.state = {
          ...this.state,
          messages: {
            ...this.state.messages,
            currentText: event.content,
          },
        };
        break;
      }

      case 'thinking': {
        this.state = {
          ...this.state,
          messages: {
            ...this.state.messages,
            currentThinking: event.content,
          },
        };
        break;
      }

      case 'tool_use': {
        const prevTU = this.state.messages;
        const turnsTU =
          prevTU.currentText.length > 0
            ? [...prevTU.turns, { role: 'assistant', content: prevTU.currentText, timestamp: Date.now() } satisfies TurnEntry]
            : prevTU.turns;
        const newToolCalls = new Map(this.state.toolCalls);
        newToolCalls.set(event.toolCall.toolCallId, {
          toolName: event.toolCall.toolName,
          input: event.toolCall.input,
          status: 'pending' as const,
        } satisfies ToolCallEntry);
        this.state = {
          ...this.state,
          messages: { turns: turnsTU, currentText: '', currentThinking: '' },
          toolCalls: newToolCalls,
        };
        break;
      }

      case 'tool_progress': {
        const newToolCalls = new Map(this.state.toolCalls);
        const entry = newToolCalls.get(event.toolCallId);
        if (entry) {
          newToolCalls.set(event.toolCallId, {
            ...entry,
            progress: event.text,
          });
          this.state = { ...this.state, toolCalls: newToolCalls };
        }
        break;
      }

      case 'tool_result': {
        const newToolCalls = new Map(this.state.toolCalls);
        const entry = newToolCalls.get(event.toolCallId);
        if (entry) {
          newToolCalls.set(event.toolCallId, {
            ...entry,
            result: event.result,
            isError: event.isError,
            status: 'complete' as const,
          });
        }
        this.state = {
          ...this.state,
          toolCalls: newToolCalls,
        };
        break;
      }

      case 'done': {
        const usage: TokenUsage = event.usage
          ? {
              inputTokens: this.state.tokenUsage.inputTokens + event.usage.inputTokens,
              outputTokens: this.state.tokenUsage.outputTokens + event.usage.outputTokens,
            }
          : this.state.tokenUsage;
        const prevDone = this.state.messages;
        const turnsDone =
          prevDone.currentText.length > 0
            ? [...prevDone.turns, { role: 'assistant', content: prevDone.currentText, timestamp: Date.now() } satisfies TurnEntry]
            : [...prevDone.turns];
        this.state = {
          ...this.state,
          status: 'idle',
          messages: { turns: turnsDone, currentText: '', currentThinking: '' },
          tokenUsage: usage,
          totalElapsed: this.state.totalElapsed + this.state.elapsed,
          elapsed: 0,
        };
        this.turnStartTime = 0;
        break;
      }

      case 'error': {
        const prevErr = this.state.messages;
        const turnsErr =
          prevErr.currentText.length > 0
            ? [...prevErr.turns, { role: 'assistant', content: prevErr.currentText, timestamp: Date.now() } satisfies TurnEntry]
            : [...prevErr.turns];
        this.state = {
          ...this.state,
          status: 'error',
          messages: { turns: turnsErr, currentText: '', currentThinking: '' },
          error: event.error.message,
          elapsed: 0,
        };
        break;
      }

      case 'agent_started': {
        const newSessions = new Map(this.state.agentSessions);
        newSessions.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          description: event.description,
          status: 'running',
          isBackground: event.isBackground ?? false,
          iterations: 0,
          toolCallCount: 0,
        } satisfies AgentSessionSummary);
        this.state = { ...this.state, agentSessions: newSessions };
        break;
      }

      case 'agent_progress': {
        const newSessions = new Map(this.state.agentSessions);
        const entry = newSessions.get(event.toolCallId);
        if (entry) {
          newSessions.set(event.toolCallId, {
            ...entry,
            progress: event.text,
          });
          this.state = { ...this.state, agentSessions: newSessions };
        }
        break;
      }

      case 'agent_completed': {
        const newSessions = new Map(this.state.agentSessions);
        const entry = newSessions.get(event.toolCallId);
        if (entry) {
          newSessions.set(event.toolCallId, {
            ...entry,
            status: event.isError ? 'error' : 'completed',
            iterations: event.iterations,
            toolCallCount: event.toolCallCount,
          });
          this.state = { ...this.state, agentSessions: newSessions };
        }
        break;
      }

      case 'steered':
      case 'follow_up':
      case 'context_overflow':
      case 'turn_end': {
        break;
      }
    }

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
    };
    this.notifySelectors();
  }

  /**
   * Dispose of the store — clear all subscriptions.
   */
  dispose(): void {
    this.selectorSubs.clear();
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
