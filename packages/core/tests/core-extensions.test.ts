import { afterEach, describe, expect, test } from 'bun:test';
import { Cortx } from '../src/index';
import {
  AGENT_CONTEXT_OVERFLOW,
  AGENT_ERROR_RECOVER,
  AGENT_EVENT_OBSERVER,
  AGENT_MESSAGES_TRANSFORM,
  AGENT_SYSTEM_TRANSFORM,
  AGENT_TOOL,
  AGENT_TOOL_AFTER,
  AGENT_TOOL_BEFORE,
  defineCortxPlugin,
  type AgentEvent,
  type CortxFactoryMap,
  type CortxRegistry,
  type CortxExtensionType,
  type LanguageMessage,
} from '../src/index';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import { PluginRegistry } from '@nerax-ai/plugin';

type StreamParts = LanguageStreamPart[];

function textResponse(text: string): StreamParts {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function toolResponse(toolCallId: string, toolName: string, input: string): StreamParts {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: input },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function mockLanguage(responses: StreamParts[], onStream?: (opts: { messages: LanguageMessage[]; tools?: unknown[] }) => void): LanguageClient {
  let index = 0;
  return {
    stream: async function* (opts: { messages: LanguageMessage[]; tools?: unknown[] }) {
      onStream?.(opts);
      const parts = responses[index++] ?? responses[responses.length - 1] ?? [];
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

function createRegistry(appName: string): CortxRegistry {
  return PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({ appName });
}

async function collect(cortx: Cortx, message = 'hello'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of cortx.run(message)) {
    events.push(event);
  }
  return events;
}

describe('core agent.* extensions', () => {
  afterEach(() => {
    PluginRegistry.reset();
  });

  test('loads a package worth of agent extensions from one configured use', async () => {
    const registry = createRegistry('core-extension-package-test');
    const capturedMessages: LanguageMessage[][] = [];
    const observed: string[] = [];
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'bundle-plugin', name: 'bundle-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_SYSTEM_TRANSFORM, 'repo-policy', () => ({
          transformSystem(input) {
            return { system: `${input.system}\npolicy` };
          },
        }));
        ctx.register(AGENT_MESSAGES_TRANSFORM, 'redact', () => ({
          transformMessages(input) {
            return {
              messages: input.messages.map((message) => {
                if (message.role !== 'user') return message;
                return {
                  ...message,
                  content: Array.isArray(message.content)
                    ? message.content.map((part) => part.type === 'text' ? { ...part, text: part.text.replace('SECRET', '[redacted]') } : part)
                    : message.content,
                } as LanguageMessage;
              }),
            };
          },
        }));
        ctx.register(AGENT_EVENT_OBSERVER, 'events', () => ({
          onAgentEvent(event) {
            observed.push(event.type);
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([textResponse('ok')], (opts) => capturedMessages.push(opts.messages)), {
      appName: 'core-extension-package-test',
      model: 'test',
      system: 'base',
      registry,
      plugins: [{ use: 'bundle-plugin' }],
    });

    const events = await collect(cortx, 'SECRET');
    expect(events.at(-1)?.type).toBe('done');
    expect(capturedMessages[0][0].role).toBe('system');
    expect(JSON.stringify(capturedMessages[0][0])).toContain('policy');
    expect(JSON.stringify(capturedMessages[0])).not.toContain('SECRET');
    expect(JSON.stringify(capturedMessages[0])).toContain('[redacted]');
    expect(observed).toContain('done');
  });

  test('agent.tool registers a model-visible tool and executes it', async () => {
    const registry = createRegistry('core-extension-tool-test');
    const capturedTools: unknown[][] = [];
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'tool-plugin', name: 'tool-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL, 'echo-tool', () => ({
          name: 'echo',
          inputSchema: {},
          execute: async (input) => ({ success: true, output: input.msg }),
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([
      toolResponse('tc1', 'echo', '{"msg":"hello"}'),
      textResponse('done'),
    ], (opts) => capturedTools.push(opts.tools ?? [])), {
      appName: 'core-extension-tool-test',
      model: 'test',
      registry,
      plugins: [{ use: 'echo-tool' }],
    });

    const events = await collect(cortx);
    expect(capturedTools[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'echo' })]));
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: 'hello', isError: false });
  });

  test('agent.toolBefore rewrites tool input and agent.toolAfter rewrites output', async () => {
    const registry = createRegistry('core-extension-tool-pipeline-test');
    let receivedInput: Record<string, unknown> | undefined;
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'pipeline-plugin', name: 'pipeline-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL_BEFORE, 'rewrite', () => ({
          beforeToolExecute(input) {
            return { action: 'rewrite', input: { ...input.input, msg: 'rewritten' } };
          },
        }));
        ctx.register(AGENT_TOOL_AFTER, 'suffix', () => ({
          afterToolExecute(input) {
            return { result: { ...input.result, output: `${String(input.result.output)}!` } };
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([
      toolResponse('tc1', 'echo', '{"msg":"original"}'),
      textResponse('done'),
    ]), {
      appName: 'core-extension-tool-pipeline-test',
      model: 'test',
      tools: [{
        name: 'echo',
        inputSchema: {},
        execute: async (input) => {
          receivedInput = input;
          return { success: true, output: input.msg };
        },
      }],
      registry,
      plugins: [{ use: 'pipeline-plugin' }],
    });

    const events = await collect(cortx);
    expect(receivedInput).toMatchObject({ msg: 'rewritten' });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: 'rewritten!', isError: false });
  });

  test('agent.toolBefore can repair invalid JSON input before execution', async () => {
    const registry = createRegistry('core-extension-repair-input-test');
    let receivedInput: Record<string, unknown> | undefined;
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'repair-plugin', name: 'repair-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL_BEFORE, 'repair', () => ({
          beforeToolExecute() {
            return { action: 'rewrite', input: { msg: 'repaired' } };
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([
      toolResponse('tc1', 'echo', '{"msg":'),
      textResponse('done'),
    ]), {
      appName: 'core-extension-repair-input-test',
      model: 'test',
      tools: [{
        name: 'echo',
        inputSchema: {},
        execute: async (input) => {
          receivedInput = input;
          return { success: true, output: input.msg };
        },
      }],
      registry,
      plugins: [{ use: 'repair' }],
    });

    const events = await collect(cortx);
    expect(receivedInput).toMatchObject({ msg: 'repaired' });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: 'repaired', isError: false });
  });

  test('agent.toolBefore short-circuits without executing the tool', async () => {
    const registry = createRegistry('core-extension-short-circuit-test');
    let executed = false;
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'short-plugin', name: 'short-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL_BEFORE, 'cache-hit', () => ({
          beforeToolExecute() {
            return { action: 'shortCircuit', result: { success: true, output: 'cached' } };
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([
      toolResponse('tc1', 'echo', '{"msg":"original"}'),
      textResponse('done'),
    ]), {
      appName: 'core-extension-short-circuit-test',
      model: 'test',
      tools: [{
        name: 'echo',
        inputSchema: {},
        execute: async () => {
          executed = true;
          return { success: true, output: 'real' };
        },
      }],
      registry,
      plugins: [{ use: 'cache-hit' }],
    });

    const events = await collect(cortx);
    expect(executed).toBe(false);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: 'cached', isError: false });
  });

  test('agent.toolBefore short-circuit preserves error output', async () => {
    const registry = createRegistry('core-extension-short-error-test');
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'short-error-plugin', name: 'short-error-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_TOOL_BEFORE, 'policy-deny', () => ({
          beforeToolExecute() {
            return { action: 'shortCircuit', result: { success: false, output: 'denied output' } };
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([
      toolResponse('tc1', 'echo', '{"msg":"original"}'),
      textResponse('done'),
    ]), {
      appName: 'core-extension-short-error-test',
      model: 'test',
      tools: [{
        name: 'echo',
        inputSchema: {},
        execute: async () => ({ success: true, output: 'real' }),
      }],
      registry,
      plugins: [{ use: 'policy-deny' }],
    });

    const events = await collect(cortx);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: 'denied output', isError: true });
  });

  test('agent.errorRecover retries once and succeeds', async () => {
    const registry = createRegistry('core-extension-recover-test');
    let attempts = 0;
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'recover-plugin', name: 'recover-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_ERROR_RECOVER, 'retry', () => ({
          recoverError() {
            return { action: 'retry', delayMs: 0 };
          },
        }));
      },
    }));

    const language = {
      stream: async function* () {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
        yield* textResponse('ok');
      },
    } as unknown as LanguageClient;

    const cortx = new Cortx(language, {
      appName: 'core-extension-recover-test',
      model: 'test',
      registry,
      plugins: [{ use: 'retry' }],
    });

    const events = await collect(cortx);
    expect(attempts).toBe(2);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('agent.contextOverflow replaces messages and retries', async () => {
    const registry = createRegistry('core-extension-overflow-test');
    let attempts = 0;
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'overflow-plugin', name: 'overflow-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_CONTEXT_OVERFLOW, 'compact', () => ({
          handleContextOverflow() {
            return {
              action: 'recover',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'compact summary' }] }],
            };
          },
        }));
      },
    }));

    const language = {
      stream: async function* () {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('context length exceeded'), { statusCode: 413 });
        yield* textResponse('ok');
      },
    } as unknown as LanguageClient;

    const cortx = new Cortx(language, {
      appName: 'core-extension-overflow-test',
      model: 'test',
      registry,
      plugins: [{ use: 'compact' }],
    });

    const events = await collect(cortx);
    expect(attempts).toBe(2);
    expect(events.some((event) => event.type === 'context_overflow')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('agent.eventObserver failures are isolated from the loop', async () => {
    const registry = createRegistry('core-extension-observer-isolation-test');
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'observer-plugin', name: 'observer-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_EVENT_OBSERVER, 'throwing-observer', () => ({
          onAgentEvent(event) {
            if (event.type === 'done') throw new Error('observer failed');
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([textResponse('ok')]), {
      appName: 'core-extension-observer-isolation-test',
      model: 'test',
      registry,
      plugins: [{ use: 'throwing-observer' }],
    });

    const events = await collect(cortx);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('reports missing configured extension using registry diagnostics', async () => {
    const registry = createRegistry('core-extension-missing-test');
    const cortx = new Cortx(mockLanguage([textResponse('ok')]), {
      appName: 'core-extension-missing-test',
      model: 'test',
      registry,
      plugins: [{ use: 'missing-extension' }],
    });

    await expect(collect(cortx)).rejects.toThrow('agent extension not found');
  });
});
