import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION, type AgentRunCheckpoint } from '@cortx/sdk';
import {
  FileDurableRunStore,
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
  isRuntimeDurableRunStore,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeSessionSnapshot,
  type RuntimeSubAgentSessionSnapshot,
} from '../src/index';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cortx-runtime-durable-store-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function checkpoint(sessionId: string): AgentRunCheckpoint {
  return {
    schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    runId: 1,
    iteration: 1,
    kind: 'turn_start',
    state: {
      phase: 'turn',
      lastEvent: { type: 'turn_start', iteration: 1 },
      terminal: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    },
  };
}

function sessionSnapshot(id: string): RuntimeSessionSnapshot {
  return {
    schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
    id,
    createdAt: 1,
    lastActivityAt: 2,
    workingDirectory: tmpDir,
    model: 'test',
    toolMode: 'none',
    approvalMode: 'deny',
    capabilities: { skills: false, subAgents: false, approval: false },
    runId: 1,
    nextEventSequence: 3,
    runtimeIncarnation: 'fixture',
    runPhase: 'idle',
    sessionHealth: 'healthy',
    resumable: false,
    queuedInputs: [],
    eventRetention: { oldestAvailableSequence: 1, lastAvailableSequence: 3 },
    metadata: { source: 'test' },
  };
}

function childSnapshot(parentSessionId: string): RuntimeSubAgentSessionSnapshot {
  return {
    schemaVersion: RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
    runId: `${parentSessionId}:agent-call`,
    parentSessionId,
    parentRunId: 1,
    toolCallId: 'agent-call',
    description: 'child',
    isBackground: true,
    status: 'running',
    output: 'partial',
    iterations: 1,
    toolCallCount: 2,
    startedAt: 10,
  };
}

