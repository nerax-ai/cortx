import { describe, test, expect } from 'bun:test';
import {
  RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
  SubAgentSessionStore,
} from '../src/index';

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

  test('complete on unknown toolCallId is a no-op', () => {
    const store = new SubAgentSessionStore();
    store.complete('unknown', false);
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

  test('remove deletes a session', () => {
    const store = new SubAgentSessionStore();
    store.create('tc1', 'test', false);
    store.remove('tc1');
    expect(store.get('tc1')).toBeUndefined();
  });

  test('listener error isolation does not break other listeners', () => {
    const store = new SubAgentSessionStore();
    const notifications: string[] = [];
    store.subscribe(() => { throw new Error('boom'); });
    store.subscribe(() => notifications.push('ok'));

    store.create('tc1', 'test', false);
    expect(notifications).toEqual(['ok']);
  });

  test('evicts oldest completed sessions when exceeding maxCompleted', () => {
    const store = new SubAgentSessionStore(3);
    for (let i = 1; i <= 4; i++) {
      store.create(`tc${i}`, `agent ${i}`, false);
      store.complete(`tc${i}`, false);
    }
    // tc1 should be evicted (oldest completed)
    expect(store.get('tc1')).toBeUndefined();
    expect(store.get('tc2')).toBeDefined();
    expect(store.get('tc3')).toBeDefined();
    expect(store.get('tc4')).toBeDefined();
  });

  test('does not evict running sessions', () => {
    const store = new SubAgentSessionStore(2);
    store.create('tc1', 'running', false);
    // tc1 is still running, completing tc2 and tc3 should not evict tc1
    store.create('tc2', 'done', false);
    store.complete('tc2', false);
    store.create('tc3', 'done too', false);
    store.complete('tc3', false);
    // tc1 is still there because it's running
    expect(store.get('tc1')).toBeDefined();
    expect(store.get('tc1')!.status).toBe('running');
  });

  test('snapshots and hydrates persisted child sessions', () => {
    const store = new SubAgentSessionStore();
    const session = store.create('call-1', 'child task', true, 'parent-session', 7);
    session.output = 'partial';
    session.iterations = 2;
    session.toolCallCount = 3;
    store.complete('call-1', false);

    const snapshot = store.snapshot('call-1');
    expect(snapshot).toMatchObject({
      schemaVersion: RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
      parentSessionId: 'parent-session',
      parentRunId: 7,
      toolCallId: 'call-1',
      status: 'completed',
      output: 'partial',
    });

    const restored = new SubAgentSessionStore();
    restored.hydrate(snapshot ? [snapshot] : []);
    expect(restored.get('call-1')).toMatchObject({
      parentRunId: 7,
      output: 'partial',
      iterations: 2,
      toolCallCount: 3,
      status: 'completed',
    });
  });

  test('abortRunning invokes registered aborters for running sessions', () => {
    const store = new SubAgentSessionStore();
    store.create('running', 'running child', true, 'parent');
    store.create('completed', 'completed child', true, 'parent');
    store.complete('completed', false);
    const aborted: string[] = [];
    store.registerAbort('running', (reason) => aborted.push(`running:${reason}`));
    store.registerAbort('completed', (reason) => aborted.push(`completed:${reason}`));

    store.abortRunning('stop');

    expect(aborted).toEqual(['running:stop']);
  });
});
