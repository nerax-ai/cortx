import { afterEach, describe, expect, test } from 'bun:test';
import { PluginRegistry } from '@nerax-ai/plugin';
import { Cortx } from '../../src/index.js';
import {
  AGENT_EVENT_OBSERVER,
  AGENT_MESSAGES_TRANSFORM,
  AGENT_SESSION_POLICY,
  AGENT_SYSTEM_TRANSFORM,
  AGENT_TOOL,
  defineCortxPlugin,
  type AgentEvent,
  type CortxExtensionType,
  type CortxFactoryMap,
  type CortxRegistry,
  type LanguageMessage,
} from '../../src/index.js';
import { collectEvents, createTestLogger, mockLanguage, runtimeExtensions, textOfMessage, textResponse, toolResponse } from './helpers.js';

function createRegistry(appName: string): CortxRegistry {
  return PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({ appName });
}

async function collectCortx(cortx: Cortx, message = 'hello'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of cortx.run(message)) events.push(event);
  return events;
}

describe('conformance: runtime extensions', () => {
  afterEach(() => {
    PluginRegistry.reset();
  });

  test('configured package id activates every matching agent contribution in stable registration order', async () => {
    const registry = createRegistry('conformance-runtime-package');
    const captured: LanguageMessage[][] = [];
    const observed: string[] = [];

    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'core-bundle', name: 'core-bundle', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL, 'echo-tool', () => ({
          name: 'echo',
          inputSchema: {},
          execute: async (input) => ({ success: true, output: input.msg }),
        }));
        ctx.register(AGENT_SYSTEM_TRANSFORM, 'system-a', () => ({
          transformSystem: ({ system }) => ({ system: `${system}|system-a` }),
        }));
        ctx.register(AGENT_SYSTEM_TRANSFORM, 'system-b', () => ({
          transformSystem: ({ system }) => ({ system: `${system}|system-b` }),
        }));
        ctx.register(AGENT_MESSAGES_TRANSFORM, 'messages-a', () => ({
          transformMessages: ({ messages }) => ({
            messages: messages.map((message) => message.role === 'user'
              ? { ...message, content: [{ type: 'text', text: textOfMessage(message).replace('SECRET', '[redacted]') }] } as LanguageMessage
              : message),
          }),
        }));
        ctx.register(AGENT_EVENT_OBSERVER, 'observer', () => ({
          onAgentEvent(event) {
            observed.push(event.type);
          },
        }));
        ctx.register(AGENT_SESSION_POLICY, 'policy', () => ({
          beforeModelRequest({ messages }) {
            observed.push(`policy:${messages.length}`);
            return { action: 'allow' };
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([textResponse('ok')], (opts) => captured.push(opts.messages)), {
      appName: 'conformance-runtime-package',
      model: 'test',
      system: 'base',
      registry,
      plugins: [{ use: 'core-bundle' }],
    });

    const events = await collectCortx(cortx, 'SECRET');

    expect(events.at(-1)?.type).toBe('done');
    expect(captured[0][0].role).toBe('system');
    expect(textOfMessage(captured[0][0])).toStartWith('base');
    expect(textOfMessage(captured[0][0])).toEndWith('|system-a|system-b');
    expect(JSON.stringify(captured[0])).not.toContain('SECRET');
    expect(JSON.stringify(captured[0])).toContain('[redacted]');
    expect(observed).toContain('done');
    expect(observed.some((entry) => entry.startsWith('policy:'))).toBe(true);
  });

  test('duplicate contribution short ids keep deterministic short-name resolution while package id activates both', async () => {
    const logger = createTestLogger();
    const registry = PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({ appName: 'conformance-runtime-duplicate', logger });
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'first-plugin', name: 'first-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL, 'duplicate-tool', () => ({
          name: 'firstTool',
          inputSchema: {},
          execute: async () => ({ success: true, output: 'first' }),
        }));
      },
    }));
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'second-plugin', name: 'second-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL, 'duplicate-tool', () => ({
          name: 'secondTool',
          inputSchema: {},
          execute: async () => ({ success: true, output: 'second' }),
        }));
      },
    }));

    const shortNameCortx = new Cortx(mockLanguage([
      toolResponse('c1', 'firstTool', '{}'),
      textResponse('done'),
    ]), {
      appName: 'conformance-runtime-duplicate',
      model: 'test',
      registry,
      plugins: [{ use: 'duplicate-tool' }],
    });
    const packageCortx = new Cortx(mockLanguage([
      toolResponse('c1', 'secondTool', '{}'),
      textResponse('done'),
    ]), {
      appName: 'conformance-runtime-duplicate',
      model: 'test',
      registry,
      plugins: [{ use: 'second-plugin' }],
    });

    const shortNameEvents = await collectCortx(shortNameCortx);
    const packageEvents = await collectCortx(packageCortx);

    expect(shortNameEvents.find((event) => event.type === 'tool_result')).toMatchObject({ type: 'tool_result', result: 'first' });
    expect(packageEvents.find((event) => event.type === 'tool_result')).toMatchObject({ type: 'tool_result', result: 'second' });
    expect(logger.records.some((record) => record.message.includes('Short name conflict'))).toBe(true);
  });

  test('system transforms run sequentially and can initialize an empty system prompt', async () => {
    const captured: LanguageMessage[][] = [];
    const extensions = runtimeExtensions({
      systemTransforms: [
        { transformSystem: ({ system }) => ({ system: system ? `${system}\nA` : 'A' }) },
        { transformSystem: ({ system }) => ({ system: `${system}\nB` }) },
      ],
    });

    await collectEvents({
      language: mockLanguage([textResponse('ok')], (opts) => captured.push(opts.messages)),
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      extensions,
    });

    expect(captured[0][0].role).toBe('system');
    expect(textOfMessage(captured[0][0])).toBe('A\nB');
  });

  test('messages transform is model-visible and persisted into the next model request', async () => {
    const captured: LanguageMessage[][] = [];
    const extensions = runtimeExtensions({
      messagesTransforms: [{
        transformMessages({ messages }) {
          return {
            messages: messages.map((message) => message.role === 'user'
              ? { ...message, content: [{ type: 'text', text: textOfMessage(message).replace('/expand', 'expanded instruction') }] } as LanguageMessage
              : message),
          };
        },
      }],
    });

    await collectEvents({
      language: mockLanguage([
        textResponse('first'),
        textResponse('second'),
      ], (opts) => captured.push(opts.messages)),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: '/expand' }] }],
      extensions,
      controller: {
        isSteered: false,
        isAborted: false,
        hasFollowUps: true,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        steer() {},
        followUp() {},
        abort() {},
        answerUser() {},
        rejectPendingQuestions() {},
        consumeSteering: () => [],
        consumeFollowUps: () => [{ role: 'user', content: [{ type: 'text', text: 'next' }] }],
      },
    });

    expect(JSON.stringify(captured[0])).toContain('expanded instruction');
    expect(JSON.stringify(captured[1])).toContain('expanded instruction');
    expect(JSON.stringify(captured[1])).toContain('next');
  });

  test('missing configured extension fails before the model is called', async () => {
    const registry = createRegistry('conformance-runtime-missing');
    let streamCalled = false;
    const cortx = new Cortx(mockLanguage([textResponse('ok')], () => { streamCalled = true; }), {
      appName: 'conformance-runtime-missing',
      model: 'test',
      registry,
      plugins: [{ use: 'missing-extension' }],
    });

    await expect(collectCortx(cortx)).rejects.toThrow('agent extension not found');
    expect(streamCalled).toBe(false);
  });
});
