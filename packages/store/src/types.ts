/**
 * Shared state types for the agent store.
 *
 * AgentState is the UI-agnostic state shape used by both TUI and web.
 * UI-specific fields (scroll, autoFollow, etc.) belong in the consuming layer.
 */

/** Status of the agent session. */
export type AgentStatus = 'idle' | 'running' | 'error';

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

/** Summary of a sub-agent session. */
export interface AgentSessionSummary {
  toolCallId: string;
  description: string;
  status: 'running' | 'completed' | 'error';
  isBackground: boolean;
  progress?: string;
  iterations: number;
  toolCallCount: number;
}

/** The UI-agnostic state object held by AgentStore. */
export interface AgentState {
  /** Unique session identifier. */
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
  status: AgentStatus;
  /** Last error message, set when status is 'error'. */
  error: string | undefined;
  /** Active and completed sub-agent sessions. */
  agentSessions: Map<string, AgentSessionSummary>;
}

/** Selector function: maps full state to a derived slice. */
export type AgentSelector<T> = (state: AgentState) => T;

/** Return value of store.select(selector). */
export interface SelectorSubscription<T> {
  /** Get the current value of the selector. */
  get: () => T;
  /** Subscribe to changes. Listener is called only when the selector result changes (shallow equality). */
  subscribe: (listener: () => void) => () => void;
}

// --- Serialization types ---

/** Serializable form of ToolCallEntry (no unknown values). */
export interface SerializedToolCallEntry {
  toolName: string;
  input: string;
  result?: string;
  isError?: boolean;
  status: 'pending' | 'complete';
  progress?: string;
}

/** Serializable form of AgentSessionSummary. */
export interface SerializedAgentSessionSummary {
  toolCallId: string;
  description: string;
  status: 'running' | 'completed' | 'error';
  isBackground: boolean;
  progress?: string;
  iterations: number;
  toolCallCount: number;
}

/** Serializable form of AgentState where Maps become Records. */
export interface SerializedAgentState {
  sessionId: string;
  messages: {
    turns: TurnEntry[];
    currentText: string;
    currentThinking: string;
  };
  iteration: number;
  toolCalls: Record<string, SerializedToolCallEntry>;
  tokenUsage: TokenUsage;
  totalElapsed: number;
  elapsed: number;
  status: AgentStatus;
  error: string | undefined;
  agentSessions: Record<string, SerializedAgentSessionSummary>;
}
