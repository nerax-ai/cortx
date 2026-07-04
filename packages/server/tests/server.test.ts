import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, createServerRuntime, type ServerRuntimeHandle } from '../src/server';
import { createLogger, createMemorySink } from '@nerax-ai/logger';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServerConfig } from '../src/types';

// Mock language client that yields a simple response
function mockLanguageClient() {
  return {
    stream: async function* (opts: any): AsyncGenerator<any> {
      yield { type: 'text-delta', delta: 'Hello!' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } };
    },
  } as any;
}

const config: ServerConfig = {
  apiKey: 'test-key-123',
  port: 3999,
  host: 'localhost',
  language: mockLanguageClient(),
  model: 'test-model',
};

const BASE = `http://localhost:${config.port}`;

describe('server routes', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let handle: ServerRuntimeHandle | undefined;

  beforeAll(() => {
    handle = createServerRuntime(config);
    server = Bun.serve({ port: config.port, fetch: handle.app.fetch });
  });

  afterAll(() => {
    server?.stop();
    handle?.dispose();
  });

  const headers = { Authorization: 'Bearer test-key-123' };

  test('health check returns ok without auth', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('unauthorized request returns 401', async () => {
    const res = await fetch(`${BASE}/sessions`);
    expect(res.status).toBe(401);
  });

  test('create session', async () => {
    const res = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.session.workingDirectory).toBeTruthy();
  });

  test('create session accepts a working directory body', async () => {
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDirectory: '.', metadata: { source: 'test' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.session.metadata).toMatchObject({ source: 'test' });
  });

  test('create session rejects invalid JSON body', async () => {
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.kind).toBe('invalid_request');
  });

  test('create session rejects workspaces outside allowed roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cortx-server-outside-'));
    try {
      const res = await fetch(`${BASE}/sessions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: outside }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.kind).toBe('invalid_workspace');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('list sessions', async () => {
    // Create a session first
    await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const res = await fetch(`${BASE}/sessions`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
  });

  test('send prompt to session', async () => {
    // Create session
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Send prompt
    const promptRes = await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    expect(promptRes.status).toBe(200);
    const body = await promptRes.json();
    expect(body.ok).toBe(true);
  });

  test('prompt to non-existent session returns 404', async () => {
    const res = await fetch(`${BASE}/sessions/nonexistent/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(res.status).toBe(404);
  });

  test('prompt with empty message returns 400', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const res = await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('message action endpoints return typed invalid_request for invalid bodies', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    for (const action of ['prompt', 'steer', 'follow-up'] as const) {
      const invalidJson = await fetch(`${BASE}/sessions/${sessionId}/${action}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(invalidJson.status).toBe(400);
      await expect(invalidJson.json()).resolves.toMatchObject({ kind: 'invalid_request' });

      const invalidMessage = await fetch(`${BASE}/sessions/${sessionId}/${action}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { text: 'hello' } }),
      });
      expect(invalidMessage.status).toBe(400);
      await expect(invalidMessage.json()).resolves.toMatchObject({
        kind: 'invalid_request',
        error: 'message must be a string',
      });
    }
  });

  test('SSE stream returns event-stream content type', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Abort after getting headers to prevent hanging on infinite stream
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);

    try {
      const eventRes = await fetch(`${BASE}/sessions/${sessionId}/events`, {
        headers,
        signal: ctrl.signal,
      });
      expect(eventRes.status).toBe(200);
      expect(eventRes.headers.get('content-type')).toContain('text/event-stream');
    } catch (e) {
      // AbortError is expected — the stream was intentionally cut
      expect((e as Error).name).toBe('AbortError');
    }
  });

  test('delete session', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const res = await fetch(`${BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers,
    });
    expect(res.status).toBe(200);
  });

  test('delete non-existent session returns 404', async () => {
    const res = await fetch(`${BASE}/sessions/nonexistent`, {
      method: 'DELETE',
      headers,
    });
    expect(res.status).toBe(404);
  });

  test('token exchange returns valid token', async () => {
    const res = await fetch(`${BASE}/auth/token`, {
      method: 'POST',
      headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    expect(body.token).toBeTruthy();
    expect(body.expiresAt).toBeGreaterThan(Date.now() - 1000);
  });

  test('token exchange rejects invalid key', async () => {
    const res = await fetch(`${BASE}/auth/token`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  test('answer endpoint works', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const res = await fetch(`${BASE}/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc_1', response: 'yes' }),
    });
    expect(res.status).toBe(200);
  });

  test('steer, follow-up, resume and abort endpoints route to runtime', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    for (const [path, body] of [
      ['steer', { message: 'use this instruction' }],
      ['follow-up', { message: 'then do this' }],
      ['resume', undefined],
      ['abort', undefined],
    ] as const) {
      const res = await fetch(`${BASE}/sessions/${sessionId}/${path}`, {
        method: 'POST',
        headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    }
  });

  test('SSE stream accepts short-lived token', async () => {
    const tokenRes = await fetch(`${BASE}/auth/token`, { method: 'POST', headers });
    const { token } = (await tokenRes.json()) as { token: string };
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);

    try {
      const eventRes = await fetch(`${BASE}/sessions/${sessionId}/events?token=${token}`, {
        signal: ctrl.signal,
      });
      expect(eventRes.status).toBe(200);
      expect(eventRes.headers.get('content-type')).toContain('text/event-stream');
    } catch (e) {
      expect((e as Error).name).toBe('AbortError');
    }
  });
});

describe('server logging', () => {
  test('network binding warning goes through configured logger', async () => {
    const sink = createMemorySink();
    const logger = createLogger({ appName: 'server-test', console: false, sinks: [sink] });
    createServer({
      ...config,
      host: '0.0.0.0',
      logger,
    });
    await logger.flush();

    expect(sink.records.some((record) => record.message.includes('Binding to 0.0.0.0'))).toBe(true);
  });

  test('createServerRuntime exposes a disposable runtime handle for embedded hosts', () => {
    const handle = createServerRuntime(config);
    expect(typeof handle.app.fetch).toBe('function');
    expect(handle.runtime.listSessions()).toEqual([]);
    handle.dispose();
    expect(handle.runtime.listSessions()).toEqual([]);
  });
});
