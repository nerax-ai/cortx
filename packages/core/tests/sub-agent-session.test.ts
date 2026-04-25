import { describe, test, expect } from 'bun:test';
import { SubAgentSessionStore } from '../src/sub-agent-session';

describe('SubAgentSessionStore', () => {
  test('create adds a running session', () => {
    const store = new SubAgentSessionStore();
    const session = store.create('tc1', 'test agent', false);
    expect(session.toolCallId).toBe('tc1');
    expect(session.description).toBe('test agent');
    expect(session.status).toBe('running');
    expect(session.events).toHaveLength(0);
    expect(store.get('tc1')).toBe(session);
  });

  test('pushEvent stores events and updates counters', () => {
    const store = new SubAgentSessionStore();
    store.create('tc1', 'test', false);

    store.pushEvent('tc1', { type: 'turn_start', iteration: 1 });
    store.pushEvent('tc1', { type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: '{}' } });
    store.pushEvent('tc1', { type: 'tool_result', toolCallId: 't1', result: 'ok' });
    store.pushEvent('tc1', { type: 'text', content: 'hello' });
    store.pushEvent('tc1', { type: 'turn_start', iteration: 2 });
    store.pushEvent('tc1', { type: 'done' });

    const session = store.get('tc1')!;
    expect(session.events).toHaveLength(6);
    expect(session.iterations).toBe(2);
    expect(session.toolCallCount).toBe(1);
    expect(session.output).toBe('hello');
  });

  test('complete marks session as completed', () => {
    const store = new SubAgentSessionStore();
    store.create('tc1', 'test', false);
    store.complete('tc1', false);
    expect(store.get('tc1')!.status).toBe('completed');
    expect(store.get('tc1')!.completedAt).toBeDefined();
  });

  test('complete marks session as error', () => {
    const store = new SubAgentSessionStore();
    store.create('tc1', 'test', false);
    store.complete('tc1', true);
    expect(store.get('tc1')!.status).toBe('error');
  });

  test('pushEvent on unknown toolCallId is a no-op', () => {
    const store = new SubAgentSessionStore();
    store.pushEvent('unknown', { type: 'text', content: 'x' });
    expect(store.get('unknown')).toBeUndefined();
  });

  test('getAll returns all sessions', () => {
    const store = new SubAgentSessionStore();
    store.create('tc1', 'agent 1', false);
    store.create('tc2', 'agent 2', false);
    store.create('tc3', 'agent 3', true);
    expect(store.getAll().size).toBe(3);
    expect(store.get('tc2')!.description).toBe('agent 2');
    expect(store.get('tc3')!.isBackground).toBe(true);
  });

  test('subscribe fires on create and complete', () => {
    const store = new SubAgentSessionStore();
    const notifications: string[] = [];
    store.subscribe(() => notifications.push('changed'));

    store.create('tc1', 'test', false);
    store.pushEvent('tc1', { type: 'text', content: 'hello' });
    store.complete('tc1', false);

    expect(notifications).toEqual(['changed', 'changed']);
  });

  test('unsubscribe stops notifications', () => {
    const store = new SubAgentSessionStore();
    const notifications: string[] = [];
    const unsub = store.subscribe(() => notifications.push('changed'));

    store.create('tc1', 'test', false);
    unsub();
    store.complete('tc1', false);

    expect(notifications).toHaveLength(1);
  });
});
