import type { LanguageClient } from '@synax-ai/core';
import type { LanguageTokenUsage } from '@synax-ai/sdk';
import type { AgentEvent, LanguageMessage, LanguageToolCallContent, Tool } from '@cortx/sdk';
import { emitPhaseEvent, withAbortSignal, withTurnDeadline, type AgentLoopRuntime } from './pipeline.js';
import { budgetExceededError, classifyAgentError } from './errors.js';

export interface StreamModelInput {
  runtime: AgentLoopRuntime;
  language: LanguageClient;
  model: string;
  messages: LanguageMessage[];
  tools: Tool[];
  maxOutputTokens?: number;
  temperature?: number;
  iteration: number;
}

export interface StreamModelOutput {
  textBuffer: string;
  thinkingBuffer: string;
  toolCalls: LanguageToolCallContent[];
  finishReason?: string;
  usage?: LanguageTokenUsage;
}

export const classifyError = classifyAgentError;

const CHARS_PER_ESTIMATED_TOKEN = 4;

function estimateOutputTokens(text: string, thinking: string): number {
  const visibleChars = text.length + thinking.length;
  return visibleChars === 0 ? 0 : Math.ceil(visibleChars / CHARS_PER_ESTIMATED_TOKEN);
}

function assertWithinStreamingBudget(runtime: AgentLoopRuntime, nextText: string, nextThinking: string): void {
  const tokenBudget = runtime.limits?.tokenBudget;
  if (tokenBudget === undefined) return;
  if (estimateOutputTokens(nextText, nextThinking) <= tokenBudget) return;
  const error = budgetExceededError(tokenBudget);
  if (!runtime.abortController.signal.aborted) runtime.abortController.abort(error);
  throw error;
}

export async function* streamModel(input: StreamModelInput): AsyncGenerator<AgentEvent, StreamModelOutput> {
  const { runtime, language, model, messages, maxOutputTokens, temperature, tools, iteration } = input;
  const toolCalls: LanguageToolCallContent[] = [];
  const toolInputBuffers = new Map<string, { name: string; buf: string }>();
  let textBuffer = '';
  let thinkingBuffer = '';
  let finishReason: string | undefined;
  let usage: LanguageTokenUsage | undefined;

  const request = {
    model,
    messages,
    maxOutputTokens,
    temperature,
    reasoning: runtime.reasoning,
    tools: tools.length
      ? tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))
      : undefined,
  };
  const stream = language.stream(request, { signal: runtime.abortController.signal } as never);
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    const next = await withAbortSignal(
      runtime.abortController.signal,
      withTurnDeadline(runtime.turnDeadline, iterator.next()),
    );
    if (next.done) break;
    const part = next.value;
    if (part.type === 'text-delta') {
      const nextText = textBuffer + part.delta;
      assertWithinStreamingBudget(runtime, nextText, thinkingBuffer);
      textBuffer = nextText;
      const event: AgentEvent = { type: 'text_delta', delta: part.delta };
      yield await emitPhaseEvent(runtime, 'model', iteration, event);
    } else if (part.type === 'reasoning-delta') {
      const nextThinking = thinkingBuffer + part.delta;
      assertWithinStreamingBudget(runtime, textBuffer, nextThinking);
      thinkingBuffer = nextThinking;
      const event: AgentEvent = { type: 'thinking_delta', delta: part.delta };
      yield await emitPhaseEvent(runtime, 'model', iteration, event);
    } else if (part.type === 'tool-input-start') {
      toolInputBuffers.set(part.id, { name: part.toolName, buf: '' });
    } else if (part.type === 'tool-input-delta') {
      const entry = toolInputBuffers.get(part.id);
      if (entry) entry.buf += part.delta;
    } else if (part.type === 'tool-input-end') {
      const entry = toolInputBuffers.get(part.id);
      if (entry) {
        toolCalls.push({ type: 'tool-call', toolCallId: part.id, toolName: entry.name, input: entry.buf });
        toolInputBuffers.delete(part.id);
      }
    } else if (part.type === 'finish') {
      finishReason = part.finishReason ?? undefined;
      usage = part.usage;
    }
  }

  return { textBuffer, thinkingBuffer, toolCalls, finishReason, usage };
}
