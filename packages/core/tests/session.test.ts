import { describe, test, expect } from 'bun:test';
import { CortxSession } from '../src/index';
import { AgentLoopController } from '../src/index';
import type { AgentEvent } from '../src/index';

function mockCortx(events: AgentEvent[], continueEvents: AgentEvent[] = []) {
  const controller = new AgentLoopController();
  return {
    controller,
    run: async function* () { yield* events; },
    continue: async function* () { yield* continueEvents; },
  } as any;
}

describe('CortxSession', () => {
  test('prompt broadcasts events to subscribers', async () => {
    const received: AgentEvent[] = [];
    const session = new CortxSession(mockCortx([
      { type: 'text', content: 'hi' },
      { type: 'done' },
    ]));
    session.subscribe(e => received.push(e));
    await session.prompt('hello');
    expect(received.map(e => e.type)).toEqual(['text', 'done']);
  });

  test('state.isRunning is true during prompt, false after', async () => {
    const states: boolean[] = [];
    const session = new CortxSession(mockCortx([{ type: 'done' }]));
    session.subscribe(() => states.push(session.state.isRunning));
    await session.prompt('hi');
    expect(states).toEqual([true]);
    expect(session.state.isRunning).toBe(false);
  });

  test('state.error is set on error event', async () => {
    const session = new CortxSession(mockCortx([
      { type: 'error', error: new Error('boom') },
    ]));
    await session.prompt('hi');
    expect(session.state.error).toBe('boom');
  });

  test('pendingToolCalls tracks tool_use and tool_result', async () => {
    const snapshots: number[] = [];
    const session = new CortxSession(mockCortx([
      { type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: '{}' } },
      { type: 'tool_result', toolCallId: 'c1', result: 'ok' },
      { type: 'done' },
    ]));
    session.subscribe(e => snapshots.push(session.state.pendingToolCalls.size));
    await session.prompt('hi');
    expect(snapshots).toEqual([1, 0, 0]);
  });

  test('unsubscribe stops receiving events', async () => {
    const received: AgentEvent[] = [];
    const session = new CortxSession(mockCortx([{ type: 'text', content: 'hi' }, { type: 'done' }]));
    const unsub = session.subscribe(e => received.push(e));
    unsub();
    await session.prompt('hi');
    expect(received).toHaveLength(0);
  });

  test('resume calls cortx.continue and broadcasts events', async () => {
    const received: AgentEvent[] = [];
    const session = new CortxSession(mockCortx([], [
      { type: 'tool_result', toolCallId: 'c1', result: 'resumed' },
      { type: 'done' },
    ]));
    session.subscribe(e => received.push(e));
    await session.resume();
    expect(received.map(e => e.type)).toEqual(['tool_result', 'done']);
  });
});
