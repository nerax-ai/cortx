import type { LanguageTokenUsage } from '@synax-ai/sdk';
import type { AgentEvent, LanguageMessage, LanguageToolCallContent, Tool } from '@cortx/sdk';
import { applyModelRequestPolicies } from './policy.js';
import { classifyError, streamModel } from './stream.js';
import { emitPhaseEvent, withTurnDeadline, type AgentLoopPhaseInput } from './pipeline.js';
import { normalizeAgentError, toError } from './errors.js';

export interface ModelPhaseInput extends AgentLoopPhaseInput {
  systemMessages: LanguageMessage[];
  messages: LanguageMessage[];
  tools: Tool[];
  iteration: number;
  retryCount: number;
  maxRetries: number;
  overflowRecoveryCount: number;
  maxOverflowRecoveries: number;
}

export type ModelPhaseOutcome =
  | {
      action: 'complete';
      textBuffer: string;
      thinkingBuffer: string;
      toolCalls: LanguageToolCallContent[];
      finishReason?: string;
      usage?: LanguageTokenUsage;
      retryCount: number;
      overflowRecoveryCount: number;
    }
  | { action: 'retry'; retryCount: number; overflowRecoveryCount: number; delayMs?: number }
  | { action: 'recoveredContext'; retryCount: number; overflowRecoveryCount: number }
  | { action: 'terminal'; event: AgentEvent; retryCount: number; overflowRecoveryCount: number };

export async function* runModelPhase(input: ModelPhaseInput): AsyncGenerator<AgentEvent, ModelPhaseOutcome> {
  const { runtime, systemMessages, messages, tools, iteration, maxRetries, maxOverflowRecoveries } = input;
  const { language, model, maxOutputTokens, temperature, extensions, logger, sessionId } = runtime;

  let retryCount = input.retryCount;
  let overflowRecoveryCount = input.overflowRecoveryCount;
  let transformedMessages: LanguageMessage[] = [...systemMessages, ...messages];
  for (const contribution of extensions.messagesTransforms) {
    const result = await withTurnDeadline(
      runtime.turnDeadline,
      Promise.resolve(contribution.transformMessages({ messages: transformedMessages })),
    );
    transformedMessages = result.messages;
  }

  persistTransformedMessages(messages, transformedMessages, systemMessages.length);

  const modelPolicy = await withTurnDeadline(
    runtime.turnDeadline,
    applyModelRequestPolicies(extensions, {
      sessionId,
      iteration,
      messages: transformedMessages,
      tools,
    }),
  );
  if (modelPolicy.action === 'deny') {
    return {
      action: 'terminal',
      event: { type: 'error', error: new Error(modelPolicy.reason), code: modelPolicy.code ?? 'client_error' },
      retryCount,
      overflowRecoveryCount,
    };
  }
  transformedMessages = modelPolicy.messages;

  try {
    const streamResult = yield* streamModel({
      runtime,
      language,
      model,
      messages: transformedMessages,
      maxOutputTokens,
      temperature,
      tools: modelPolicy.tools,
      iteration,
    });

    if (streamResult.thinkingBuffer) {
      const event: AgentEvent = { type: 'thinking', content: streamResult.thinkingBuffer };
      yield await emitPhaseEvent(runtime, 'model', iteration, event);
    }
    if (streamResult.textBuffer) {
      const event: AgentEvent = { type: 'text', content: streamResult.textBuffer };
      yield await emitPhaseEvent(runtime, 'model', iteration, event);
    }

    return {
      action: 'complete',
      textBuffer: streamResult.textBuffer,
      thinkingBuffer: streamResult.thinkingBuffer,
      toolCalls: streamResult.toolCalls,
      finishReason: streamResult.finishReason,
      usage: streamResult.usage,
      retryCount: 0,
      overflowRecoveryCount,
    };
  } catch (caught) {
    const error = toError(caught);
    const code = classifyError(caught);

    if (code === 'context_overflow') {
      overflowRecoveryCount++;
      const overflowEvent: AgentEvent = { type: 'context_overflow', messages: [...messages] };
      yield await emitPhaseEvent(runtime, 'model', iteration, overflowEvent);

      if (extensions.contextOverflows.length && overflowRecoveryCount <= maxOverflowRecoveries) {
        for (const contribution of extensions.contextOverflows) {
          const result = await withTurnDeadline(
            runtime.turnDeadline,
            Promise.resolve(contribution.handleContextOverflow({ messages: [...messages] })),
          );
          if (result.action === 'recover') {
            messages.length = 0;
            for (const message of result.messages) messages.push(message);
            return { action: 'recoveredContext', retryCount, overflowRecoveryCount };
          }
        }
      }

      return {
        action: 'terminal',
        event: { type: 'error', error, code: 'context_overflow' },
        retryCount,
        overflowRecoveryCount,
      };
    }

    let shouldRetry = false;
    let retryDelay = 1000;
    if (extensions.errorRecovers.length) {
      const errorEvent = normalizeAgentError(error, code);
      for (const contribution of extensions.errorRecovers) {
        const result = await withTurnDeadline(
          runtime.turnDeadline,
          Promise.resolve(contribution.recoverError({ event: errorEvent, error, code })),
        );
        if (result.action === 'retry' && retryCount < maxRetries) {
          shouldRetry = true;
          retryDelay = result.delayMs ?? 1000;
          break;
        }
      }
    } else {
      shouldRetry = (code === 'rate_limited' || code === 'stream_error') && retryCount < maxRetries;
    }

    if (shouldRetry) {
      retryCount++;
      return { action: 'retry', retryCount, overflowRecoveryCount, delayMs: retryDelay };
    }

    return {
      action: 'terminal',
      event: { type: 'error', error, code },
      retryCount,
      overflowRecoveryCount,
    };
  }
}

function persistTransformedMessages(
  messages: LanguageMessage[],
  transformedMessages: LanguageMessage[],
  offset: number,
): void {
  for (let i = 0; i < messages.length && offset + i < transformedMessages.length; i++) {
    if (messages[i] !== transformedMessages[offset + i]) {
      messages[i] = transformedMessages[offset + i];
    }
  }
}
