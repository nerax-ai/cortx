import type { AgentEvent } from '@cortx/sdk';
import { formatToolSummary } from '@cortx/sdk';
import { AgentStore } from '@cortx/store';
import type { AgentState } from '@cortx/store';
import type {
  TuiState,
  TuiSelector,
  TurnEntry,
} from './types/tui-state.js';

/**
 * TUI-specific reactive state store.
 *
 * Extends AgentStore with scroll state, elapsed timer, interrupt handling,
 * and turn flushing for terminal rendering.
 */
export class TuiStore extends AgentStore {
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;

  protected override createInitialState(): AgentState {
    return {
      ...super.createInitialState(),
      scrollOffset: 0,
      autoFollow: true,
      activeAgentView: null,
    } as TuiState;
  }

  /** Read-only snapshot of the current state (typed to TuiState). */
  getState(): Readonly<TuiState> {
    return this.state as TuiState;
  }

  /**
   * Create a selector-based subscription with TuiState typing.
   */
  select<T>(selector: TuiSelector<T>) {
    return super.select(selector as (state: AgentState) => T);
  }

  /**
   * Override dispatch to add TUI-specific behavior on top of AgentStore.
   */
  dispatch(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start': {
        // Emit flushed tool call turns before calling super
        // (AgentStore handles core state transitions)
        this.flushToolCallsToTurns();
        super.dispatch(event);
        this.startElapsedTimer();
        break;
      }

      case 'done': {
        this.stopElapsedTimer();
        super.dispatch(event);
        break;
      }

      case 'error': {
        this.stopElapsedTimer();
        super.dispatch(event);
        break;
      }

      default: {
        super.dispatch(event);
        break;
      }
    }
  }

  /** Scroll up by delta lines. Disables autoFollow. */
  scrollUp(delta: number): void {
    const state = this.state as TuiState;
    const newOffset = Math.min(state.scrollOffset + delta, 99999);
    (this.state as TuiState) = { ...state, scrollOffset: newOffset, autoFollow: false };
    this.notifySelectors();
  }

  /** Scroll down by delta lines. Re-enables autoFollow when reaching bottom. */
  scrollDown(delta: number): void {
    const state = this.state as TuiState;
    const newOffset = Math.max(0, state.scrollOffset - delta);
    (this.state as TuiState) = { ...state, scrollOffset: newOffset, autoFollow: newOffset === 0 };
    this.notifySelectors();
  }

  /** Reset scroll to bottom, enable autoFollow. */
  scrollToBottom(): void {
    (this.state as TuiState) = { ...this.state as TuiState, scrollOffset: 0, autoFollow: true };
    this.notifySelectors();
  }

  /**
   * Set status to interrupting (called when user hits Ctrl+C during run).
   */
  setInterrupting(): void {
    this.state = {
      ...this.state,
      status: 'interrupting' as AgentState['status'],
    };
    this.notifySelectors();
  }

  /**
   * Set the currently viewed agent session by toolCallId.
   * Pass null to return to the main view.
   */
  setActiveAgentView(toolCallId: string | null): void {
    (this.state as TuiState) = {
      ...this.state as TuiState,
      activeAgentView: toolCallId,
    };
    this.notifySelectors();
  }

  /**
   * Reset the store to initial state.
   * Generates a new session ID unless one is provided (for session restore).
   */
  reset(sessionId?: string): void {
    this.stopElapsedTimer();
    super.reset(sessionId);
    // Add TUI-specific fields back to the state
    this.state = {
      ...this.state,
      scrollOffset: 0,
      autoFollow: true,
      activeAgentView: null,
    } as TuiState;
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
   */
  dispose(): void {
    this.stopElapsedTimer();
    super.dispose();
  }

  // --- Private helpers ---

  /**
   * Emit completed/pending tool calls as TurnEntry items.
   * Called before turn_start to flush the previous turn's tool calls.
   */
  private flushToolCallsToTurns(): void {
    const prev = this.state.messages;
    let turns = [...prev.turns];
    for (const entry of this.state.toolCalls.values()) {
      if (entry.status === 'complete' || entry.status === 'pending') {
        const header = entry.status === 'pending' ? `⏳ ${entry.toolName}` : entry.isError ? `✗ ${entry.toolName}` : `✓ ${entry.toolName}`;
        const inputSummary = formatToolSummary(entry.toolName, entry.input, { maxLength: 120 });
        const resultSummary = entry.result != null ? String(entry.result).slice(0, 200) : '';
        const content = [header, inputSummary, resultSummary].filter(Boolean).join('\n');
        turns = [...turns, { role: 'tool', content, timestamp: Date.now() } satisfies TurnEntry];
      }
    }
    if (turns.length !== prev.turns.length) {
      this.state = { ...this.state, messages: { ...prev, turns } };
    }
  }

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
}

// --- Exported selector functions ---

/** Select the agent sessions map from state. */
export const selectAgentSessions = (state: TuiState) =>
  state.agentSessions;

/** Select the currently active agent view toolCallId from state. */
export const selectActiveAgentView = (state: TuiState): string | null =>
  state.activeAgentView;
