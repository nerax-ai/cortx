import { describe, expect, test } from 'bun:test';
import { RemoteRuntimeClient, RemoteRuntimeError, type EventSourceLike } from '../remote-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('RemoteRuntimeClient', () => {
  test('creates sessions and sends runtime actions with bearer auth', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'test-key',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/sessions')) {
          return jsonResponse({
            session: {
              id: 'sess_remote',
              createdAt: 1,
              lastActivityAt: 1,
              workingDirectory: '/repo',
              model: 'default',
              toolMode: 'all',
              approvalMode: 'interactive',
              isRunning: false,
              eventCount: 0,
            },
          });
        }
        if (String(url).endsWith('/sessions/sess_remote')) {
          return jsonResponse({
            session: {
              id: 'sess_remote',
              createdAt: 1,
              lastActivityAt: 2,
              workingDirectory: '/repo',
              model: 'default',
              toolMode: 'all',
              approvalMode: 'interactive',
              isRunning: true,
              eventCount: 1,
            },
          });
        }
        return jsonResponse({ ok: true });
      },
    });

    const session = await client.createSession({ workingDirectory: '/repo' });
    await client.prompt(session.id, 'hello');
    await client.steer(session.id, 'steer');
    await client.followUp(session.id, 'more');
    await client.answer(session.id, 'tc_1', 'yes');
    await client.abort(session.id);
    await client.resume(session.id);
    const refreshed = await client.getSession(session.id);

    expect(refreshed.isRunning).toBe(true);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/sessions',
      '/sessions/sess_remote/prompt',
      '/sessions/sess_remote/steer',
      '/sessions/sess_remote/follow-up',
      '/sessions/sess_remote/answer',
      '/sessions/sess_remote/abort',
      '/sessions/sess_remote/resume',
      '/sessions/sess_remote',
    ]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer test-key');
    }
  });

  test('lists runtime sessions through the remote server contract', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'test-key',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          sessions: [
            {
              id: 'sess_a',
              createdAt: 1,
              lastActivityAt: 3,
              workingDirectory: '/repo-a',
              model: 'default',
              toolMode: 'all',
              approvalMode: 'interactive',
              isRunning: false,
              eventCount: 2,
            },
            {
              id: 'sess_b',
              createdAt: 2,
              lastActivityAt: 4,
              workingDirectory: '/repo-b',
              model: 'default',
              toolMode: 'read-only',
              approvalMode: 'deny',
              isRunning: true,
              eventCount: 5,
            },
          ],
        });
      },
    });

    const sessions = await client.listSessions();

    expect(sessions.map((session) => session.id)).toEqual(['sess_a', 'sess_b']);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe('/sessions');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer test-key');
  });

  test('launches AgentSpec assets through the remote server contract', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'test-key',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          session: {
            id: 'sess_spec',
            createdAt: 1,
            lastActivityAt: 2,
            workingDirectory: '/repo',
            model: 'default',
            toolMode: 'read-only',
            approvalMode: 'deny',
            isRunning: true,
            eventCount: 1,
            metadata: { agentSpec: 'reviewer' },
          },
        });
      },
    });

    const session = await client.launchAgentSpec({ path: 'examples/skill-packs/basic/agents/reviewer.json' });

    expect(session).toMatchObject({
      id: 'sess_spec',
      metadata: { agentSpec: 'reviewer' },
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe('/agent-specs/launch');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      path: 'examples/skill-packs/basic/agents/reviewer.json',
    });
  });

  test('lists AgentSpec assets through the remote server contract', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'test-key',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          agentSpecs: [
            {
              name: 'reviewer',
              path: '/repo/agents/reviewer.json',
              relativePath: 'agents/reviewer.json',
              sourceRoot: '/repo',
              promptPreview: 'Review current changes',
              toolMode: 'read-only',
              approvalMode: 'deny',
            },
          ],
        });
      },
    });

    const specs = await client.listAgentSpecs();

    expect(specs).toEqual([
      expect.objectContaining({
        name: 'reviewer',
        path: '/repo/agents/reviewer.json',
        promptPreview: 'Review current changes',
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe('/agent-specs');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer test-key');
  });

  test('lists and installs SkillPacks through the remote server contract', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'test-key',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/skill-packs/install')) {
          return jsonResponse({
            skillPack: {
              id: 'review-pack',
              name: 'Review Pack',
              sourcePath: '/repo/review-pack',
              installedAt: 2,
              path: '/repo/review-pack',
              skillPaths: ['/repo/review-pack/skills'],
              agentSpecPaths: ['/repo/review-pack/agents'],
            },
          });
        }
        return jsonResponse({
          skillPacks: [
            {
              id: 'review-pack',
              name: 'Review Pack',
              sourcePath: '/repo/review-pack',
              installedAt: 1,
              path: '/repo/review-pack',
              skillPaths: ['/repo/review-pack/skills'],
              agentSpecPaths: ['/repo/review-pack/agents'],
            },
          ],
        });
      },
    });

    const packs = await client.listSkillPacks();
    const installed = await client.installSkillPack({ path: 'review-pack', id: 'review-pack' });

    expect(packs).toEqual([expect.objectContaining({ id: 'review-pack', name: 'Review Pack' })]);
    expect(installed).toMatchObject({ id: 'review-pack', installedAt: 2 });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/skill-packs', '/skill-packs/install']);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ path: 'review-pack', id: 'review-pack' });
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer test-key');
    }
  });

  test('throws typed remote errors from server error bodies', async () => {
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      fetch: async () => jsonResponse({ error: 'outside root', kind: 'invalid_workspace' }, { status: 400 }),
    });

    await expect(client.createSession({ workingDirectory: '/etc' })).rejects.toBeInstanceOf(RemoteRuntimeError);
    await expect(client.createSession({ workingDirectory: '/etc' })).rejects.toMatchObject({
      status: 400,
      kind: 'invalid_workspace',
    });
  });

  test('connects SSE with a short-lived token and dispatches parsed events', async () => {
    let eventSource: EventSourceLike | undefined;
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      fetch: async (url) => {
        expect(String(url)).toBe('http://localhost:3000/auth/token');
        return jsonResponse({ token: 'short-token', expiresAt: Date.now() + 60_000 });
      },
      eventSourceFactory: (url) => {
        expect(url).toBe('http://localhost:3000/sessions/sess_remote/events?format=envelope&token=short-token');
        eventSource = {
          onmessage: null,
          onerror: null,
          close() {},
        };
        return eventSource;
      },
    });

    const events: string[] = [];
    const unsubscribe = await client.connectEvents('sess_remote', (event) => events.push(event.type));
    eventSource?.onmessage?.({
      data: JSON.stringify({
        sequence: 1,
        timestamp: 100,
        sessionId: 'sess_remote',
        runId: 1,
        event: { type: 'text_delta', delta: 'hi' },
      }),
    });
    eventSource?.onmessage?.({
      data: JSON.stringify({
        sequence: 1,
        timestamp: 100,
        sessionId: 'sess_remote',
        runId: 1,
        event: { type: 'text_delta', delta: 'duplicate' },
      }),
    });
    eventSource?.onmessage?.({ data: '{}' });
    unsubscribe();

    expect(events).toEqual(['text_delta']);
  });

  test('refreshes a near-expiry short-lived token before reconnecting SSE', async () => {
    const tokens = [
      { token: 'near-expiry-token', expiresAt: Date.now() + 1_000 },
      { token: 'fresh-token', expiresAt: Date.now() + 60_000 },
    ];
    const eventUrls: string[] = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      fetch: async () => jsonResponse(tokens.shift()),
      eventSourceFactory: (url) => {
        eventUrls.push(url);
        return {
          onmessage: null,
          onerror: null,
          close() {},
        };
      },
    });

    const unsubscribeFirst = await client.connectEvents('sess_remote', () => {});
    unsubscribeFirst();
    const unsubscribeSecond = await client.connectEvents('sess_remote', () => {});
    unsubscribeSecond();

    expect(eventUrls).toEqual([
      'http://localhost:3000/sessions/sess_remote/events?format=envelope&token=near-expiry-token',
      'http://localhost:3000/sessions/sess_remote/events?format=envelope&token=fresh-token',
    ]);
  });
});
