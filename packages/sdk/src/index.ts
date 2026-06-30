import type { Logger } from '@nerax-ai/logger';
import type { InlinePlugin, PluginStorage } from '@nerax-ai/plugin';

export type { Logger };
export { noopLogger } from '@nerax-ai/logger';

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
  isError?: boolean;
  action?: 'allow' | 'rewrite' | 'deny' | 'shortCircuit';
  input?: string | Record<string, unknown>;
}

export interface ErrorRecoverResult {
  retry: boolean;
  delay?: number;
}

export interface CortxPlugin {
  'messages.transform'?: (messages: LanguageMessage[]) => LanguageMessage[] | Promise<LanguageMessage[]>;
  'system.transform'?: (system: string) => string | Promise<string>;
  'tool.execute.before'?: (tc: LanguageToolCallContent, ctx: ToolContext, tool?: Tool, input?: Record<string, unknown>) => ToolExecuteBeforeResult | Promise<ToolExecuteBeforeResult>;
  'tool.execute.after'?: (tc: LanguageToolCallContent, result: ToolResult, tool?: Tool) => ToolResult | Promise<ToolResult>;
  'error.recover'?: (event: AgentEvent & { type: 'error' }) => ErrorRecoverResult | Promise<ErrorRecoverResult>;
  'context.overflow'?: (messages: LanguageMessage[]) => Promise<LanguageMessage[] | null>;
  'event'?: (event: AgentEvent) => void | Promise<void>;
  tools?: Tool[];
}

export const CORTX_LEGACY_PLUGIN = 'cortx' as const;
export const AGENT_TOOL = 'agent.tool' as const;
export const AGENT_SYSTEM_TRANSFORM = 'agent.systemTransform' as const;
export const AGENT_MESSAGES_TRANSFORM = 'agent.messagesTransform' as const;
export const AGENT_TOOL_BEFORE = 'agent.toolBefore' as const;
export const AGENT_TOOL_AFTER = 'agent.toolAfter' as const;
export const AGENT_ERROR_RECOVER = 'agent.errorRecover' as const;
export const AGENT_CONTEXT_OVERFLOW = 'agent.contextOverflow' as const;
export const AGENT_EVENT_OBSERVER = 'agent.eventObserver' as const;

export const AGENT_EXTENSION_TYPES = [
  AGENT_TOOL,
  AGENT_SYSTEM_TRANSFORM,
  AGENT_MESSAGES_TRANSFORM,
  AGENT_TOOL_BEFORE,
  AGENT_TOOL_AFTER,
  AGENT_ERROR_RECOVER,
  AGENT_CONTEXT_OVERFLOW,
  AGENT_EVENT_OBSERVER,
] as const;

export const CORTX_EXTENSION_TYPES = [
  CORTX_LEGACY_PLUGIN,
  ...AGENT_EXTENSION_TYPES,
] as const;

export type AgentExtensionType = (typeof AGENT_EXTENSION_TYPES)[number];
export type CortxExtensionType = (typeof CORTX_EXTENSION_TYPES)[number];

export interface CortxFactoryContext {
  instanceId: string;
  options: Record<string, unknown>;
  logger: Logger;
  storage: PluginStorage;
}

export interface AgentSystemTransformInput {
  system: string;
}

export type AgentSystemTransformResult = string | { system: string };

export interface AgentSystemTransformContribution {
  transformSystem(input: AgentSystemTransformInput): AgentSystemTransformResult | Promise<AgentSystemTransformResult>;
}

export interface AgentMessagesTransformInput {
  messages: LanguageMessage[];
}

export type AgentMessagesTransformResult = LanguageMessage[] | { messages: LanguageMessage[] };

export interface AgentMessagesTransformContribution {
  transformMessages(input: AgentMessagesTransformInput): AgentMessagesTransformResult | Promise<AgentMessagesTransformResult>;
}

export interface AgentToolBeforeInput {
  toolCall: LanguageToolCallContent;
  tool?: Tool;
  input: Record<string, unknown>;
  toolContext: ToolContext;
}

