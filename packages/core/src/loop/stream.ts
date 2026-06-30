import type { LanguageClient } from '@synax-ai/core';
import type { LanguageTokenUsage } from '@synax-ai/sdk';
import type {
  AgentEvent,
  AgentRuntimeExtensions,
  ErrorCode,
  LanguageMessage,
  LanguageToolCallContent,
  Logger,
  Tool,
} from '@cortx/sdk';
import { emit } from './events.js';

export interface StreamModelInput {
  language: LanguageClient;
  model: string;
  messages: LanguageMessage[];
  tools: Tool[];
  maxOutputTokens?: number;
  temperature?: number;
  extensions: AgentRuntimeExtensions;
  logger: Logger;
}

export interface StreamModelOutput {
  textBuffer: string;
  thinkingBuffer: string;
  toolCalls: LanguageToolCallContent[];
  finishReason?: string;
  usage?: LanguageTokenUsage;
}

export function classifyError(e: unknown): ErrorCode {
  const err = e instanceof Error ? e : new Error(String(e));
  const msg = err.message.toLowerCase();
  const status = (err as { statusCode?: number; status?: number })?.statusCode ?? (err as { statusCode?: number; status?: number })?.status ?? 0;
  if (status === 413 || msg.includes('context length') || msg.includes('context window') || msg.includes('prompt is too long') || msg.includes('too many tokens')) return 'context_overflow';
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limited';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500 || msg.includes('503') || msg.includes('500') || msg.includes('server error')) return 'stream_error';
  return 'stream_error';
}

export async function* streamModel(input: StreamModelInput): AsyncGenerator<AgentEvent, StreamModelOutput> {
  const { language, model, messages, maxOutputTokens, temperature, tools, extensions, logger } = input;
  const toolCalls: LanguageToolCallContent[] = [];
  const toolInputBuffers = new Map<string, { name: string; buf: string }>();
  let textBuffer = '';
  let thinkingBuffer = '';
  let finishReason: string | undefined;
  let usage: LanguageTokenUsage | undefined;

  for await (const part of language.stream({
    model,
    messages,
    maxOutputTokens,
    temperature,
    tools: tools.length
      ? tools.map((tool) => ({ type: 'function' as const, name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      : undefined,
  })) {
    if (part.type === 'text-delta') {
      textBuffer += part.delta;
      const event: AgentEvent = { type: 'text_delta', delta: part.delta };
      await emit(extensions, event, logger);
      yield event;
    } else if (part.type === 'reasoning-delta') {
      thinkingBuffer += part.delta;
      const event: AgentEvent = { type: 'thinking_delta', delta: part.delta };
      await emit(extensions, event, logger);
      yield event;
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
