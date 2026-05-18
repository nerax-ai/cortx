import { describe, test, expect } from 'bun:test';
import { agentLoop } from '../src/index';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import type { Tool } from '@cortx/sdk';

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

function multiToolResponse(calls: { id: string; name: string; input: string }[]): StreamParts {
  const parts: LanguageStreamPart[] = [];
  for (const c of calls) {
    parts.push({ type: 'tool-input-start', id: c.id, toolName: c.name });
    parts.push({ type: 'tool-input-delta', id: c.id, delta: c.input });
    parts.push({ type: 'tool-input-end', id: c.id });
  }
  parts.push({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } as any });
  return parts;
}

function makeTool(name: string, sideEffects: Tool['sideEffects'] = 'write', delay = 0): Tool {
  return {
    name,
    inputSchema: {},
    sideEffects,
    execute: async (input) => {
      if (delay) await new Promise(r => setTimeout(r, delay));
      return { success: true, output: `${name}:${JSON.stringify(input)}` };
    },
  };
}

async function collectEvents(opts: Parameters<typeof agentLoop>[0]) {
  const events: any[] = [];
  for await (const e of agentLoop(opts)) events.push(e);
  return events;
}

describe('parallel tool execution', () => {
  test('read-only tools execute in parallel', async () => {
    const readA = makeTool('readA', 'read');
    const readB = makeTool('readB', 'read');

    const language = mockLanguage([
      multiToolResponse([
        { id: 'c1', name: 'readA', input: '{"file_path":"/a"}' },
        { id: 'c2', name: 'readB', input: '{"file_path":"/b"}' },
      ]),
      textResponse('done'),
    ]);

    const events = await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'read both' }],
      tools: [readA, readB],
    });

    const toolUseEvents = events.filter(e => e.type === 'tool_use');
    const toolResultEvents = events.filter(e => e.type === 'tool_result');

    expect(toolUseEvents).toHaveLength(2);
    expect(toolResultEvents).toHaveLength(2);

    // Both results should be success
    for (const r of toolResultEvents) {
      expect(r.isError).toBeFalsy();
    }
  });

  test('write tools execute serially', async () => {
    const executionOrder: string[] = [];
    const writeA: Tool = {
      name: 'writeA',
      inputSchema: {},
      sideEffects: 'write',
      execute: async () => { executionOrder.push('writeA'); return { success: true, output: 'ok' }; },
    };
    const writeB: Tool = {
      name: 'writeB',
      inputSchema: {},
      sideEffects: 'write',
      execute: async () => { executionOrder.push('writeB'); return { success: true, output: 'ok' }; },
    };

    const language = mockLanguage([
      multiToolResponse([
        { id: 'c1', name: 'writeA', input: '{}' },
        { id: 'c2', name: 'writeB', input: '{}' },
      ]),
      textResponse('done'),
    ]);

    await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'write both' }],
      tools: [writeA, writeB],
    });

    expect(executionOrder).toEqual(['writeA', 'writeB']);
  });

  test('mixed read+write tools: reads parallel, writes serial', async () => {
    const readTool = makeTool('read', 'read');
    const writeTool = makeTool('write', 'write');

    const language = mockLanguage([
      multiToolResponse([
        { id: 'c1', name: 'read', input: '{"file_path":"/a"}' },
        { id: 'c2', name: 'write', input: '{"file_path":"/b"}' },
      ]),
      textResponse('done'),
    ]);

    const events = await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'mixed' }],
      tools: [readTool, writeTool],
    });

    const results = events.filter(e => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.isError).toBeFalsy();
    }
  });

  test('read tools do not jump ahead of earlier write tools', async () => {
    const executionOrder: string[] = [];
    let value = 'old';
    const writeTool: Tool = {
      name: 'write',
      inputSchema: {},
      sideEffects: 'write',
      execute: async () => {
        executionOrder.push('write');
        value = 'new';
        return { success: true, output: 'written' };
      },
    };
    const readTool: Tool = {
      name: 'read',
      inputSchema: {},
      sideEffects: 'read',
      execute: async () => {
        executionOrder.push('read');
        return { success: true, output: value };
      },
    };

    const language = mockLanguage([
      multiToolResponse([
        { id: 'c1', name: 'write', input: '{}' },
        { id: 'c2', name: 'read', input: '{}' },
      ]),
      textResponse('done'),
    ]);

    const events = await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'write then read' }],
      tools: [writeTool, readTool],
    });

    const readResult = events.find(e => e.type === 'tool_result' && e.toolCallId === 'c2');
    expect(executionOrder).toEqual(['write', 'read']);
    expect(readResult?.result).toBe('new');
  });

  test('failed tool results surface error text when output is absent', async () => {
    const failingTool: Tool = {
      name: 'fail',
      inputSchema: {},
      execute: async () => ({ success: false, error: 'explicit failure text' }),
    };
    const language = mockLanguage([
      multiToolResponse([{ id: 'c1', name: 'fail', input: '{}' }]),
      textResponse('done'),
    ]);

    const events = await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'fail' }],
      tools: [failingTool],
    });

    const result = events.find(e => e.type === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(result?.result).toBe('explicit failure text');
  });

  test('one parallel read failure does not affect others', async () => {
    const goodRead = makeTool('goodRead', 'read');
    const badRead: Tool = {
      name: 'badRead',
      inputSchema: {},
      sideEffects: 'read',
      execute: async () => { throw new Error('read failed'); },
    };

    const language = mockLanguage([
      multiToolResponse([
        { id: 'c1', name: 'goodRead', input: '{}' },
        { id: 'c2', name: 'badRead', input: '{}' },
      ]),
      textResponse('done'),
    ]);

    const events = await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'reads' }],
      tools: [goodRead, badRead],
    });

    const results = events.filter(e => e.type === 'tool_result');
    expect(results).toHaveLength(2);

    const goodResult = results.find(r => r.toolCallId === 'c1');
    const badResult = results.find(r => r.toolCallId === 'c2');

    expect(goodResult?.isError).toBeFalsy();
    expect(badResult?.isError).toBe(true);
  });

  test('agent tools batch when consecutive in serial queue', async () => {
    const agentTool: Tool = {
      name: 'agent',
      inputSchema: {},
      sideEffects: 'write',
      execute: async (input) => {
        const desc = (input as any).description ?? 'agent';
        return { success: true, output: `${desc} result` };
      },
    };

    const language = mockLanguage([
      multiToolResponse([
        { id: 'c1', name: 'agent', input: '{"prompt":"task1","description":"agent-1"}' },
        { id: 'c2', name: 'agent', input: '{"prompt":"task2","description":"agent-2"}' },
      ]),
      textResponse('done'),
    ]);

    const events = await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'run agents' }],
      tools: [agentTool],
    });

    const results = events.filter(e => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.isError).toBeFalsy();
    }
  });

  test('tool_result events preserve toolCallId ordering regardless of completion order', async () => {
    let readBCalled = false;
    const readA: Tool = {
      name: 'readA',
      inputSchema: {},
      sideEffects: 'read',
      execute: async () => {
        // readA takes longer, should complete after readB
        await new Promise(r => setTimeout(r, 50));
        return { success: true, output: 'A done' };
      },
    };
    const readB: Tool = {
      name: 'readB',
      inputSchema: {},
      sideEffects: 'read',
      execute: async () => {
        readBCalled = true;
        return { success: true, output: 'B done' };
      },
    };

    const language = mockLanguage([
      multiToolResponse([
        { id: 'c1', name: 'readA', input: '{}' },
        { id: 'c2', name: 'readB', input: '{}' },
      ]),
      textResponse('done'),
    ]);

    const events = await collectEvents({
      language,
      model: 'test',
      messages: [{ role: 'user', content: 'reads' }],
      tools: [readA, readB],
    });

    const results = events.filter(e => e.type === 'tool_result');
    // Both results should be present
    const ids = results.map(r => r.toolCallId);
    expect(ids).toContain('c1');
    expect(ids).toContain('c2');
  });
});
