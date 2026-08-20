import { describe, expect, test } from 'bun:test';
import type { LanguageClient } from '@synax-ai/core';
import { noopLogger, type AgentEvent } from '@cortx/sdk';
import { SubAgentSessionStore } from '../src/capabilities/sub-agent/session-store.js';
import { RuntimeHostFactory } from '../src/host/runtime-host-factory.js';
import { CortxHostScope } from '../src/host-scope.js';
import { RuntimeRunCoordinator } from '../src/runs/runtime-run-coordinator.js';
import type { ManagedRuntimeSession, SessionProjection } from '../src/session.js';
import { RuntimeCommandLedger } from '../src/sessions/runtime-command-ledger.js';
import { RuntimeSessionRegistry } from '../src/sessions/session-registry.js';
import { RuntimeInputSource } from '../src/sessions/runtime-input-source.js';
import { SessionCommandQueue } from '../src/runs/session-command-queue.js';

function projection(id: string, lastActivityAt = 1): SessionProjection {
  return {
    id,
    createdAt: 1,
    lastActivityAt,
    workingDirectory: '/workspace',
    model: 'test-model',
    toolMode: 'none',
    toolProfile: '@cortx-ai/workspace-tools/none',
    pluginGeneration: 'plugins:test',
    approvalMode: 'deny',
    capabilities: {},
    runtimeIncarnation: 'runtime:test',
    projectionAsOfSequence: lastActivityAt,
    eventRetention: { oldestAvailableSequence: null, lastAvailableSequence: lastActivityAt },
    runPhase: 'idle',
    sessionHealth: 'healthy',
    resumable: false,
    acceptsPrompt: true,
    pendingInteraction: null,
    queuedInputs: [],
    isRunning: false,
    eventCount: 0,
  };
}

function testLanguage(): LanguageClient {
  return {
    stream: async function* () {
      yield { type: 'finish', finishReason: 'stop' };
    },
  } as unknown as LanguageClient;
}

function createHostFactory(): RuntimeHostFactory {
  return new RuntimeHostFactory({
    language: testLanguage(),
    tools: [],
    logger: noopLogger,
    closeScope: async (scope, owner) => scope.close(new Error(owner)),
  });
}

async function managedSession(factory: RuntimeHostFactory, id = 'run:test'): Promise<ManagedRuntimeSession> {
  const scope = new CortxHostScope(`session:${id}`, 'session');
  const agentSessions = new SubAgentSessionStore();
  const inputSource = new RuntimeInputSource();
  let session!: ManagedRuntimeSession;
  const host = await factory.create({
    id,
    workingDirectory: process.cwd(),
    model: 'test-model',
    toolMode: 'none',
    toolProfile: '@cortx-ai/workspace-tools/none',
    approvalMode: 'deny',
    requestedCapabilities: { skills: false, subAgents: false, approval: false },
    requestTools: [],
    contributions: [],
    scope,
    mountProjectContributions: false,
    getRunScope: () => session.runScope,
    agentSessions,
    inputSource,
    onAgentEvent: () => undefined,
  });
  session = {
    id,
    cortx: host.cortx,
    createdAt: 1,
    lastActivityAt: 1,
    workingDirectory: process.cwd(),
    model: 'test-model',
    toolMode: 'none',
    toolProfile: '@cortx-ai/workspace-tools/none',
    pluginGeneration: host.pluginGeneration,
    approvalMode: 'deny',
    requestedCapabilities: { skills: false, subAgents: false, approval: false },
    capabilities: host.capabilities,
    promptHistory: [],
    requestTools: [],
    contributions: [],
    scope,
    events: [],
    eventEnvelopes: [],
    subscribers: new Set(),
    envelopeSubscribers: new Set(),
    streamSubscribers: new Set(),
    idleTimer: undefined,
    isRunning: false,
    runPhase: 'idle',
    sessionHealth: 'healthy',
    resumable: false,
    inputSource,
    commandLedger: new RuntimeCommandLedger(),
    runId: 0,
    nextEventSequence: 0,
    streamOffset: 0,
    eventRetention: { oldestAvailableSequence: null, lastAvailableSequence: 0 },
    agentSessions,
    contextMetadata: host.contextMetadata,
  } satisfies ManagedRuntimeSession;
  return session;
}

