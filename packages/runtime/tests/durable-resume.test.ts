import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LanguageClient } from '@synax-ai/core';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION, type AgentEvent } from '@cortx/sdk';
import {
  CortxRuntime,
  FileDurableRunStore,
  MemoryDurableRunStore,
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
} from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-runtime-resume-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function neverFinishingLanguage(): LanguageClient {
  return {
    stream: async function* () {
      await new Promise(() => {});
    },
  } as unknown as LanguageClient;
}

function textLanguage(text: string): LanguageClient {
  return {
    stream: async function* () {
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', delta: text };
      yield { type: 'text-end', id: 't1' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
    },
  } as unknown as LanguageClient;
}

function durableProjection(lastAvailableSequence: number) {
  return {
    runtimeIncarnation: 'fixture',
    runPhase: 'idle' as const,
    sessionHealth: 'healthy' as const,
    resumable: false,
    queuedInputs: [],
    eventRetention: {
      oldestAvailableSequence: lastAvailableSequence > 0 ? 1 : null,
      lastAvailableSequence,
    },
  };
}

describe('runtime durable resume', () => {
  test('new runtime instance resumes a non-terminal checkpoint by stable session id', async () => {
    const durableStore = new MemoryDurableRunStore();
    const first = new CortxRuntime({
      language: neverFinishingLanguage(),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
      durableStore,
    });
    const firstSession = await first.createSession({ id: 'stable-session' });
    const firstEvents: AgentEvent[] = [];
    first.subscribe(firstSession.id, (event) => firstEvents.push(event));

    await first.prompt(firstSession.id, 'resume me');
    await waitForEvent(firstEvents, 'turn_start');

    const checkpoint = durableStore.loadCheckpoint('stable-session');
    expect(checkpoint).toMatchObject({
      sessionId: 'stable-session',
      runId: 1,
      state: { terminal: false },
    });

    const second = new CortxRuntime({
      language: textLanguage('resumed'),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
      durableStore,
    });
    const secondSession = await second.createSession({ id: 'stable-session' });
    const secondEvents: AgentEvent[] = [];
    second.subscribe(secondSession.id, (event) => secondEvents.push(event));

    await second.resume(secondSession.id);
    await waitForEvent(secondEvents, 'done');

    expect(secondEvents.find((event) => event.type === 'text')).toMatchObject({ content: 'resumed' });
    await first.close();
    await second.close();
  });

  test('restores durable sessions from file snapshots and auto-resumes non-terminal checkpoints', async () => {
    const durableDir = join(tmpDir, 'durable');
    const firstStore = new FileDurableRunStore(durableDir);
    const first = new CortxRuntime({
      language: neverFinishingLanguage(),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      durableStore: firstStore,
    });
    const firstSession = await first.createSession({
      id: 'file-backed-session',
      creatorPrincipalId: 'principal:alice',
      metadata: { source: 'durable-test' },
    });
    const firstEvents: AgentEvent[] = [];
    first.subscribe(firstSession.id, (event) => firstEvents.push(event));

    await first.prompt(firstSession.id, 'resume me');
    await waitForEvent(firstEvents, 'turn_start');
    await waitForDurableEnvelope(firstStore, 'file-backed-session', 'turn_start');
    await firstStore.saveSubAgentSession({
      schemaVersion: RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
      runId: 'file-backed-session:agent-call',
      parentSessionId: 'file-backed-session',
      parentRunId: 1,
      toolCallId: 'agent-call',
      description: 'restored child',
      isBackground: true,
      status: 'running',
      output: 'partial child output',
      iterations: 1,
      toolCallCount: 2,
      startedAt: Date.now(),
    });
    firstStore.releaseOwnership();
    const secondStore = new FileDurableRunStore(durableDir);
    const second = new CortxRuntime({
      language: textLanguage('resumed from disk'),
      model: 'fallback',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore: secondStore,
    });

    const restored = await second.restoreDurableSessions({ autoResume: true });
    const secondEvents: AgentEvent[] = [];
    second.subscribe('file-backed-session', (event) => secondEvents.push(event));
    await waitForEvent(secondEvents, 'done');
    const replayedHistory = second.getEventEnvelopeHistory('file-backed-session');

    expect(restored).toHaveLength(1);
    expect(second.getSession('file-backed-session')).toMatchObject({
      workingDirectory: tmpDir,
      creatorPrincipalId: 'principal:alice',
      model: 'test',
      toolMode: 'none',
      approvalMode: 'deny',
      promptHistory: ['resume me'],
      metadata: { source: 'durable-test' },
    });
    expect(second.getLocalState('file-backed-session').agentSessions.get('agent-call')).toMatchObject({
      description: 'restored child',
      parentRunId: 1,
      output: 'partial child output',
      status: 'interrupted',
    });
    expect(replayedHistory[0]).toMatchObject({
      sessionId: 'file-backed-session',
      runId: 1,
      sequence: 1,
      event: { type: 'user_message', message: 'resume me', source: 'prompt' },
    });
    expect(replayedHistory.find((event) => event.event.type === 'turn_start')).toMatchObject({
      sessionId: 'file-backed-session',
      runId: 1,
      sequence: 2,
    });
    expect(replayedHistory.find((event) => event.event.type === 'done')).toMatchObject({
      sessionId: 'file-backed-session',
      runId: 2,
    });
    expect(secondEvents.find((event) => event.type === 'text')).toMatchObject({ content: 'resumed from disk' });
    await second.close();
    await first.close();
  });

  test('restored legacy done envelopes are enriched with context usage facts', async () => {
    const durableDir = join(tmpDir, 'durable');
    const sessionId = 'legacy-context-session';
    const store = new FileDurableRunStore(durableDir);
    await store.saveCheckpoint({
      schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
      sessionId,
      runId: 1,
      iteration: 1,
      kind: 'turn_start',
      state: {
        phase: 'model',
        terminal: false,
        lastEvent: { type: 'turn_start', iteration: 1 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'restore usage facts' }] }],
      },
    });
    await store.saveRuntimeSession({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: sessionId,
      createdAt: 1,
      lastActivityAt: 2,
      workingDirectory: tmpDir,
      model: 'test-model',
      system: 'System prompt',
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      runId: 1,
      nextEventSequence: 1,
      ...durableProjection(1),
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 1,
      timestamp: 2,
      sessionId,
      runId: 1,
      event: { type: 'done', usage: { inputTokens: 100, outputTokens: 5 } },
    });
    store.releaseOwnership();

    const runtime = new CortxRuntime({
      language: textLanguage('unused'),
      model: 'test-model',
      system: 'System prompt',
      contextWindowTokens: 2000,
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore: new FileDurableRunStore(durableDir),
    });

    await runtime.restoreDurableSessions({ autoResume: false });
    const history = runtime.getEventEnvelopeHistory(sessionId);
    const done = history.find((event) => event.event.type === 'done')?.event;

    expect(runtime.getLocalState(sessionId).getMessages()).toHaveLength(1);
    expect(done).toMatchObject({
      type: 'done',
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        context: {
          usedTokens: 100,
          requestInputTokens: 100,
          requestOutputTokens: 5,
          windowTokens: 2000,
          windowSource: 'configured',
          percentUsed: 5,
          model: 'test-model',
        },
      },
    });
    expect(done?.type === 'done' ? done.usage?.context?.breakdown.map((row) => row.key) : []).toEqual([
      'messages',
      'tools',
      'skills',
      'system_prompt',
      'other',
    ]);
    await runtime.close();
  });

  test('backfills legacy prompt history into replayable user message events', async () => {
    const durableDir = join(tmpDir, 'durable-legacy-prompts');
    const sessionId = 'legacy-prompt-session';
    const store = new FileDurableRunStore(durableDir);
    await store.saveRuntimeSession({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: sessionId,
      createdAt: 10,
      lastActivityAt: 20,
      workingDirectory: tmpDir,
      model: 'test-model',
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      promptHistory: ['restore my original question'],
      runId: 1,
      nextEventSequence: 2,
      ...durableProjection(2),
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 1,
      timestamp: 20,
      sessionId,
      runId: 1,
      event: { type: 'turn_start', iteration: 1 },
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 2,
      timestamp: 21,
      sessionId,
      runId: 1,
      event: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    });
    store.releaseOwnership();

    const runtime = new CortxRuntime({
      language: textLanguage('unused'),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore: new FileDurableRunStore(durableDir),
    });

    await runtime.restoreDurableSessions({ autoResume: false });
    const history = runtime.getEventEnvelopeHistory(sessionId);

    expect(history[0]).toMatchObject({
      sequence: 0,
      sessionId,
      runId: 1,
      event: { type: 'user_message', message: 'restore my original question', source: 'prompt' },
    });
    expect(history[1]).toMatchObject({ sequence: 1, event: { type: 'turn_start' } });
    await runtime.close();
  });

  test('restores cumulative usage from full durable events even when replay history is bounded', async () => {
    const durableDir = join(tmpDir, 'durable-usage-summary');
    const sessionId = 'bounded-usage-session';
    const store = new FileDurableRunStore(durableDir);
    await store.saveRuntimeSession({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: sessionId,
      createdAt: 1,
      lastActivityAt: 2,
      workingDirectory: tmpDir,
      model: 'test-model',
      system: 'System prompt',
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        context: {
          usedTokens: 1,
          requestInputTokens: 1,
          windowTokens: 128000,
          percentUsed: 0.00078125,
          cacheHitRate: 0,
          breakdown: [],
        },
      },
      runId: 1,
      nextEventSequence: 3,
      ...durableProjection(3),
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 1,
      timestamp: 2,
      sessionId,
      runId: 1,
      event: { type: 'done', usage: { inputTokens: 100, outputTokens: 10 } },
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 2,
      timestamp: 3,
      sessionId,
      runId: 1,
      event: { type: 'done', usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 1000 } },
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 3,
      timestamp: 4,
      sessionId,
      runId: 1,
      event: { type: 'done', usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 2000 } },
    });
    store.releaseOwnership();

    const runtime = new CortxRuntime({
      language: textLanguage('unused'),
      model: 'test-model',
      system: 'System prompt',
      contextWindowTokens: 128000,
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore: new FileDurableRunStore(durableDir),
      maxEventsPerSession: 1,
    });

    await runtime.restoreDurableSessions({ autoResume: false });
    const restored = runtime.getSession(sessionId);

    expect(runtime.getEventEnvelopeHistory(sessionId)).toHaveLength(1);
    expect(restored.usage).toMatchObject({
      inputTokens: 600,
      outputTokens: 60,
      cacheReadTokens: 3000,
    });
    expect(restored.usage?.context).toMatchObject({
      usedTokens: 2300,
      requestInputTokens: 300,
      requestCacheReadTokens: 2000,
      cacheHitRate: 86.95652173913044,
    });
    await runtime.close();
  });

  test('restores terminal and empty sessions while marking interrupted replay recoverable', async () => {
    const durableDir = join(tmpDir, 'durable-all-sessions');
    const store = new FileDurableRunStore(durableDir);
    await store.saveRuntimeSession({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: 'empty-session',
      createdAt: 1,
      lastActivityAt: 1,
      workingDirectory: tmpDir,
      model: 'test',
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      runId: 0,
      nextEventSequence: 0,
      ...durableProjection(0),
    });
    await store.saveRuntimeSession({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: 'terminal-session',
      createdAt: 2,
      lastActivityAt: 3,
      workingDirectory: tmpDir,
      model: 'test',
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      runId: 1,
      nextEventSequence: 1,
      ...durableProjection(1),
    });
    await store.saveCheckpoint({
      schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'terminal-session',
      runId: 1,
      iteration: 1,
      kind: 'terminal',
      state: {
        phase: 'completion',
        terminal: true,
        lastEvent: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'done session' }] }],
      },
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 1,
      timestamp: 3,
      sessionId: 'terminal-session',
      runId: 1,
      event: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    });
    await store.saveRuntimeSession({
      schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
      id: 'interrupted-session',
      createdAt: 4,
      lastActivityAt: 5,
      workingDirectory: tmpDir,
      model: 'test',
      toolMode: 'none',
      approvalMode: 'deny',
      capabilities: { skills: false, subAgents: false, approval: false },
      runId: 1,
      nextEventSequence: 1,
      ...durableProjection(1),
    });
    await store.saveCheckpoint({
      schemaVersion: AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
      sessionId: 'interrupted-session',
      runId: 1,
      iteration: 1,
      kind: 'turn_start',
      state: {
        phase: 'turn',
        terminal: false,
        lastEvent: { type: 'turn_start', iteration: 1 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'interrupted session' }] }],
      },
    });
    await store.saveEventEnvelope({
      schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
      sequence: 1,
      timestamp: 5,
      sessionId: 'interrupted-session',
      runId: 1,
      event: { type: 'turn_start', iteration: 1 },
    });
    store.releaseOwnership();

    const runtime = new CortxRuntime({
      language: textLanguage('unused'),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore: new FileDurableRunStore(durableDir),
    });

    const restored = await runtime.restoreDurableSessions({ autoResume: false });

    expect(restored.map((session) => session.id).sort()).toEqual([
      'empty-session',
      'interrupted-session',
      'terminal-session',
    ]);
    expect(runtime.getLocalState('terminal-session').getMessages()).toHaveLength(1);
    expect(runtime.getEventEnvelopeHistory('empty-session')).toHaveLength(0);
    expect(runtime.getEventEnvelopeHistory('terminal-session').at(-1)?.event).toMatchObject({ type: 'done' });
    expect(runtime.getEventEnvelopeHistory('interrupted-session').at(-1)?.event).toMatchObject({
      type: 'error',
      code: 'client_error',
    });
    await runtime.close();
  });

  test('restores durable queued follow-ups as visible interrupted inputs without replaying them into Core', async () => {
    const durableDir = join(tmpDir, 'durable-queued-inputs');
    const firstStore = new FileDurableRunStore(durableDir);
    const first = new CortxRuntime({
      language: neverFinishingLanguage(),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      durableStore: firstStore,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await first.createSession({ id: 'queued-session' });
    await first.prompt(session.id, 'start');
    first.followUp(session.id, 'queued after restart', 'input:queued');
    await waitForDurableSession(firstStore, session.id, (value) => value.queuedInputs.length === 1);
    firstStore.releaseOwnership();

    const second = new CortxRuntime({
      language: textLanguage('must not run automatically'),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      durableStore: new FileDurableRunStore(durableDir),
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    await second.restoreDurableSessions({ autoResume: false });

    expect(second.getSession(session.id)).toMatchObject({
      runPhase: 'interrupted',
      queuedInputs: [{ inputId: 'input:queued', message: 'queued after restart', state: 'interrupted' }],
      pendingInteraction: null,
    });
    expect(second.getEventHistory(session.id).some((event) => event.type === 'text')).toBe(false);
    await second.close();
    await first.close();
  });

  test('unsupported checkpoint schema emits a typed client error event', async () => {
    const durableStore = new MemoryDurableRunStore();
    durableStore.saveCheckpoint({
      schemaVersion: 999 as never,
      sessionId: 'unsupported-session',
      runId: 1,
      iteration: 1,
      kind: 'turn_start',
      state: {
        phase: 'turn',
        lastEvent: { type: 'turn_start', iteration: 1 },
        terminal: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'resume me' }] }],
      },
    });
    const runtime = new CortxRuntime({
      language: textLanguage('unused'),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
      durableStore,
    });
    const session = await runtime.createSession({ id: 'unsupported-session' });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.resume(session.id);
    const error = await waitForEvent(events, 'error');

    expect(error).toMatchObject({ type: 'error', code: 'client_error' });
    expect(error.type === 'error' ? error.error.message : '').toContain('Unsupported checkpoint schema version');
    await runtime.close();
  });
});

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type'], timeoutMs = 1_000): Promise<AgentEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = events.find((item) => item.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function waitForDurableEnvelope(
  store: FileDurableRunStore,
  sessionId: string,
  type: AgentEvent['type'],
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = (await store.listEventEnvelopes(sessionId)).find((item) => item.event.type === type);
    if (event) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for durable ${type}`);
}

async function waitForDurableSession(
  store: FileDurableRunStore,
  sessionId: string,
  predicate: (snapshot: Awaited<ReturnType<FileDurableRunStore['loadRuntimeSession']>>) => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await store.loadRuntimeSession(sessionId);
    if (snapshot && predicate(snapshot)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for durable session snapshot');
}
