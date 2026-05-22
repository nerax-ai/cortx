import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../src/server';
import { SessionManager } from '../src/session-manager';
import { createLogger, createMemorySink } from '@nerax-ai/logger';
import { PluginRegistry } from '@nerax-ai/plugin';
import type { ServerConfig } from '../src/types';
import type { AgentEvent } from '@cortx/sdk';
import type { CortxPlugin } from '@cortx/core';

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

  beforeAll(() => {
    const app = createServer(config);
    server = Bun.serve({ port: config.port, fetch: app.fetch });
  });

  afterAll(() => {
    server?.stop();
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
    const { sessionId } = await createRes.json() as { sessionId: string };

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
    const { sessionId } = await createRes.json() as { sessionId: string };

    const res = await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('SSE stream returns event-stream content type', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = await createRes.json() as { sessionId: string };

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
    const { sessionId } = await createRes.json() as { sessionId: string };

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
    const body = await res.json() as { token: string; expiresAt: number };
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
    const { sessionId } = await createRes.json() as { sessionId: string };

    const res = await fetch(`${BASE}/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc_1', response: 'yes' }),
    });
    expect(res.status).toBe(200);
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
});

describe('SessionManager', () => {
  test('passes configured registry plugins into managed sessions', async () => {
    PluginRegistry.reset();
    let pluginSawDone = false;
    const registry = PluginRegistry.getInstance<'cortx', { cortx: () => CortxPlugin }>({ appName: 'session-manager-plugin-test' });
    await registry.register({
      manifest: { manifestVersion: 1, id: 'session-plugin', name: 'session-plugin', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx) {
        ctx.register('cortx', 'event-plugin', () => ({
          event(event) {
            if (event.type === 'done') pluginSawDone = true;
          },
        }));
      },
    });

    const manager = new SessionManager({
      registry,
      plugins: [{ use: 'event-plugin' }],
      language: mockLanguageClient(),
      model: 'test-model',
      logger: createLogger({ appName: 'session-manager-plugin-test', console: false }),
    });
    const created = await manager.create();
    if ('error' in created) throw new Error(created.error);

    expect(await manager.prompt(created.id, 'hello')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(pluginSawDone).toBe(true);
    manager.dispose();
    PluginRegistry.reset();
  });

  test('stream failures are broadcast with real Error instances', async () => {
    PluginRegistry.reset();
    const manager = new SessionManager({
      registry: PluginRegistry.getInstance({ appName: 'session-manager-test' }),
      language: {
        stream: async function* () {
          const error = new Error('stream failed') as Error & { statusCode?: number };
          error.statusCode = 400;
          throw error;
        },
      } as any,
      model: 'test-model',
      logger: createLogger({ appName: 'session-manager-test', console: false }),
    });
    const created = await manager.create();
    if ('error' in created) throw new Error(created.error);
    const events: AgentEvent[] = [];
    manager.subscribe(created.id, (event) => events.push(event));

    expect(await manager.prompt(created.id, 'hello')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 100));

    const errorEvent = events.find((event) => event.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
    expect(errorEvent.error).toBeInstanceOf(Error);
    expect(errorEvent.error.message).toBe('stream failed');
    manager.dispose();
    PluginRegistry.reset();
  });
});
