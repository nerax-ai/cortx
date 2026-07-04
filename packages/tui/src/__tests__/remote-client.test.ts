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
        expect(url).toBe('http://localhost:3000/sessions/sess_remote/events?token=short-token');
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
    eventSource?.onmessage?.({ data: JSON.stringify({ type: 'text_delta', delta: 'hi' }) });
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
      'http://localhost:3000/sessions/sess_remote/events?token=near-expiry-token',
      'http://localhost:3000/sessions/sess_remote/events?token=fresh-token',
    ]);
  });
});
