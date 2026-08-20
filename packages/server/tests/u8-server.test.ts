import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryPluginSecretsBackend,
  createMemoryPluginRuntimeDomain,
  definePluginContract,
} from '@nerax-ai/plugin';
import { OFFICIAL_TOOL_PROFILE_ALIASES, CortxRuntime, ProjectDomain } from '@cortx/runtime';
import type { PluginAdminContext, PluginAdminService, PluginAdminSubscription } from '@synax-ai/sdk';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerRuntime } from '../src/server';
import { createAuthMiddleware } from '../src/auth';
import { mountPluginAdminHttp } from '../src/plugin-admin-http';
import type { ServerConfig } from '../src/types';

const roots: string[] = [];
const domains: ProjectDomain[] = [];

afterEach(async () => {
  await Promise.allSettled(domains.splice(0).map((domain) => domain.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('U8 Server contracts', () => {
  test('keeps direct and HTTP PluginAdmin DTOs in parity and enforces grants', async () => {
    const projectDomain = await createProjectDomain();
    const handle = createServerRuntime(serverConfig(projectDomain));
    const direct = await handle.pluginAdminService.execute(
      { type: 'snapshot.get' },
      adminContext('default', ['plugins.inspect', 'plugins.observe', 'plugins.manage']),
    );
    const response = await request(handle, '/api/plugins/snapshot', { headers: rootHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(direct);

    const denied = await request(handle, '/api/plugins/actions', {
      method: 'POST',
      headers: { ...observerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'plugin.disable', pluginId: 'test.server-plugin' }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    await handle.close();
  });

  test('returns the shared PluginAdminResult envelope for malformed and transport-level failures', async () => {
    const projectDomain = await createProjectDomain();
    const handle = createServerRuntime(serverConfig(projectDomain));

    for (const [body, action] of [
      ['{', 'unknown'],
      [JSON.stringify({ type: 'plugin.enable' }), 'plugin.enable'],
      [JSON.stringify({ type: 'unknown.action' }), 'unknown'],
    ] as const) {
      const response = await request(handle, '/api/plugins/actions', {
        method: 'POST',
        headers: { ...rootHeaders(), 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, action, error: { code: 'invalid_request' } });
    }

    const queryCredential = await request(handle, '/api/plugins/snapshot?key=root-key', {
      headers: rootHeaders(),
    });
    expect(queryCredential.status).toBe(400);
    expect(await queryCredential.json()).toMatchObject({
      ok: false,
      action: 'snapshot.get',
      error: { code: 'invalid_request' },
    });

    const insecure = await handle.app.request(
      'http://server.local/api/plugins/snapshot',
      { headers: rootHeaders() },
      { remoteAddress: '203.0.113.4' },
    );
    expect(insecure.status).toBe(403);
    expect(await insecure.json()).toMatchObject({
      ok: false,
      action: 'snapshot.get',
      error: { code: 'transport_security' },
    });

    const unauthenticated = await request(handle, '/api/plugins/snapshot');
    expect(unauthenticated.status).toBe(403);
    expect(await unauthenticated.json()).toMatchObject({
      ok: false,
      action: 'snapshot.get',
      error: { code: 'transport_security' },
    });
    await handle.close();
  });

  test('pulls one PluginAdmin SSE delivery per reader demand and cleans up once on cancel', async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    const subscription: PluginAdminSubscription = {
      async next() {
        nextCalls++;
        return { done: false, value: { type: 'gap', afterCursor: 0, watermark: nextCalls } };
      },
      async return() {
        returnCalls++;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const service: PluginAdminService = {
      async execute(action) {
        return { ok: false, action: action.type, error: { code: 'internal', message: 'unused', retryable: false } };
      },
      async subscribe() {
        return subscription;
      },
    };
    const config = {
      apiKey: 'root-key',
      language: mockLanguage(),
      model: 'test-model',
    } as ServerConfig;
    const app = new Hono();
    app.use('*', createAuthMiddleware(config));
    mountPluginAdminHttp(app, { service, config });

    const response = await app.request(
      '/api/plugins/events',
      { headers: rootHeaders() },
      { remoteAddress: '127.0.0.1' },
    );
    expect(response.status).toBe(200);
    expect(nextCalls).toBe(0);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"watermark":1');
    expect(nextCalls).toBe(1);
    await reader.cancel();
    expect(returnCalls).toBe(1);
  });

  test('applies creator-or-admin ACL and rejects every principal ceiling escalation', async () => {
    const projectDomain = await createProjectDomain();
    const handle = createServerRuntime(serverConfig(projectDomain));
    const created = await request(handle, '/sessions', {
      method: 'POST',
      headers: { ...principalHeaders('key-a'), 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { skills: true, subAgents: false, approval: true } }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as {
      session: { id: string; creatorPrincipalId: string; toolMode: string; approvalMode: string; capabilities: unknown };
    };
    expect(session.session).toMatchObject({
      creatorPrincipalId: 'principal-a',
      toolMode: OFFICIAL_TOOL_PROFILE_ALIASES.none,
      approvalMode: 'interactive',
      capabilities: { subAgents: false },
    });

    expect((await request(handle, `/sessions/${session.session.id}`, { headers: principalHeaders('key-b') })).status).toBe(403);
    expect((await request(handle, `/sessions/${session.session.id}`, { headers: rootHeaders() })).status).toBe(200);

    for (const body of [
      { contributions: [{ use: 'test.server-plugin/not-authorized' }] },
      { toolMode: 'test.server-plugin/read-profile' },
      { capabilities: { subAgents: true } },
      { approvalMode: 'full-access' },
    ]) {
      const denied = await request(handle, '/sessions', {
        method: 'POST',
        headers: { ...principalHeaders('key-a'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(403);
    }
    await handle.close();
  });

  test('filters the global session baseline before serialization', async () => {
    const projectDomain = await createProjectDomain();
    const handle = createServerRuntime(serverConfig(projectDomain));
    const a = await request(handle, '/sessions', {
      method: 'POST',
      headers: principalHeaders('key-a'),
    });
    const b = await request(handle, '/sessions', {
      method: 'POST',
      headers: principalHeaders('key-b'),
    });
    const aId = ((await a.json()) as { sessionId: string }).sessionId;
    const bId = ((await b.json()) as { sessionId: string }).sessionId;

    const scoped = await requestJson(handle, '/sessions/feed/baseline', principalHeaders('key-a')) as {
      runtimeIncarnation: string;
      cursor: string;
      sessions: Array<Record<string, unknown>>;
    };
    expect(scoped.runtimeIncarnation).toBeString();
    expect(scoped.cursor).toBeString();
    expect(scoped.sessions.map((session) => session.id)).toEqual([aId]);
    expect(scoped.sessions[0]).not.toHaveProperty('creatorPrincipalId');
    expect(scoped.sessions[0]).not.toHaveProperty('workingDirectory');

    const admin = await requestJson(handle, '/sessions/feed/baseline', rootHeaders()) as {
      sessions: Array<{ id: string }>;
    };
    expect(admin.sessions.map((session) => session.id).sort()).toEqual([aId, bId].sort());
    await handle.close();
  });

  test('exposes cloned child list, status, abort, and wait DTOs', async () => {
    const projectDomain = await createProjectDomain();
    const handle = createServerRuntime(serverConfig(projectDomain));
    const created = await request(handle, '/sessions', {
      method: 'POST',
      headers: principalHeaders('key-a'),
    });
    const sessionId = ((await created.json()) as { sessionId: string }).sessionId;
    const store = handle.runtime.getLocalState(sessionId).agentSessions;
    const completed = store.create('completed-child', 'completed', true, sessionId, 1);
    store.recordEvent(completed.toolCallId, { type: 'text', content: 'done' });
    store.finish(completed.toolCallId, 'completed');

    const listed = await request(handle, `/sessions/${sessionId}/children`, { headers: principalHeaders('key-a') });
    expect(await listed.json()).toEqual({
      children: [
        expect.objectContaining({ toolCallId: 'completed-child', status: 'completed', output: 'done' }),
      ],
    });
    expect(JSON.stringify(await requestJson(handle, `/sessions/${sessionId}/children/completed-child`, principalHeaders('key-a')))).not.toContain('events');

    const running = store.create('running-child', 'running', true, sessionId, 1);
    store.registerAbort(running.toolCallId, () => store.finish(running.toolCallId, 'cancelled'));
    const aborted = await request(handle, `/sessions/${sessionId}/children/running-child/abort`, {
      method: 'POST',
      headers: principalHeaders('key-a'),
    });
    expect(await aborted.json()).toMatchObject({ child: { status: 'cancelled' } });
    const waited = await request(handle, `/sessions/${sessionId}/children/running-child/wait?timeoutMs=100`, {
      headers: principalHeaders('key-a'),
    });
    expect(await waited.json()).toMatchObject({ child: { status: 'cancelled' } });
    await handle.close();
  });

  test('closes active admin subscriptions, respects runtime ownership, and never closes the borrowed ProjectDomain', async () => {
    const projectDomain = await createProjectDomain();
    const borrowedRuntime = createRuntime(projectDomain);
    let borrowedCloses = 0;
    const borrowedClose = borrowedRuntime.close.bind(borrowedRuntime);
    borrowedRuntime.close = async () => {
      borrowedCloses++;
      return borrowedClose();
    };
    const borrowed = createServerRuntime({
      ...serverConfig(projectDomain),
      runtime: { value: borrowedRuntime, ownership: 'borrowed' },
    });
    const subscription = await borrowed.pluginAdminService.subscribe(
      {},
      adminContext('default', ['plugins.observe']),
    );
    await borrowed.close();
    expect((await subscription.next()).done).toBe(true);
    expect(borrowedCloses).toBe(0);
    expect((await projectDomain.registry.snapshot()).managerEpoch).toBeString();
    await borrowedRuntime.close();

    const ownedRuntime = createRuntime(projectDomain);
    let ownedCloses = 0;
    const ownedClose = ownedRuntime.close.bind(ownedRuntime);
    ownedRuntime.close = async () => {
      ownedCloses++;
      return ownedClose();
    };
    const owned = createServerRuntime({
      ...serverConfig(projectDomain),
      runtime: { value: ownedRuntime, ownership: 'owned' },
    });
    await owned.close();
    await owned.close();
    expect(ownedCloses).toBe(1);
  });

  test('keeps the recovery administration plane available while a plugin is pending on a missing runtime service', async () => {
    const projectDomain = await createProjectDomain(true);
    const handle = createServerRuntime(serverConfig(projectDomain));
    const response = await request(handle, '/api/plugins/snapshot', { headers: rootHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { plugins: { 'test.pending-plugin': { state: 'pending' } } },
    });
    await handle.close();
  });
});

async function createProjectDomain(includePending = false): Promise<ProjectDomain> {
  const root = mkdtempSync(join(tmpdir(), 'cortx-server-u8-'));
  roots.push(root);
  const projectDomain = new ProjectDomain({
    domain: createMemoryPluginRuntimeDomain({
      runtimeDomainId: `server-u8:${crypto.randomUUID()}`,
      root,
      secretsBackend: new MemoryPluginSecretsBackend('server-u8-test'),
    }),
  });
  domains.push(projectDomain);
  await projectDomain.start();
  await projectDomain.register(serverPlugin());
  if (includePending) {
    const mutation = await projectDomain.registry.register(pendingPlugin(), { enabled: true });
    if (!mutation.accepted) throw new Error('pending plugin registration conflicted');
    expect((await mutation.operation.wait()).status).toBe('pending');
  }
  return projectDomain;
}

function serverPlugin() {
  return definePluginContract({
    manifest: {
      manifestVersion: 1,
      id: 'test.server-plugin',
      name: 'Server Plugin',
      version: '1.0.0',
      runtime: { main: 'inline' },
      contributes: {
        'agent.eventObserver': { id: 'observer', executable: true },
        'runtime.toolProfile': {
          id: 'read-profile',
          executable: false,
          metadata: { tools: [] },
        },
      },
    },
    setup(ctx) {
      ctx.bind({ type: 'agent.eventObserver', id: 'observer', factory: () => ({ onAgentEvent() {} }) });
    },
  });
}

function pendingPlugin() {
  return definePluginContract({
    manifest: {
      manifestVersion: 1,
      id: 'test.pending-plugin',
      name: 'Pending Plugin',
      version: '1.0.0',
      runtime: { main: 'inline' },
      services: { required: ['cortx.runtime.workspace'] },
    },
    setup() {},
  });
}

function serverConfig(projectDomain: ProjectDomain): ServerConfig {
  return {
    apiKey: 'root-key',
    apiKeys: [
      {
        id: 'principal-a',
        key: 'key-a',
        allowedWorkspaceRoots: [process.cwd()],
        allowedContributions: ['test.server-plugin/observer'],
        allowedToolProfiles: [OFFICIAL_TOOL_PROFILE_ALIASES.none],
        capabilities: { skills: true, subAgents: false, approval: true },
        approvalMode: 'interactive',
        pluginGrants: ['plugins.inspect', 'plugins.observe'],
      },
      {
        id: 'principal-b',
        key: 'key-b',
        allowedWorkspaceRoots: [process.cwd()],
        allowedContributions: ['test.server-plugin/observer'],
        allowedToolProfiles: [OFFICIAL_TOOL_PROFILE_ALIASES.none],
      },
    ],
    projectDomain,
    contributions: [{ use: 'test.server-plugin/observer' }],
    language: mockLanguage(),
    model: 'test-model',
    defaultWorkingDirectory: process.cwd(),
    allowedWorkspaceRoots: [process.cwd()],
    toolMode: 'none',
    approvalMode: 'interactive',
    capabilities: { skills: true, subAgents: true, approval: true },
  };
}

function createRuntime(projectDomain: ProjectDomain): CortxRuntime {
  const config = serverConfig(projectDomain);
  return new CortxRuntime({
    projectDomain,
    contributions: config.contributions,
    language: config.language,
    model: config.model,
    defaultWorkingDirectory: config.defaultWorkingDirectory,
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
  });
}

function mockLanguage() {
  return {
    async *stream() {
      yield { type: 'text-delta', delta: 'ok' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
    },
  } as ServerConfig['language'];
}

function request(
  handle: ReturnType<typeof createServerRuntime>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return handle.app.request(path, init, { remoteAddress: '127.0.0.1' });
}

async function requestJson(
  handle: ReturnType<typeof createServerRuntime>,
  path: string,
  headers: HeadersInit,
): Promise<unknown> {
  return (await request(handle, path, { headers })).json();
}

function rootHeaders(): Record<string, string> {
  return { Authorization: 'Bearer root-key' };
}

function observerHeaders(): Record<string, string> {
  return { Authorization: 'Bearer key-a' };
}

function principalHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

function adminContext(principalId: string, grants: PluginAdminContext['grants']): PluginAdminContext {
  return { principalId, grants, transport: 'direct' };
}
