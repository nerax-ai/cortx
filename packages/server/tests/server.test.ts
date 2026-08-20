import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  MemoryPluginSecretsBackend,
  createMemoryPluginRuntimeDomain,
} from '@nerax-ai/plugin';
import { ProjectDomain } from '@cortx/runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerRuntime, type ServerRuntimeHandle } from '../src/server';
import type { ServerConfig } from '../src/types';

let root: string;
let projectDomain: ProjectDomain;
let handle: ServerRuntimeHandle;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cortx-server-routes-'));
  projectDomain = new ProjectDomain({
    domain: createMemoryPluginRuntimeDomain({
      runtimeDomainId: `server-routes:${crypto.randomUUID()}`,
      root,
      secretsBackend: new MemoryPluginSecretsBackend('server-routes-test'),
    }),
  });
  await projectDomain.start();
  handle = createServerRuntime(config(projectDomain, root));
});

afterEach(async () => {
  await handle.close();
  await projectDomain.close();
  rmSync(root, { recursive: true, force: true });
});

describe('server routes', () => {
  test('serves health locally and requires header authentication elsewhere', async () => {
    const health = await request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', sessions: 0, runningSessions: 0 });

    expect((await request('/sessions')).status).toBe(401);
    expect((await request('/sessions?token=root-key', { headers: rootHeaders() })).status).toBe(400);
    expect((await request('/auth/token', { method: 'POST', headers: rootHeaders() })).status).toBe(404);
  });

  test('creates, updates, lists, gets, and deletes a creator-owned session', async () => {
    const created = await request('/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ metadata: { source: 'route-test' } }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { sessionId: string; session: { creatorPrincipalId: string } };
    expect(session.session.creatorPrincipalId).toBe('default');

    const updated = await request(`/sessions/${session.sessionId}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ model: 'reasoning-model', reasoningEffort: 'high', approvalMode: 'deny' }),
    });
    expect(await updated.json()).toMatchObject({
      session: { id: session.sessionId, model: 'reasoning-model', reasoningEffort: 'high', approvalMode: 'deny' },
    });

    expect(await (await request('/sessions', { headers: rootHeaders() })).json()).toMatchObject({
      sessions: [expect.objectContaining({ id: session.sessionId })],
    });
    expect((await request(`/sessions/${session.sessionId}`, { headers: rootHeaders() })).status).toBe(200);
    expect((await request(`/sessions/${session.sessionId}`, { method: 'DELETE', headers: rootHeaders() })).status).toBe(200);
    expect((await request(`/sessions/${session.sessionId}`, { headers: rootHeaders() })).status).toBe(404);
  });

  test('runs a prompt and exposes bounded envelope history', async () => {
    const created = await request('/sessions', { method: 'POST', headers: rootHeaders() });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const prompt = await request(`/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    expect(prompt.status).toBe(200);
    await waitFor(() => handle.runtime.getEventEnvelopeHistory(sessionId).some((event) => event.event.type === 'done'));

    const history = await request(`/sessions/${sessionId}/events/history?format=envelope&limit=2`, {
      headers: rootHeaders(),
    });
    const body = (await history.json()) as { events: Array<{ sessionId: string }>; page: { lastSequence?: number } };
    expect(body.events.length).toBeLessThanOrEqual(2);
    expect(body.events.at(-1)?.sessionId).toBe(sessionId);
    expect(body.page.lastSequence).toBeNumber();
  });

  test('forwards command identity and Runtime incarnation to the idempotent mutation boundary', async () => {
    const created = await request('/sessions', { method: 'POST', headers: rootHeaders() });
    const { sessionId, session } = (await created.json()) as {
      sessionId: string;
      session: { runtimeIncarnation: string };
    };
    const command = {
      message: 'Exactly once',
      commandId: 'command-once',
      expectedRuntimeIncarnation: session.runtimeIncarnation,
    };

    expect((await request(`/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(command),
    })).status).toBe(200);
    expect((await request(`/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(command),
    })).status).toBe(200);
    expect(handle.runtime.getEventEnvelopeHistory(sessionId).filter((event) => event.event.type === 'user_message')).toHaveLength(1);

    const conflict = await request(`/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...command, message: 'Different payload' }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ kind: 'conflict' });

    const staleRuntime = await request(`/sessions/${sessionId}/abort`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ commandId: 'stale-abort', expectedRuntimeIncarnation: 'stale-runtime' }),
    });
    expect(staleRuntime.status).toBe(409);
    expect(await staleRuntime.json()).toMatchObject({ kind: 'conflict' });
  });

  test('streams session events with header authentication', async () => {
    const created = await request('/sessions', { method: 'POST', headers: rootHeaders() });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await request(`/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ message: 'Stream this' }),
    });
    await waitFor(() => handle.runtime.getEventEnvelopeHistory(sessionId).some((event) => event.event.type === 'done'));

    const controller = new AbortController();
    const response = await request(`/sessions/${sessionId}/events?format=envelope`, {
      headers: rootHeaders(),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    expect(new TextDecoder().decode(first.value)).toContain('data:');
  });

  test('offers explicit framed replay completion for gap-aware clients', async () => {
    const created = await request('/sessions', { method: 'POST', headers: rootHeaders() });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await request(`/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ message: 'Frame this', commandId: 'framed-prompt' }),
    });
    await waitFor(() => handle.runtime.getEventEnvelopeHistory(sessionId).some((event) => event.event.type === 'done'));

    const controller = new AbortController();
    const response = await request(`/sessions/${sessionId}/events?format=envelope&protocol=frames`, {
      headers: rootHeaders(),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('replay-complete')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
    expect(text).toContain('"type":"durable-event"');
    expect(text).toContain('"type":"replay-complete"');
  });

  test('validates JSON, models, workspaces, and profile aliases', async () => {
    expect((await request('/sessions', { method: 'POST', headers: jsonHeaders(), body: '{' })).status).toBe(400);
    const models = await request('/models', { headers: rootHeaders() });
    expect(await models.json()).toMatchObject({
      models: [
        expect.objectContaining({ id: 'test-model', contextWindowTokens: 1000 }),
        expect.objectContaining({ id: 'reasoning-model' }),
      ],
    });
    const directory = await request(`/workspaces/directories?path=${encodeURIComponent(root)}`, { headers: rootHeaders() });
    expect(await directory.json()).toMatchObject({ current: root });

    const created = await request('/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ toolMode: 'none', workingDirectory: root }),
    });
    expect(await created.json()).toMatchObject({
      session: { toolMode: '@cortx-ai/workspace-tools/none', workingDirectory: root },
    });
  });
});

function config(project: ProjectDomain, workingDirectory: string): ServerConfig {
  return {
    apiKey: 'root-key',
    projectDomain: project,
    language: mockLanguage(),
    model: 'test-model',
    models: [
      { id: 'test-model', name: 'Test Model', limits: { context: 1000 } },
      { id: 'reasoning-model', name: 'Reasoning Model', limits: { context: 2000 }, capabilities: { reasoning: true } },
    ],
    defaultWorkingDirectory: workingDirectory,
    allowedWorkspaceRoots: [workingDirectory],
    toolMode: 'none',
    approvalMode: 'interactive',
    maxSessions: 10,
  };
}

function mockLanguage() {
  return {
    async *stream() {
      yield { type: 'text-delta', delta: 'Hello!' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } };
    },
  } as ServerConfig['language'];
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return handle.app.request(path, init, { remoteAddress: '127.0.0.1' });
}

function rootHeaders(): Record<string, string> {
  return { Authorization: 'Bearer root-key' };
}

function jsonHeaders(): Record<string, string> {
  return { ...rootHeaders(), 'content-type': 'application/json' };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for runtime event');
}