describe('RuntimeSessionRegistry', () => {
  test('provides an atomic baseline cursor and replays add/update/remove without a subscription window', () => {
    const registry = new RuntimeSessionRegistry<SessionProjection>({ project: (session) => session });
    const one = projection('one');
    registry.add(one);
    const baseline = registry.baseline();

    registry.add(projection('two'));
    one.lastActivityAt = 2;
    one.projectionAsOfSequence = 2;
    registry.changed(one);
    registry.remove('two');

    expect(baseline.sessions.map((session) => session.id)).toEqual(['one']);
    expect(baseline.cursor).not.toMatch(/^\d+$/);
    expect(registry.changesAfter(baseline.cursor).map((change) => change.type)).toEqual([
      'added',
      'updated',
      'removed',
    ]);
  });

  test('summary feed excludes detail-only queued input and pending interaction fields', () => {
    const registry = new RuntimeSessionRegistry<SessionProjection>({ project: (session) => session });
    registry.add({
      ...projection('detail'),
      queuedInputs: [{
        inputId: 'input:secret',
        message: 'do not leak',
        acceptedAt: 1,
        admissionSequence: 1,
        state: 'queued',
      }],
      pendingInteraction: {
        requestId: 'question:secret',
        kind: 'question',
        prompt: 'do not leak',
        runId: 1,
        runtimeIncarnation: 'runtime:test',
        createdAt: 1,
      },
    });

    const [summary] = registry.baseline().sessions;
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('queuedInputs');
    expect(summary).not.toHaveProperty('pendingInteraction');
    expect(summary).not.toHaveProperty('promptHistory');
  });

  test('bounds retained changes and fails loud with reset cursors after expiration', () => {
    const registry = new RuntimeSessionRegistry<SessionProjection>({
      project: (session) => session,
      maxChanges: 2,
    });
    const initial = registry.baseline().cursor;
    registry.add(projection('one'));
    const oldest = registry.baseline().cursor;
    registry.add(projection('two'));
    registry.add(projection('three'));

    expect(() => registry.changesAfter(initial)).toThrow(/expired/i);
    try {
      registry.subscribe(initial, () => {});
      throw new Error('expected expired cursor');
    } catch (error) {
      expect(error).toMatchObject({
        details: {
          resetRequired: true,
          currentCursor: registry.baseline().cursor,
          oldestCursor: oldest,
        },
      });
    }
  });
});

