import type {
  LanguageMessage,
  LanguageToolCallContent,
} from '@synax-ai/sdk';

export type ErrorCode = 'context_overflow' | 'rate_limited' | 'max_iterations' | 'user_abort' | 'stream_error' | 'client_error' | 'budget_exceeded' | 'timeout';

// AgentEvent lives in the SDK so runtime extensions, tools, and hosts share one event contract.
export type AgentEvent =
  | { type: 'turn_start'; iteration: number }
  | { type: 'turn_end'; iteration: number; toolCallCount: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'text'; content: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; toolCall: LanguageToolCallContent }
  | { type: 'tool_progress'; toolCallId: string; text: string }
  | { type: 'tool_result'; toolCallId: string; result: unknown; isError?: boolean }
  | { type: 'steered'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'context_overflow'; messages: LanguageMessage[] }
  | { type: 'error'; error: Error; code?: ErrorCode }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'agent_started'; toolCallId: string; description: string; isBackground?: boolean }
  | { type: 'agent_progress'; toolCallId: string; text: string }
  | { type: 'agent_completed'; toolCallId: string; output: string; iterations: number; toolCallCount: number; isError?: boolean }
  | { type: 'user_question'; question: string; toolCallId: string }
  | { type: 'user_answer'; toolCallId: string; response: string };
