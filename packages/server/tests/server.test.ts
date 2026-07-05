import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, createServerRuntime, type ServerRuntimeHandle } from '../src/server';
import { createLogger, createMemorySink } from '@nerax-ai/logger';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

const serverStateDir = mkdtempSync(join(tmpdir(), 'cortx-server-state-'));
const serverFixtureDirs: string[] = [];

const config: ServerConfig = {
  apiKey: 'test-key-123',
  port: 3999,
  host: 'localhost',
  language: mockLanguageClient(),
  model: 'test-model',
  maxSessions: 100,
  skillPackRegistryPath: join(serverStateDir, 'skill-packs.json'),
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
    for (const dir of serverFixtureDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(serverStateDir, { recursive: true, force: true });
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

  test('installs and lists local SkillPacks through the server contract', async () => {
    const fixtureDir = mkdtempSync(join(process.cwd(), '.tmp-cortx-server-pack-'));
    serverFixtureDirs.push(fixtureDir);
    const skillDir = join(fixtureDir, 'skills', 'review');
    const agentsDir = join(fixtureDir, 'agents');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'skill-pack.json'), JSON.stringify({ name: 'server-pack' }), 'utf8');
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\nServer skill: $ARGUMENTS',
      'utf8',
    );
    writeFileSync(
      join(agentsDir, 'reviewer.json'),
      JSON.stringify({
        name: 'server-reviewer',
        prompt: '/review current diff',
        capabilities: { skills: true, subAgents: false, approval: false },
        skillPacks: ['server-pack'],
      }),
      'utf8',
    );

    const installRes = await fetch(`${BASE}/skill-packs/install`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fixtureDir }),
    });
    expect(installRes.status).toBe(201);
    const installBody = await installRes.json();
    expect(installBody.skillPack).toMatchObject({ id: 'server-pack', name: 'server-pack' });

    const listRes = await fetch(`${BASE}/skill-packs`, { headers });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.skillPacks.map((pack: { id: string }) => pack.id)).toContain('server-pack');

    const specsRes = await fetch(`${BASE}/agent-specs`, { headers });
    expect(specsRes.status).toBe(200);
    const specsBody = await specsRes.json();
    expect(specsBody.agentSpecs.map((spec: { name: string }) => spec.name)).toContain('server-reviewer');

    const sessionRes = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolMode: 'none',
        capabilities: { skills: true, subAgents: false, approval: false },
        skillPacks: ['server-pack'],
      }),
    });
    expect(sessionRes.status).toBe(201);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.skillPacks).toEqual(['server-pack']);
  });

  test('SkillPack install rejects paths outside allowed roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cortx-server-pack-outside-'));
    try {
      writeFileSync(join(outside, 'skill-pack.json'), JSON.stringify({ name: 'outside-pack' }), 'utf8');
      const res = await fetch(`${BASE}/skill-packs/install`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: outside }),
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

