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

function runtimeSession(id: string, workingDirectory = '/remote/repo') {
  return {
    id,
    createdAt: 1,
    lastActivityAt: id === 'sess_remote_b' ? 3 : 2,
    workingDirectory,
    model: 'default',
    toolMode: 'all',
    approvalMode: 'interactive',
    isRunning: false,
    eventCount: 0,
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

  test('local adapter installs, lists and enables SkillPacks from the workspace', async () => {
    const packDir = join(tmpDir, 'review-pack');
    const skillDir = join(packDir, 'skills', 'review');
    const agentsDir = join(packDir, 'agents');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(packDir, 'skill-pack.json'), JSON.stringify({ name: 'Review Pack' }), 'utf8');
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: Review changes\n---\nReview skill', 'utf8');
    writeFileSync(
      join(agentsDir, 'reviewer.json'),
      JSON.stringify({
        name: 'pack-reviewer',
        prompt: 'review with installed pack',
        toolMode: 'none',
        capabilities: { skills: false, subAgents: false, approval: false },
      }),
      'utf8',
    );
    const session = await createLocalRuntimeSession({
      language: mockLanguage(textParts('pack result')),
      model: 'default',
      workingDirectory: tmpDir,
    });

    const installed = await session.installSkillPack('review-pack');
    const packs = await session.listSkillPacks();
    const specs = await session.listAgentSpecs();
    const enabled = await session.createSession({ skillPacks: ['review-pack'] });

    expect(installed).toMatchObject({ id: 'review-pack', name: 'Review Pack' });
    expect(packs.map((pack) => pack.id)).toEqual(['review-pack']);
    expect(specs.map((spec) => spec.name)).toContain('pack-reviewer');
    expect(enabled.getInfo().skillPacks).toEqual(['review-pack']);

    session.dispose();
    enabled.dispose();
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

  test('remote adapter lists, switches and creates server-owned workspace sessions', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://server',
      apiKey: 'key',
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const method = init?.method ?? 'GET';
        calls.push({
          path,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (path === '/sessions' && method === 'GET') {
          return jsonResponse({ sessions: [runtimeSession('sess_remote_a'), runtimeSession('sess_remote_b', '/remote/other')] });
        }
        if (path === '/sessions/sess_remote_b') {
          return jsonResponse({ session: runtimeSession('sess_remote_b', '/remote/other') });
        }
        if (path === '/sessions' && method === 'POST') {
          const body = init.body ? JSON.parse(String(init.body)) : {};
          return jsonResponse({
            session: {
              ...runtimeSession(body.workingDirectory === '/remote/new' ? 'sess_new' : 'sess_remote_a', body.workingDirectory),
              model: body.model ?? 'default',
              toolMode: body.toolMode ?? 'all',
              approvalMode: body.approvalMode ?? 'interactive',
            },
          });
        }
        return jsonResponse(sessionBody());
      },
    });
    const session = await createRemoteRuntimeSession({ client, create: { workingDirectory: '/remote/repo' } });

    const listed = await session.listSessions();
    const switched = await session.switchSession('sess_remote_b');
    const created = await session.createSessionForWorkspace('/remote/new');

    expect(listed.map((item) => item.id)).toEqual(['sess_remote_a', 'sess_remote_b']);
    expect(switched.getInfo()).toMatchObject({ id: 'sess_remote_b', workingDirectory: '/remote/other' });
    expect(created.getInfo()).toMatchObject({ id: 'sess_new', workingDirectory: '/remote/new' });
    expect(calls).toEqual([
      { path: '/sessions', method: 'POST', body: { workingDirectory: '/remote/repo', metadata: { tuiMode: 'remote' } } },
      { path: '/sessions', method: 'GET', body: undefined },
      { path: '/sessions/sess_remote_b', method: 'GET', body: undefined },
      {
        path: '/sessions',
        method: 'POST',
        body: {
          workingDirectory: '/remote/new',
          model: 'default',
          toolMode: 'all',
          approvalMode: 'interactive',
          metadata: { tuiMode: 'remote' },
        },
      },
    ]);

    session.dispose();
    switched.dispose();
    created.dispose();
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

  test('remote adapter lists, installs and enables SkillPacks through the server client', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://server',
      apiKey: 'key',
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push({
          path,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (path === '/skill-packs/install') {
          return jsonResponse({
            skillPack: {
              id: 'review-pack',
              name: 'Review Pack',
              sourcePath: '/remote/repo/review-pack',
              installedAt: 2,
              path: '/remote/repo/review-pack',
              skillPaths: ['/remote/repo/review-pack/skills'],
              agentSpecPaths: ['/remote/repo/review-pack/agents'],
            },
          });
        }
        if (path === '/skill-packs') {
          return jsonResponse({
            skillPacks: [
              {
                id: 'review-pack',
                name: 'Review Pack',
                sourcePath: '/remote/repo/review-pack',
                installedAt: 1,
                path: '/remote/repo/review-pack',
                skillPaths: ['/remote/repo/review-pack/skills'],
                agentSpecPaths: ['/remote/repo/review-pack/agents'],
              },
            ],
          });
        }
        if (path === '/sessions' && init?.method === 'POST') {
          const body = init.body ? JSON.parse(String(init.body)) : {};
          return jsonResponse({
            session: {
              id: body.skillPacks ? 'sess_pack' : 'sess_remote',
              createdAt: 1,
              lastActivityAt: 2,
              workingDirectory: body.workingDirectory ?? '/remote/repo',
              model: body.model ?? 'default',
              toolMode: body.toolMode ?? 'all',
              approvalMode: body.approvalMode ?? 'interactive',
              skillPacks: body.skillPacks,
              isRunning: false,
              eventCount: 0,
            },
          });
        }
        return jsonResponse(sessionBody());
      },
    });
    const session = await createRemoteRuntimeSession({ client, create: { workingDirectory: '/remote/repo' } });

    const packs = await session.listSkillPacks();
    const installed = await session.installSkillPack('review-pack', 'review-pack');
    const enabled = await session.createSession({ skillPacks: ['review-pack'] });

    expect(packs.map((pack) => pack.id)).toEqual(['review-pack']);
    expect(installed).toMatchObject({ id: 'review-pack', installedAt: 2 });
    expect(enabled.getInfo()).toMatchObject({ id: 'sess_pack', skillPacks: ['review-pack'] });
    expect(calls).toEqual([
      { path: '/sessions', method: 'POST', body: { workingDirectory: '/remote/repo', metadata: { tuiMode: 'remote' } } },
      { path: '/skill-packs', method: 'GET', body: undefined },
      { path: '/skill-packs/install', method: 'POST', body: { path: 'review-pack', id: 'review-pack' } },
      {
        path: '/sessions',
        method: 'POST',
        body: {
          workingDirectory: '/remote/repo',
          model: 'default',
          toolMode: 'all',
          approvalMode: 'interactive',
          skillPacks: ['review-pack'],
          metadata: { tuiMode: 'remote' },
        },
      },
    ]);

    session.dispose();
    enabled.dispose();
  });
});