export type AgentToolBeforeResult =
  | { action?: 'allow' }
  | { action: 'rewrite'; input: string | Record<string, unknown> }
  | { action: 'deny'; reason?: string; result?: ToolResult | string }
  | { action: 'shortCircuit'; result: ToolResult | string; isError?: boolean };

export interface AgentToolBeforeContribution {
  beforeToolExecute(input: AgentToolBeforeInput): AgentToolBeforeResult | Promise<AgentToolBeforeResult>;
}

export interface AgentToolAfterInput {
  toolCall: LanguageToolCallContent;
  tool?: Tool;
  result: ToolResult;
}

export type AgentToolAfterResult = ToolResult | { result: ToolResult };

export interface AgentToolAfterContribution {
  afterToolExecute(input: AgentToolAfterInput): AgentToolAfterResult | Promise<AgentToolAfterResult>;
}

export interface AgentErrorRecoverInput {
  event: AgentEvent & { type: 'error' };
  error: Error;
  code?: ErrorCode;
}

export type AgentErrorRecoverResult =
  | { action: 'retry'; delayMs?: number; reason?: string }
  | { action: 'fail'; reason?: string }
  | { retry: boolean; delay?: number };

export interface AgentErrorRecoverContribution {
  recoverError(input: AgentErrorRecoverInput): AgentErrorRecoverResult | Promise<AgentErrorRecoverResult>;
}

export interface AgentContextOverflowInput {
  messages: LanguageMessage[];
}

export type AgentContextOverflowResult =
  | LanguageMessage[]
  | { messages: LanguageMessage[] }
  | { action: 'fail' }
  | null;

export interface AgentContextOverflowContribution {
  handleContextOverflow(input: AgentContextOverflowInput): AgentContextOverflowResult | Promise<AgentContextOverflowResult>;
}

export interface AgentEventObserverContribution {
  onAgentEvent(event: AgentEvent): void | Promise<void>;
}

export interface CortxFactoryMap {
  [CORTX_LEGACY_PLUGIN]: (ctx: CortxFactoryContext) => CortxPlugin | Promise<CortxPlugin>;
  [AGENT_TOOL]: (ctx: CortxFactoryContext) => Tool | Promise<Tool>;
  [AGENT_SYSTEM_TRANSFORM]: (ctx: CortxFactoryContext) => AgentSystemTransformContribution | Promise<AgentSystemTransformContribution>;
  [AGENT_MESSAGES_TRANSFORM]: (ctx: CortxFactoryContext) => AgentMessagesTransformContribution | Promise<AgentMessagesTransformContribution>;
  [AGENT_TOOL_BEFORE]: (ctx: CortxFactoryContext) => AgentToolBeforeContribution | Promise<AgentToolBeforeContribution>;
  [AGENT_TOOL_AFTER]: (ctx: CortxFactoryContext) => AgentToolAfterContribution | Promise<AgentToolAfterContribution>;
  [AGENT_ERROR_RECOVER]: (ctx: CortxFactoryContext) => AgentErrorRecoverContribution | Promise<AgentErrorRecoverContribution>;
  [AGENT_CONTEXT_OVERFLOW]: (ctx: CortxFactoryContext) => AgentContextOverflowContribution | Promise<AgentContextOverflowContribution>;
  [AGENT_EVENT_OBSERVER]: (ctx: CortxFactoryContext) => AgentEventObserverContribution | Promise<AgentEventObserverContribution>;
}

export function defineCortxPlugin<T extends InlinePlugin<CortxExtensionType, CortxFactoryMap>>(plugin: T): T {
  return plugin;
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
  | { type: 'agent_completed'; toolCallId: string; output: string; iterations: number; toolCallCount: number; isError?: boolean }
  | { type: 'user_question'; question: string; toolCallId: string }
  | { type: 'user_answer'; toolCallId: string; response: string };

export type { PluginModule, PluginContext, PluginManifest, InlinePlugin } from '@nerax-ai/plugin';
export type { SkillInfo } from './skill.js';
export { formatToolSummary } from './tool-format.js';
export type { FormatToolSummaryOptions } from './tool-format.js';
