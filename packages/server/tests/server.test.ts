import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, createServerRuntime, type ServerRuntimeHandle } from '../src/server';
import { createLogger, createMemorySink } from '@nerax-ai/logger';
import { PluginRegistry } from '@nerax-ai/plugin';
import { FileDurableRunStore, type CortxExtensionType, type CortxFactoryMap, type CortxRegistry } from '@cortx/runtime';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
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
  models: [
    { id: 'test-model', name: 'Test Model', limits: { context: 1000, output: 100 } },
    { id: 'reasoning-model', name: 'Reasoning Model', limits: { context: 2000, output: 200 }, capabilities: { reasoning: true } },
  ],
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

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function createWorkspaceToolRegistry(): Promise<CortxRegistry> {
  const source = resolve(import.meta.dir, '../../../../cortx-plugins/workspace-tools');
  const cleanSource = mkdtempSync(join(tmpdir(), 'cortx-server-workspace-tools-plugin-'));
  cpSync(resolve(source, 'manifest.json'), resolve(cleanSource, 'manifest.json'));
  cpSync(resolve(source, 'src'), resolve(cleanSource, 'src'), { recursive: true });
  const registry = new PluginRegistry<CortxExtensionType, CortxFactoryMap>({
    appName: `cortx-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }) as CortxRegistry;
  await registry.load(cleanSource);
  return registry;
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

async function readSseUntil(
  url: string,
  headers: HeadersInit,
  needle: string,
  timeoutMs = 1_000,
): Promise<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(url, { headers, signal: ctrl.signal });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');

  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes(needle)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (!text.includes(needle)) throw error;
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    ctrl.abort();
    reader.releaseLock();
  }

  if (!text.includes(needle)) throw new Error(`SSE stream did not include ${needle}`);
  return text;
}

describe('server routes', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let handle: ServerRuntimeHandle | undefined;

  beforeAll(async () => {
    handle = createServerRuntime({
      ...config,
      registry: await createWorkspaceToolRegistry(),
      toolMode: 'all',
    });
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
    expect(typeof body.sessions).toBe('number');
    expect(typeof body.runningSessions).toBe('number');
    expect(body.maxSessions).toBe(config.maxSessions);
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

  test('updates session controls without creating a new session', async () => {
    const createRes = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolMode: 'none', approvalMode: 'deny' }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const updateRes = await fetch(`${BASE}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolMode: 'read-only', approvalMode: 'interactive' }),
    });
    expect(updateRes.status).toBe(200);
    await expect(updateRes.json()).resolves.toMatchObject({
      session: {
        id: sessionId,
        toolMode: 'read-only',
        approvalMode: 'interactive',
      },
    });
  });

  test('lists configured models with context and reasoning options', async () => {
    const res = await fetch(`${BASE}/models`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toContainEqual(expect.objectContaining({
      id: 'test-model',
      name: 'Test Model',
      contextWindowTokens: 1000,
    }));
    expect(body.models).toContainEqual(expect.objectContaining({
      id: 'reasoning-model',
      name: 'Reasoning Model',
      contextWindowTokens: 2000,
      reasoningEfforts: expect.arrayContaining([
        { value: 'low', label: 'Light' },
        { value: 'xhigh', label: 'Extra High' },
      ]),
    }));
  });

  test('lists plugin-provided tool profiles', async () => {
    const res = await fetch(`${BASE}/tool-profiles`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { toolProfiles: Array<{ id: string; tools: Array<{ use: string }> }> };
    expect(body.toolProfiles.map((profile) => profile.id)).toEqual(['none', 'read-only', 'coding', 'all']);
    expect(body.toolProfiles.find((profile) => profile.id === 'coding')?.tools.map((tool) => tool.use)).toEqual([
      '@cortx-ai/workspace-tools/read',
      '@cortx-ai/workspace-tools/bash',
      '@cortx-ai/workspace-tools/edit',
      '@cortx-ai/workspace-tools/write',
    ]);
  });

  test('updates session model and reasoning without creating a new session', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const updateRes = await fetch(`${BASE}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'reasoning-model', reasoningEffort: 'xhigh' }),
    });
    expect(updateRes.status).toBe(200);
    await expect(updateRes.json()).resolves.toMatchObject({
      session: {
        id: sessionId,
        model: 'reasoning-model',
        reasoningEffort: 'xhigh',
        contextWindowTokens: 2000,
        contextWindowSource: 'model_metadata',
      },
    });
  });

  test('lists workspace directories for project selection', async () => {
    const fixtureDir = mkdtempSync(join(process.cwd(), '.tmp-cortx-server-workspace-'));
    serverFixtureDirs.push(fixtureDir);
    mkdirSync(join(fixtureDir, 'packages'), { recursive: true });
    writeFileSync(join(fixtureDir, 'README.md'), 'not a directory', 'utf8');

    const res = await fetch(`${BASE}/workspaces/directories?path=${encodeURIComponent(fixtureDir)}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      roots: string[];
      current: string;
      parent?: string;
      entries: Array<{ name: string; path: string }>;
    };
    expect(body.current).toBe(fixtureDir);
    expect(body.entries).toContainEqual({ name: 'packages', path: join(fixtureDir, 'packages') });
    expect(body.entries.map((entry) => entry.name)).not.toContain('README.md');
    expect(body.roots.length).toBeGreaterThan(0);

    const outside = mkdtempSync(join(tmpdir(), 'cortx-server-workspace-outside-'));
    try {
      const denied = await fetch(`${BASE}/workspaces/directories?path=${encodeURIComponent(outside)}`, { headers });
      expect(denied.status).toBe(400);
      await expect(denied.json()).resolves.toMatchObject({ kind: 'invalid_workspace' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  test('launches discovered AgentSpec files with source-root-relative SkillPack paths', async () => {
    const specRoot = mkdtempSync(join(tmpdir(), 'cortx-server-spec-pack-'));
    try {
      const packRoot = join(specRoot, 'packs', 'basic');
      mkdirSync(join(packRoot, 'agents'), { recursive: true });
      mkdirSync(join(packRoot, 'skills', 'review'), { recursive: true });
      writeFileSync(
        join(packRoot, 'skill-pack.json'),
        JSON.stringify({
          schemaVersion: 1,
          name: 'basic',
          skillPaths: ['skills'],
          agentSpecPaths: ['agents'],
        }),
        'utf8',
      );
      writeFileSync(
        join(packRoot, 'skills', 'review', 'SKILL.md'),
        '---\nname: review\ndescription: Review code changes.\n---\nReview the current changes.',
        'utf8',
      );
      writeFileSync(
        join(packRoot, 'agents', 'reviewer.json'),
        JSON.stringify({
          schemaVersion: 1,
          name: 'source-root-reviewer',
          prompt: '/review current changes',
          toolMode: 'read-only',
          capabilities: { skills: true, subAgents: false, approval: false },
          skillPacks: ['packs/basic'],
        }),
        'utf8',
      );

      const packHandle = createServerRuntime({
        ...config,
        registry: await createWorkspaceToolRegistry(),
        defaultWorkingDirectory: specRoot,
        allowedWorkspaceRoots: [specRoot],
        agentSpecRoots: [specRoot],
      });
      try {
        const launch = await packHandle.app.request('/agent-specs/launch', {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: 'packs/basic/agents/reviewer.json' }),
        });
        expect(launch.status).toBe(201);
        const body = (await launch.json()) as { sessionId: string; session: { skillPacks?: string[] } };
        expect(body.session.skillPacks).toEqual([packRoot]);
        await waitForRuntimeEnvelope(packHandle, body.sessionId, 'done');
      } finally {
        packHandle.dispose();
      }
    } finally {
      rmSync(specRoot, { recursive: true, force: true });
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

    const skillsRes = await fetch(`${BASE}/sessions/${sessionBody.sessionId}/skills`, { headers });
    expect(skillsRes.status).toBe(200);
    const skillsBody = await skillsRes.json();
    expect(skillsBody.skills).toContainEqual(expect.objectContaining({
      name: 'review',
      description: 'Review changes',
    }));
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

  test('list sessions restores durable sessions after idle eviction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortx-server-durable-list-'));
    const handle = createServerRuntime({
      ...config,
      defaultWorkingDirectory: root,
      allowedWorkspaceRoots: [root],
      durableStore: new FileDurableRunStore(join(root, '.cortx', 'runtime')),
      idleTimeoutMs: 20,
    });

    try {
      const sessionRes = await handle.app.request('/sessions', { method: 'POST', headers });
      expect(sessionRes.status).toBe(201);
      const { sessionId } = (await sessionRes.json()) as { sessionId: string };
      expect(handle.runtime.listSessions().map((session) => session.id)).toContain(sessionId);

      await waitForCondition(() => handle.runtime.listSessions().length === 0);

      const listRes = await handle.app.request('/sessions', { headers });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.map((session) => session.id)).toContain(sessionId);
      expect(handle.runtime.listSessions().map((session) => session.id)).toContain(sessionId);
    } finally {
      handle.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('list sessions skips durable sessions outside current workspace roots', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'cortx-server-durable-first-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'cortx-server-durable-second-'));
    const durableDir = join(firstRoot, '.cortx', 'runtime');
    serverFixtureDirs.push(firstRoot, secondRoot);
    const first = createServerRuntime({
      ...config,
      defaultWorkingDirectory: firstRoot,
      allowedWorkspaceRoots: [firstRoot],
      durableStore: new FileDurableRunStore(durableDir),
    });
    const second = createServerRuntime({
      ...config,
      defaultWorkingDirectory: secondRoot,
      allowedWorkspaceRoots: [secondRoot],
      durableStore: new FileDurableRunStore(durableDir),
    });
    let firstDisposed = false;

    try {
      await first.runtime.createSession({ workingDirectory: firstRoot });
      first.dispose();
      firstDisposed = true;

      const listRes = await second.app.request('/sessions', { headers });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as { sessions: Array<{ workingDirectory: string }> };
      expect(body.sessions.some((session) => session.workingDirectory === firstRoot)).toBe(false);
    } finally {
      if (!firstDisposed) first.dispose();
      second.dispose();
    }
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
    expect(handle!.runtime.getEventEnvelopeHistory(sessionId)[0]).toMatchObject({
      runId: 1,
      event: { type: 'user_message', message: 'Hello agent', source: 'prompt' },
    });

    const sessionRes = await fetch(`${BASE}/sessions/${sessionId}`, { headers });
    await expect(sessionRes.json()).resolves.toMatchObject({
      session: { promptHistory: ['Hello agent'] },
    });
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

  test('event history endpoint returns runtime envelopes in one payload', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    await waitForRuntimeEnvelope(handle!, sessionId, 'done');

    const firstEnvelope = handle!.runtime.getEventEnvelopeHistory(sessionId)[0]!;
    const res = await fetch(`${BASE}/sessions/${sessionId}/events/history?format=envelope`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: RuntimeAgentEventEnvelope[] };

    expect(body.events.length).toBe(handle!.runtime.getEventEnvelopeHistory(sessionId).length);
    expect(body.events[0]).toMatchObject({
      sequence: firstEnvelope.sequence,
      sessionId,
      runId: 1,
      event: { type: firstEnvelope.event.type },
    });
  });

  test('event history endpoint hydrates legacy edit results with contextual details', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    const runtime = handle!.runtime as any;
    const session = runtime.sessions.get(sessionId);
    const initialContent = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n');

    runtime.broadcast(session, {
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'write_1',
        toolName: 'write',
        input: JSON.stringify({ path: 'hello.txt', content: initialContent }),
      },
    } satisfies AgentEvent);
    runtime.broadcast(session, { type: 'tool_result', toolCallId: 'write_1', result: 'Wrote hello.txt', isError: false } satisfies AgentEvent);
    runtime.broadcast(session, {
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'edit_1',
        toolName: 'edit',
        input: JSON.stringify({ path: 'hello.txt', oldText: 'six', newText: 'six\nseven' }),
      },
    } satisfies AgentEvent);
    runtime.broadcast(session, { type: 'tool_result', toolCallId: 'edit_1', result: 'Edited hello.txt', isError: false } satisfies AgentEvent);

    const res = await fetch(`${BASE}/sessions/${sessionId}/events/history?format=envelope`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: RuntimeAgentEventEnvelope[] };
    const editResult = body.events.find(
      (envelope) => envelope.event.type === 'tool_result' && envelope.event.toolCallId === 'edit_1',
    )?.event;

    expect(editResult).toMatchObject({
      type: 'tool_result',
      details: {
        kind: 'file_edit',
        path: 'hello.txt',
        contextLines: 3,
        removedLines: 0,
        addedLines: 1,
      },
    });
    expect((editResult as any).details.lines.map((line: any) => `${line.kind}:${line.text}`)).toEqual([
      'context:four',
      'context:five',
      'context:six',
      'add:seven',
    ]);
  });

  test('event history endpoint reconstructs edit context from current files when no prior write snapshot exists', async () => {
    const workspace = mkdtempSync(join(process.cwd(), '.cortx-server-edit-context-'));
    serverFixtureDirs.push(workspace);
    writeFileSync(join(workspace, 'existing.txt'), ['one', 'two', 'status: ready', 'four', 'five'].join('\n'));
    const createRes = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDirectory: workspace }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    const runtime = handle!.runtime as any;
    const session = runtime.sessions.get(sessionId);

    runtime.broadcast(session, {
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'edit_existing',
        toolName: 'edit',
        input: JSON.stringify({ path: 'existing.txt', oldText: 'status: draft', newText: 'status: ready' }),
      },
    } satisfies AgentEvent);
    runtime.broadcast(session, {
      type: 'tool_result',
      toolCallId: 'edit_existing',
      result: 'Edited existing.txt',
      isError: false,
    } satisfies AgentEvent);

    const res = await fetch(`${BASE}/sessions/${sessionId}/events/history?format=envelope`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: RuntimeAgentEventEnvelope[] };
    const editResult = body.events.find(
      (envelope) => envelope.event.type === 'tool_result' && envelope.event.toolCallId === 'edit_existing',
    )?.event;

    expect(editResult).toMatchObject({
      type: 'tool_result',
      details: {
        kind: 'file_edit',
        path: 'existing.txt',
        oldStartLine: 3,
        newStartLine: 3,
        removedLines: 1,
        addedLines: 1,
      },
    });
    expect((editResult as any).details.lines.map((line: any) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ['context', 1, 1, 'one'],
      ['context', 2, 2, 'two'],
      ['remove', 3, undefined, 'status: draft'],
      ['add', undefined, 3, 'status: ready'],
      ['context', 4, 4, 'four'],
      ['context', 5, 5, 'five'],
    ]);
  });

  test('event history endpoint pages older envelope history', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    await waitForRuntimeEnvelope(handle!, sessionId, 'done');

    const latestRes = await fetch(`${BASE}/sessions/${sessionId}/events/history?format=envelope&limit=1`, { headers });
    expect(latestRes.status).toBe(200);
    const latest = (await latestRes.json()) as {
      events: RuntimeAgentEventEnvelope[];
      page: { hasMoreBefore: boolean; firstSequence: number; lastSequence: number };
    };

    expect(latest.events).toHaveLength(1);
    expect(latest.page.hasMoreBefore).toBe(true);
    expect(latest.page.firstSequence).toBe(latest.events[0].sequence);

    const olderRes = await fetch(
      `${BASE}/sessions/${sessionId}/events/history?format=envelope&before=${latest.page.firstSequence}&limit=1`,
      { headers },
    );
    expect(olderRes.status).toBe(200);
    const older = (await olderRes.json()) as {
      events: RuntimeAgentEventEnvelope[];
      page: { hasMoreBefore: boolean; lastSequence: number };
    };

    expect(older.events).toHaveLength(1);
    expect(older.events[0].sequence).toBeLessThan(latest.events[0].sequence);
    expect(older.page.lastSequence).toBe(older.events[0].sequence);
  });

  test('SSE envelope stream can skip full replay for live-only clients', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    await waitForRuntimeEnvelope(handle!, sessionId, 'done');

    const text = await readSseUntil(
      `${BASE}/sessions/${sessionId}/events?format=envelope&replay=false`,
      headers,
      'data: {}',
    );

    expect(text).toContain('data: {}');
    expect(text).not.toContain('"text_delta"');
  });

  test('SSE stream sends a replay-complete heartbeat immediately', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });
    await waitForRuntimeEnvelope(handle!, sessionId, 'done');

    const text = await readSseUntil(`${BASE}/sessions/${sessionId}/events?format=envelope`, headers, 'data: {}');

    expect(text).toContain('data: {}');
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

  test('answer endpoint rejects unknown pending questions', async () => {
    const createRes = await fetch(`${BASE}/sessions`, { method: 'POST', headers });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const res = await fetch(`${BASE}/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc_1', response: 'yes' }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      kind: 'invalid_request',
      error: 'No pending user question matches toolCallId',
    });
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
      registry: await createWorkspaceToolRegistry(),
      toolMode: 'all',
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

      mkdirSync(join(rootA, 'src'), { recursive: true });
      mkdirSync(join(rootB, 'src'), { recursive: true });
      const dirsA = await handle.app.request(`/workspaces/directories?path=${encodeURIComponent(rootA)}`, {
        headers: { Authorization: 'Bearer key-a' },
      });
      expect(dirsA.status).toBe(200);
      await expect(dirsA.json()).resolves.toMatchObject({
        current: rootA,
        entries: expect.arrayContaining([{ name: 'src', path: join(rootA, 'src') }]),
      });

      const crossDirs = await handle.app.request(`/workspaces/directories?path=${encodeURIComponent(rootB)}`, {
        headers: { Authorization: 'Bearer key-a' },
      });
      expect(crossDirs.status).toBe(403);
      await expect(crossDirs.json()).resolves.toMatchObject({ kind: 'permission_denied' });

      const crossUpdate = await handle.app.request(`/sessions/${sessionB.id}`, {
        method: 'PATCH',
        headers: headersA,
        body: JSON.stringify({ toolMode: 'none' }),
      });
      expect(crossUpdate.status).toBe(403);

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
      registry: await createWorkspaceToolRegistry(),
      toolMode: 'all',
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

      const sessionRes = await handle.app.request('/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: rootA }),
      });
      expect(sessionRes.status).toBe(201);
      const { session } = (await sessionRes.json()) as { session: { id: string } };

      const escalatedUpdate = await handle.app.request(`/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolMode: 'all' }),
      });
      expect(escalatedUpdate.status).toBe(403);
      await expect(escalatedUpdate.json()).resolves.toMatchObject({ kind: 'permission_denied' });

      const narrowedUpdate = await handle.app.request(`/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolMode: 'none', approvalMode: 'deny' }),
      });
      expect(narrowedUpdate.status).toBe(200);
      await expect(narrowedUpdate.json()).resolves.toMatchObject({
        session: { id: session.id, toolMode: 'none', approvalMode: 'deny' },
      });

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
    const agentsA = join(rootA, '.cortx', 'agents');
    const agentsB = join(rootB, '.cortx', 'agents');
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

  test('keeps AgentSpec discovery scoped away from broad workspace browse roots', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cortx-server-broad-root-'));
    const rootA = join(parent, 'project-a');
    const rootB = join(parent, 'project-b');
    const agentsA = join(rootA, '.cortx', 'agents');
    const agentsB = join(rootB, 'agents');
    mkdirSync(agentsA, { recursive: true });
    mkdirSync(agentsB, { recursive: true });
    writeFileSync(join(agentsA, 'reviewer.json'), JSON.stringify({ name: 'project-a-reviewer', prompt: 'review a' }), 'utf8');
    writeFileSync(join(agentsB, 'builder.json'), JSON.stringify({ name: 'project-b-builder', prompt: 'build b' }), 'utf8');

    const defaultHandle = createServerRuntime({
      ...config,
      apiKey: 'admin-key',
      defaultWorkingDirectory: rootA,
      allowedWorkspaceRoots: [parent],
      skillPackRegistryPath: join(parent, 'default-packs.json'),
    });
    const configuredHandle = createServerRuntime({
      ...config,
      apiKey: 'admin-key',
      defaultWorkingDirectory: rootA,
      allowedWorkspaceRoots: [parent],
      agentSpecRoots: [rootB],
      skillPackRegistryPath: join(parent, 'configured-packs.json'),
    });

    try {
      const defaultList = await defaultHandle.app.request('/agent-specs', {
        headers: { Authorization: 'Bearer admin-key' },
      });
      expect(defaultList.status).toBe(200);
      const defaultSpecs = ((await defaultList.json()) as { agentSpecs: Array<{ name: string }> }).agentSpecs;
      expect(defaultSpecs.map((item) => item.name)).toEqual(['project-a-reviewer']);

      const configuredList = await configuredHandle.app.request('/agent-specs', {
        headers: { Authorization: 'Bearer admin-key' },
      });
      expect(configuredList.status).toBe(200);
      const configuredSpecs = ((await configuredList.json()) as { agentSpecs: Array<{ name: string }> }).agentSpecs;
      expect(configuredSpecs.map((item) => item.name)).toEqual(['project-b-builder']);
    } finally {
      defaultHandle.dispose();
      configuredHandle.dispose();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
