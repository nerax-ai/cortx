import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import type { AgentEvent, AgentRuntimeExtensions, LanguageMessage, Logger } from '@cortx/sdk';
import { createEmptyAgentRuntimeExtensions } from '@cortx/sdk';
import { agentLoop } from '../../src/index.js';

export type StreamParts = LanguageStreamPart[];

export function createTestLogger(namespace: string[] = [], records: Array<{ namespace: string[]; message: string }> = []): Logger & { records: Array<{ namespace: string[]; message: string }> } {
  const logger: Logger & { records: Array<{ namespace: string[]; message: string }> } = {
    records,
    debug: (...args: unknown[]) => records.push({ namespace, message: String(args[0] ?? '') }),
    info: (...args: unknown[]) => records.push({ namespace, message: String(args[0] ?? '') }),
    warn: (...args: unknown[]) => records.push({ namespace, message: String(args[0] ?? '') }),
    error: (...args: unknown[]) => records.push({ namespace, message: String(args[0] ?? '') }),
    scope: (name: string) => createTestLogger([...namespace, name], records),
    withContext: () => logger,
  };
  return logger;
}

export function runtimeExtensions(overrides: Partial<AgentRuntimeExtensions>): AgentRuntimeExtensions {
  return { ...createEmptyAgentRuntimeExtensions(), ...overrides };
}

export function textResponse(text: string, usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } }): StreamParts {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage },
  ];
}

export function lengthResponse(text: string): StreamParts {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'length', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

export function toolResponse(toolCallId: string, toolName: string, input: string): StreamParts {
  return multiToolResponse([{ id: toolCallId, name: toolName, input }]);
}

export function multiToolResponse(calls: { id: string; name: string; input: string }[]): StreamParts {
  const parts: LanguageStreamPart[] = [];
  for (const call of calls) {
    parts.push({ type: 'tool-input-start', id: call.id, toolName: call.name });
    parts.push({ type: 'tool-input-delta', id: call.id, delta: call.input });
    parts.push({ type: 'tool-input-end', id: call.id });
  }
  parts.push({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } });
  return parts;
}

export function lengthToolResponse(calls: { id: string; name: string; input: string }[]): StreamParts {
  const parts = multiToolResponse(calls);
  return parts.map((part) =>
    part.type === 'finish'
      ? { ...part, finishReason: 'length' as const }
      : part,
  );
}

export function mockLanguage(
  responses: StreamParts[],
  onStream?: (opts: { messages: LanguageMessage[]; tools?: unknown[] }) => void,
): LanguageClient {
  let index = 0;
  return {
    stream: async function* (opts: { messages: LanguageMessage[]; tools?: unknown[] }) {
      onStream?.(opts);
      const parts = responses[index++] ?? responses[responses.length - 1] ?? [];
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

export async function collectEvents(opts: Parameters<typeof agentLoop>[0]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agentLoop(opts)) {
    events.push(event);
  }
  return events;
}

export function textOfMessage(message: LanguageMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('');
}
