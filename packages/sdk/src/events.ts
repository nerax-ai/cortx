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

export type RuntimeTransientAgentEvent = Extract<
  AgentEvent,
  { type: 'text_delta' | 'thinking_delta' | 'tool_progress' | 'agent_progress' }
>;

/**
 * Ephemeral, run-local stream data. Frames are never persisted and do not
 * consume the durable event sequence used for replay and gap detection.
 */
export interface RuntimeAgentStreamFrameEnvelope {
  kind: 'frame';
  offset: number;
  timestamp: number;
  sessionId: string;
  runId: number;
  runtimeIncarnation: string;
  event: RuntimeTransientAgentEvent;
}

export type RuntimeAgentStreamEnvelope = RuntimeAgentEventEnvelope | RuntimeAgentStreamFrameEnvelope;

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
  /** Provider-reported input tokens for the latest completed request. */
  requestInputTokens?: number;
  /** Provider-reported output tokens for the latest completed request. */
  requestOutputTokens?: number;
  /** Provider-reported non-cached input tokens for the latest completed request, when available. */
  requestNoCacheInputTokens?: number;
  /** Provider-reported cache-read input tokens for the latest completed request, when available. */
  requestCacheReadTokens?: number;
  /** Provider-reported cache-write input tokens for the latest completed request, when available. */
  requestCacheCreationTokens?: number;
  /** Model context window. Comes from explicit runtime config first, then Synax model metadata when available. */
  windowTokens?: number;
  windowSource?: ContextUsageSource;
  model?: string;
  /** Percentage in the 0..100 range. */
  percentUsed?: number;
  /** Cache hit rate for the latest completed request, in the 0..100 range. */
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
  | { type: 'user_message'; message: string; source?: 'prompt' | 'follow_up' }
  | { type: 'turn_start'; iteration: number }
  | { type: 'turn_end'; iteration: number; toolCallCount: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'text'; content: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; toolCall: LanguageToolCallContent }
  | { type: 'tool_progress'; toolCallId: string; text: string }
  | { type: 'tool_result'; toolCallId: string; result: unknown; isError?: boolean; details?: unknown }
  | { type: 'steered'; message: string }
  | { type: 'follow_up'; message: string; inputId?: string }
  | { type: 'context_overflow'; messages: LanguageMessage[] }
  | { type: 'error'; error: Error; code?: ErrorCode }
  | { type: 'done'; usage?: AgentDoneUsage }
  | { type: 'agent_started'; toolCallId: string; description: string; isBackground?: boolean }
  | { type: 'agent_progress'; toolCallId: string; text: string }
  | { type: 'agent_completed'; toolCallId: string; output: string; iterations: number; toolCallCount: number; isError?: boolean }
  | { type: 'user_request'; request: RuntimeUserRequest }
  | { type: 'user_question'; question: string; toolCallId: string }
  | { type: 'user_answer'; toolCallId: string; response: string };
