import type { AgentEvent } from '@cortx/sdk';
import type {
  TuiState,
  TuiSelector,
  SelectorSubscription,
  TurnEntry,
  ToolCallEntry,
  TokenUsage,
} from './types/tui-state.js';

/**
 * Reactive state store for the TUI.
 *
 * Ingests AgentEvents via dispatch() and exposes selector-based subscriptions.
 * This is a plain TypeScript class with no React dependency -- components use
 * `useSyncExternalStore` to subscribe.
 */
export class TuiStore {
  private state: TuiState;
  private turnStartTime = 0;
  private totalStartTime = 0;
  private selectorSubs: Map<
    TuiSelector<unknown>,
    {
      listeners: Set<() => void>;
      lastValue: unknown;
    }
  > = new Map();
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;

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
      scrollOffset: 0,
      autoFollow: true,
    };
  }

  /** Read-only snapshot of the current state. */
  getState(): Readonly<TuiState> {
    return this.state;
  }

  /**
   * Create a selector-based subscription.
   *
   * Returns { get(), subscribe(listener) } where listener is called only
   * when the selector result changes (shallow equality).
   */
  select<T>(selector: TuiSelector<T>): SelectorSubscription<T> {
    // Reuse existing subscription if one exists for this exact selector function
    const existing = this.selectorSubs.get(selector as TuiSelector<unknown>);
    if (existing) {
      return {
        get: () => selector(this.state),
        subscribe: (listener: () => void) => {
          existing.listeners.add(listener);
          return () => {
            existing.listeners.delete(listener);
            if (existing.listeners.size === 0) {
              this.selectorSubs.delete(selector as TuiSelector<unknown>);
            }
          };
        },
      };
    }

    const entry = {
      listeners: new Set<() => void>(),
      lastValue: selector(this.state) as unknown,
    };
    this.selectorSubs.set(selector as TuiSelector<unknown>, entry);

    return {
      get: () => selector(this.state),
      subscribe: (listener: () => void) => {
        entry.listeners.add(listener);
        return () => {
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) {
            this.selectorSubs.delete(selector as TuiSelector<unknown>);
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
        // Calculate previous turn duration
        const turnDuration = this.turnStartTime > 0 ? (Date.now() - this.turnStartTime) / 1000 : 0;
        // Persist any streaming text as an assistant turn with duration
        if (prev.currentText.length > 0) {
          turns = [...turns, { role: 'assistant', content: prev.currentText, timestamp: Date.now(), duration: turnDuration } satisfies TurnEntry];
        } else if (turnDuration > 0 && turns.length > 0) {
          // No text but had a previous turn (e.g., tool-only turn) — attach duration to last turn
          const last = turns[turns.length - 1];
          if (!last.duration) turns[turns.length - 1] = { ...last, duration: turnDuration };
        }
        // Persist completed tool calls from previous turn into turns
        for (const entry of this.state.toolCalls.values()) {
          if (entry.status === 'complete' || entry.status === 'pending') {
            const header = entry.status === 'pending' ? `⏳ ${entry.toolName}` : entry.isError ? `✗ ${entry.toolName}` : `✓ ${entry.toolName}`;
            const inputSummary = formatToolInput(entry);
            const resultSummary = entry.result != null ? String(entry.result).slice(0, 200) : '';
            const content = [header, inputSummary, resultSummary].filter(Boolean).join('\n');
            turns = [...turns, { role: 'tool', content, timestamp: Date.now() } satisfies TurnEntry];
          }
        }
        // Accumulate total elapsed time from previous turn
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
        this.startElapsedTimer();
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
        // Finalize text -- set currentText directly
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
        // Snapshot accumulated text before this tool call into turns,
        // then clear currentText. This prevents text duplication across
        // tool call sub-iterations within the same turn.
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
        // Update tool call entry with latest progress text for display
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
        this.stopElapsedTimer();
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
        this.stopElapsedTimer();
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

      case 'steered':
      case 'follow_up':
      case 'context_overflow':
      case 'turn_end': {
        // These events don't modify core state currently.
        // Plugins can subscribe to the store and react to dispatch calls
        // if they need these events. Future: extend as needed.
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

  /** Scroll up by delta lines. Disables autoFollow. */
  scrollUp(delta: number): void {
    const newOffset = Math.min(this.state.scrollOffset + delta, 99999);
    this.state = { ...this.state, scrollOffset: newOffset, autoFollow: false };
    this.notifySelectors();
  }

  /** Scroll down by delta lines. Re-enables autoFollow when reaching bottom. */
  scrollDown(delta: number): void {
    const newOffset = Math.max(0, this.state.scrollOffset - delta);
    this.state = { ...this.state, scrollOffset: newOffset, autoFollow: newOffset === 0 };
    this.notifySelectors();
  }

  /** Reset scroll to bottom, enable autoFollow. */
  scrollToBottom(): void {
    this.state = { ...this.state, scrollOffset: 0, autoFollow: true };
    this.notifySelectors();
  }

  /**
   * Set status to interrupting (called when user hits Ctrl+C during run).
   */
  setInterrupting(): void {
    this.state = {
      ...this.state,
      status: 'interrupting',
    };
    this.notifySelectors();
  }

  /**
   * Set the session ID (used during session restore).
   */
  setSessionId(sessionId: string): void {
    this.state = {
      ...this.state,
      sessionId,
    };
    this.notifySelectors();
  }

  /**
   * Reset the store to initial state.
   * Generates a new session ID unless one is provided (for session restore).
   */
  reset(sessionId?: string): void {
    this.stopElapsedTimer();
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
      scrollOffset: 0,
      autoFollow: true,
    };
    this.notifySelectors();
  }

  /**
   * Clear flushed turns from the messages to keep the Ink frame small.
   * Turns should be written to the terminal via console.log before calling this.
   */
  clearFlushedTurns(): void {
    const prev = this.state.messages;
    if (prev.turns.length === 0) return;
    this.state = {
      ...this.state,
      messages: { ...prev, turns: [] },
    };
    this.notifySelectors();
  }

  /**
   * Load persisted turns into the store (used during session restore).
   * Replaces the current turns array without affecting other state.
   */
  loadTurns(turns: TurnEntry[]): void {
    this.state = {
      ...this.state,
      messages: { turns, currentText: '', currentThinking: '' },
    };
    this.notifySelectors();
  }

  /**
   * Dispose of the store — stop timers and clear all subscriptions.
   * Call this on unmount to prevent timer leaks.
   */
  dispose(): void {
    this.stopElapsedTimer();
    this.selectorSubs.clear();
  }

  // --- Private helpers ---

  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    const start = Date.now();
    this.elapsedTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (elapsed !== this.state.elapsed) {
        this.state = { ...this.state, elapsed };
        this.notifySelectors();
      }
    }, 1000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== undefined) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }

  /**
   * Notify all selector subscriptions whose value has changed.
   * Uses shallow equality to avoid notifying when nothing changed.
   */
  private notifySelectors(): void {
    for (const [selector, entry] of this.selectorSubs) {
      const newValue = selector(this.state);
      if (!shallowEqual(newValue, entry.lastValue)) {
        entry.lastValue = newValue;
        // Copy listeners to avoid mutation during iteration
        const listeners = [...entry.listeners];
        for (const listener of listeners) {
          listener();
        }
      }
    }
  }
}

function formatToolInput(entry: { toolName: string; input: unknown }): string {
  try {
    const parsed = typeof entry.input === 'string' ? JSON.parse(entry.input) : entry.input;
    if (entry.toolName === 'agent') {
      const desc = String(parsed?.description ?? '').slice(0, 40);
      const prompt = String(parsed?.prompt ?? '').slice(0, 60);
      return desc ? `${desc}: ${prompt}` : prompt;
    }
    if (entry.toolName === 'bash') {
      return String(parsed?.command ?? '').slice(0, 100);
    }
    if (entry.toolName === 'read' || entry.toolName === 'write' || entry.toolName === 'edit') {
      return String(parsed?.file_path ?? parsed?.path ?? '').slice(0, 100);
    }
    const preview = JSON.stringify(parsed);
    return preview.length > 120 ? preview.slice(0, 120) + '...' : preview;
  } catch {
    return String(entry.input ?? '').slice(0, 120);
  }
}

/**
 * Shallow equality comparison.
 * Handles primitives, plain objects, and arrays.
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;

  if (typeof a !== 'object' || typeof b !== 'object') return false;

  // Map comparison
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || b.get(key) !== val) return false;
    }
    return true;
  }

  // Array comparison
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Plain object comparison
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
