import { describe, test, expect } from 'bun:test';
import { agentLoop, AgentLoopController } from '../src/index';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';

type StreamParts = LanguageStreamPart[];

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

describe('agentLoop (streaming)', () => {
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

  test('plugin event hook is called', async () => {
    const language = mockLanguage([textResponse('hi')]);
    const received: string[] = [];
    const plugin = { event: (e: any) => { received.push(e.type); } };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], plugins: [plugin] })) events.push(e);
    expect(received).toContain('text');
    expect(received).toContain('done');
  });

  test('plugin system.transform modifies system prompt', async () => {
    let captured: any;
    const language = { stream: async function* (opts: any) { captured = opts.messages; yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } }; } } as any;
    const plugin = { 'system.transform': (s: string) => s + ' transformed' };
    for await (const _ of agentLoop({ language, model: 'test', system: 'base', messages: [], plugins: [plugin] }));
    expect(captured[0]).toMatchObject({ role: 'system', content: 'base transformed' });
  });

  test('plugin messages.transform modifies messages', async () => {
    let captured: any;
    const language = { stream: async function* (opts: any) { captured = opts.messages; yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } }; } } as any;
    const plugin = { 'messages.transform': (msgs: any[]) => [...msgs, { role: 'user', content: 'injected' }] };
    for await (const _ of agentLoop({ language, model: 'test', messages: [{ role: 'user', content: 'original' }], plugins: [plugin] }));
    expect(captured.at(-1)).toMatchObject({ content: 'injected' });
  });

  test('plugin tool.execute.before can skip tool', async () => {
    const language = mockLanguage([toolResponse('c1', 'echo', '{}'), textResponse('done')]);
    const tool = { name: 'echo', inputSchema: {}, execute: async () => ({ success: true, output: 'real' }) };
    const plugin = { 'tool.execute.before': async () => ({ skip: true, result: 'skipped' }) };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], tools: [tool], plugins: [plugin] })) events.push(e);
    const r = events.find(e => e.type === 'tool_result') as any;
    expect(r?.result).toBe('skipped');
    expect(r?.isError).toBe(false);
  });

  test('plugin tool.execute.after can modify result', async () => {
    const language = mockLanguage([toolResponse('c1', 'echo', '{"msg":"hi"}'), textResponse('done')]);
    const tool = { name: 'echo', inputSchema: {}, execute: async (input: any) => ({ success: true, output: input.msg }) };
    const plugin = { 'tool.execute.after': async (_: any, r: any) => ({ ...r, output: r.output + '!' }) };
    const events = [];
    for await (const e of agentLoop({ language, model: 'test', messages: [], tools: [tool], plugins: [plugin] })) events.push(e);
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
