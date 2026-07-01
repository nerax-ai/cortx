import type { LanguageTokenUsage } from '@synax-ai/sdk';
import type { AgentEvent } from '../types.js';
import type { LanguageMessage } from '@cortx/sdk';
import { messageText } from '../message-helpers.js';
import { emitPhaseEvent, type AgentLoopPhaseInput } from './pipeline.js';

export type CompletionPhaseOutcome =
  | { action: 'continue'; autoContinueCount: number }
  | { action: 'done'; autoContinueCount: number };

export interface CompletionPhaseInput extends AgentLoopPhaseInput {
  finishReason?: string;
  thinkingBuffer: string;
  textBuffer: string;
  usage?: LanguageTokenUsage;
  autoContinueCount: number;
  autoContinueLimit: number;
  messages: LanguageMessage[];
  iteration: number;
}

export async function* runCompletionPhase(
  input: CompletionPhaseInput,
): AsyncGenerator<AgentEvent, CompletionPhaseOutcome> {
  const { runtime, finishReason, thinkingBuffer, textBuffer, usage, autoContinueLimit, messages, iteration } = input;
  const { controller, extensions, logger } = runtime;
  let autoContinueCount = input.autoContinueCount;
  const isTruncated = finishReason === 'length';

  if (isTruncated && autoContinueCount < autoContinueLimit) {
    autoContinueCount++;
    messages.push({
      role: 'assistant',
      content: [
        ...(thinkingBuffer ? [{ type: 'reasoning' as const, reasoning: thinkingBuffer }] : []),
        ...(textBuffer ? [{ type: 'text' as const, text: textBuffer }] : []),
      ],
    });
    messages.push({ role: 'user', content: [{ type: 'text' as const, text: 'Continue where you left off.' }] });
    const event: AgentEvent = { type: 'follow_up', message: 'auto-continue (output truncated)' };
    yield await emitPhaseEvent(runtime, 'completion', iteration, event);
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
    yield await emitPhaseEvent(runtime, 'turn', iteration, turnEnd);
    return { action: 'continue', autoContinueCount };
  }

  if (!isTruncated) autoContinueCount = 0;
  if (thinkingBuffer || textBuffer) {
    messages.push({
      role: 'assistant',
      content: [
        ...(thinkingBuffer ? [{ type: 'reasoning' as const, reasoning: thinkingBuffer }] : []),
        ...(textBuffer ? [{ type: 'text' as const, text: textBuffer }] : []),
      ],
    });
  }

  if (controller?.hasFollowUps) {
    for (const message of controller.consumeFollowUps()) {
      messages.push(message);
      const event: AgentEvent = { type: 'follow_up', message: messageText(message) || 'follow-up' };
      yield await emitPhaseEvent(runtime, 'completion', iteration, event);
    }
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
    yield await emitPhaseEvent(runtime, 'turn', iteration, turnEnd);
    return { action: 'continue', autoContinueCount };
  }

  const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
  yield await emitPhaseEvent(runtime, 'turn', iteration, turnEnd);
  const done: AgentEvent = {
    type: 'done',
    usage: usage
      ? { inputTokens: usage.inputTokens.total ?? 0, outputTokens: usage.outputTokens.total ?? 0 }
      : undefined,
  };
  yield await emitPhaseEvent(runtime, 'completion', iteration, done);
  return { action: 'done', autoContinueCount };
}
