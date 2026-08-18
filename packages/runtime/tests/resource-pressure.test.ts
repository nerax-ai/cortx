import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION, type AgentEvent } from '@cortx/sdk';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import {
  CortxRuntime,
  FileDurableRunStore,
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeSessionSnapshot,
} from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-runtime-pressure-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function longTextParts(prefix: string, count: number): LanguageStreamPart[] {
  return [
    { type: 'text-start', id: `${prefix}-text` },
    ...Array.from({ length: count }, (_, index) => ({
      type: 'text-delta' as const,
      id: `${prefix}-text`,
      delta: `${prefix}-${index};`,
    })),
    { type: 'text-end', id: `${prefix}-text` },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: count } } },
  ];
}

function mockLanguage(responses: LanguageStreamPart[][]): LanguageClient {
  let index = 0;
  return {
    stream: async function* () {
      const parts = responses[index++] ?? responses.at(-1) ?? [];
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

function abortAwareLanguage(state: { started: boolean; aborted: boolean }): LanguageClient {
  return {
    stream: async function* (_request: unknown, options?: { signal?: AbortSignal }) {
      state.started = true;
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('test timeout waiting for abort')), 5_000);
        options?.signal?.addEventListener(
          'abort',
          () => {
            state.aborted = true;
            clearTimeout(timer);
            reject(new Error('provider aborted'));
          },
          { once: true },
        );
      });
    },
  } as unknown as LanguageClient;
}

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type'], timeoutMs = 1_000): Promise<AgentEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function expectSessionNotFound(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ kind: 'session_not_found' });
    return;
  }
  throw new Error('Expected session_not_found');
}

function sessionSnapshot(id: string, durableRoot: string): RuntimeSessionSnapshot {
  return {
    schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
    id,
    createdAt: 1,
    lastActivityAt: 2,
    workingDirectory: durableRoot,
    model: 'test-model',
    toolMode: 'none',
    approvalMode: 'deny',
    capabilities: { skills: false, subAgents: false, approval: false },
    runId: 7,
    nextEventSequence: 11,
  };
}

function envelopeSnapshot(sessionId: string, sequence: number): RuntimeEventEnvelopeSnapshot {
  return {
    schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
    sequence,
    timestamp: sequence,
    sessionId,
    runId: 7,
    event: { type: 'text', content: `event-${sequence}` },
  };
}

describe('runtime resource pressure guardrails', () => {
  test('bounds in-memory event histories during long streamed output', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([longTextParts('long', 40)]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      maxEventsPerSession: 12,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'long-session' });
    const live: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => live.push(event), { replay: false });

    await runtime.prompt(session.id, 'produce a long stream');
    await waitForEvent(live, 'done');

    const events = runtime.getEventHistory(session.id);
    const envelopes = runtime.getEventEnvelopeHistory(session.id);
    expect(events.length).toBeLessThanOrEqual(12);
    expect(envelopes.length).toBeLessThanOrEqual(12);
    expect(envelopes.every((event) => event.sessionId === 'long-session')).toBe(true);
    expect(envelopes.map((event) => event.sequence)).toEqual(
      [...envelopes].map((event) => event.sequence).sort((a, b) => a - b),
    );
    expect(envelopes.at(-1)?.event.type).toBe('done');
    await runtime.close();
  });

  test('keeps multi-session histories isolated while pruning each session independently', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([longTextParts('alpha', 20), longTextParts('beta', 20)]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      maxEventsPerSession: 6,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const alpha = await runtime.createSession({ id: 'alpha-session' });
    const beta = await runtime.createSession({ id: 'beta-session' });
    const alphaLive: AgentEvent[] = [];
    const betaLive: AgentEvent[] = [];
    runtime.subscribe(alpha.id, (event) => alphaLive.push(event), { replay: false });
    runtime.subscribe(beta.id, (event) => betaLive.push(event), { replay: false });

    await runtime.prompt(alpha.id, 'alpha');
    await runtime.prompt(beta.id, 'beta');
    await waitForEvent(alphaLive, 'done');
    await waitForEvent(betaLive, 'done');

    const alphaEnvelopes = runtime.getEventEnvelopeHistory(alpha.id);
    const betaEnvelopes = runtime.getEventEnvelopeHistory(beta.id);
    expect(alphaEnvelopes).toHaveLength(6);
    expect(betaEnvelopes).toHaveLength(6);
    expect(alphaEnvelopes.every((event) => event.sessionId === alpha.id)).toBe(true);
    expect(betaEnvelopes.every((event) => event.sessionId === beta.id)).toBe(true);
    expect(alphaEnvelopes.map((event) => event.event.type)).toContain('done');
    expect(betaEnvelopes.map((event) => event.event.type)).toContain('done');
    await runtime.close();
  });

  test('restores only retained durable envelopes and reapplies the runtime memory bound', async () => {
    const durableStore = new FileDurableRunStore({ root: join(tmpDir, 'durable'), maxEventEnvelopesPerSession: 5 });
    await durableStore.saveRuntimeSession(sessionSnapshot('durable-session', tmpDir));
    await durableStore.saveCheckpoint({
      schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'durable-session',
      runId: 7,
      iteration: 1,
      kind: 'model_stream',
      state: {
        phase: 'model',
        lastEvent: { type: 'text', content: 'event-10' },
        terminal: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'restore me' }] }],
      },
    });
    for (let sequence = 1; sequence <= 10; sequence++) {
      await durableStore.saveEventEnvelope(envelopeSnapshot('durable-session', sequence));
    }

    expect((await durableStore.listEventEnvelopes('durable-session')).map((event) => event.sequence)).toEqual([
      6, 7, 8, 9, 10,
    ]);

    const runtime = new CortxRuntime({
      language: mockLanguage([longTextParts('restored', 1)]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      durableStore,
      maxEventsPerSession: 3,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });

    const restored = await runtime.restoreDurableSessions();

    expect(restored.map((session) => session.id)).toEqual(['durable-session']);
    expect(runtime.getEventEnvelopeHistory('durable-session').map((event) => event.sequence)).toEqual([9, 10, 12]);
    expect(runtime.getEventHistory('durable-session').map((event) => event.type)).toEqual(['text', 'text', 'error']);
    await runtime.close();
  });

  test('abort and dispose clear observable running state and cancel the provider signal', async () => {
    const provider = { started: false, aborted: false };
    const runtime = new CortxRuntime({
      language: abortAwareLanguage(provider),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'cleanup-session' });

    await runtime.prompt(session.id, 'wait forever');
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    await waitFor(() => provider.started);

    await runtime.abort(session.id);
    await waitFor(() => provider.aborted);
    expect(runtime.getSession(session.id).isRunning).toBe(false);

    await runtime.prompt(session.id, 'can run again');
    await runtime.deleteSession(session.id);
    expectSessionNotFound(() => runtime.getSession(session.id));
    expectSessionNotFound(() => runtime.subscribe(session.id, () => {}));
    await runtime.close();
    expect(runtime.listSessions()).toEqual([]);
  });

  test('dispose removes busy sessions and aborts their provider requests', async () => {
    const provider = { started: false, aborted: false };
    const runtime = new CortxRuntime({
      language: abortAwareLanguage(provider),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'dispose-session' });

    await runtime.prompt(session.id, 'wait forever');
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    await waitFor(() => provider.started);
    await runtime.close();

    await waitFor(() => provider.aborted);
    await waitFor(() => runtime.listSessions().length === 0);
    expect(runtime.listSessions()).toEqual([]);
    expectSessionNotFound(() => runtime.getSession(session.id));
  });
});
