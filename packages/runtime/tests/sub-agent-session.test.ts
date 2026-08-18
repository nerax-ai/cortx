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
    expect(store.get('tc1')).toEqual(session);
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

  test('evicts by completedAt rather than creation order', async () => {
    const store = new SubAgentSessionStore(2);
    store.create('slow', 'created first, completed later', false);
    store.create('old-1', 'old completed session', false);
    store.complete('old-1', false);
    await Bun.sleep(2);
    store.create('old-2', 'older completed session', false);
    store.complete('old-2', false);
    await Bun.sleep(2);
    store.complete('slow', false);
    await Bun.sleep(2);

    store.create('trigger', 'new terminal session', false);
    store.complete('trigger', false);

    expect(store.get('old-1')).toBeUndefined();
    expect(store.get('old-2')).toBeUndefined();
    expect(store.get('slow')).toBeDefined();
    expect(store.get('trigger')).toBeDefined();
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
    store.create('call-1', 'child task', true, 'parent-session', 7);
    store.recordEvent('call-1', { type: 'turn_start', iteration: 2 });
    store.recordEvent('call-1', {
      type: 'tool_use',
      toolCall: { type: 'tool-call', toolCallId: 'nested', toolName: 'read', input: '{}' },
    });
    store.recordEvent('call-1', {
      type: 'tool_use',
      toolCall: { type: 'tool-call', toolCallId: 'nested-2', toolName: 'read', input: '{}' },
    });
    store.recordEvent('call-1', {
      type: 'tool_use',
      toolCall: { type: 'tool-call', toolCallId: 'nested-3', toolName: 'read', input: '{}' },
    });
    store.recordEvent('call-1', { type: 'text', content: 'partial' });
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

  test('hydrates an unrecoverable running child as interrupted', () => {
    const source = new SubAgentSessionStore();
    source.create('running', 'orphaned child', true, 'parent', 2);
    const snapshot = source.snapshot('running');
    const restored = new SubAgentSessionStore();
    restored.hydrate(snapshot ? [snapshot] : []);
    expect(restored.get('running')).toMatchObject({ status: 'interrupted', parentRunId: 2 });
  });

  test('query, abort, and wait share one terminal child result', async () => {
    const store = new SubAgentSessionStore();
    store.create('running', 'queryable child', true, 'parent');
    store.registerAbort('running', () => store.finish('running', 'cancelled'));
    const waiter = store.wait('running');
    const aborted = await store.abort('running', 'explicit child abort');
    expect(aborted.status).toBe('cancelled');
    expect(await waiter).toEqual(aborted);
    expect(store.get('running')).toEqual(aborted);
  });

  test('abortRunning invokes registered aborters for running sessions and waits for terminal state', async () => {
    const store = new SubAgentSessionStore();
    store.create('running', 'running child', true, 'parent');
    store.create('completed', 'completed child', true, 'parent');
    store.complete('completed', false);
    const aborted: string[] = [];
    store.registerAbort('running', (reason) => {
      aborted.push(`running:${reason}`);
      store.finish('running', 'cancelled');
    });
    store.registerAbort('completed', (reason) => aborted.push(`completed:${reason}`));

    await store.abortRunning('stop');

    expect(aborted).toEqual(['running:stop']);
  });

  test('an abort requested before aborter registration is delivered after registration', async () => {
    const store = new SubAgentSessionStore();
    store.create('racing', 'racing child', true, 'parent');
    const abort = store.abort('racing', 'stop before register', 100);
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.registerAbort('racing', () => store.finish('racing', 'cancelled'));
    await expect(abort).resolves.toMatchObject({ status: 'cancelled' });
  });

  test('abortRunning includes running sessions whose aborter has not registered yet', async () => {
    const store = new SubAgentSessionStore();
    store.create('late', 'late child', true, 'parent');
    const aborting = store.abortRunning('stop all', 100);
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.registerAbort('late', () => store.finish('late', 'cancelled'));
    await aborting;
    expect(store.get('late')).toMatchObject({ status: 'cancelled' });
  });

  test('query results are detached from mutable store state', () => {
    const store = new SubAgentSessionStore();
    store.create('detached', 'detached child', true, 'parent');
    const queried = store.get('detached')!;
    queried.status = 'completed';
    queried.events.push({ type: 'text', content: 'external mutation' });
    expect(store.get('detached')).toMatchObject({ status: 'running', events: [] });

    const listed = store.getAll().get('detached')!;
    listed.output = 'external mutation';
    expect(store.get('detached')?.output).toBe('');
  });

  test('terminal child sessions clear abort handlers while completed history stays bounded', async () => {
    const store = new SubAgentSessionStore(2);
    const aborted: string[] = [];

    store.create('running', 'running child', true, 'parent');
    store.registerAbort('running', (reason) => {
      aborted.push(`running:${reason}`);
      store.finish('running', 'cancelled');
    });

    for (let index = 1; index <= 4; index++) {
      const id = `done-${index}`;
      store.create(id, `completed child ${index}`, true, 'parent');
      store.registerAbort(id, (reason) => aborted.push(`${id}:${reason}`));
      store.complete(id, index === 4);
    }

    await store.abortRunning('stop');

    expect(aborted).toEqual(['running:stop']);
    expect(store.get('running')).toBeUndefined();
    expect(store.get('done-1')).toBeUndefined();
    expect(store.get('done-2')).toBeUndefined();
    expect(store.get('done-3')).toMatchObject({ status: 'completed' });
    expect(store.get('done-4')).toMatchObject({ status: 'error' });
  });
});
