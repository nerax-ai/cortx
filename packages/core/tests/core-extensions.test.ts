import { describe, expect, test } from 'bun:test';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import {
  Cortx,
  createEmptyAgentRuntimeExtensions,
  type AgentEvent,
  type AgentRuntimeExtensions,
  type LanguageMessage,
} from '../src/index';

function textResponse(text: string): LanguageStreamPart[] {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function mockLanguage(
  responses: LanguageStreamPart[][],
  onStream?: (input: { messages: LanguageMessage[]; tools?: unknown[] }) => void,
): LanguageClient {
  let index = 0;
  return {
    stream: async function* (input: { messages: LanguageMessage[]; tools?: unknown[] }) {
      onStream?.(input);
      for (const part of responses[index++] ?? responses.at(-1) ?? []) yield part;
    },
  } as unknown as LanguageClient;
}

async function collect(cortx: Cortx, message = 'hello'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of cortx.run(message)) events.push(event);
  return events;
}

function extensions(input: Partial<AgentRuntimeExtensions>): AgentRuntimeExtensions {
  return { ...createEmptyAgentRuntimeExtensions(), ...input };
}

describe('Core accepts assembled extensions only', () => {
  test('assembled transforms and observers are applied without Registry access', async () => {
    const captured: LanguageMessage[][] = [];
    const observed: string[] = [];
    const cortx = new Cortx(mockLanguage([textResponse('ok')], (input) => captured.push(input.messages)), {
      model: 'test',
      system: 'base',
      extensions: extensions({
        systemTransforms: [{ transformSystem: ({ system }) => ({ system: `${system}|policy` }) }],
        messagesTransforms: [{
          transformMessages: ({ messages }) => ({
            messages: messages.map((message) =>
              message.role === 'user'
                ? { ...message, content: [{ type: 'text', text: JSON.stringify(message.content).replace('SECRET', '[redacted]') }] }
                : message,
            ) as LanguageMessage[],
          }),
        }],
        eventObservers: [{ onAgentEvent: (event) => observed.push(event.type) }],
      }),
    });

    const events = await collect(cortx, 'SECRET');

    expect(events.at(-1)?.type).toBe('done');
    expect(JSON.stringify(captured[0][0])).toContain('base|policy');
    expect(JSON.stringify(captured[0])).not.toContain('SECRET');
    expect(observed).toContain('done');
  });

  test('assembled tools are visible and executable', async () => {
    const language = mockLanguage([
      [
        { type: 'tool-input-start', id: 'c1', toolName: 'echo' },
        { type: 'tool-input-delta', id: 'c1', delta: '{"value":"ok"}' },
        { type: 'tool-input-end', id: 'c1' },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
      ],
      textResponse('done'),
    ]);
    const cortx = new Cortx(language, {
      model: 'test',
      extensions: extensions({
        tools: [{
          name: 'echo',
          inputSchema: {},
          execute: async (input) => ({ success: true, output: input.value }),
        }],
      }),
    });

    const events = await collect(cortx);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      result: 'ok',
      isError: false,
    });
  });

  test('Core config has no app-name, Registry, source, or plugin discovery behavior', async () => {
    let calls = 0;
    const cortx = new Cortx(mockLanguage([textResponse('ok')], () => calls++), { model: 'test' });
    await collect(cortx);
    expect(calls).toBe(1);
    expect(Object.keys(cortx)).not.toContain('registry');
  });
});
