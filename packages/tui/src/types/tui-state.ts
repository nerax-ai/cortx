import type { AgentState, AgentStatus, AgentSelector, SelectorSubscription } from '@cortx/store';

export type { AgentStatus, AgentSelector, SelectorSubscription };
export type {
  ToolCallEntry,
  TurnEntry,
  TokenUsage,
  AgentSessionSummary,
} from '@cortx/store';

/** TUI-specific status adds 'interrupting'. */
export type TuiStatus = AgentStatus | 'interrupting';

/** The full state object held by TuiStore. */
export interface TuiState extends AgentState {
  /** Scroll offset into flattened output lines (0 = bottom/latest). */
  scrollOffset: number;
  /** Whether to auto-scroll to bottom on new content. */
  autoFollow: boolean;
  /** Currently viewed agent toolCallId, or null for main view. */
  activeAgentView: string | null;
}

/** Selector function: maps full state to a derived slice. */
export type TuiSelector<T> = (state: TuiState) => T;
