import type {
  AgentRuntimeExtensions,
  ErrorCode,
  LanguageMessage,
  LanguageToolCallContent,
  Tool,
  ToolContext,
} from '@cortx/sdk';
import { parseToolInput, parseToolInputError, toolDecisionOutput, type ToolExecOutput } from './tool-phase.js';

export type TurnPolicyOutcome =
  | { action: 'allow' }
  | { action: 'rewriteMessages'; messages: LanguageMessage[] }
  | { action: 'deny'; reason: string; code?: ErrorCode };

export type ModelRequestPolicyOutcome =
  | { action: 'allow'; messages: LanguageMessage[]; tools: Tool[] }
  | { action: 'deny'; reason: string; code?: ErrorCode };

export type ToolPolicyOutcome =
  | { action: 'allow'; input?: string | Record<string, unknown> }
  | { action: 'readyOutput'; output: ToolExecOutput }
  | { action: 'invalidInput'; message: string };

export async function applyTurnPolicies(
  extensions: AgentRuntimeExtensions,
  input: { sessionId: string; iteration: number; messages: LanguageMessage[] },
): Promise<TurnPolicyOutcome> {
  let messages = input.messages;
  for (const policy of extensions.sessionPolicies) {
    if (!policy.beforeTurn) continue;
    const decision = await policy.beforeTurn({ ...input, messages });
    if (!decision || decision.action === 'allow') continue;
    if (decision.action === 'rewriteMessages') {
      messages = decision.messages;
      continue;
    }
    if (decision.action === 'deny') return { action: 'deny', reason: decision.reason ?? 'Denied by session policy', code: decision.code };
  }
  return messages === input.messages ? { action: 'allow' } : { action: 'rewriteMessages', messages };
}

export async function applyModelRequestPolicies(
  extensions: AgentRuntimeExtensions,
  input: { sessionId: string; iteration: number; messages: LanguageMessage[]; tools: Tool[] },
): Promise<ModelRequestPolicyOutcome> {
  let messages = input.messages;
  let tools = input.tools;
  for (const policy of extensions.sessionPolicies) {
    if (!policy.beforeModelRequest) continue;
    const decision = await policy.beforeModelRequest({ ...input, messages, tools });
    if (!decision || decision.action === 'allow') continue;
    if (decision.action === 'rewriteMessages') {
      messages = decision.messages;
      continue;
    }
    if (decision.action === 'rewriteTools') {
      tools = decision.tools;
      continue;
    }
    if (decision.action === 'deny') return { action: 'deny', reason: decision.reason ?? 'Denied by session policy', code: decision.code };
  }
  return { action: 'allow', messages, tools };
}

export async function applyToolPolicies(
  extensions: AgentRuntimeExtensions,
  input: { sessionId: string; toolCall: LanguageToolCallContent; tool?: Tool; input: Record<string, unknown>; toolContext: ToolContext },
): Promise<ToolPolicyOutcome> {
  let currentInput: string | Record<string, unknown> | undefined;
  let parsedInput = input.input;
  for (const policy of extensions.sessionPolicies) {
    if (!policy.beforeToolCall) continue;
    const decision = await policy.beforeToolCall({ ...input, input: parsedInput });
    if (!decision || decision.action === 'allow') continue;
    if (decision.action === 'rewriteToolInput') {
      const error = parseToolInputError(decision.input);
      if (error) return { action: 'invalidInput', message: error };
      currentInput = decision.input;
      parsedInput = parseToolInput(decision.input);
      continue;
    }
    if (decision.action === 'deny') {
      return { action: 'readyOutput', output: toolDecisionOutput('deny', decision.result, decision.reason, true) };
    }
    if (decision.action === 'shortCircuitTool') {
      return { action: 'readyOutput', output: toolDecisionOutput('shortCircuit', decision.result, undefined, decision.isError) };
    }
  }
  return { action: 'allow', input: currentInput };
}
