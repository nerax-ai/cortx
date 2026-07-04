import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CortxRuntime, RuntimeError, toCoreCapabilities } from '../src/index';
import type { AgentEvent, LanguageMessage } from '@cortx/sdk';
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

describe('CortxRuntime sessions', () => {
  test('maps runtime default capabilities into core capability flags', () => {
    expect(toCoreCapabilities()).toEqual({ skills: 'enabled', subAgents: 'enabled' });
    expect(toCoreCapabilities({ skills: false, subAgents: false })).toEqual({
      skills: 'disabled',
      subAgents: 'disabled',
    });
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

  test('abort clears the running gate and ignores stale run completion', async () => {
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
    runtime.abort(session.id);
    expect(runtime.getSession(session.id).isRunning).toBe(false);
    await runtime.prompt(session.id, 'second');
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
    expect(events.find((event) => event.type === 'user_answer')).toMatchObject({ response: 'yes' });
    runtime.abort(session.id);
    await runtime.resume(session.id);
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
});
