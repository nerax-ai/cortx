import { describe, expect, test } from 'bun:test';
import { agentLoop } from '../../src/index.js';
import { AgentLoopController } from '../../src/types.js';
import type { AgentEvent } from '../../src/index.js';
import { collectEvents, mockLanguage, runtimeExtensions, textResponse, toolResponse } from './helpers.js';

describe('conformance: control plane', () => {
  test('follow-up messages create a bounded next turn and are model-visible', async () => {
    const capturedMessages: unknown[] = [];
    const controller = new AgentLoopController();
    controller.followUp('next task');

    const events = await collectEvents({
      language: mockLanguage([
        textResponse('first'),
        textResponse('second'),
      ], (opts) => capturedMessages.push(opts.messages)),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      controller,
    });

    expect(events.map((event) => event.type)).toEqual([
      'turn_start',
      'text_delta',
      'text',
      'follow_up',
      'turn_end',
      'turn_start',
      'text_delta',
      'text',
      'turn_end',
      'done',
    ]);
    expect(JSON.stringify(capturedMessages[1])).toContain('next task');
  });

  test('steering before tool execution skips the pending tool batch and starts a new turn', async () => {
    const capturedMessages: unknown[] = [];
    const controller = new AgentLoopController();
    let executed = false;
    controller.steer('use this instruction instead');

    const events = await collectEvents({
      language: mockLanguage([
        toolResponse('c1', 'writeFile', '{}'),
        textResponse('steered answer'),
      ], (opts) => capturedMessages.push(opts.messages)),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      tools: [{
        name: 'writeFile',
        inputSchema: {},
        execute: async () => {
          executed = true;
          return { success: true, output: 'written' };
        },
      }],
      controller,
    });

    expect(executed).toBe(false);
    expect(events.find((event) => event.type === 'tool_use')).toBeUndefined();
    expect(events.find((event) => event.type === 'tool_result')).toBeUndefined();
    expect(events.find((event) => event.type === 'steered')).toMatchObject({ type: 'steered', message: 'use this instruction instead' });
    expect(JSON.stringify(capturedMessages[1])).toContain('use this instruction instead');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('abort after tool_use but before execution returns a typed terminal error', async () => {
    const controller = new AgentLoopController();
    let executed = false;
    const extensions = runtimeExtensions({
      eventObservers: [{
        onAgentEvent(event) {
          if (event.type === 'tool_use') controller.abort('stop before execution');
        },
      }],
    });

    const events = await collectEvents({
      language: mockLanguage([
        toolResponse('c1', 'writeFile', '{}'),
        textResponse('should not run'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      tools: [{
        name: 'writeFile',
        inputSchema: {},
        execute: async () => {
          executed = true;
          return { success: true, output: 'written' };
        },
      }],
      extensions,
      controller,
    });

    expect(executed).toBe(false);
    expect(events.find((event) => event.type === 'tool_use')).toBeDefined();
    expect(events.find((event) => event.type === 'tool_result')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'user_abort' });
  });

  test('abort before model dispatch does not call the language provider', async () => {
    const controller = new AgentLoopController();
    let streamCalled = false;
    controller.abort('cancelled');

    const events = await collectEvents({
      language: mockLanguage([textResponse('should not run')], () => {
        streamCalled = true;
      }),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      controller,
    });

    expect(streamCalled).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'user_abort' });
  });

  test('abort while askUser is pending releases the question and terminates the turn', async () => {
    const controller = new AgentLoopController();
    const gen = agentLoop({
      language: mockLanguage([
        toolResponse('c1', 'approvalTool', '{}'),
        textResponse('should not run'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }],
      tools: [{
        name: 'approvalTool',
        inputSchema: {},
        execute: async (_input, ctx) => {
          const answer = await ctx.askUser?.('Allow tool?');
          return { success: true, output: `answer:${answer}` };
        },
      }],
      controller,
    });

    const events: Awaited<ReturnType<typeof collectEvents>> = [];
    while (!events.some((event) => event.type === 'user_question')) {
      const next = await Promise.race([
        gen.next(),
        new Promise<IteratorResult<AgentEvent>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 100)),
      ]);
      expect(next.done).toBe(false);
      events.push(next.value);
    }

    controller.abort('cancel pending approval');
    for await (const event of gen) events.push(event);

    expect(events.find((event) => event.type === 'user_question')).toMatchObject({
      type: 'user_question',
      question: 'Allow tool?',
      toolCallId: 'c1',
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      toolCallId: 'c1',
      isError: true,
      result: 'cancel pending approval',
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'user_abort' });
  });

  test('continue mode executes persisted tool calls before calling the model again', async () => {
    const capturedMessages: unknown[] = [];
    let executed = false;

    const events = await collectEvents({
      language: mockLanguage([textResponse('done')], (opts) => capturedMessages.push(opts.messages)),
      model: 'test',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'start' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: '{"msg":"resumed"}' }] },
      ],
      tools: [{
        name: 'echo',
        inputSchema: {},
        execute: async (input) => {
          executed = true;
          return { success: true, output: input.msg };
        },
      }],
      skipInitialLlm: true,
    });

    expect(executed).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'turn_start',
      'tool_use',
      'tool_result',
      'turn_end',
      'turn_start',
      'text_delta',
      'text',
      'turn_end',
      'done',
    ]);
    expect(capturedMessages).toHaveLength(1);
    expect(JSON.stringify(capturedMessages[0])).toContain('resumed');
  });
});
