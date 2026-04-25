/**
 * State shape types for the TUI reactive store.
 *
 * TuiStore holds a single immutable-ish state object. Components and plugins
 * subscribe to derived slices via `store.select(selector)`.
 */

/** Status of the agent session. */
export type TuiStatus = 'idle' | 'running' | 'error' | 'interrupting';

/** A single tool call tracked by the store. */
export interface ToolCallEntry {
  toolName: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
  status: 'pending' | 'complete';
  progress?: string;
}

/** A single completed turn in the message history. */
export interface TurnEntry {
  role: string;
  content: string;
  timestamp: number;
  /** Duration of this turn in seconds, if available. */
  duration?: number;
}

/** Cumulative token usage across the session. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Summary of a sub-agent session tracked by the TUI. */
export interface AgentSessionSummary {
  toolCallId: string;
  description: string;
  status: 'running' | 'completed' | 'error';
  isBackground: boolean;
  progress?: string;
  iterations: number;
  toolCallCount: number;
}

/** The full state object held by TuiStore. */
export interface TuiState {
  /** Unique session identifier (e.g. "sess_1234_abc"). */
  sessionId: string;
  /** Accumulated turns plus the current streaming text and thinking. */
  messages: {
    turns: TurnEntry[];
    currentText: string;
    currentThinking: string;
  };
  /** Current iteration number (incremented on turn_start). */
  iteration: number;
  /** Active tool calls keyed by toolCallId. */
  toolCalls: Map<string, ToolCallEntry>;
  /** Cumulative token usage from done events. */
  tokenUsage: TokenUsage;
  /** Total elapsed seconds across all turns in the session. */
  totalElapsed: number;
  /** Elapsed seconds since the last turn_start. 0 when idle. */
  elapsed: number;
  /** Current agent status. */
  status: TuiStatus;
  /** Last error message, set when status is 'error'. */
  error: string | undefined;
  /** Scroll offset into flattened output lines (0 = bottom/latest). */
  scrollOffset: number;
  /** Whether to auto-scroll to bottom on new content. */
  autoFollow: boolean;
  /** Active and completed sub-agent sessions. */
  agentSessions: Map<string, AgentSessionSummary>;
  /** Currently viewed agent toolCallId, or null for main view. */
  activeAgentView: string | null;
}

/** Selector function: maps full state to a derived slice. */
export type TuiSelector<T> = (state: TuiState) => T;

/** Return value of store.select(selector). */
export interface SelectorSubscription<T> {
  /** Get the current value of the selector. */
  get: () => T;
  /** Subscribe to changes. Listener is called only when the selector result changes (shallow equality). */
  subscribe: (listener: () => void) => () => void;
}
