import { describe, test, expect } from 'bun:test';
import { agentLoop, AgentLoopController } from '../src/index';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import { createEmptyAgentRuntimeExtensions, type AgentRuntimeExtensions, type Logger } from '@cortx/sdk';

type StreamParts = LanguageStreamPart[];

function createTestLogger(namespace: string[] = [], records: Array<{ namespace: string[]; message: string }> = []): Logger & { records: Array<{ namespace: string[]; message: string }> } {
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

function mockLanguage(responses: StreamParts[]): LanguageClient {
  let i = 0;
  return {
    stream: async function* () {
      const parts = responses[i++] ?? responses[responses.length - 1];
      for (const p of parts) yield p;
    },
  } as unknown as LanguageClient;
}

function textResponse(text: string): StreamParts {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } as any },
  ];
}

function toolResponse(toolCallId: string, toolName: string, input: string): StreamParts {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: input },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } as any },
  ];
}

function extensions(overrides: Partial<AgentRuntimeExtensions>): AgentRuntimeExtensions {
  return { ...createEmptyAgentRuntimeExtensions(), ...overrides };
}

describe('agentLoop (streaming)', () => {
  test('default logger fallback is silent without configured output', async () => {
    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    const calls: string[] = [];
    console.log = (...args: unknown[]) => calls.push(String(args[0] ?? ''));
    console.warn = (...args: unknown[]) => calls.push(String(args[0] ?? ''));
    console.error = (...args: unknown[]) => calls.push(String(args[0] ?? ''));
    try {
      const language = mockLanguage([textResponse('hello')]);
      const events = [];
      for await (const event of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event);
      }
      expect(events.at(-1)?.type).toBe('done');
      expect(calls).toHaveLength(0);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
  });

  test('separate injected loggers keep tool execution records isolated', async () => {
    const firstLogger = createTestLogger(['first']);
    const secondLogger = createTestLogger(['second']);
    const language = () =>
      mockLanguage([
        toolResponse('c1', 'echo', '{"msg":"hi"}'),
        textResponse('done'),
      ]);
    const tool = {
      name: 'echo',
      inputSchema: {},
      execute: async (_input: unknown, ctx: { logger: { info: (...args: unknown[]) => void } }) => {
        ctx.logger.info('tool ran');
        return { success: true, output: 'ok' };
      },
    };

    for await (const _event of agentLoop({
      language: language(),
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      logger: firstLogger,
    })) {}
    for await (const _event of agentLoop({
      language: language(),
      model: 'test',
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      logger: secondLogger,
    })) {}
    expect(firstLogger.records.some((record) => record.namespace.join('/') === 'first/echo')).toBe(true);
    expect(secondLogger.records.some((record) => record.namespace.join('/') === 'second/echo')).toBe(true);
    expect(firstLogger.records.every((record) => record.namespace[0] === 'first')).toBe(true);
    expect(secondLogger.records.every((record) => record.namespace[0] === 'second')).toBe(true);
  });

  test('text response yields text_delta + text + done', async () => {
    const language = mockLanguage([textResponse('hello')]);
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'hi' }] }))
      events.push(e);

    expect(events.find(e => e.type === 'text_delta')).toMatchObject({ type: 'text_delta', delta: 'hello' });
    expect(events.find(e => e.type === 'text')).toMatchObject({ type: 'text', content: 'hello' });
    expect(events.at(-1)?.type).toBe('done');
  });

  test('done carries usage', async () => {
    const language = mockLanguage([textResponse('hi')]);
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [] })) events.push(e);
    const done = events.find(e => e.type === 'done') as any;
    expect(done.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  test('done preserves provider cache and reasoning usage', async () => {
    const language = mockLanguage([
      [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'cached' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 },
            outputTokens: { total: 20, reasoning: 5 },
          },
        } as any,
      ],
    ]);
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [] })) events.push(e);
    const done = events.find((e) => e.type === 'done') as any;
    expect(done.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      noCacheInputTokens: 60,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      reasoningTokens: 5,
    });
  });

  test('forwards configured reasoning effort to the language request', async () => {
    let seenReasoning: unknown;
    const language = {
      stream: async function* (request: { reasoning?: unknown }) {
        seenReasoning = request.reasoning;
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        } as LanguageStreamPart;
      },
    } as unknown as LanguageClient;

    const events = [];
    for await (const event of agentLoop({
      language,
      model: 'test',
      reasoning: { enabled: true, effort: 'high' },
      messages: [],
    })) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe('done');
    expect(seenReasoning).toEqual({ enabled: true, effort: 'high' });
  });

  test('abort before start yields error', async () => {
    const language = mockLanguage([]);
    const controller = new AgentLoopController();
    controller.abort('cancelled');
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], controller })) events.push(e);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as any).error.message).toContain('cancelled');
  });

  test('maxIterations exceeded yields error', async () => {
    const language = mockLanguage([toolResponse('x', 'noop', '{}')]);
    const tool = { name: 'noop', inputSchema: {}, execute: async () => ({ success: true, output: 'ok' }) };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'go' }], tools: [tool], maxIterations: 2 }))
      events.push(e);
    expect((events.at(-1) as any).error.message).toContain('Max iterations');
  });

  test('unknown tool yields tool_result with error', async () => {
    const language = mockLanguage([toolResponse('c1', 'missing', '{}'), textResponse('done')]);
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'go' }] })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.isError).toBe(true);
    expect(r?.result).toContain('Unknown tool');
  });

  test('tool execution result is yielded', async () => {
    const language = mockLanguage([toolResponse('c1', 'echo', '{"msg":"hi"}'), textResponse('done')]);
    const tool = { name: 'echo', inputSchema: {}, execute: async (input: any) => ({ success: true, output: input.msg }) };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'go' }], tools: [tool] })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.isError).toBeFalsy();
    expect(r?.result).toBe('hi');
  });

  test('tool execution details are yielded without changing model output', async () => {
    const language = mockLanguage([toolResponse('c1', 'echo', '{"msg":"hi"}'), textResponse('done')]);
    const tool = {
      name: 'echo',
      inputSchema: {},
      execute: async (input: any) => ({ success: true, output: input.msg, details: { preview: 'ui-only' } }),
    };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'go' }], tools: [tool] })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.result).toBe('hi');
    expect(r?.details).toEqual({ preview: 'ui-only' });
  });

  test('followUp continues loop', async () => {
    const language = mockLanguage([textResponse('first'), textResponse('second')]);
    const controller = new AgentLoopController();
    controller.followUpMode = 'all';
    controller.followUp('follow up task');
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'start' }], controller })) events.push(e);
    expect(events.some(e => e.type === 'follow_up')).toBe(true);
    expect(events.filter(e => e.type === 'text')).toHaveLength(2);
  });

  test('skipInitialLlm resumes from existing tool calls', async () => {
    const language = mockLanguage([textResponse('done')]);
    const tool = { name: 'echo', inputSchema: {}, execute: async (input: any) => ({ success: true, output: input.msg }) };
    const messages = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: 'echo', input: '{"msg":"resumed"}' }] },
    ];
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages, tools: [tool], skipInitialLlm: true })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.result).toBe('resumed');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('skipInitialLlm errors if last message has no tool calls', async () => {
    const language = mockLanguage([]);
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages, skipInitialLlm: true })) events.push(e);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as any).error.message).toContain('continue()');
  });

  test('turn_start and turn_end are emitted', async () => {
    const language = mockLanguage([textResponse('hi')]);
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [] })) events.push(e);
    expect(events.find(e => e.type === 'turn_start')).toMatchObject({ type: 'turn_start', iteration: 1 });
    expect(events.find(e => e.type === 'turn_end')).toMatchObject({ type: 'turn_end', toolCallCount: 0 });
  });

  test('thinking_delta and thinking events are emitted', async () => {
    const language = mockLanguage([[
      { type: 'reasoning-delta', id: 'r1', delta: 'hmm' } as any,
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as any },
    ]]);
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [] })) events.push(e);
    expect(events.find(e => e.type === 'thinking_delta')).toMatchObject({ delta: 'hmm' });
    expect(events.find(e => e.type === 'thinking')).toMatchObject({ content: 'hmm' });
  });

  test('LLM stream error yields error event', async () => {
    const language = { stream: async function* () { throw new Error('network fail'); } } as any;
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [] })) events.push(e);
    expect(events.find(e => e.type === 'error')).toMatchObject({ type: 'error' });
    expect((events.find(e => e.type === 'error') as any).error.message).toBe('network fail');
  });

  test('tool execute throws yields error result', async () => {
    const language = mockLanguage([toolResponse('c1', 'boom', '{}'), textResponse('done')]);
    const tool = { name: 'boom', inputSchema: {}, execute: async () => { throw new Error('exploded'); } };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], tools: [tool] })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.isError).toBe(true);
    expect(r?.result).toContain('exploded');
  });

  test('tool_progress events are emitted', async () => {
    const language = mockLanguage([toolResponse('c1', 'slow', '{}'), textResponse('done')]);
    const tool = {
      name: 'slow', inputSchema: {},
      execute: async (_: any, ctx: any) => { ctx.reportProgress('step 1'); return { success: true, output: 'ok' }; },
    };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], tools: [tool] })) events.push(e);
    expect(events.find(e => e.type === 'tool_progress')).toMatchObject({ type: 'tool_progress', text: 'step 1' });
  });

  test('agent.eventObserver is called', async () => {
    const language = mockLanguage([textResponse('hi')]);
    const received: string[] = [];
    const runtime = extensions({ eventObservers: [{ onAgentEvent: (e) => { received.push(e.type); } }] });
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], extensions: runtime })) events.push(e);
    expect(received).toContain('text');
    expect(received).toContain('done');
  });

  test('agent.systemTransform modifies system prompt', async () => {
    let captured: any;
    const language = { stream: async function* (opts: any) { captured = opts.messages; yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } }; } } as any;
    const runtime = extensions({ systemTransforms: [{ transformSystem: ({ system }) => ({ system: `${system} transformed` }) }] });
    for await (const _ of agentLoop({ language, model: 'test', system: 'base', messages: [], extensions: runtime }));
    expect(captured[0]).toMatchObject({
      role: 'system',
      content: [{ type: 'text', text: 'base transformed' }],
    });
  });

  test('agent.messagesTransform modifies messages', async () => {
    let captured: any;
    const language = { stream: async function* (opts: any) { captured = opts.messages; yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } }; } } as any;
    const runtime = extensions({ messagesTransforms: [{ transformMessages: ({ messages }) => ({ messages: [...messages, { role: 'user', content: 'injected' } as any] }) }] });
    for await (const _ of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'original' }], extensions: runtime }));
    expect(captured.at(-1)).toMatchObject({ content: 'injected' });
  });

  test('agent.toolBefore can short-circuit tool execution', async () => {
    const language = mockLanguage([toolResponse('c1', 'echo', '{}'), textResponse('done')]);
    const tool = { name: 'echo', inputSchema: {}, execute: async () => ({ success: true, output: 'real' }) };
    const runtime = extensions({ toolBefores: [{ beforeToolExecute: async () => ({ action: 'shortCircuit', result: { success: true, output: 'skipped' } }) }] });
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], tools: [tool], extensions: runtime })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.result).toBe('skipped');
    expect(r?.isError).toBe(false);
  });

  test('agent.toolAfter can modify result', async () => {
    const language = mockLanguage([toolResponse('c1', 'echo', '{"msg":"hi"}'), textResponse('done')]);
    const tool = { name: 'echo', inputSchema: {}, execute: async (input: any) => ({ success: true, output: input.msg }) };
    const runtime = extensions({ toolAfters: [{ afterToolExecute: async ({ result }) => ({ result: { ...result, output: `${result.output}!` } }) }] });
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], tools: [tool], extensions: runtime })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.result).toBe('hi!');
  });

  test('steer interrupts tool execution loop', async () => {
    const language = mockLanguage([toolResponse('c1', 'echo', '{}'), textResponse('done')]);
    const tool = { name: 'echo', inputSchema: {}, execute: async () => ({ success: true, output: 'ok' }) };
    const controller = new AgentLoopController();
    controller.steer('stop now');
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], tools: [tool], controller })) events.push(e);
    expect(events.find(e => e.type === 'steered')).toBeTruthy();
  });
});
