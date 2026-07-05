import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, createServerRuntime, type ServerRuntimeHandle } from '../src/server';
import { createLogger, createMemorySink } from '@nerax-ai/logger';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServerConfig } from '../src/types';
import type { AgentEvent, RuntimeAgentEventEnvelope } from '@cortx/sdk';

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
  maxSessions: 100,
};

const BASE = `http://localhost:${config.port}`;

async function waitForRuntimeEnvelope(
  handle: ServerRuntimeHandle,
  sessionId: string,
  type: AgentEvent['type'],
  timeoutMs = 1_000,
): Promise<RuntimeAgentEventEnvelope> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = handle.runtime.getEventEnvelopeHistory(sessionId).find((event) => event.event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function readFirstSseJson(
  url: string,
  headers: HeadersInit,
): Promise<{ id: string | undefined; data: RuntimeAgentEventEnvelope }> {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');

  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    ctrl.abort();
    reader.releaseLock();
  }

  const id = text.match(/(?:^|\n)id: ([^\n]+)/)?.[1];
  const data = text.match(/(?:^|\n)data: ([^\n]+)/)?.[1];
  if (!data) throw new Error(`No SSE data found in ${JSON.stringify(text)}`);
  return { id, data: JSON.parse(data) as RuntimeAgentEventEnvelope };
}

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

  test('launches an inline AgentSpec through the server endpoint', async () => {
    const res = await fetch(`${BASE}/agent-specs/launch`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: {
          name: 'server-inline-agent',
          prompt: 'hello from spec',
          toolMode: 'none',
          capabilities: { skills: false, subAgents: false, approval: false },
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.metadata).toMatchObject({ agentSpec: 'server-inline-agent' });
    await waitForRuntimeEnvelope(handle!, body.sessionId, 'done');
  });

  test('launches an AgentSpec file through the server endpoint', async () => {
    const fixtureDir = mkdtempSync(join(process.cwd(), '.tmp-cortx-server-spec-'));
    try {
      const specPath = join(fixtureDir, 'agent.json');
      writeFileSync(
        specPath,
        JSON.stringify({
          name: 'server-file-agent',
          prompt: 'hello from file',
          toolMode: 'none',
          capabilities: { skills: false, subAgents: false, approval: false },
        }),
        'utf8',
      );
      const res = await fetch(`${BASE}/agent-specs/launch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: specPath }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.session.metadata).toMatchObject({ agentSpec: 'server-file-agent' });
      await waitForRuntimeEnvelope(handle!, body.sessionId, 'done');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('AgentSpec file launch rejects paths outside allowed roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cortx-server-spec-outside-'));
    try {
      const specPath = join(outside, 'agent.json');
      writeFileSync(specPath, JSON.stringify({ prompt: 'outside' }), 'utf8');
      const res = await fetch(`${BASE}/agent-specs/launch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: specPath }),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ kind: 'invalid_workspace' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  test('create session rejects invalid runtime modes', async () => {
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolMode: 'everything' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      kind: 'invalid_request',
      details: { toolMode: 'everything' },
    });
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
    await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    await waitForRuntimeEnvelope(handle!, sessionId, 'done');

    const ctrl = new AbortController();
    const eventRes = await fetch(`${BASE}/sessions/${sessionId}/events`, {
      headers,
      signal: ctrl.signal,
    });
    expect(eventRes.status).toBe(200);
    expect(eventRes.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort();
  });

  test('SSE envelope stream replays runtime envelope ids and metadata', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    const promptRes = await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    expect(promptRes.status).toBe(200);

    await waitForRuntimeEnvelope(handle!, sessionId, 'done');
    const firstEnvelope = handle!.runtime.getEventEnvelopeHistory(sessionId)[0]!;
    const replayed = await readFirstSseJson(`${BASE}/sessions/${sessionId}/events?format=envelope`, headers);

    expect(replayed.id).toBe(String(firstEnvelope.sequence));
    expect(replayed.data).toMatchObject({
      sequence: firstEnvelope.sequence,
      sessionId,
      runId: 1,
      event: { type: firstEnvelope.event.type },
    });
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
    await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    await waitForRuntimeEnvelope(handle!, sessionId, 'done');

    const ctrl = new AbortController();
    const eventRes = await fetch(`${BASE}/sessions/${sessionId}/events?token=${token}`, {
      signal: ctrl.signal,
    });
    expect(eventRes.status).toBe(200);
    expect(eventRes.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort();
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
