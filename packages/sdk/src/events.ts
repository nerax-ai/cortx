import type {
  LanguageMessage,
  LanguageToolCallContent,
} from '@synax-ai/sdk';

export type ErrorCode = 'context_overflow' | 'rate_limited' | 'max_iterations' | 'user_abort' | 'stream_error' | 'client_error' | 'budget_exceeded' | 'timeout';

export type RuntimeUserRequestKind = 'question' | 'tool_approval';

export interface RuntimeUserRequestContext {
  toolCallId?: string;
  toolName?: string;
  sideEffects?: string;
  inputPreview?: string;
  workingDirectory?: string;
  [key: string]: unknown;
}

export interface RuntimeUserRequest {
  requestId: string;
  kind: RuntimeUserRequestKind;
  prompt: string;
  context?: RuntimeUserRequestContext;
  allowedResponses?: string[];
}

export interface RuntimeAgentEventEnvelope {
  sequence: number;
  timestamp: number;
  sessionId: string;
  runId: number;
  event: AgentEvent;
  parent?: {
    sessionId: string;
    runId?: number;
    toolCallId?: string;
  };
}

export type ContextUsageBreakdownKey = 'messages' | 'tools' | 'skills' | 'system_prompt' | 'other';
export type ContextUsageSource = 'provider' | 'runtime_exact' | 'runtime_estimate' | 'configured' | 'model_metadata' | 'unknown';

export interface ContextUsageBreakdownEntry {
  key: ContextUsageBreakdownKey;
  label: string;
  tokens: number;
  source: ContextUsageSource;
  count?: number;
  description?: string;
}

export interface ContextUsageFacts {
  /** Tokens consumed by the current model request context. Usually provider-reported input tokens. */
  usedTokens?: number;
  /** Model context window. Comes from explicit runtime config first, then Synax model metadata when available. */
  windowTokens?: number;
  windowSource?: ContextUsageSource;
  model?: string;
  /** Percentage in the 0..100 range. */
  percentUsed?: number;
  /** Cache hit rate for this request, in the 0..100 range. */
  cacheHitRate?: number;
  breakdown: ContextUsageBreakdownEntry[];
}

export interface AgentDoneUsage {
  inputTokens: number;
  outputTokens: number;
  noCacheInputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  context?: ContextUsageFacts;
}

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
  | { type: 'done'; usage?: AgentDoneUsage }
  | { type: 'agent_started'; toolCallId: string; description: string; isBackground?: boolean }
  | { type: 'agent_progress'; toolCallId: string; text: string }
  | { type: 'agent_completed'; toolCallId: string; output: string; iterations: number; toolCallCount: number; isError?: boolean }
  | { type: 'user_request'; request: RuntimeUserRequest }
  | { type: 'user_question'; question: string; toolCallId: string }
  | { type: 'user_answer'; toolCallId: string; response: string };
