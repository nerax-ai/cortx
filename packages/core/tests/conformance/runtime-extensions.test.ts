import { describe, expect, test } from 'bun:test';
import {
  Cortx,
  type AgentEvent,
  type LanguageMessage,
} from '../../src/index.js';
import { mockLanguage, runtimeExtensions, textOfMessage, textResponse } from './helpers.js';

async function collectCortx(cortx: Cortx, message = 'hello'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of cortx.run(message)) events.push(event);
  return events;
}

describe('conformance: assembled runtime extensions', () => {
  test('Host-assembled contributions execute in stable array order', async () => {
    const captured: LanguageMessage[][] = [];
    const observed: string[] = [];
    const extensions = runtimeExtensions({
      systemTransforms: [
        { transformSystem: ({ system }) => ({ system: `${system}|system-a` }) },
        { transformSystem: ({ system }) => ({ system: `${system}|system-b` }) },
      ],
      messagesTransforms: [{
        transformMessages: ({ messages }) => ({
          messages: messages.map((message) =>
            message.role === 'user'
              ? { ...message, content: [{ type: 'text', text: textOfMessage(message).replace('SECRET', '[redacted]') }] }
              : message,
          ) as LanguageMessage[],
        }),
      }],
      eventObservers: [{ onAgentEvent: (event) => observed.push(event.type) }],
      sessionPolicies: [{
        beforeModelRequest({ messages }) {
          observed.push(`policy:${messages.length}`);
          return { action: 'allow' };
        },
      }],
    });

    const cortx = new Cortx(mockLanguage([textResponse('ok')], (input) => captured.push(input.messages)), {
      model: 'test',
      system: 'base',
      extensions,
    });
    const events = await collectCortx(cortx, 'SECRET');

    expect(events.at(-1)?.type).toBe('done');
    expect(textOfMessage(captured[0][0])).toEndWith('|system-a|system-b');
    expect(JSON.stringify(captured[0])).toContain('[redacted]');
    expect(observed).toContain('done');
    expect(observed.some((entry) => entry.startsWith('policy:'))).toBe(true);
  });

  test('empty assembled extensions require no plugin subsystem', async () => {
    const cortx = new Cortx(mockLanguage([textResponse('ok')]), {
      model: 'test',
      extensions: runtimeExtensions({}),
    });
    expect((await collectCortx(cortx)).at(-1)?.type).toBe('done');
  });
});