describe('RuntimeInputSource', () => {
  test('claims identical messages by input id and only acknowledges the exact durable delivery', () => {
    const source = new RuntimeInputSource();
    const first = source.admit('input:one', 'continue', 4, 10);
    const retry = source.admit('input:one', 'continue', 4, 20);
    source.admit('input:two', 'continue', 5, 30);

    expect(retry).toEqual(first);
    expect(() => source.admit('input:one', 'different', 4, 20)).toThrow(/different payload/i);
    expect(source.consumeFollowUps('one-at-a-time')).toEqual([
      {
        inputId: 'input:one',
        message: { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      },
    ]);
    expect(source.get('input:one')?.state).toBe('queued');
    expect(source.consumeFollowUps('one-at-a-time')).toEqual([
      {
        inputId: 'input:two',
        message: { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      },
    ]);
    expect(source.acknowledge('input:two')).toBe(true);
    expect(source.get('input:one')?.state).toBe('queued');
    expect(source.get('input:two')?.state).toBe('delivered');
    expect(source.acknowledge('input:one')).toBe(true);
  });

  test('cancels only inputs that have not crossed the Core delivery boundary', () => {
    const source = new RuntimeInputSource();
    source.admit('cancel-me', 'later', 1);
    expect(source.cancel('cancel-me')).toMatchObject({ inputId: 'cancel-me', state: 'queued' });
    expect(source.visible()).toEqual([]);

    source.admit('claimed', 'already claimed', 2);
    source.consumeFollowUps('one-at-a-time');
    expect(() => source.cancel('claimed')).toThrow('already being delivered');
  });
});

describe('SessionCommandQueue', () => {
  test('serializes commands for one session while allowing different sessions to progress', async () => {
    const queue = new SessionCommandQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = queue.run('one', async () => {
      order.push('one:start');
      await gate;
      order.push('one:end');
    });
    const second = queue.run('one', () => {
      order.push('one:second');
    });
    await queue.run('two', () => {
      order.push('two');
    });

    expect(order).toEqual(['one:start', 'two']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['one:start', 'two', 'one:end', 'one:second']);
    expect(queue.size).toBe(0);
  });

  test('seals a session before draining so no new command enters behind deletion', async () => {
    const queue = new SessionCommandQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = queue.run('one', () => gate);
    const drained = queue.seal('one');

    await expect(queue.run('one', () => undefined)).rejects.toThrow(/closed/i);
    release();
    await Promise.all([active, drained]);
    await expect(queue.runInternal('one', () => 'cleanup')).resolves.toBe('cleanup');
  });
});

describe('RuntimeCommandLedger', () => {
  test('replays matching receipts, rejects payload conflicts, and bounds retained history', () => {
    const ledger = new RuntimeCommandLedger([], 2);
    ledger.record({ commandId: 'one', kind: 'prompt', payloadHash: 'hash:one', acceptedAt: 1, result: { runId: 1 } });
    ledger.record({ commandId: 'two', kind: 'answer', payloadHash: 'hash:two', acceptedAt: 2, result: true });

    const replay = ledger.get('one', 'prompt', 'hash:one');
    expect(replay).toEqual(expect.objectContaining({ result: { runId: 1 } }));
    (replay?.result as { runId: number }).runId = 9;
    expect(ledger.get('one', 'prompt', 'hash:one')?.result).toEqual({ runId: 1 });
    expect(() => ledger.get('one', 'prompt', 'different')).toThrow(/different command or payload/i);

    ledger.record({ commandId: 'three', kind: 'abort', payloadHash: 'hash:three', acceptedAt: 3 });
    expect(ledger.get('one', 'prompt', 'hash:one')).toBeUndefined();
    expect(ledger.values().map((receipt) => receipt.commandId)).toEqual(['two', 'three']);
  });
});

describe('RuntimeHostFactory', () => {
  test('builds a stable, self-contained capability assembly without a Runtime facade', async () => {
    const factory = createHostFactory();
    const firstScope = new CortxHostScope('host:first', 'session');
    const secondScope = new CortxHostScope('host:second', 'session');
    const inputSource = new RuntimeInputSource();
    const common = {
      workingDirectory: process.cwd(),
      model: 'test-model',
      toolMode: 'none' as const,
      toolProfile: '@cortx-ai/workspace-tools/none',
      approvalMode: 'deny' as const,
      requestedCapabilities: { skills: false, subAgents: false, approval: false },
      requestTools: [],
      contributions: [],
      mountProjectContributions: false,
      getRunScope: () => undefined,
      agentSessions: new SubAgentSessionStore(),
      inputSource,
      onAgentEvent: () => undefined,
    };

    const first = await factory.create({ ...common, id: 'host:first', scope: firstScope });
    const second = await factory.create({ ...common, id: 'host:second', scope: secondScope });

    expect(first.pluginGeneration).toMatch(/^assembly:/);
    expect(second.pluginGeneration).toBe(first.pluginGeneration);
    expect(first.capabilities).toEqual(common.requestedCapabilities);
    expect(first.contextMetadata).toMatchObject({ toolCount: 0, skillCount: 0 });

    await Promise.all([firstScope.close(), secondScope.close()]);
  });
});

describe('RuntimeRunCoordinator', () => {
  test('owns admission, single-run gating, consumption, and scope settlement independently', async () => {
    const factory = createHostFactory();
    const session = await managedSession(factory);
    const registry = new RuntimeSessionRegistry<ManagedRuntimeSession>({
      project: (value) => projection(value.id, value.lastActivityAt),
    });
    registry.add(session);
    const queue = new SessionCommandQueue();
    const observed: AgentEvent[] = [];
    const closed: string[] = [];
    let persisted = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new RuntimeRunCoordinator({
      maxSessions: 1,
      commandQueue: queue,
      hostFactory: factory,
      sessionRegistry: registry,
      effects: {
        isSessionDeleted: () => false,
        assertSessionMutable: () => undefined,
        broadcast: async (_session, event) => { observed.push(event); },
        persist: async () => { persisted++; },
        publish: (value) => registry.changed(value),
        resetIdleTimer: () => undefined,
        closeScope: async (scope, owner) => {
          closed.push(owner);
          await scope.close(new Error(owner));
        },
      },
    });

    await coordinator.start(session, async function* () {
      await gate;
      yield { type: 'done', reason: 'completed' };
    });

    expect(session).toMatchObject({ isRunning: true, runPhase: 'running', runId: 1 });
    await expect(coordinator.start(session, async function* () {})).rejects.toThrow(/already running/i);
    const activeRun = session.runPromise;
    expect(activeRun).toBeInstanceOf(Promise);

    release();
    await activeRun;

    expect(session).toMatchObject({ isRunning: false, runPhase: 'idle', runScope: undefined });
    expect(observed.map((event) => event.type)).toEqual(['done']);
    expect(closed).toContain(`settled run:${session.id}:1`);
    expect(persisted).toBe(2);
    await session.scope.close();
  });

  test('serializes abort against the active run and invokes receipt hooks at command boundaries', async () => {
    const factory = createHostFactory();
    const session = await managedSession(factory, 'run:abort');
    const registry = new RuntimeSessionRegistry<ManagedRuntimeSession>({
      project: (value) => projection(value.id, value.lastActivityAt),
    });
    registry.add(session);
    const queue = new SessionCommandQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let beforeAbort = 0;
    let afterAbort = 0;
    const coordinator = new RuntimeRunCoordinator({
      maxSessions: 1,
      commandQueue: queue,
      hostFactory: factory,
      sessionRegistry: registry,
      effects: {
        isSessionDeleted: () => false,
        assertSessionMutable: () => undefined,
        broadcast: async () => undefined,
        persist: async () => undefined,
        publish: (value) => registry.changed(value),
        resetIdleTimer: () => undefined,
        closeScope: async (scope, owner) => scope.close(new Error(owner)),
      },
    });
    await coordinator.start(session, async function* () {
      await gate;
      yield { type: 'done', reason: 'completed' };
    });
    session.inputSource.admit('queued', 'later', 1);

    const aborting = coordinator.abort(session.id, {
      abortReason: 'test abort',
      pendingQuestionReason: 'test abort',
      beforeAbort: () => {
        beforeAbort++;
        return true;
      },
      afterAbort: () => { afterAbort++; },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.runPhase).toBe('aborting');
    expect(session.inputSource.visible()).toEqual([]);
    release();
    await aborting;

    expect(session).toMatchObject({ isRunning: false, runPhase: 'idle', runPromise: undefined });
    expect({ beforeAbort, afterAbort }).toEqual({ beforeAbort: 1, afterAbort: 1 });
    await session.scope.close();
  });
});