describe('server scoped API keys', () => {
  test('scopes session create/list/access/action routes by API key workspace roots', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'cortx-server-root-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'cortx-server-root-b-'));
    const handle = createServerRuntime({
      ...config,
      apiKey: 'admin-key',
      defaultWorkingDirectory: rootA,
      allowedWorkspaceRoots: [rootA],
      apiKeys: [
        { id: 'project-a', key: 'key-a', allowedWorkspaceRoots: [rootA], toolMode: 'read-only', approvalMode: 'interactive' },
        { id: 'project-b', key: 'key-b', allowedWorkspaceRoots: [rootB], toolMode: 'all', approvalMode: 'full-access' },
      ],
    });

    try {
      const headersA = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
      const headersB = { Authorization: 'Bearer key-b', 'Content-Type': 'application/json' };

      const sessionARes = await handle.app.request('/sessions', {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ workingDirectory: rootA }),
      });
      const sessionBRes = await handle.app.request('/sessions', {
        method: 'POST',
        headers: headersB,
        body: JSON.stringify({ workingDirectory: rootB }),
      });
      expect(sessionARes.status).toBe(201);
      expect(sessionBRes.status).toBe(201);

      const sessionA = ((await sessionARes.json()) as { session: { id: string; toolMode: string; approvalMode: string } }).session;
      const sessionB = ((await sessionBRes.json()) as { session: { id: string; toolMode: string; approvalMode: string } }).session;
      expect(sessionA.toolMode).toBe('read-only');
      expect(sessionA.approvalMode).toBe('interactive');
      expect(sessionB.toolMode).toBe('all');
      expect(sessionB.approvalMode).toBe('full-access');

      const deniedCreate = await handle.app.request('/sessions', {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ workingDirectory: rootB }),
      });
      expect(deniedCreate.status).toBe(403);
      await expect(deniedCreate.json()).resolves.toMatchObject({ kind: 'permission_denied' });

      const listA = await handle.app.request('/sessions', { headers: { Authorization: 'Bearer key-a' } });
      const visibleA = ((await listA.json()) as { sessions: Array<{ id: string }> }).sessions;
      expect(visibleA.map((item) => item.id)).toContain(sessionA.id);
      expect(visibleA.map((item) => item.id)).not.toContain(sessionB.id);

      const crossGet = await handle.app.request(`/sessions/${sessionB.id}`, {
        headers: { Authorization: 'Bearer key-a' },
      });
      expect(crossGet.status).toBe(403);
      await expect(crossGet.json()).resolves.toMatchObject({ kind: 'permission_denied' });

      const crossPrompt = await handle.app.request(`/sessions/${sessionB.id}/prompt`, {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ message: 'should not run' }),
      });
      expect(crossPrompt.status).toBe(403);

      const ownGet = await handle.app.request(`/sessions/${sessionB.id}`, {
        headers: { Authorization: 'Bearer key-b' },
      });
      expect(ownGet.status).toBe(200);
    } finally {
      handle.dispose();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  test('scopes token-authenticated requests and prevents mode escalation', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'cortx-server-token-root-a-'));
    const handle = createServerRuntime({
      ...config,
      apiKey: 'admin-key',
      defaultWorkingDirectory: rootA,
      allowedWorkspaceRoots: [rootA],
      apiKeys: [
        { id: 'project-a', key: 'key-a', allowedWorkspaceRoots: [rootA], toolMode: 'read-only', approvalMode: 'interactive' },
      ],
    });

    try {
      const tokenRes = await handle.app.request('/auth/token', {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a' },
      });
      const { token } = (await tokenRes.json()) as { token: string };

      const escalatedTool = await handle.app.request('/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: rootA, toolMode: 'all' }),
      });
      expect(escalatedTool.status).toBe(403);
      await expect(escalatedTool.json()).resolves.toMatchObject({ kind: 'permission_denied' });

      const invalidTool = await handle.app.request('/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: rootA, toolMode: 'everything' }),
      });
      expect(invalidTool.status).toBe(400);
      await expect(invalidTool.json()).resolves.toMatchObject({ kind: 'invalid_request' });

      const escalatedApproval = await handle.app.request('/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: rootA, approvalMode: 'full-access' }),
      });
      expect(escalatedApproval.status).toBe(403);
      await expect(escalatedApproval.json()).resolves.toMatchObject({ kind: 'permission_denied' });

      const narrowerSession = await handle.app.request('/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: rootA, toolMode: 'none', approvalMode: 'deny' }),
      });
      expect(narrowerSession.status).toBe(201);
      await expect(narrowerSession.json()).resolves.toMatchObject({
        session: { toolMode: 'none', approvalMode: 'deny' },
      });
    } finally {
      handle.dispose();
      rmSync(rootA, { recursive: true, force: true });
    }
  });

  test('rejects AgentSpec file launches outside the current API key workspace scope', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'cortx-server-spec-root-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'cortx-server-spec-root-b-'));
    const handle = createServerRuntime({
      ...config,
      apiKey: 'admin-key',
      defaultWorkingDirectory: rootA,
      allowedWorkspaceRoots: [rootA],
      apiKeys: [
        { id: 'project-a', key: 'key-a', allowedWorkspaceRoots: [rootA] },
        { id: 'project-b', key: 'key-b', allowedWorkspaceRoots: [rootB] },
      ],
    });

    try {
      const specPath = join(rootB, 'agent.json');
      writeFileSync(
        specPath,
        JSON.stringify({
          name: 'project-b-agent',
          prompt: 'hello from project b',
          workingDirectory: rootB,
          toolMode: 'none',
          capabilities: { skills: false, subAgents: false, approval: false },
        }),
        'utf8',
      );

      const crossLaunch = await handle.app.request('/agent-specs/launch', {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: specPath }),
      });
      expect(crossLaunch.status).toBe(403);
      await expect(crossLaunch.json()).resolves.toMatchObject({ kind: 'permission_denied' });

      const ownLaunch = await handle.app.request('/agent-specs/launch', {
        method: 'POST',
        headers: { Authorization: 'Bearer key-b', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: specPath }),
      });
      expect(ownLaunch.status).toBe(201);
      const body = (await ownLaunch.json()) as { sessionId: string; session: { metadata?: Record<string, unknown> } };
      expect(body.session.metadata).toMatchObject({ agentSpec: 'project-b-agent' });
      await waitForRuntimeEnvelope(handle, body.sessionId, 'done');
    } finally {
      handle.dispose();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  test('lists discovered AgentSpec assets within the current API key workspace scope', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'cortx-server-discover-root-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'cortx-server-discover-root-b-'));
    const agentsA = join(rootA, 'agents');
    const agentsB = join(rootB, 'agents');
    mkdirSync(agentsA, { recursive: true });
    mkdirSync(agentsB, { recursive: true });
    writeFileSync(
      join(agentsA, 'reviewer.json'),
      JSON.stringify({
        name: 'project-a-reviewer',
        prompt: 'review project a',
        workingDirectory: rootA,
        toolMode: 'read-only',
        approvalMode: 'deny',
      }),
      'utf8',
    );
    writeFileSync(join(agentsA, 'broken.json'), JSON.stringify({ prompt: '' }), 'utf8');
    writeFileSync(
      join(agentsB, 'builder.json'),
      JSON.stringify({
        name: 'project-b-builder',
        prompt: 'build project b',
        workingDirectory: rootB,
        toolMode: 'all',
        approvalMode: 'full-access',
      }),
      'utf8',
    );

    const handle = createServerRuntime({
      ...config,
      apiKey: 'admin-key',
      defaultWorkingDirectory: rootA,
      allowedWorkspaceRoots: [rootA],
      apiKeys: [
        { id: 'project-a', key: 'key-a', allowedWorkspaceRoots: [rootA] },
        { id: 'project-b', key: 'key-b', allowedWorkspaceRoots: [rootB] },
      ],
    });

    try {
      const listA = await handle.app.request('/agent-specs', { headers: { Authorization: 'Bearer key-a' } });
      const specsA = ((await listA.json()) as { agentSpecs: Array<{ name: string; path: string }> }).agentSpecs;
      expect(listA.status).toBe(200);
      expect(specsA.map((item) => item.name)).toEqual(['project-a-reviewer']);
      expect(specsA[0].path).toBe(join(agentsA, 'reviewer.json'));

      const listB = await handle.app.request('/agent-specs', { headers: { Authorization: 'Bearer key-b' } });
      const specsB = ((await listB.json()) as { agentSpecs: Array<{ name: string; path: string }> }).agentSpecs;
      expect(listB.status).toBe(200);
      expect(specsB.map((item) => item.name)).toEqual(['project-b-builder']);
    } finally {
      handle.dispose();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
