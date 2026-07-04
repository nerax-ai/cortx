import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent } from '@cortx/sdk';
import { CortxRuntime, MemoryDurableRunStore } from '../src/index';

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
    first.dispose();
    second.dispose();
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
    runtime.dispose();
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
