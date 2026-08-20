import { describe, expect, test } from 'bun:test';
import type { AgentRunCheckpoint } from '@cortx/sdk';
import { RuntimeEventJournal } from '../src/event-journal/event-journal.js';
import {
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeDurableRunStore,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeSessionSnapshot,
  type RuntimeSubAgentSessionSnapshot,
} from '../src/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function snapshot(sequence: number): RuntimeSessionSnapshot {
  return {
    schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
    id: 'ordered',
    createdAt: 1,
    lastActivityAt: sequence,
    workingDirectory: '/tmp',
    model: 'test',
    toolMode: 'none',
    approvalMode: 'deny',
    capabilities: { skills: false, subAgents: false, approval: false },
    runId: 1,
    nextEventSequence: sequence,
    runtimeIncarnation: 'fixture',
    runPhase: 'running',
    sessionHealth: 'healthy',
    resumable: false,
    queuedInputs: [],
    eventRetention: { oldestAvailableSequence: 1, lastAvailableSequence: sequence },
  };
}

function envelope(sequence: number): RuntimeEventEnvelopeSnapshot {
  return {
    schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
    sequence,
    timestamp: sequence,
    sessionId: 'ordered',
    runId: 1,
    event: { type: 'turn_start', iteration: sequence },
  };
}

test('serializes event append before its observing snapshot for each session', async () => {
  const gate = deferred();
  const operations: string[] = [];
  const saved: RuntimeSessionSnapshot[] = [];
  const store = stubStore({
    async saveEventEnvelope(event) {
      operations.push(`event:${event.sequence}:start`);
      if (event.sequence === 1) await gate.promise;
      operations.push(`event:${event.sequence}:done`);
    },
    saveRuntimeSession(value) {
      operations.push(`snapshot:${value.nextEventSequence}`);
      saved.push(value);
    },
  });
  const journal = new RuntimeEventJournal(store);

  const first = journal.commit({ snapshot: snapshot(1), envelope: envelope(1) });
  const second = journal.commit({ snapshot: snapshot(2), envelope: envelope(2) });
  await Promise.resolve();
  expect(operations).toEqual(['event:1:start']);

  gate.resolve();
  await Promise.all([first, second]);

  expect(operations).toEqual([
    'event:1:start',
    'event:1:done',
    'snapshot:1',
    'event:2:start',
    'event:2:done',
    'snapshot:2',
  ]);
  expect(saved.at(-1)?.nextEventSequence).toBe(2);
});

describe('journal failure boundary', () => {
  test('marks a permanent failure and refuses later commits while still allowing delete', async () => {
    const failures: string[] = [];
    let deleted = false;
    const store = stubStore({
      saveEventEnvelope() {
        throw new Error('disk unavailable');
      },
      deleteRuntimeSession() {
        deleted = true;
      },
    });
    const journal = new RuntimeEventJournal(store, {
      onFailure: (_sessionId, error) => failures.push(error.message),
    });

    await expect(journal.commit({ snapshot: snapshot(1), envelope: envelope(1) })).rejects.toThrow('disk unavailable');
    await expect(journal.saveSnapshot(snapshot(2))).rejects.toThrow('disk unavailable');
    await journal.delete('ordered');

    expect(failures).toEqual(['disk unavailable']);
    expect(deleted).toBe(true);
  });
});

function stubStore(overrides: Partial<RuntimeDurableRunStore>): RuntimeDurableRunStore {
  return {
    saveCheckpoint() {},
    loadCheckpoint(): AgentRunCheckpoint | undefined { return undefined; },
    saveRuntimeSession() {},
    loadRuntimeSession() { return undefined; },
    listRuntimeSessions() { return []; },
    deleteRuntimeSession() {},
    saveSubAgentSession(_snapshot: RuntimeSubAgentSessionSnapshot) {},
    listSubAgentSessions() { return []; },
    deleteSubAgentSessions() {},
    ...overrides,
  };
}
