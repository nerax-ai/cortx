import type { LanguageTokenUsage } from '@synax-ai/sdk';
import type { AgentController, AgentEvent } from '../types.js';
import type { AgentRuntimeExtensions, LanguageMessage, Logger } from '@cortx/sdk';
import { messageText } from '../message-helpers.js';
import { emit } from './events.js';

export type CompletionPhaseOutcome =
  | { action: 'continue'; autoContinueCount: number }
  | { action: 'done'; autoContinueCount: number };

export interface CompletionPhaseInput {
  finishReason?: string;
  thinkingBuffer: string;
  textBuffer: string;
  usage?: LanguageTokenUsage;
  autoContinueCount: number;
  autoContinueLimit: number;
  messages: LanguageMessage[];
  controller?: AgentController;
  iteration: number;
  extensions: AgentRuntimeExtensions;
  logger: Logger;
}

export async function* runCompletionPhase(input: CompletionPhaseInput): AsyncGenerator<AgentEvent, CompletionPhaseOutcome> {
  const {
    finishReason,
    thinkingBuffer,
    textBuffer,
    usage,
    autoContinueLimit,
    messages,
    controller,
    iteration,
    extensions,
    logger,
  } = input;
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
    await emit(extensions, event, logger);
    yield event;
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
    await emit(extensions, turnEnd, logger);
    yield turnEnd;
    return { action: 'continue', autoContinueCount };
  }

  if (!isTruncated) autoContinueCount = 0;

  if (controller?.hasFollowUps) {
    for (const message of controller.consumeFollowUps()) {
      messages.push(message);
      const event: AgentEvent = { type: 'follow_up', message: messageText(message) || 'follow-up' };
      await emit(extensions, event, logger);
      yield event;
    }
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
    await emit(extensions, turnEnd, logger);
    yield turnEnd;
    return { action: 'continue', autoContinueCount };
  }

  const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
  await emit(extensions, turnEnd, logger);
  yield turnEnd;
  const done: AgentEvent = {
    type: 'done',
    usage: usage ? { inputTokens: usage.inputTokens.total ?? 0, outputTokens: usage.outputTokens.total ?? 0 } : undefined,
  };
  await emit(extensions, done, logger);
  yield done;
  return { action: 'done', autoContinueCount };
}
