import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION, type AgentRunCheckpoint } from '@cortx/sdk';
import {
  FileDurableRunStore,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
  isRuntimeDurableRunStore,
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
  });

  test('persists runtime sessions and sub-agent snapshots', async () => {
    const store = new FileDurableRunStore(tmpDir);
    await store.saveRuntimeSession(sessionSnapshot('session-a'));
    await store.saveSubAgentSession(childSnapshot('session-a'));

    expect(await store.loadRuntimeSession('session-a')).toMatchObject({
      id: 'session-a',
      toolMode: 'none',
      metadata: { source: 'test' },
    });
    expect(await store.listRuntimeSessions()).toHaveLength(1);
    expect(await store.listSubAgentSessions('session-a')).toEqual([childSnapshot('session-a')]);

    await store.deleteRuntimeSession('session-a');
    expect(await store.loadRuntimeSession('session-a')).toBeUndefined();
    expect(await store.listSubAgentSessions('session-a')).toEqual([]);
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

  test('skips invalid persisted records without blocking valid ones', async () => {
    const store = new FileDurableRunStore(tmpDir);
    await store.saveRuntimeSession(sessionSnapshot('valid'));
    const sessionsDir = join(tmpDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'invalid.json'), '{', 'utf8');
    writeFileSync(join(sessionsDir, 'wrong-schema.json'), JSON.stringify({ schemaVersion: 999 }), 'utf8');

    expect((await store.listRuntimeSessions()).map((item) => item.id)).toEqual(['valid']);
  });

  test('runtime store guard requires the full host-level contract', () => {
    const store = new FileDurableRunStore(tmpDir);
    const partialStore = {
      saveCheckpoint: async () => {},
      loadCheckpoint: async () => undefined,
      saveRuntimeSession: async () => {},
      listRuntimeSessions: async () => [],
    };

    expect(isRuntimeDurableRunStore(store)).toBe(true);
    expect(isRuntimeDurableRunStore(partialStore)).toBe(false);
  });
});
