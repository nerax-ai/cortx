import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@cortx/sdk';
import { CortxRuntime } from '@cortx/runtime';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import { RemoteRuntimeClient } from '../remote-client.js';
import { createLocalRuntimeSession, createRemoteRuntimeSession } from '../runtime-session.js';

let temporaryDirectory: string;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'cortx-tui-runtime-session-'));
});

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function language(text = 'local result'): LanguageClient {
  const parts: LanguageStreamPart[] = [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, reasoning: undefined },
      },
    },
  ];
  return {
    stream: async function* () { for (const part of parts) yield part; },
  } as unknown as LanguageClient;
}

function createRuntime(): CortxRuntime {
  return new CortxRuntime({
    language: language(),
    model: 'default',
    maxIterations: 9,
    defaultWorkingDirectory: temporaryDirectory,
    allowedWorkspaceRoots: [temporaryDirectory],
    toolMode: 'none',
    approvalMode: 'interactive',
  });
}

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type']): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === type)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function runtimeSession(id: string, workingDirectory = '/remote/repo') {
  return {
    id,
    createdAt: 1,
    lastActivityAt: id === 'sess_b' ? 3 : 2,
    workingDirectory,
    model: 'default',
    toolMode: 'none',
    approvalMode: 'interactive',
    capabilities: { skills: true, subAgents: true, approval: true },
    isRunning: false,
    eventCount: 0,
  };
}

function sseResponse(event: AgentEvent): Response {
  const envelope = {
    sequence: 1,
    timestamp: 1,
    sessionId: 'sess_remote',
    runId: 1,
    event,
  };
  return new Response(`data: ${JSON.stringify(envelope)}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('TUI runtime session adapters', () => {
  test('local adapter borrows Runtime and closes only its subscriptions', async () => {
    const runtime = createRuntime();
    const session = await createLocalRuntimeSession({
      runtime,
      create: { workingDirectory: temporaryDirectory, model: 'default', toolMode: 'none' },
    });
    const events: AgentEvent[] = [];
    const subscription = session.subscribe((event) => events.push(event));

    await session.prompt('hello');
    await waitForEvent(events, 'done');
    expect(events.map((event) => event.type)).toContain('text_delta');
    expect(session.getInfo()).toMatchObject({ workingDirectory: temporaryDirectory, model: 'default' });

    await subscription.close();
    await session.close();
    const stillAvailable = await runtime.createSession({ workingDirectory: temporaryDirectory, model: 'default' });
    expect(stillAvailable.id).toStartWith('sess_');
    await runtime.close();
  });

  test('local adapter lists and launches AgentSpecs through the borrowed Runtime', async () => {
    const agentsDirectory = join(temporaryDirectory, 'agents');
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(join(agentsDirectory, 'reviewer.json'), JSON.stringify({
      name: 'reviewer',
      prompt: 'review with tui',
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    }));
    const runtime = createRuntime();
    const session = await createLocalRuntimeSession({ runtime, create: { workingDirectory: temporaryDirectory } });

    const specs = await session.listAgentSpecs();
    const launched = await session.launchAgentSpec('reviewer');
    expect(specs.map((spec) => spec.name)).toContain('reviewer');
    expect(launched.getInfo().metadata).toMatchObject({ agentSpec: 'reviewer' });

    await session.close();
    await launched.close();
    await runtime.close();
  });

  test('remote adapter streams through the Header-authenticated client and keeps restore server-owned', async () => {
    const calls: string[] = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'https://server.test',
      apiKey: 'key',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${url.pathname}:${init?.method ?? 'GET'}`);
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key');
        if (url.pathname.endsWith('/events')) return sseResponse({ type: 'turn_start', iteration: 1 });
        if (url.pathname === '/sessions' && init?.method === 'POST') return jsonResponse({ session: runtimeSession('sess_remote') });
        if (url.pathname === '/sessions/sess_remote') return jsonResponse({ session: runtimeSession('sess_remote') });
        return jsonResponse({ ok: true });
      },
    });
    const session = await createRemoteRuntimeSession({ client, create: { workingDirectory: '/remote/repo' } });
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitForEvent(events, 'turn_start');

    await session.prompt('hello');
    await session.steer('steer');
    await session.followUp('more');
    await session.answerUser('tc_1', 'yes');
    await session.abort('stop');
    await session.resume();

    expect(session.supportsMessageRestore).toBe(false);
    expect(session.getAgentMessages()).toEqual([]);
    expect(calls).toContain('/sessions/sess_remote/events:GET');
    await session.close();
    await client.close();
  });

  test('remote adapter lists, switches and creates sessions without a local ProjectDomain', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'https://server.test',
      apiKey: 'key',
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (path === '/sessions' && method === 'GET') return jsonResponse({ sessions: [runtimeSession('sess_remote'), runtimeSession('sess_b')] });
        if (path === '/sessions' && method === 'POST') return jsonResponse({ session: runtimeSession('sess_created', '/remote/other') });
        if (path === '/sessions/sess_b') return jsonResponse({ session: runtimeSession('sess_b') });
        return jsonResponse({ session: runtimeSession('sess_remote') });
      },
    });
    const session = await createRemoteRuntimeSession({ client, sessionId: 'sess_remote' });
    const listed = await session.listSessions();
    const switched = await session.switchSession('sess_b');
    const created = await session.createSessionForWorkspace('/remote/other');

    expect(listed.map((item) => item.id)).toEqual(['sess_remote', 'sess_b']);
    expect(switched.getInfo().id).toBe('sess_b');
    expect(created.getInfo()).toMatchObject({ id: 'sess_created', workingDirectory: '/remote/other' });
    expect(calls.some((call) => call.path === '/sessions' && call.method === 'POST')).toBe(true);

    await session.close();
    await switched.close();
    await created.close();
    await client.close();
  });
});
