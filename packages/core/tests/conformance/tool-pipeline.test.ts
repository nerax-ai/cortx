import { describe, expect, test } from 'bun:test';
import type { AgentEvent, Tool } from '@cortx/sdk';
import { agentLoop } from '../../src/index.js';
import { AgentLoopController } from '../../src/types.js';
import {
  collectEvents,
  lengthToolResponse,
  mockLanguage,
  multiToolResponse,
  runtimeExtensions,
  textResponse,
  toolResponse,
} from './helpers.js';

async function nextEventOrTimeout(
  gen: AsyncGenerator<AgentEvent>,
  timeoutMs = 100,
): Promise<IteratorResult<AgentEvent>> {
  return Promise.race([
    gen.next(),
    new Promise<IteratorResult<AgentEvent>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs),
    ),
  ]);
}

describe('conformance: tool pipeline', () => {
  test('toolBefore allow, rewrite, deny, and shortCircuit compose in model order', async () => {
    const receivedInputs: Record<string, unknown>[] = [];
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'rewriteMe',
        inputSchema: {},
        execute: async (input) => {
          executedTools.push('rewriteMe');
          receivedInputs.push(input);
          return { success: true, output: input.value };
        },
      },
      {
        name: 'denyMe',
        inputSchema: {},
        execute: async () => {
          executedTools.push('denyMe');
          return { success: true, output: 'should not run' };
        },
      },
      {
        name: 'cacheMe',
        inputSchema: {},
        execute: async () => {
          executedTools.push('cacheMe');
          return { success: true, output: 'should not run' };
        },
      },
    ];
    const extensions = runtimeExtensions({
      toolBefores: [
        {
          beforeToolExecute({ tool, input }) {
            if (tool?.name === 'rewriteMe') return { action: 'rewrite', input: { ...input, value: 'rewritten' } };
            if (tool?.name === 'denyMe') return { action: 'deny', reason: 'blocked by policy' };
            if (tool?.name === 'cacheMe')
              return { action: 'shortCircuit', result: { success: true, output: 'cached result' } };
            return { action: 'allow' };
          },
        },
      ],
    });

    const events = await collectEvents({
      language: mockLanguage([
        multiToolResponse([
          { id: 'c1', name: 'rewriteMe', input: '{"value":"original"}' },
          { id: 'c2', name: 'denyMe', input: '{}' },
          { id: 'c3', name: 'cacheMe', input: '{}' },
        ]),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'tools' }],
      tools,
      extensions,
    });

    expect(executedTools).toEqual(['rewriteMe']);
    expect(receivedInputs).toEqual([{ value: 'rewritten' }]);
    expect(events.filter((event) => event.type === 'tool_use').map((event) => event.toolCall.toolCallId)).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
    expect(
      events
        .filter((event) => event.type === 'tool_result')
        .map((event) => ({ id: event.toolCallId, result: event.result, isError: event.isError })),
    ).toEqual([
      { id: 'c1', result: 'rewritten', isError: false },
      { id: 'c2', result: 'blocked by policy', isError: true },
      { id: 'c3', result: 'cached result', isError: false },
    ]);
  });

  test('before-hook progress is emitted before the final short-circuit result', async () => {
    const extensions = runtimeExtensions({
      toolBefores: [
        {
          beforeToolExecute({ toolContext }) {
            toolContext.reportProgress?.('checking permission');
            return { action: 'shortCircuit', result: { success: false, error: 'permission denied' } };
          },
        },
      ],
    });

    const events = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'danger', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [{ name: 'danger', inputSchema: {}, execute: async () => ({ success: true, output: 'nope' }) }],
      extensions,
    });

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['tool_progress', 'tool_result']));
    const progressIndex = events.findIndex((event) => event.type === 'tool_progress');
    const resultIndex = events.findIndex((event) => event.type === 'tool_result');
    expect(progressIndex).toBeGreaterThan(-1);
    expect(progressIndex).toBeLessThan(resultIndex);
    expect(events[resultIndex]).toMatchObject({ type: 'tool_result', isError: true, result: 'permission denied' });
  });

  test('unknown tools and thrown tool errors become structured tool results', async () => {
    const events = await collectEvents({
      language: mockLanguage([
        multiToolResponse([
          { id: 'c1', name: 'missingTool', input: '{}' },
          { id: 'c2', name: 'throwTool', input: '{}' },
        ]),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [
        {
          name: 'throwTool',
          inputSchema: {},
          execute: async () => {
            throw new Error('tool exploded');
          },
        },
      ],
    });

    expect(
      events
        .filter((event) => event.type === 'tool_result')
        .map((event) => ({ id: event.toolCallId, result: event.result, isError: event.isError })),
    ).toEqual([
      { id: 'c1', result: 'Unknown tool: missingTool', isError: true },
      { id: 'c2', result: 'tool exploded', isError: true },
    ]);
  });

  test('complete tool calls are executed even when the stream finish reason is length', async () => {
    const executed: Record<string, unknown>[] = [];
    const events = await collectEvents({
      language: mockLanguage([
        lengthToolResponse([
          { id: 'c1', name: 'echo', input: '{"msg":"from length finish"}' },
        ]),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [
        {
          name: 'echo',
          inputSchema: {},
          execute: async (input) => {
            executed.push(input);
            return { success: true, output: input.msg };
          },
        },
      ],
    });

    expect(executed).toEqual([{ msg: 'from length finish' }]);
    expect(events.find((event) => event.type === 'tool_use')).toMatchObject({
      type: 'tool_use',
      toolCall: { toolCallId: 'c1', toolName: 'echo' },
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      toolCallId: 'c1',
      result: 'from length finish',
      isError: false,
    });
  });

  test('every yielded tool_result pairs with exactly one prior tool_use in model order', async () => {
    const extensions = runtimeExtensions({
      sessionPolicies: [
        {
          beforeToolCall({ tool }) {
            if (tool?.name === 'denied') return { action: 'deny', reason: 'blocked' };
            return { action: 'allow' };
          },
        },
      ],
    });

    const events = await collectEvents({
      language: mockLanguage([
        multiToolResponse([
          { id: 'c1', name: 'ok', input: '{}' },
          { id: 'c2', name: 'missing', input: '{}' },
          { id: 'c3', name: 'denied', input: '{}' },
        ]),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'pairing' }],
      tools: [
        { name: 'ok', inputSchema: {}, execute: async () => ({ success: true, output: 'ok' }) },
        { name: 'denied', inputSchema: {}, execute: async () => ({ success: true, output: 'should not run' }) },
      ],
      extensions,
    });

    const uses = events.filter((event) => event.type === 'tool_use').map((event) => event.toolCall.toolCallId);
    const results = events.filter((event) => event.type === 'tool_result').map((event) => event.toolCallId);
    expect(uses).toEqual(['c1', 'c2', 'c3']);
    expect(results).toEqual(uses);
    expect(events.filter((event) => event.type === 'tool_result').map((event) => event.result)).toEqual([
      'ok',
      'Unknown tool: missing',
      'blocked',
    ]);
  });

  test('toolAfter rewrites success and error results before events and model-visible messages', async () => {
    const capturedMessages: unknown[] = [];
    const extensions = runtimeExtensions({
      toolAfters: [
        {
          afterToolExecute({ result }) {
            return { result: { ...result, output: `normalized:${String(result.output ?? result.error ?? '')}` } };
          },
        },
      ],
    });

    const events = await collectEvents({
      language: mockLanguage(
        [
          multiToolResponse([
            { id: 'c1', name: 'okTool', input: '{}' },
            { id: 'c2', name: 'badTool', input: '{}' },
          ]),
          textResponse('done'),
        ],
        (opts) => capturedMessages.push(opts.messages),
      ),
      model: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [
        { name: 'okTool', inputSchema: {}, execute: async () => ({ success: true, output: 'ok' }) },
        { name: 'badTool', inputSchema: {}, execute: async () => ({ success: false, output: 'bad' }) },
      ],
      extensions,
    });

    expect(
      events
        .filter((event) => event.type === 'tool_result')
        .map((event) => ({ result: event.result, isError: event.isError })),
    ).toEqual([
      { result: 'normalized:ok', isError: false },
      { result: 'normalized:bad', isError: true },
    ]);
    expect(JSON.stringify(capturedMessages[1])).toContain('normalized:ok');
    expect(JSON.stringify(capturedMessages[1])).toContain('normalized:bad');
  });

  test('invalid tool input becomes structured tool error unless repaired before execution', async () => {
    let repairedInput: Record<string, unknown> | undefined;
    const repairExtensions = runtimeExtensions({
      toolBefores: [
        {
          beforeToolExecute() {
            return { action: 'rewrite', input: { repaired: true } };
          },
        },
      ],
    });

    const unrepaired = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'echo', '{"broken":'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'bad' }],
      tools: [{ name: 'echo', inputSchema: {}, execute: async () => ({ success: true, output: 'should not run' }) }],
    });

    const repaired = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'echo', '{"broken":'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'bad' }],
      tools: [
        {
          name: 'echo',
          inputSchema: {},
          execute: async (input) => {
            repairedInput = input;
            return { success: true, output: 'repaired' };
          },
        },
      ],
      extensions: repairExtensions,
    });

    expect(unrepaired.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      isError: true,
    });
    expect(repairedInput).toEqual({ repaired: true });
    expect(repaired.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      result: 'repaired',
      isError: false,
    });
  });

  test('read-only spans execute concurrently but never cross an earlier write boundary', async () => {
    const order: string[] = [];
    let value = 'old';
    const tools: Tool[] = [
      {
        name: 'write',
        inputSchema: {},
        sideEffects: 'write',
        execute: async () => {
          order.push('write');
          await new Promise((resolve) => setTimeout(resolve, 15));
          value = 'new';
          return { success: true, output: 'written' };
        },
      },
      {
        name: 'readA',
        inputSchema: {},
        sideEffects: 'read',
        execute: async () => {
          order.push('readA:start');
          await new Promise((resolve) => setTimeout(resolve, 25));
          order.push('readA:end');
          return { success: true, output: value };
        },
      },
      {
        name: 'readB',
        inputSchema: {},
        sideEffects: 'read',
        execute: async () => {
          order.push('readB:start');
          order.push('readB:end');
          return { success: true, output: value };
        },
      },
    ];

    const events = await collectEvents({
      language: mockLanguage([
        multiToolResponse([
          { id: 'c1', name: 'write', input: '{}' },
          { id: 'c2', name: 'readA', input: '{}' },
          { id: 'c3', name: 'readB', input: '{}' },
        ]),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'ordered' }],
      tools,
    });

    expect(order[0]).toBe('write');
    expect(order.indexOf('readA:start')).toBeGreaterThan(order.indexOf('write'));
    expect(order.indexOf('readB:start')).toBeGreaterThan(order.indexOf('write'));
    expect(order.indexOf('readB:end')).toBeLessThan(order.indexOf('readA:end'));
    expect(events.filter((event) => event.type === 'tool_result').map((event) => event.result)).toEqual([
      'written',
      'new',
      'new',
    ]);
  });

  test('write tools execute serially in model order', async () => {
    const order: string[] = [];
    const events = await collectEvents({
      language: mockLanguage([
        multiToolResponse([
          { id: 'c1', name: 'writeA', input: '{}' },
          { id: 'c2', name: 'writeB', input: '{}' },
        ]),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'write' }],
      tools: [
        {
          name: 'writeA',
          inputSchema: {},
          sideEffects: 'write',
          execute: async () => {
            order.push('writeA:start');
            await new Promise((resolve) => setTimeout(resolve, 15));
            order.push('writeA:end');
            return { success: true, output: 'A' };
          },
        },
        {
          name: 'writeB',
          inputSchema: {},
          sideEffects: 'write',
          execute: async () => {
            order.push('writeB:start');
            order.push('writeB:end');
            return { success: true, output: 'B' };
          },
        },
      ],
    });

    expect(order).toEqual(['writeA:start', 'writeA:end', 'writeB:start', 'writeB:end']);
    expect(events.filter((event) => event.type === 'tool_result').map((event) => event.result)).toEqual(['A', 'B']);
  });

  test('toolContext askUser emits a question event and blocks tool completion until answered', async () => {
    const controller = new AgentLoopController();
    let asked = false;
    const gen = agentLoop({
      language: mockLanguage([toolResponse('c1', 'approvalTool', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'ask' }],
      tools: [
        {
          name: 'approvalTool',
          inputSchema: {},
          execute: async (_input, ctx) => {
            asked = true;
            const answer = await ctx.askUser?.('Allow tool?');
            return { success: true, output: `answer:${answer}` };
          },
        },
      ],
      controller,
    });

    const events: AgentEvent[] = [];
    while (!events.some((event) => event.type === 'user_question')) {
      const next = await nextEventOrTimeout(gen);
      expect(next.done).toBe(false);
      events.push(next.value);
    }

    expect(asked).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'user_question', question: 'Allow tool?', toolCallId: 'c1' });
    expect(events.some((event) => event.type === 'tool_result')).toBe(false);

    controller.answerUser('c1', 'yes');
    for await (const event of gen) events.push(event);

    const questionIndex = events.findIndex((event) => event.type === 'user_question');
    const resultIndex = events.findIndex((event) => event.type === 'tool_result');
    expect(questionIndex).toBeGreaterThan(-1);
    expect(questionIndex).toBeLessThan(resultIndex);
    expect(events[questionIndex]).toMatchObject({ type: 'user_question', question: 'Allow tool?', toolCallId: 'c1' });
    expect(events[resultIndex]).toMatchObject({ type: 'tool_result', result: 'answer:yes', isError: false });
  });

  test('toolBefore askUser uses the same yielded question event contract', async () => {
    const controller = new AgentLoopController();
    let beforeAsked = false;
    const extensions = runtimeExtensions({
      toolBefores: [
        {
          async beforeToolExecute({ input, toolContext }) {
            beforeAsked = true;
            const answer = await toolContext.askUser?.('Rewrite with approval?');
            return { action: 'rewrite', input: { ...input, answer } };
          },
        },
      ],
    });
    const gen = agentLoop({
      language: mockLanguage([toolResponse('c1', 'approvalTool', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'ask before' }],
      tools: [
        {
          name: 'approvalTool',
          inputSchema: {},
          execute: async (input) => ({ success: true, output: `before:${input.answer}` }),
        },
      ],
      extensions,
      controller,
    });

    const events: AgentEvent[] = [];
    while (!events.some((event) => event.type === 'user_question')) {
      const next = await nextEventOrTimeout(gen);
      expect(next.done).toBe(false);
      events.push(next.value);
    }

    expect(beforeAsked).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'user_question',
      question: 'Rewrite with approval?',
      toolCallId: 'c1',
    });
    expect(events.some((event) => event.type === 'tool_result')).toBe(false);

    controller.answerUser('c1', 'yes');
    for await (const event of gen) events.push(event);

    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      result: 'before:yes',
      isError: false,
    });
  });

  test('custom askUser callback still produces a replayable user_question event', async () => {
    const askedQuestions: string[] = [];
    const events = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'approvalTool', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'custom ask' }],
      tools: [
        {
          name: 'approvalTool',
          inputSchema: {},
          execute: async (_input, ctx) => {
            const answer = await ctx.askUser?.('Use callback?');
            return { success: true, output: `custom:${answer}` };
          },
        },
      ],
      askUser: async (question) => {
        askedQuestions.push(question);
        return 'yes';
      },
    });

    expect(askedQuestions).toEqual(['Use callback?']);
    expect(events.find((event) => event.type === 'user_question')).toMatchObject({
      type: 'user_question',
      question: 'Use callback?',
      toolCallId: 'c1',
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      result: 'custom:yes',
      isError: false,
    });
  });

  test('oversized tool output is budgeted before toolAfter sees it', async () => {
    let afterSawOutput = '';
    const extensions = runtimeExtensions({
      toolAfters: [
        {
          afterToolExecute({ result }) {
            afterSawOutput = String(result.output);
            return { result };
          },
        },
      ],
    });

    const events = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'large', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'large' }],
      tools: [{ name: 'large', inputSchema: {}, execute: async () => ({ success: true, output: 'x'.repeat(100) }) }],
      extensions,
      toolResultBudget: 80,
    });

    expect(afterSawOutput.length).toBeLessThanOrEqual(100);
    expect(afterSawOutput).toContain('truncated');
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      result: afterSawOutput,
    });
  });

  test('tool timeout becomes a structured tool_result and preserves the loop', async () => {
    let toolSettled = false;
    let signalSeen = false;
    const events = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'slowTool', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'slow' }],
      tools: [
        {
          name: 'slowTool',
          inputSchema: {},
          execute: async (_input, ctx) => {
            signalSeen = Boolean(ctx.signal);
            await new Promise((resolve) => setTimeout(resolve, 25));
            toolSettled = true;
            return { success: true, output: 'late success' };
          },
        },
      ],
      limits: { toolTimeoutMs: 5 },
    });

    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', toolCallId: 'c1', isError: true });
    expect(String((result as Extract<AgentEvent, { type: 'tool_result' }>).result)).toContain('timed out after 5ms');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(signalSeen).toBe(true);
    expect(toolSettled).toBe(false);
  });

  test('tool timeout aborts the tool context signal for cooperative tools', async () => {
    let aborted = false;
    const events = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'cooperativeSlowTool', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'slow' }],
      tools: [
        {
          name: 'cooperativeSlowTool',
          inputSchema: {},
          execute: async (_input, ctx) => {
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
            });
            return { success: false, error: 'aborted cooperatively' };
          },
        },
      ],
      limits: { toolTimeoutMs: 5 },
    });

    expect(aborted).toBe(true);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      toolCallId: 'c1',
      isError: true,
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  test('recorder observes tool prepare, question, progress, and result phases', async () => {
    const recorded: Array<{ type: string; phase?: string; iteration: number }> = [];
    const controller = new AgentLoopController();
    const gen = agentLoop({
      language: mockLanguage([toolResponse('c1', 'interactiveTool', '{}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'record tools' }],
      tools: [
        {
          name: 'interactiveTool',
          inputSchema: {},
          execute: async (_input, ctx) => {
            ctx.reportProgress?.('working');
            const answer = await ctx.askUser?.('Approve?');
            return { success: true, output: `answer:${answer}` };
          },
        },
      ],
      controller,
      recorder: {
        recordEvent(event, context) {
          recorded.push({ type: event.type, phase: context.phase, iteration: context.iteration });
        },
      },
    });

    const events: AgentEvent[] = [];
    while (!events.some((event) => event.type === 'user_question')) {
      const next = await nextEventOrTimeout(gen);
      expect(next.done).toBe(false);
      events.push(next.value);
    }
    controller.answerUser('c1', 'yes');
    for await (const event of gen) events.push(event);

    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      result: 'answer:yes',
    });
    expect(recorded).toContainEqual({ type: 'tool_use', phase: 'tool.prepare', iteration: 1 });
    expect(recorded).toContainEqual({ type: 'user_question', phase: 'tool.execute', iteration: 1 });
    expect(recorded).toContainEqual({ type: 'tool_progress', phase: 'tool.execute', iteration: 1 });
    expect(recorded).toContainEqual({ type: 'tool_result', phase: 'tool.execute', iteration: 1 });
  });
});
