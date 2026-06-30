import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '@cortx/sdk';
import { CortxSession } from '../../src/index.js';
import { AgentLoopController } from '../../src/types.js';
import { collectEvents, createTestLogger, lengthResponse, mockLanguage, runtimeExtensions, textResponse, toolResponse } from './helpers.js';

function mockCortx(events: AgentEvent[], continueEvents: AgentEvent[] = []) {
  const controller = new AgentLoopController();
  return {
    controller,
    run: async function* () { yield* events; },
    continue: async function* () { yield* continueEvents; },
  } as any;
}

describe('conformance: session and events', () => {
  test('event order is replayable for a tool turn and terminal done includes usage', async () => {
    const observed: string[] = [];
    const extensions = runtimeExtensions({
      eventObservers: [{ onAgentEvent: (event) => { observed.push(event.type); } }],
    });

    const events = await collectEvents({
      language: mockLanguage([
        toolResponse('c1', 'echo', '{"msg":"hello"}'),
        textResponse('done'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [{ name: 'echo', inputSchema: {}, execute: async (input) => ({ success: true, output: input.msg }) }],
      extensions,
    });

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
    expect(observed).toEqual(events.map((event) => event.type));
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
  });

  test('observer failures are logged and do not prevent terminal events', async () => {
    const logger = createTestLogger();
    const extensions = runtimeExtensions({
      eventObservers: [{ onAgentEvent: () => { throw new Error('observer failed'); } }],
    });

    const events = await collectEvents({
      language: mockLanguage([textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      extensions,
      logger,
    });

    expect(events.at(-1)?.type).toBe('done');
    expect(logger.records.some((record) => record.namespace.join('/') === 'agent.eventObserver' && record.message.includes('failed'))).toBe(true);
  });

  test('errorRecover decline produces typed terminal error without retrying forever', async () => {
    let attempts = 0;
    const extensions = runtimeExtensions({
      errorRecovers: [{ recoverError: () => ({ action: 'decline' }) }],
    });

    const events = await collectEvents({
      language: {
        stream: async function* () {
          attempts++;
          throw Object.assign(new Error('rate limit'), { statusCode: 429 });
        },
      } as any,
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      extensions,
    });

    expect(attempts).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'rate_limited' });
  });

  test('contextOverflow decline emits context_overflow followed by typed terminal error', async () => {
    const extensions = runtimeExtensions({
      contextOverflows: [{ handleContextOverflow: () => ({ action: 'decline', reason: 'unsafe to compact' }) }],
    });

    const events = await collectEvents({
      language: {
        stream: async function* () {
          throw Object.assign(new Error('context length exceeded'), { statusCode: 413 });
        },
      } as any,
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      extensions,
    });

    expect(events.map((event) => event.type)).toEqual(['turn_start', 'context_overflow', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'context_overflow' });
  });

  test('contextOverflow recovery is capped and then returns a typed terminal error', async () => {
    let streamAttempts = 0;
    let recoveryAttempts = 0;
    const extensions = runtimeExtensions({
      contextOverflows: [{
        handleContextOverflow: ({ messages }) => {
          recoveryAttempts++;
          return { action: 'recover', messages };
        },
      }],
    });

    const events = await collectEvents({
      language: {
        stream: async function* () {
          streamAttempts++;
          throw Object.assign(new Error('context length exceeded'), { statusCode: 413 });
        },
      } as any,
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      extensions,
    });

    expect(streamAttempts).toBe(4);
    expect(recoveryAttempts).toBe(3);
    expect(events.filter((event) => event.type === 'context_overflow')).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'context_overflow' });
  });

  test('auto-continue emits follow_up and preserves bounded turn structure before final done', async () => {
    const events = await collectEvents({
      language: mockLanguage([
        lengthResponse('partial'),
        textResponse('complete'),
      ]),
      model: 'test',
      messages: [{ role: 'user', content: 'continue' }],
      autoContinueLimit: 1,
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
  });

  test('CortxSession tracks pending tool calls, clears state at terminal events, and isolates subscriber failures', async () => {
    const session = new CortxSession(mockCortx([
      { type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: '{}' } },
      { type: 'tool_result', toolCallId: 'c1', result: 'ok' },
      { type: 'error', error: new Error('boom') },
    ]));
    const snapshots: number[] = [];
    session.subscribe(() => { throw new Error('listener failed'); });
    session.subscribe(() => snapshots.push(session.state.pendingToolCalls.size));

    await session.prompt('hello');

    expect(snapshots).toEqual([1, 0, 0]);
    expect(session.state.isRunning).toBe(false);
    expect(session.state.pendingToolCalls.size).toBe(0);
    expect(session.state.error).toBe('boom');
  });
});