function encodedId(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function eventSnapshot(sessionId: string, sequence: number): RuntimeEventEnvelopeSnapshot {
  return {
    schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
    sequence,
    timestamp: sequence,
    sessionId,
    runId: 1,
    event: sequence === 2 ? { type: 'error', error: new Error('durable failure'), code: 'stream_error' } : { type: 'turn_start', iteration: 1 },
  };
}

describe('FileDurableRunStore', () => {
  test('persists checkpoints across store instances', async () => {
    const first = new FileDurableRunStore(tmpDir);
    await first.saveCheckpoint(checkpoint('session-a'));

    const second = new FileDurableRunStore(tmpDir);

    expect(await second.loadCheckpoint('session-a')).toMatchObject({
      sessionId: 'session-a',
      state: { terminal: false },
    });
    expect((await second.listCheckpoints()).map((item) => item.sessionId)).toEqual(['session-a']);
    first.close();
  });

  test('allows only one writer to own a durable root until it closes', async () => {
    const first = new FileDurableRunStore(tmpDir);
    const second = new FileDurableRunStore(tmpDir);

    await first.saveRuntimeSession(sessionSnapshot('first'));
    await expect(second.saveRuntimeSession(sessionSnapshot('second'))).rejects.toThrow(/already owned/i);

    first.close();
    await second.saveRuntimeSession(sessionSnapshot('second'));
    expect(await second.loadRuntimeSession('second')).toMatchObject({ id: 'second' });
    second.close();
  });

  test('persists runtime sessions and sub-agent snapshots', async () => {
    const store = new FileDurableRunStore(tmpDir);
    await store.saveRuntimeSession(sessionSnapshot('session-a'));
    await store.saveSubAgentSession(childSnapshot('session-a'));
    await store.saveEventEnvelope(eventSnapshot('session-a', 2));
    await store.saveEventEnvelope(eventSnapshot('session-a', 1));

    expect(await store.loadRuntimeSession('session-a')).toMatchObject({
      id: 'session-a',
      toolMode: 'none',
      metadata: { source: 'test' },
    });
    expect(await store.listRuntimeSessions()).toHaveLength(1);
    expect(await store.listSubAgentSessions('session-a')).toEqual([childSnapshot('session-a')]);
    expect((await store.listEventEnvelopes('session-a')).map((event) => event.sequence)).toEqual([1, 2]);
    const errorEvent = (await store.listEventEnvelopes('session-a'))[1].event;
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.type === 'error' ? errorEvent.error.message : '').toBe('durable failure');

    await store.deleteRuntimeSession('session-a');
    expect(await store.loadRuntimeSession('session-a')).toBeUndefined();
    expect(await store.listSubAgentSessions('session-a')).toEqual([]);
    expect(await store.listEventEnvelopes('session-a')).toEqual([]);
  });

  test('migrates legacy runtime durable snapshots to the current schema', async () => {
    const store = new FileDurableRunStore(tmpDir);
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
    mkdirSync(join(tmpDir, 'sub-agents', encodedId('legacy-session')), { recursive: true });
    mkdirSync(join(tmpDir, 'events', encodedId('legacy-session')), { recursive: true });
    writeFileSync(
      join(tmpDir, 'sessions', `${encodedId('legacy-session')}.json`),
      JSON.stringify({
        schemaVersion: 0,
        id: 'legacy-session',
        createdAt: 10,
        lastActivityAt: 20,
        workingDirectory: tmpDir,
        model: 'legacy-model',
        metadata: { migrated: true },
      }),
      'utf8',
    );
    writeFileSync(
      join(tmpDir, 'sub-agents', encodedId('legacy-session'), `${encodedId('agent-call')}.json`),
      JSON.stringify({
        schemaVersion: 0,
        parentSessionId: 'legacy-session',
        toolCallId: 'agent-call',
        description: 'legacy child',
        isBackground: true,
        status: 'completed',
        output: 'legacy output',
        iterations: 2,
        toolCallCount: 3,
        startedAt: 30,
        completedAt: 40,
      }),
      'utf8',
    );
    writeFileSync(
      join(tmpDir, 'events', encodedId('legacy-session'), '0000000000000007.json'),
      JSON.stringify({
        schemaVersion: 0,
        sequence: 7,
        timestamp: 70,
        sessionId: 'legacy-session',
        runId: 1,
        event: { type: 'text', content: 'legacy replay' },
      }),
      'utf8',
    );

    expect(await store.loadRuntimeSession('legacy-session')).toMatchObject({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: 'legacy-session',
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      runId: 0,
      nextEventSequence: 0,
      metadata: { migrated: true },
    });
    expect(await store.listSubAgentSessions('legacy-session')).toMatchObject([
      {
        schemaVersion: RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
        runId: 'legacy-session:agent-call',
        status: 'completed',
        output: 'legacy output',
      },
    ]);
    expect(await store.listEventEnvelopes('legacy-session')).toMatchObject([
      {
        schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
        sequence: 7,
        event: { type: 'text', content: 'legacy replay' },
      },
    ]);
  });

  test('migrates schema v1 sessions to v2 projection defaults', async () => {
    const sessionsDir = join(tmpDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${encodedId('v1-session')}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id: 'v1-session',
        createdAt: 1,
        lastActivityAt: 2,
        workingDirectory: tmpDir,
        model: 'test',
        toolMode: 'none',
        approvalMode: 'deny',
        capabilities: { skills: false, subAgents: false, approval: false },
        runId: 3,
        nextEventSequence: 4,
      }),
      'utf8',
    );

    expect(await new FileDurableRunStore(tmpDir).loadRuntimeSession('v1-session')).toMatchObject({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      runtimeIncarnation: 'legacy',
      runPhase: 'idle',
      sessionHealth: 'healthy',
      resumable: false,
      queuedInputs: [],
      eventRetention: { oldestAvailableSequence: 1, lastAvailableSequence: 4 },
    });
  });

  test('prunes durable event envelopes to the configured per-session limit', async () => {
    const store = new FileDurableRunStore({ root: tmpDir, maxEventEnvelopesPerSession: 2 });

    await store.saveEventEnvelope(eventSnapshot('session-a', 1));
    await store.saveEventEnvelope(eventSnapshot('session-a', 2));
    await store.saveEventEnvelope(eventSnapshot('session-a', 3));
    await store.saveEventEnvelope(eventSnapshot('session-a', 4));

    expect((await store.listEventEnvelopes('session-a')).map((event) => event.sequence)).toEqual([3, 4]);
    expect(await store.getEventEnvelopeRetention('session-a')).toEqual({
      oldestAvailableSequence: 3,
      lastAvailableSequence: 4,
    });
  });

  test('serializes sub-agent snapshot writes so completed status wins', async () => {
    const store = new FileDurableRunStore(tmpDir);
    const running = childSnapshot('session-a');
    const completed: RuntimeSubAgentSessionSnapshot = {
      ...running,
      status: 'completed',
      output: 'final output',
      completedAt: 20,
    };

    await Promise.all([
      store.saveSubAgentSession(running),
      store.saveSubAgentSession(completed),
    ]);
    await store.saveSubAgentSession(running);

    expect(await store.listSubAgentSessions('session-a')).toMatchObject([
      {
        status: 'completed',
        output: 'final output',
        completedAt: 20,
      },
    ]);
  });

  test('fails loud on invalid persisted records without modifying the source files', async () => {
    const store = new FileDurableRunStore(tmpDir);
    await store.saveRuntimeSession(sessionSnapshot('valid'));
    const sessionsDir = join(tmpDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const invalidPath = join(sessionsDir, 'invalid.json');
    writeFileSync(invalidPath, '{', 'utf8');
    writeFileSync(join(sessionsDir, 'wrong-schema.json'), JSON.stringify({ schemaVersion: 999 }), 'utf8');

    await expect(store.listRuntimeSessions()).rejects.toThrow(/invalid durable json/i);
    expect(readFileSync(invalidPath, 'utf8')).toBe('{');
  });

  test('runtime store guard requires the full host-level contract', () => {
    const store = new FileDurableRunStore(tmpDir);
    const storeWithoutEventReplay = {
      saveCheckpoint: async () => {},
      loadCheckpoint: async () => undefined,
      saveRuntimeSession: async () => {},
      loadRuntimeSession: async () => undefined,
      listRuntimeSessions: async () => [],
      deleteRuntimeSession: async () => {},
      saveSubAgentSession: async () => {},
      listSubAgentSessions: async () => [],
      deleteSubAgentSessions: async () => {},
    };
    const partialStore = {
      saveCheckpoint: async () => {},
      loadCheckpoint: async () => undefined,
      saveRuntimeSession: async () => {},
      listRuntimeSessions: async () => [],
    };

    expect(isRuntimeDurableRunStore(store)).toBe(true);
    expect(isRuntimeDurableRunStore(storeWithoutEventReplay)).toBe(true);
    expect(isRuntimeDurableRunStore(partialStore)).toBe(false);
  });
});
