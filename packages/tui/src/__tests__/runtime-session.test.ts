import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentEvent } from '@cortx/sdk';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import { RemoteRuntimeClient, type EventSourceLike } from '../remote-client.js';
import { createLocalRuntimeSession, createRemoteRuntimeSession } from '../runtime-session.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-tui-runtime-session-'));
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

function mockLanguage(parts: LanguageStreamPart[]): LanguageClient {
  return {
    stream: async function* () {
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type']): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1_000) {
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function sessionBody(isRunning = false) {
  return {
    session: {
      id: 'sess_remote',
      createdAt: 1,
      lastActivityAt: 1,
      workingDirectory: '/remote/repo',
      model: 'default',
      toolMode: 'all',
      approvalMode: 'interactive',
      isRunning,
      eventCount: 0,
    },
  };
}

describe('TUI runtime session adapters', () => {
  test('local adapter embeds runtime and streams events to the existing TUI store path', async () => {
    const session = await createLocalRuntimeSession({
      language: mockLanguage(textParts('local result')),
      model: 'default',
      maxIterations: 9,
      workingDirectory: tmpDir,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.prompt('hello');
    await waitForEvent(events, 'done');
    session.steer('prefer tests');
    session.followUp('add coverage');
    session.answerUser('question-1', 'yes');

    expect(session.mode).toBe('local');
    expect(session.supportsMessageRestore).toBe(true);
    expect(session.getInfo()).toMatchObject({
      workingDirectory: tmpDir,
      model: 'default',
      maxIterations: 9,
      toolMode: 'all',
      approvalMode: 'interactive',
      isRunning: false,
    });
    expect(events.map((event) => event.type)).toContain('text_delta');
    expect(events.find((event) => event.type === 'user_answer')).toMatchObject({ response: 'yes' });

    unsubscribe();
    session.dispose();
  });

  test('local adapter lists and launches AgentSpec assets from the workspace', async () => {
    const agentsDir = join(tmpDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'reviewer.json'),
      JSON.stringify({
        name: 'reviewer',
        prompt: 'review with tui',
        toolMode: 'none',
        capabilities: { skills: false, subAgents: false, approval: false },
      }),
      'utf8',
    );
    const session = await createLocalRuntimeSession({
      language: mockLanguage(textParts('agent spec result')),
      model: 'default',
      workingDirectory: tmpDir,
    });

    const specs = await session.listAgentSpecs();
    const launched = await session.launchAgentSpec('reviewer');
    const events: AgentEvent[] = [];
    const unsubscribe = launched.subscribe((event) => events.push(event));
    await waitForEvent(events, 'done');

    expect(specs).toEqual([
      expect.objectContaining({
        name: 'reviewer',
        path: join(agentsDir, 'reviewer.json'),
      }),
    ]);
    expect(launched.getInfo().metadata).toMatchObject({ agentSpec: 'reviewer' });

    unsubscribe();
    session.dispose();
    launched.dispose();
  });

  test('remote adapter uses server actions and SSE while keeping restore server-owned', async () => {
    const calls: string[] = [];
    let eventSource: EventSourceLike | undefined;
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://server',
      apiKey: 'key',
      fetch: async (url) => {
        calls.push(new URL(String(url)).pathname);
        if (String(url).endsWith('/auth/token')) return jsonResponse({ token: 'short-token' });
        if (String(url).endsWith('/sessions')) return jsonResponse(sessionBody());
        if (String(url).endsWith('/sessions/sess_remote')) return jsonResponse(sessionBody(true));
        return jsonResponse({ ok: true });
      },
      eventSourceFactory: (url) => {
        expect(url).toBe('http://server/sessions/sess_remote/events?token=short-token');
        eventSource = { onmessage: null, onerror: null, close() {} };
        return eventSource;
      },
    });

    const session = await createRemoteRuntimeSession({
      client,
      create: { workingDirectory: '/remote/repo', model: 'default' },
    });
    const events: AgentEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    eventSource?.onmessage?.({ data: JSON.stringify({ type: 'turn_start', iteration: 1 }) });

    await session.prompt('hello');
    await session.steer('steer');
    await session.followUp('more');
    await session.answerUser('tc_1', 'yes');
    await session.abort('stop');
    await session.resume();

    expect(session.mode).toBe('remote');
    expect(session.supportsMessageRestore).toBe(false);
    expect(session.getAgentMessages()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['turn_start']);
    expect(calls).toEqual([
      '/sessions',
      '/auth/token',
      '/sessions/sess_remote/prompt',
      '/sessions/sess_remote',
      '/sessions/sess_remote/steer',
      '/sessions/sess_remote/follow-up',
      '/sessions/sess_remote/answer',
      '/sessions/sess_remote/abort',
      '/sessions/sess_remote',
      '/sessions/sess_remote/resume',
      '/sessions/sess_remote',
    ]);

    unsubscribe();
    session.dispose();
  });

  test('remote adapter lists and launches AgentSpec assets through the server client', async () => {
    const calls: string[] = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://server',
      apiKey: 'key',
      fetch: async (url, init) => {
        calls.push(`${new URL(String(url)).pathname}:${init?.method ?? 'GET'}`);
        if (String(url).endsWith('/agent-specs')) {
          return jsonResponse({
            agentSpecs: [
              {
                name: 'reviewer',
                path: '/repo/agents/reviewer.json',
                relativePath: 'agents/reviewer.json',
                sourceRoot: '/repo',
                promptPreview: 'Review current changes',
              },
            ],
          });
        }
        if (String(url).endsWith('/agent-specs/launch')) {
          return jsonResponse({
            session: {
              id: 'sess_spec',
              createdAt: 1,
              lastActivityAt: 2,
              workingDirectory: '/remote/repo',
              model: 'default',
              toolMode: 'read-only',
              approvalMode: 'deny',
              isRunning: true,
              eventCount: 1,
              metadata: { agentSpec: 'reviewer' },
            },
          });
        }
        return jsonResponse(sessionBody());
      },
    });
    const session = await createRemoteRuntimeSession({ client, create: { workingDirectory: '/remote/repo' } });

    const specs = await session.listAgentSpecs();
    const launched = await session.launchAgentSpec('agents/reviewer.json');

    expect(specs).toEqual([
      expect.objectContaining({
        name: 'reviewer',
        relativePath: 'agents/reviewer.json',
      }),
    ]);
    expect(launched.getInfo()).toMatchObject({
      id: 'sess_spec',
      metadata: { agentSpec: 'reviewer' },
    });
    expect(calls).toEqual([
      '/sessions:POST',
      '/agent-specs:GET',
      '/agent-specs:GET',
      '/agent-specs/launch:POST',
    ]);

    session.dispose();
    launched.dispose();
  });
});
