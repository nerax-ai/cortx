import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_RUNTIME_CAPABILITIES, CortxRuntime, RuntimeError } from '../src/index';
import type {
  AgentEvent,
  AgentRunCheckpoint,
  LanguageMessage,
  RuntimeAgentEventEnvelope,
  Tool,
} from '@cortx/sdk';
import type {
  RuntimeDurableRunStore,
  RuntimeSessionSnapshot,
  RuntimeSubAgentSessionSnapshot,
} from '../src/index';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-runtime-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function textParts(text: string): LanguageStreamPart[] {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
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

function delayedLanguage(delayMs: number): LanguageClient {
  return {
    stream: async function* () {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
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

async function waitForEnvelope(
  events: RuntimeAgentEventEnvelope[],
  type: AgentEvent['type'],
  timeoutMs = 1_000,
): Promise<RuntimeAgentEventEnvelope> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find((event) => event.event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

class DelayedRuntimeSessionStore implements RuntimeDurableRunStore {
  private readonly checkpoints = new Map<string, AgentRunCheckpoint>();
  private readonly sessions = new Map<string, RuntimeSessionSnapshot>();
  private readonly subAgents = new Map<string, RuntimeSubAgentSessionSnapshot[]>();
  private saveGate: Promise<void> | undefined;
  private releaseSaveGate: (() => void) | undefined;
  activeRuntimeSaves = 0;
  blockedRuntimeSaves = 0;

  delayRuntimeSessionSaves(): void {
    if (this.saveGate) return;
    this.saveGate = new Promise((resolve) => {
      this.releaseSaveGate = resolve;
    });
  }

  releaseRuntimeSessionSaves(): void {
    this.releaseSaveGate?.();
    this.releaseSaveGate = undefined;
    this.saveGate = undefined;
  }

  async waitForBlockedRuntimeSave(timeoutMs = 1_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.blockedRuntimeSaves > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for a blocked runtime session save');
  }

  async waitForRuntimeSavesToDrain(timeoutMs = 1_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.activeRuntimeSaves === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for runtime session saves to drain');
  }

  saveCheckpoint(checkpoint: AgentRunCheckpoint): void {
    this.checkpoints.set(checkpoint.sessionId, checkpoint);
  }

  loadCheckpoint(sessionId: string): AgentRunCheckpoint | undefined {
    return this.checkpoints.get(sessionId);
  }

  deleteCheckpoint(sessionId: string): void {
    this.checkpoints.delete(sessionId);
  }

  async saveRuntimeSession(snapshot: RuntimeSessionSnapshot): Promise<void> {
    this.activeRuntimeSaves++;
    try {
      if (this.saveGate) {
        this.blockedRuntimeSaves++;
        await this.saveGate;
      }
      this.sessions.set(snapshot.id, snapshot);
    } finally {
      this.activeRuntimeSaves--;
    }
  }

  loadRuntimeSession(sessionId: string): RuntimeSessionSnapshot | undefined {
    return this.sessions.get(sessionId);
  }

  listRuntimeSessions(): RuntimeSessionSnapshot[] {
    return [...this.sessions.values()];
  }

  deleteRuntimeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.checkpoints.delete(sessionId);
    this.subAgents.delete(sessionId);
  }

  saveSubAgentSession(snapshot: RuntimeSubAgentSessionSnapshot): void {
    const existing = this.subAgents.get(snapshot.parentSessionId) ?? [];
    this.subAgents.set(snapshot.parentSessionId, [
      ...existing.filter((item) => item.toolCallId !== snapshot.toolCallId),
      snapshot,
    ]);
  }

  listSubAgentSessions(parentSessionId: string): RuntimeSubAgentSessionSnapshot[] {
    return this.subAgents.get(parentSessionId) ?? [];
  }

  deleteSubAgentSessions(parentSessionId: string): void {
    this.subAgents.delete(parentSessionId);
  }
}

describe('CortxRuntime sessions', () => {
  test('defines runtime-owned default capabilities', () => {
    expect(DEFAULT_RUNTIME_CAPABILITIES).toEqual({ skills: true, subAgents: true, approval: true });
  });

  test('can disable runtime-mounted skill bridge for a hosted session', async () => {
    const skillDir = join(tmpDir, '.cortx', 'skills', 'commit');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: commit\ndescription: Commit skill\n---\nExpanded commit instructions',
    );
    let seenMessages: LanguageMessage[] | undefined;
    const runtime = new CortxRuntime({
      language: {
        stream: async function* (request: { messages: LanguageMessage[] }) {
          seenMessages = request.messages;
          yield {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, '/commit fix');
    await waitForEvent(events, 'done');

    const content = seenMessages?.at(-1)?.content;
    expect(typeof content === 'string' ? content : content?.find((part) => part.type === 'text')?.text).toBe(
      '/commit fix',
    );
    runtime.dispose();
  });

  test('lists skills available to a hosted session', async () => {
    const skillDir = join(tmpDir, '.cortx', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: Review code changes\narguments:\n  - target\n---\nReview the requested target.',
    );
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('ok')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: true, subAgents: false, approval: false },
    });
    const enabled = await runtime.createSession();
    const disabled = await runtime.createSession({ capabilities: { skills: false, subAgents: false, approval: false } });

    await expect(runtime.listSessionSkills(enabled.id)).resolves.toEqual([
      expect.objectContaining({
        name: 'review',
        description: 'Review code changes',
        arguments: ['target'],
      }),
    ]);
    await expect(runtime.listSessionSkills(disabled.id)).resolves.toEqual([]);
    runtime.dispose();
  });

  test('stores per-session maxIterations in runtime session metadata', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('ok')]),
      model: 'test-model',
      maxIterations: 3,
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
    });
    const session = await runtime.createSession({ maxIterations: 7 });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'hello');
    await waitForEvent(events, 'done');

    expect(runtime.getSession(session.id).maxIterations).toBe(7);
    runtime.dispose();
  });

  test('enriches done events with runtime context usage facts', async () => {
    const skillDir = join(tmpDir, '.cortx', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: Review code changes\n---\nUse severity ordered findings.',
    );
    const runtime = new CortxRuntime({
      language: mockLanguage([
        [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'ok' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 1000, noCache: 700, cacheRead: 200, cacheWrite: 100 },
              outputTokens: { total: 50, reasoning: 10 },
            },
          },
        ] as LanguageStreamPart[],
      ]),
      model: 'test-model',
      system: 'You are Cortx.',
      contextWindowTokens: 2000,
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: true, subAgents: false, approval: false },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'hello');
    const done = (await waitForEvent(events, 'done')) as Extract<AgentEvent, { type: 'done' }>;

    expect(done.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      reasoningTokens: 10,
    });
    expect(done.usage?.context).toMatchObject({
      usedTokens: 1000,
      requestInputTokens: 1000,
      requestOutputTokens: 50,
      requestNoCacheInputTokens: 700,
      requestCacheReadTokens: 200,
      requestCacheCreationTokens: 100,
      windowTokens: 2000,
      windowSource: 'configured',
      percentUsed: 50,
      cacheHitRate: 20,
      model: 'test-model',
    });
    expect(done.usage?.context?.breakdown.map((row) => row.key)).toEqual([
      'messages',
      'tools',
      'skills',
      'system_prompt',
      'other',
    ]);
    expect(done.usage?.context?.breakdown.find((row) => row.key === 'skills')?.count).toBe(1);
    expect(runtime.getSession(session.id).contextWindowTokens).toBe(2000);
    runtime.dispose();
  });

  test('counts provider cache-read input toward context window usage', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([
        [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'ok' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 398, cacheRead: 1472 },
              outputTokens: { total: 133 },
            },
          },
        ] as LanguageStreamPart[],
      ]),
      model: 'test-model',
      contextWindowTokens: 128_000,
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'hello');
    const done = (await waitForEvent(events, 'done')) as Extract<AgentEvent, { type: 'done' }>;

    expect(done.usage?.context).toMatchObject({
      usedTokens: 1870,
      requestInputTokens: 398,
      requestOutputTokens: 133,
      requestCacheReadTokens: 1472,
      windowTokens: 128_000,
      cacheHitRate: 78.71657754010695,
    });
    expect(done.usage?.context?.percentUsed).toBeCloseTo(1.4609375);
    runtime.dispose();
  });

  test('updates the current session model and reasoning effort before the next run', async () => {
    const requests: Array<{ model?: string; reasoning?: unknown }> = [];
    const runtime = new CortxRuntime({
      language: {
        stream: async function* (request: { model?: string; reasoning?: unknown }) {
          requests.push(request);
          yield {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          } as LanguageStreamPart;
        },
      } as unknown as LanguageClient,
      model: 'small',
      models: [
        { id: 'small', name: 'Small', limits: { context: 1000, output: 100 } },
        { id: 'large', name: 'Large', limits: { context: 2000, output: 200 }, capabilities: { reasoning: true } },
      ],
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    expect(session.contextWindowTokens).toBe(1000);
    const updated = await runtime.updateSession(session.id, { model: 'large', reasoningEffort: 'high' });
    expect(updated).toMatchObject({
      id: session.id,
      model: 'large',
      reasoningEffort: 'high',
      contextWindowTokens: 2000,
      contextWindowSource: 'model_metadata',
    });

    await runtime.prompt(session.id, 'hello');
    await waitForEvent(events, 'done');
    expect(requests.at(-1)).toMatchObject({
      model: 'large',
      reasoning: { enabled: true, effort: 'high' },
    });
    runtime.dispose();
  });

  test('does not report context usage below runtime-known context breakdown', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([
        [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'ok' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 1, cacheRead: 9 },
              outputTokens: { total: 2 },
            },
          },
        ] as LanguageStreamPart[],
      ]),
      model: 'test-model',
      system: 'You are Cortx. '.repeat(200),
      contextWindowTokens: 128_000,
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'hello');
    const done = (await waitForEvent(events, 'done')) as Extract<AgentEvent, { type: 'done' }>;
    const context = done.usage?.context;
    const breakdownTotal = context?.breakdown.reduce((total, row) => total + row.tokens, 0) ?? 0;

    expect(context?.usedTokens).toBeGreaterThanOrEqual(breakdownTotal);
    expect(context?.usedTokens).toBeGreaterThan(10);
    expect(context?.cacheHitRate).toBe(90);
    runtime.dispose();
  });

  test('creates independent sessions and replays bounded event history', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('one'), textParts('two')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      maxEventsPerSession: 2,
      toolMode: 'none',
    });
    const a = await runtime.createSession({ id: 'a' });
    const b = await runtime.createSession({ id: 'b' });
    const liveA: AgentEvent[] = [];
    runtime.subscribe(a.id, (event) => liveA.push(event));

    expect(a.id).not.toBe(b.id);
    await runtime.prompt(a.id, 'hello a');
    await runtime.prompt(b.id, 'hello b');
    await waitForEvent(liveA, 'done');

    expect(runtime.getEventHistory(a.id).length).toBeLessThanOrEqual(2);
    expect(runtime.getEventHistory(b.id).length).toBeLessThanOrEqual(2);
    expect(runtime.getSession(a.id).isRunning).toBe(false);
    expect(runtime.getSession(b.id).isRunning).toBe(false);

    const replayed: AgentEvent[] = [];
    runtime.subscribe(a.id, (event) => replayed.push(event));
    expect(replayed.map((event) => event.type)).toEqual(runtime.getEventHistory(a.id).map((event) => event.type));
    runtime.dispose();
  });

  test('isolates replay subscriber errors for event and envelope subscriptions', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('replay me')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'replay-session' });
    const live: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => live.push(event));
    await runtime.prompt(session.id, 'hello');
    await waitForEvent(live, 'done');

    let replayCalls = 0;
    const replayed: AgentEvent['type'][] = [];
    runtime.subscribe(session.id, (event) => {
      replayCalls++;
      if (replayCalls === 1) throw new Error('boom');
      replayed.push(event.type);
    });

    let envelopeReplayCalls = 0;
    const replayedEnvelopes: AgentEvent['type'][] = [];
    runtime.subscribeEnvelopes(session.id, (event) => {
      envelopeReplayCalls++;
      if (envelopeReplayCalls === 1) throw new Error('boom');
      replayedEnvelopes.push(event.event.type);
    });

    expect(replayCalls).toBe(runtime.getEventHistory(session.id).length);
    expect(replayed).toContain('done');
    expect(envelopeReplayCalls).toBe(runtime.getEventEnvelopeHistory(session.id).length);
    expect(replayedEnvelopes).toContain('done');

    const liveAfterReplay: AgentEvent[] = [];
    runtime.subscribe(session.id, async () => {
      throw new Error('async boom');
    }, { replay: false });
    runtime.subscribe(session.id, (event) => liveAfterReplay.push(event), { replay: false });
    await runtime.prompt(session.id, 'again');
    await waitForEvent(liveAfterReplay, 'done');

    runtime.dispose();
  });

  test('records runtime event envelopes with stable identity and bounded history', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('enveloped')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      maxEventsPerSession: 3,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'envelope-session' });
    const live: RuntimeAgentEventEnvelope[] = [];
    runtime.subscribeEnvelopes(session.id, (event) => live.push(event));

    await runtime.prompt(session.id, 'hello');
    await waitForEnvelope(live, 'done');

    const history = runtime.getEventEnvelopeHistory(session.id);
    expect(history.length).toBeLessThanOrEqual(3);
    expect(history.at(-1)).toMatchObject({
      sessionId: 'envelope-session',
      runId: 1,
      event: { type: 'done' },
    });
    expect(history.every((event) => typeof event.timestamp === 'number' && event.timestamp > 0)).toBe(true);
    expect(history.map((event) => event.sequence)).toEqual(
      [...history].map((event) => event.sequence).sort((a, b) => a - b),
    );

    const replayed: RuntimeAgentEventEnvelope[] = [];
    runtime.subscribeEnvelopes(session.id, (event) => replayed.push(event));
    expect(replayed.map((event) => event.sequence)).toEqual(history.map((event) => event.sequence));
    runtime.dispose();
  });

  test('enforces max sessions only for currently running sessions', async () => {
    const runtime = new CortxRuntime({
      language: delayedLanguage(120),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      maxSessions: 1,
      toolMode: 'none',
    });
    const one = await runtime.createSession({ id: 'one' });
    const two = await runtime.createSession({ id: 'two' });
    const oneEvents: AgentEvent[] = [];
    const twoEvents: AgentEvent[] = [];
    runtime.subscribe(one.id, (event) => oneEvents.push(event));
    runtime.subscribe(two.id, (event) => twoEvents.push(event));

    await runtime.prompt(one.id, 'first');
    await expect(runtime.prompt(two.id, 'second')).rejects.toMatchObject({
      kind: 'capacity_exceeded',
      status: 429,
    });
    expect(runtime.getSession(two.id).isRunning).toBe(false);

    await waitForEvent(oneEvents, 'done');
    await runtime.prompt(two.id, 'second');
    await waitForEvent(twoEvents, 'done');
    runtime.dispose();
  });

  test('abort waits for the active run before clearing the running gate', async () => {
    const runtime = new CortxRuntime({
      language: delayedLanguage(200),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
    });
    const session = await runtime.createSession();
    await runtime.prompt(session.id, 'first');
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    const abortPromise = runtime.abort(session.id);
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    await expect(runtime.prompt(session.id, 'too soon')).rejects.toMatchObject({ kind: 'session_busy' });
    await abortPromise;
    expect(runtime.getSession(session.id).isRunning).toBe(false);
    await runtime.prompt(session.id, 'second');
    runtime.dispose();
  });

  test('runtime owns the active run promise until the session finishes', async () => {
    const runtime = new CortxRuntime({
      language: delayedLanguage(20),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'tracked-run' });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'track this run');
    const internal = (runtime as unknown as { sessions: Map<string, { runPromise?: Promise<void> }> }).sessions.get(session.id);
    expect(internal?.runPromise).toBeInstanceOf(Promise);
    await waitForEvent(events, 'done');
    await internal?.runPromise;

    expect(internal?.runPromise).toBeUndefined();
    expect(runtime.getSession(session.id).isRunning).toBe(false);
    runtime.dispose();
  });

  test('deleteSession prevents delayed durable writes from resurrecting deleted sessions', async () => {
    const durableStore = new DelayedRuntimeSessionStore();
    const runtime = new CortxRuntime({
      language: delayedLanguage(100),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore,
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'delete-race' });
    durableStore.delayRuntimeSessionSaves();

    await runtime.prompt(session.id, 'delete me');
    await durableStore.waitForBlockedRuntimeSave();
    await runtime.deleteSession(session.id);
    expect(durableStore.listRuntimeSessions()).toEqual([]);

    durableStore.releaseRuntimeSessionSaves();
    await durableStore.waitForRuntimeSavesToDrain();
    expect(durableStore.listRuntimeSessions()).toEqual([]);
    await expect(runtime.restoreDurableSessions()).resolves.toEqual([]);
    runtime.dispose();
  });

  test('routes steer, follow-up and resume through the hosted controller', async () => {
    const runtime = new CortxRuntime({
      language: delayedLanguage(100),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'start');
    expect(events[0]).toMatchObject({ type: 'user_message', message: 'start', source: 'prompt' });
    expect(runtime.getEventEnvelopeHistory(session.id)[0]).toMatchObject({
      runId: 1,
      event: { type: 'user_message', message: 'start', source: 'prompt' },
    });
    runtime.steer(session.id, 'use this instead');
    runtime.followUp(session.id, 'then continue');
    expect(events.find((event) => event.type === 'user_message' && event.message === 'then continue')).toMatchObject({
      source: 'follow_up',
    });
    expect(runtime.getSession(session.id).promptHistory).toEqual(['start', 'then continue']);
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    await expect(runtime.prompt(session.id, 'parallel')).rejects.toMatchObject({ kind: 'session_busy' });
    expect(runtime.answer(session.id, 'question-1', 'yes')).toBe(false);
    expect(events.filter((event) => event.type === 'user_answer')).toHaveLength(0);
    expect(events.map((event) => event.type)).not.toContain('user_response');
    await runtime.abort(session.id);
    await runtime.resume(session.id);
    runtime.dispose();
  });

  test('updates current session controls without replacing the session or history', async () => {
    const seenToolNames: string[][] = [];
    const seenMessages: LanguageMessage[][] = [];
    const runtime = new CortxRuntime({
      language: {
        stream: async function* (request: { tools?: Array<{ name: string }>; messages: LanguageMessage[] }) {
          seenToolNames.push((request.tools ?? []).map((tool) => tool.name));
          seenMessages.push(request.messages);
          yield {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'interactive',
      capabilities: { skills: false, subAgents: false, approval: true },
    });
    const session = await runtime.createSession({ id: 'controls-session', approvalMode: 'full-access' });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'first');
    await waitForEvent(events, 'done');
    expect(runtime.getSession(session.id)).toMatchObject({
      id: 'controls-session',
      approvalMode: 'full-access',
      capabilities: { approval: false },
    });
    expect(seenToolNames[0]).not.toContain('read');

    events.length = 0;
    const updated = await runtime.updateSession(session.id, {
      toolMode: 'read-only',
      approvalMode: 'interactive',
    });
    expect(updated).toMatchObject({
      id: 'controls-session',
      toolMode: 'read-only',
      approvalMode: 'interactive',
      capabilities: { approval: true },
    });

    await runtime.prompt(session.id, 'second');
    await waitForEvent(events, 'done');

    expect(runtime.listSessions().map((item) => item.id)).toEqual(['controls-session']);
    expect(seenToolNames[1]).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls']));
    expect(seenToolNames[1]).not.toContain('write');
    expect(JSON.stringify(seenMessages[1])).toContain('first');
    runtime.dispose();
  });

  test('restores session request tools from durable snapshots when the store preserves tool functions', async () => {
    const durableStore = new DelayedRuntimeSessionStore();
    const seenToolNames: string[][] = [];
    const customTool: Tool = {
      name: 'custom_tool',
      description: 'Custom tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ success: true, output: 'ok' }),
    };
    const firstRuntime = new CortxRuntime({
      language: mockLanguage([textParts('first')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore,
    });
    const session = await firstRuntime.createSession({ tools: [customTool] });

    const restoredRuntime = new CortxRuntime({
      language: {
        stream: async function* (request: { tools?: Array<{ name: string }> }) {
          seenToolNames.push((request.tools ?? []).map((tool) => tool.name));
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      durableStore,
    });

    await restoredRuntime.restoreDurableSessions({ autoResume: false });
    const events: AgentEvent[] = [];
    restoredRuntime.subscribe(session.id, (event) => events.push(event));
    await restoredRuntime.prompt(session.id, 'use restored tool definitions');
    await waitForEvent(events, 'done');

    expect(seenToolNames[0]).toContain('custom_tool');
    firstRuntime.dispose();
    restoredRuntime.dispose();
  });

  test('allows session control updates during an active run and applies them on the next turn', async () => {
    const seenToolNames: string[][] = [];
    const runtime = new CortxRuntime({
      language: {
        stream: async function* (request: { tools?: Array<{ name: string }> }) {
          seenToolNames.push((request.tools ?? []).map((tool) => tool.name));
          await new Promise((resolve) => setTimeout(resolve, 40));
          yield {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'interactive',
      capabilities: { skills: false, subAgents: false, approval: true },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'running');
    const started = Date.now();
    while (seenToolNames.length === 0 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(seenToolNames.length).toBe(1);
    const updated = await runtime.updateSession(session.id, { toolMode: 'read-only', approvalMode: 'full-access' });
    expect(updated).toMatchObject({
      toolMode: 'read-only',
      approvalMode: 'full-access',
      isRunning: true,
    });
    expect(seenToolNames[0]).not.toContain('read');

    await waitForEvent(events, 'done');
    events.length = 0;
    await runtime.prompt(session.id, 'next');
    await waitForEvent(events, 'done');

    expect(seenToolNames[1]).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls']));
    runtime.dispose();
  });

  test('throws typed errors for missing sessions and invalid requests', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('ok')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
    });
    expect(() => runtime.getSession('missing')).toThrow(RuntimeError);
    const session = await runtime.createSession();
    await expect(runtime.prompt(session.id, '')).rejects.toMatchObject({ kind: 'invalid_request' });
    runtime.dispose();
  });

  test('rejects invalid session tool and approval modes before mounting capabilities', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('ok')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
    });

    await expect(runtime.createSession({ toolMode: 'everything' as never })).rejects.toMatchObject({
      kind: 'invalid_request',
      details: { toolMode: 'everything' },
    });
    await expect(runtime.createSession({ approvalMode: 'ask' as never })).rejects.toMatchObject({
      kind: 'invalid_request',
      details: { approvalMode: 'ask' },
    });
    const session = await runtime.createSession();
    await expect(runtime.updateSession(session.id, { toolMode: 'everything' as never })).rejects.toMatchObject({
      kind: 'invalid_request',
      details: { toolMode: 'everything' },
    });
    await expect(runtime.updateSession(session.id, { approvalMode: 'ask' as never })).rejects.toMatchObject({
      kind: 'invalid_request',
      details: { approvalMode: 'ask' },
    });
    runtime.dispose();
  });
});
