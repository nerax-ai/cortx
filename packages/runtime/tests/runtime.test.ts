import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_RUNTIME_CAPABILITIES, CortxRuntime, RuntimeError } from '../src/index';
import type { AgentEvent, LanguageMessage, RuntimeAgentEventEnvelope } from '@cortx/sdk';
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
      windowTokens: 128_000,
      cacheHitRate: 78.71657754010695,
    });
    expect(done.usage?.context?.percentUsed).toBeCloseTo(1.4609375);
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

  test('enforces max sessions', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('ok')]),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      maxSessions: 1,
      toolMode: 'none',
    });
    await runtime.createSession({ id: 'one' });
    await expect(runtime.createSession({ id: 'two' })).rejects.toMatchObject({
      kind: 'capacity_exceeded',
      status: 429,
    });
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

  test('routes steer, follow-up, answer and resume through the hosted controller', async () => {
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
    runtime.steer(session.id, 'use this instead');
    runtime.followUp(session.id, 'then continue');
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    await expect(runtime.prompt(session.id, 'parallel')).rejects.toMatchObject({ kind: 'session_busy' });
    runtime.answer(session.id, 'question-1', 'yes');
    expect(events.filter((event) => event.type === 'user_answer')).toHaveLength(1);
    expect(events.find((event) => event.type === 'user_answer')).toMatchObject({ response: 'yes' });
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

  test('rejects session control updates while a run is active', async () => {
    const runtime = new CortxRuntime({
      language: delayedLanguage(100),
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
    });
    const session = await runtime.createSession();

    await runtime.prompt(session.id, 'running');
    await expect(runtime.updateSession(session.id, { toolMode: 'all' })).rejects.toMatchObject({
      kind: 'session_busy',
    });

    await runtime.abort(session.id);
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
