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
  workingDirectory: string;
  logger: Logger;
  reportProgress?: (text: string) => void;
  askUser?: (question: string) => Promise<string>;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolExecuteBeforeResult {
  skip?: boolean;
  result?: string;
}

export interface CortxPlugin {
  'messages.transform'?: (messages: LanguageMessage[]) => LanguageMessage[] | Promise<LanguageMessage[]>;
  'system.transform'?: (system: string) => string | Promise<string>;
  'tool.execute.before'?: (tc: LanguageToolCallContent, ctx: ToolContext) => ToolExecuteBeforeResult | Promise<ToolExecuteBeforeResult>;
  'tool.execute.after'?: (tc: LanguageToolCallContent, result: ToolResult) => ToolResult | Promise<ToolResult>;
  'event'?: (event: AgentEvent) => void | Promise<void>;
  tools?: Tool[];
}

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
  | { type: 'error'; error: Error }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } };

export type { PluginModule, PluginContext, PluginManifest, InlinePlugin } from '@nerax-ai/plugin';
