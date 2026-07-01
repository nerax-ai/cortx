import { describe, expect, test } from 'bun:test';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION, type AgentEvent, type AgentRunCheckpoint } from '@cortx/sdk';
import { CortxSession } from '../../src/index.js';
import { AgentLoopController } from '../../src/types.js';
import {
  collectEvents,
  createTestLogger,
  lengthResponse,
  mockLanguage,
  runtimeExtensions,
  textResponse,
  toolResponse,
} from './helpers.js';

function mockCortx(events: AgentEvent[], continueEvents: AgentEvent[] = []) {
  const controller = new AgentLoopController();
  return {
    controller,
    run: async function* () {
      yield* events;
    },
    continue: async function* () {
      yield* continueEvents;
    },
  } as any;
}

describe('conformance: session and events', () => {
  test('event order is replayable for a tool turn and terminal done includes usage', async () => {
    const observed: string[] = [];
    const extensions = runtimeExtensions({
      eventObservers: [
        {
          onAgentEvent: (event) => {
            observed.push(event.type);
          },
        },
      ],
    });

    const events = await collectEvents({
      language: mockLanguage([toolResponse('c1', 'echo', '{"msg":"hello"}'), textResponse('done')]),
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
      eventObservers: [
        {
          onAgentEvent: () => {
            throw new Error('observer failed');
          },
        },
      ],
    });

    const events = await collectEvents({
      language: mockLanguage([textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      extensions,
      logger,
    });

    expect(events.at(-1)?.type).toBe('done');
    expect(
      logger.records.some(
        (record) => record.namespace.join('/') === 'agent.eventObserver' && record.message.includes('failed'),
      ),
    ).toBe(true);
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
      contextOverflows: [
        {
          handleContextOverflow: ({ messages }) => {
            recoveryAttempts++;
            return { action: 'recover', messages };
          },
        },
      ],
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
      language: mockLanguage([lengthResponse('partial'), textResponse('complete')]),
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

  test('recorder receives loop-level events with phase and iteration context', async () => {
    const recorded: Array<{ type: string; phase?: string; iteration: number }> = [];
    const checkpoints: Array<{
      schemaVersion: number;
      kind: string;
      iteration: number;
      phase: string;
      lastEvent: string;
      terminal: boolean;
      messages: number;
      pendingToolResults: number;
    }> = [];
    const durableCheckpoints: Array<{
      schemaVersion: number;
      kind: string;
      iteration: number;
      phase: string;
      lastEvent: string;
      terminal: boolean;
      messages: number;
      pendingToolResults: number;
    }> = [];
    const checkpointSummary = (checkpoint: {
      schemaVersion: number;
      kind: string;
      iteration: number;
      state: {
        phase: string;
        lastEvent: AgentEvent;
        terminal: boolean;
        messages?: unknown[];
        pendingToolResults?: unknown[];
      };
    }) => ({
      schemaVersion: checkpoint.schemaVersion,
      kind: checkpoint.kind,
      iteration: checkpoint.iteration,
      phase: checkpoint.state.phase,
      lastEvent: checkpoint.state.lastEvent.type,
      terminal: checkpoint.state.terminal,
      messages: checkpoint.state.messages?.length ?? 0,
      pendingToolResults: checkpoint.state.pendingToolResults?.length ?? 0,
    });
    const events = await collectEvents({
      language: mockLanguage([textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      recorder: {
        recordEvent(event, context) {
          recorded.push({ type: event.type, phase: context.phase, iteration: context.iteration });
        },
        recordCheckpoint(checkpoint) {
          checkpoints.push(checkpointSummary(checkpoint));
        },
      },
      durableStore: {
        saveCheckpoint(checkpoint) {
          durableCheckpoints.push(checkpointSummary(checkpoint));
        },
        loadCheckpoint() {
          return undefined;
        },
      },
    });

    expect(events.map((event) => event.type)).toEqual(['turn_start', 'text_delta', 'text', 'turn_end', 'done']);
    expect(recorded).toContainEqual({ type: 'turn_start', phase: 'turn', iteration: 1 });
    expect(recorded).toContainEqual({ type: 'text_delta', phase: 'model', iteration: 1 });
    expect(recorded).toContainEqual({ type: 'text', phase: 'model', iteration: 1 });
    expect(recorded).toContainEqual({ type: 'turn_end', phase: 'turn', iteration: 1 });
    expect(recorded).toContainEqual({ type: 'done', phase: 'completion', iteration: 1 });
    expect(checkpoints).toEqual([
      {
        schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
        kind: 'turn_start',
        iteration: 1,
        phase: 'turn',
        lastEvent: 'turn_start',
        terminal: false,
        messages: 1,
        pendingToolResults: 0,
      },
      {
        schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
        kind: 'turn_end',
        iteration: 1,
        phase: 'turn',
        lastEvent: 'turn_end',
        terminal: false,
        messages: 2,
        pendingToolResults: 0,
      },
      {
        schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
        kind: 'terminal',
        iteration: 1,
        phase: 'completion',
        lastEvent: 'done',
        terminal: true,
        messages: 2,
        pendingToolResults: 0,
      },
    ]);
    expect(durableCheckpoints).toEqual(checkpoints);
  });

  test('resume checkpoint restores messages and pending tool results before model dispatch', async () => {
    const capturedMessages: unknown[] = [];
    const checkpoint: AgentRunCheckpoint = {
      schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'sess_resume',
      iteration: 1,
      kind: 'tool_result',
      state: {
        phase: 'tool.execute',
        terminal: false,
        lastEvent: { type: 'tool_result', toolCallId: 'c1', result: 'cached', isError: false },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'run' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: '{"msg":"cached"}' }],
          },
        ],
        pendingToolResults: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'echo',
            output: { type: 'text', value: 'cached' },
            isError: false,
          },
        ],
      },
    };

    const events = await collectEvents({
      language: mockLanguage([textResponse('done')], (opts) => capturedMessages.push(opts.messages)),
      model: 'test',
      messages: [],
      sessionId: 'sess_resume',
      resumeCheckpoint: checkpoint,
    });

    expect(events.map((event) => event.type)).toEqual(['turn_start', 'text_delta', 'text', 'turn_end', 'done']);
    expect(JSON.stringify(capturedMessages[0])).toContain('cached');
  });

  test('tool-result checkpoint includes pending tool results before they are appended to messages', async () => {
    const toolResultCheckpoints: Array<{ lastEvent: string; messages: number; pendingToolResults: number }> = [];
    await collectEvents({
      language: mockLanguage([toolResponse('c1', 'echo', '{"msg":"hello"}'), textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'run' }],
      tools: [{ name: 'echo', inputSchema: {}, execute: async (input) => ({ success: true, output: input.msg }) }],
      durableStore: {
        saveCheckpoint(checkpoint) {
          if (
            checkpoint.kind === 'tool_result' ||
            checkpoint.state.lastEvent.type === 'turn_end' ||
            checkpoint.state.lastEvent.type === 'done'
          ) {
            toolResultCheckpoints.push({
              lastEvent: checkpoint.state.lastEvent.type,
              messages: checkpoint.state.messages?.length ?? 0,
              pendingToolResults: checkpoint.state.pendingToolResults?.length ?? 0,
            });
          }
        },
        loadCheckpoint() {
          return undefined;
        },
      },
    });

    expect(toolResultCheckpoints).toEqual([
      { lastEvent: 'tool_result', messages: 2, pendingToolResults: 1 },
      { lastEvent: 'turn_end', messages: 3, pendingToolResults: 0 },
      { lastEvent: 'turn_end', messages: 4, pendingToolResults: 0 },
      { lastEvent: 'done', messages: 4, pendingToolResults: 0 },
    ]);
  });

  test('tracer wraps model and completion phases without changing event order', async () => {
    const spans: Array<{ name: string; ended: boolean; error?: unknown }> = [];
    const events = await collectEvents({
      language: mockLanguage([textResponse('done')]),
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      tracer: {
        startSpan(name) {
          const span = { name, ended: false, error: undefined as unknown };
          spans.push(span);
          return {
            name,
            end(error?: unknown) {
              span.ended = true;
              span.error = error;
            },
          };
        },
      },
    });

    expect(events.map((event) => event.type)).toEqual(['turn_start', 'text_delta', 'text', 'turn_end', 'done']);
    expect(spans.map((span) => span.name)).toEqual(['agent.model', 'agent.completion']);
    expect(spans.every((span) => span.ended)).toBe(true);
    expect(spans.every((span) => span.error === undefined)).toBe(true);
  });

  test('token budget emits a typed terminal error after provider usage is known', async () => {
    const events = await collectEvents({
      language: mockLanguage([textResponse('expensive', { inputTokens: { total: 7 }, outputTokens: { total: 6 } })]),
      model: 'test',
      messages: [{ role: 'user', content: 'budget' }],
      limits: { tokenBudget: 10 },
    });

    expect(events.map((event) => event.type)).toEqual(['turn_start', 'text_delta', 'text', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'budget_exceeded' });
    expect((events.at(-1) as Extract<AgentEvent, { type: 'error' }>).error.message).toContain('Token budget exceeded');
  });

  test('turn timeout stops a slow model stream with a typed terminal error', async () => {
    const events = await collectEvents({
      language: {
        stream: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 25));
          yield { type: 'text-start', id: 't1' } as const;
          yield { type: 'text-delta', id: 't1', delta: 'late' } as const;
        },
      } as any,
      model: 'test',
      messages: [{ role: 'user', content: 'timeout' }],
      limits: { turnTimeoutMs: 5 },
    });

    expect(events.map((event) => event.type)).toEqual(['turn_start', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'timeout' });
    expect((events.at(-1) as Extract<AgentEvent, { type: 'error' }>).error.message).toContain('timed out');
  });

  test('controller abort propagates to the model stream signal', async () => {
    const controller = new AgentLoopController();
    let signalAborted = false;
    const gen = collectEvents({
      language: {
        stream: async function* (_request: unknown, options?: { signal?: AbortSignal }) {
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                signalAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          yield {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
          } as const;
        },
      } as any,
      model: 'test',
      messages: [{ role: 'user', content: 'abort me' }],
      controller,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort('stop now');
    const events = await gen;

    expect(signalAborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'user_abort' });
  });

  test('runtime limits override legacy max iteration defaults', async () => {
    const events = await collectEvents({
      language: mockLanguage([textResponse('first'), textResponse('second')]),
      model: 'test',
      messages: [{ role: 'user', content: 'start' }],
      maxIterations: 20,
      limits: { maxIterations: 1 },
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
      'error',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'max_iterations' });
  });

  test('CortxSession tracks pending tool calls, clears state at terminal events, and isolates subscriber failures', async () => {
    const session = new CortxSession(
      mockCortx([
        { type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: '{}' } },
        { type: 'tool_result', toolCallId: 'c1', result: 'ok' },
        { type: 'error', error: new Error('boom') },
      ]),
    );
    const snapshots: number[] = [];
    session.subscribe(() => {
      throw new Error('listener failed');
    });
    session.subscribe(() => snapshots.push(session.state.pendingToolCalls.size));

    await session.prompt('hello');

    expect(snapshots).toEqual([1, 0, 0]);
    expect(session.state.isRunning).toBe(false);
    expect(session.state.pendingToolCalls.size).toBe(0);
    expect(session.state.error).toBe('boom');
  });
});
