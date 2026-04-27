import type { Logger } from '@nerax-ai/logger';

export type { Logger };

import type {
  LanguageMessage,
  LanguageToolCallContent,
  LanguageToolResultContent,
} from '@synax-ai/sdk';

export type { LanguageMessage, LanguageToolCallContent, LanguageToolResultContent };

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface ToolContext {
  sessionId: string;
  toolCallId: string;
  workingDirectory: string;
  logger: Logger;
  reportProgress?: (text: string) => void;
  askUser?: (question: string) => Promise<string>;
}

export type SideEffects = 'none' | 'read' | 'write' | 'destructive';

export interface Tool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  sideEffects?: SideEffects;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolExecuteBeforeResult {
  skip?: boolean;
  result?: string;
}

export interface ErrorRecoverResult {
  retry: boolean;
  delay?: number;
}

export interface CortxPlugin {
  'messages.transform'?: (messages: LanguageMessage[]) => LanguageMessage[] | Promise<LanguageMessage[]>;
  'system.transform'?: (system: string) => string | Promise<string>;
  'tool.execute.before'?: (tc: LanguageToolCallContent, ctx: ToolContext) => ToolExecuteBeforeResult | Promise<ToolExecuteBeforeResult>;
  'tool.execute.after'?: (tc: LanguageToolCallContent, result: ToolResult) => ToolResult | Promise<ToolResult>;
  'error.recover'?: (event: AgentEvent & { type: 'error' }) => ErrorRecoverResult | Promise<ErrorRecoverResult>;
  'context.overflow'?: (messages: LanguageMessage[]) => Promise<LanguageMessage[] | null>;
  'event'?: (event: AgentEvent) => void | Promise<void>;
  tools?: Tool[];
}

export type ErrorCode = 'context_overflow' | 'rate_limited' | 'max_iterations' | 'user_abort' | 'stream_error' | 'client_error';

// AgentEvent is needed by CortxPlugin['event'], defined here to avoid circular deps
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
  | { type: 'agent_completed'; toolCallId: string; output: string; iterations: number; toolCallCount: number; isError?: boolean };

export type { PluginModule, PluginContext, PluginManifest, InlinePlugin } from '@nerax-ai/plugin';
export type { SkillInfo } from './skill.js';
export { formatToolSummary } from './tool-format.js';
export type { FormatToolSummaryOptions } from './tool-format.js';
