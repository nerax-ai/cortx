import { afterEach, describe, expect, test } from 'bun:test';
import { PluginRegistry } from '@nerax-ai/plugin';
import { AGENT_SESSION_POLICY, Cortx, defineCortxPlugin, type AgentEvent, type CortxFactoryMap, type CortxExtensionType, type CortxRegistry } from '../../src/index.js';
import { collectEvents, mockLanguage, runtimeExtensions, textResponse, toolResponse } from './helpers.js';

function createRegistry(appName: string): CortxRegistry {
  return PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({ appName });
}

async function collectCortx(cortx: Cortx, message = 'hello'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of cortx.run(message)) events.push(event);
  return events;
}

describe('conformance: session policy', () => {
  afterEach(() => {
    PluginRegistry.reset();
  });

  test('configured agent.sessionPolicy can hide tools before the model request', async () => {
    const registry = createRegistry('conformance-session-policy-tools');
    const capturedTools: unknown[][] = [];
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'policy-plugin', name: 'policy-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_SESSION_POLICY, 'read-only', () => ({
          beforeModelRequest({ tools }) {
            return { action: 'rewriteTools', tools: tools.filter((tool) => tool.sideEffects === 'read') };
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([textResponse('ok')], (opts) => capturedTools.push(opts.tools ?? [])), {
      appName: 'conformance-session-policy-tools',
      model: 'test',
      registry,
      plugins: [{ use: 'read-only' }],
      tools: [
        { name: 'readFile', sideEffects: 'read', inputSchema: {}, execute: async () => ({ success: true, output: 'read' }) },
        { name: 'writeFile', sideEffects: 'write', inputSchema: {}, execute: async () => ({ success: true, output: 'write' }) },
      ],
    });

    await collectCortx(cortx);

    expect(JSON.stringify(capturedTools[0])).toContain('readFile');
    expect(JSON.stringify(capturedTools[0])).not.toContain('writeFile');
  });

  test('beforeModelRequest can rewrite messages before provider dispatch', async () => {
    const capturedMessages: unknown[] = [];
    const events = await collectEvents({
      language: mockLanguage([textResponse('ok')], (opts) => capturedMessages.push(opts.messages)),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'original' }] }],
      extensions: runtimeExtensions({
        sessionPolicies: [{
          beforeModelRequest({ messages }) {
            return {
              action: 'rewriteMessages',
              messages: messages.map((message) => message.role === 'user'
                ? { ...message, content: [{ type: 'text', text: 'rewritten by policy' }] }
                : message),
            };
          },
        }],
      }),
    });

    expect(events.at(-1)?.type).toBe('done');
    expect(JSON.stringify(capturedMessages[0])).toContain('rewritten by policy');
    expect(JSON.stringify(capturedMessages[0])).not.toContain('original');
  });

  test('beforeModelRequest can deny dispatch before the provider is called', async () => {
    let streamCalled = false;
    const events = await collectEvents({
      language: mockLanguage([textResponse('should not run')], () => { streamCalled = true; }),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      extensions: runtimeExtensions({
        sessionPolicies: [{
          beforeModelRequest() {
            return { action: 'deny', reason: 'workspace locked', code: 'client_error' };
          },
        }],
      }),
    });

    expect(streamCalled).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['turn_start', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'client_error' });
  });

  test('beforeToolCall can deny write tools before execution while preserving tool-call/result pairing', async () => {
    let executed = false;
    const extensions = runtimeExtensions({
      sessionPolicies: [{
        beforeToolCall({ tool }) {
          if (tool?.sideEffects === 'write') return { action: 'deny', reason: 'read-only session' };
          return { action: 'allow' };
        },
      }],
    });

    const events = await collectEvents({
      language: mockLanguage([
        toolResponse('c1', 'writeFile', '{}'),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
      tools: [{
        name: 'writeFile',
        sideEffects: 'write',
        inputSchema: {},
        execute: async () => {
          executed = true;
          return { success: true, output: 'written' };
        },
      }],
      extensions,
    });

    expect(executed).toBe(false);
    expect(events.find((event) => event.type === 'tool_use')).toMatchObject({ type: 'tool_use', toolCall: { toolCallId: 'c1' } });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ type: 'tool_result', toolCallId: 'c1', result: 'read-only session', isError: true });
  });

  test('beforeToolCall rewrites tool input before existing toolBefore hooks and execution', async () => {
    let executedInput: Record<string, unknown> | undefined;
    let hookInput: Record<string, unknown> | undefined;
    const extensions = runtimeExtensions({
      sessionPolicies: [{
        beforeToolCall({ input }) {
          return { action: 'rewriteToolInput', input: { ...input, source: 'policy' } };
        },
      }],
      toolBefores: [{
        beforeToolExecute({ input }) {
          hookInput = input;
          return { action: 'rewrite', input: { ...input, source: `${input.source}+hook` } };
        },
      }],
    });

    const events = await collectEvents({
      language: mockLanguage([
        toolResponse('c1', 'echo', '{"source":"model"}'),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'rewrite' }] }],
      tools: [{
        name: 'echo',
        inputSchema: {},
        execute: async (input) => {
          executedInput = input;
          return { success: true, output: input.source };
        },
      }],
      extensions,
    });

    expect(hookInput).toEqual({ source: 'policy' });
    expect(executedInput).toEqual({ source: 'policy+hook' });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ type: 'tool_result', result: 'policy+hook', isError: false });
  });

  test('beforeToolCall can short-circuit tool execution with a model-visible result', async () => {
    let executed = false;
    const capturedMessages: unknown[] = [];
    const events = await collectEvents({
      language: mockLanguage([
        toolResponse('c1', 'lookupCache', '{}'),
        textResponse('done'),
      ], (opts) => capturedMessages.push(opts.messages)),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'lookup' }] }],
      tools: [{
        name: 'lookupCache',
        inputSchema: {},
        execute: async () => {
          executed = true;
          return { success: true, output: 'fresh' };
        },
      }],
      extensions: runtimeExtensions({
        sessionPolicies: [{
          beforeToolCall() {
            return { action: 'shortCircuitTool', result: { success: true, output: 'cached' } };
          },
        }],
      }),
    });

    expect(executed).toBe(false);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ type: 'tool_result', toolCallId: 'c1', result: 'cached', isError: false });
    expect(JSON.stringify(capturedMessages[1])).toContain('cached');
  });

  test('beforeTurn can enforce an iteration budget with a typed terminal error', async () => {
    const events = await collectEvents({
      language: mockLanguage([
        textResponse('first'),
        textResponse('second'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      extensions: runtimeExtensions({
        sessionPolicies: [{
          beforeTurn({ iteration }) {
            return iteration > 1 ? { action: 'deny', reason: 'turn budget exceeded', code: 'client_error' } : { action: 'allow' };
          },
        }],
      }),
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

    expect(events.map((event) => event.type)).toEqual([
      'turn_start',
      'text_delta',
      'text',
      'follow_up',
      'turn_end',
      'turn_start',
      'error',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'client_error' });
  });

  test('beforeSubAgent can deny child agents before a session is created', async () => {
    const registry = createRegistry('conformance-session-policy-subagent');
    await registry.register(defineCortxPlugin({
      manifest: { manifestVersion: 1, id: 'policy-plugin', name: 'policy-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register(AGENT_SESSION_POLICY, 'no-subagents', () => ({
          beforeSubAgent() {
            return { action: 'deny', reason: 'sub-agents disabled' };
          },
        }));
      },
    }));

    const cortx = new Cortx(mockLanguage([
      toolResponse('agent-call', 'agent', '{"prompt":"delegate","description":"child"}'),
      textResponse('done'),
    ]), {
      appName: 'conformance-session-policy-subagent',
      model: 'test',
      registry,
      plugins: [{ use: 'no-subagents' }],
    });

    const events = await collectCortx(cortx, 'delegate');

    expect(cortx.agentSessions.get('agent-call')).toBeUndefined();
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      toolCallId: 'agent-call',
      result: 'sub-agents disabled',
      isError: true,
    });
  });
});
