import type { LanguageMessage, LanguageToolCallContent } from '@synax-ai/sdk';
import type { ErrorCode } from './events.js';
import type { Tool, ToolContext, ToolResult } from './tools.js';

export type AgentPolicyAllowDecision = { action?: 'allow' };
export type AgentPolicyDenyDecision = { action: 'deny'; reason?: string; code?: ErrorCode };

export interface AgentTurnPolicyInput {
  sessionId: string;
  iteration: number;
  messages: LanguageMessage[];
}

export type AgentTurnPolicyDecision =
  | AgentPolicyAllowDecision
  | AgentPolicyDenyDecision
  | { action: 'rewriteMessages'; messages: LanguageMessage[] };

export interface AgentModelRequestPolicyInput {
  sessionId: string;
  iteration: number;
  messages: LanguageMessage[];
  tools: Tool[];
}

export type AgentModelRequestPolicyDecision =
  | AgentPolicyAllowDecision
  | AgentPolicyDenyDecision
  | { action: 'rewriteMessages'; messages: LanguageMessage[] }
  | { action: 'rewriteTools'; tools: Tool[] };

export interface AgentToolPolicyInput {
  sessionId: string;
  toolCall: LanguageToolCallContent;
  tool?: Tool;
  input: Record<string, unknown>;
  toolContext: ToolContext;
}

export type AgentToolPolicyDecision =
  | AgentPolicyAllowDecision
  | { action: 'deny'; reason?: string; result?: ToolResult | string }
  | { action: 'rewriteToolInput'; input: string | Record<string, unknown> }
  | { action: 'shortCircuitTool'; result: ToolResult | string; isError?: boolean };

export interface AgentSubAgentPolicyInput {
  sessionId: string;
  parentToolCallId: string;
  prompt: string;
  description: string;
  isBackground: boolean;
}

export type AgentSubAgentPolicyDecision =
  | AgentPolicyAllowDecision
  | { action: 'deny'; reason?: string; result?: ToolResult | string; code?: ErrorCode };

export interface AgentSessionPolicyContribution {
  beforeTurn?(input: AgentTurnPolicyInput): AgentTurnPolicyDecision | Promise<AgentTurnPolicyDecision>;
  beforeModelRequest?(input: AgentModelRequestPolicyInput): AgentModelRequestPolicyDecision | Promise<AgentModelRequestPolicyDecision>;
  beforeToolCall?(input: AgentToolPolicyInput): AgentToolPolicyDecision | Promise<AgentToolPolicyDecision>;
  beforeSubAgent?(input: AgentSubAgentPolicyInput): AgentSubAgentPolicyDecision | Promise<AgentSubAgentPolicyDecision>;
}
