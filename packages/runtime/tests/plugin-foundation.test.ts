import { describe, expect, test } from 'bun:test';
import {
  MemoryPluginSecretsBackend,
  PluginRegistry,
  createMemoryPluginRuntimeDomain,
  definePluginContract,
} from '@nerax-ai/plugin';
import {
  AGENT_TOOL,
  RUNTIME_TOOL_PROFILE,
  defineContributionBinding,
  defineCortxContributionDescriptor,
} from '@cortx/sdk';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortxHostScope } from '../src/host-scope.js';
import { ProjectDomain, createFilesystemProjectDomain } from '../src/project-domain.js';
import { ProjectIdentityStore } from '../src/project-identity.js';
import {
  createEmbeddedCortxTopology,
  createRemoteCortxTopology,
  createStandaloneCortxTopology,
} from '../src/topology.js';
import { CortxRuntime } from '../src/runtime.js';
import type { LanguageClient } from '@synax-ai/core';

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `cortx-${label}-`));
}

describe('Cortx plugin runtime foundation', () => {
  test('Host scope closes effects once in reverse order and retries only failed cleanup', async () => {
    const calls: string[] = [];
    let attempts = 0;
    const scope = new CortxHostScope('test', 'session', undefined, 1_000);
    scope.defer(() => calls.push('first'));
    scope.defer(() => {
      attempts++;
      calls.push(`second:${attempts}`);
      if (attempts === 1) throw new Error('retry me');
    });

    await expect(scope.close()).rejects.toThrow('cleanup failed');
    expect(calls).toEqual(['second:1', 'first']);
    await scope.retryFailedCleanup();
    expect(calls).toEqual(['second:1', 'first', 'second:2']);
    await scope.close();
    expect(calls).toEqual(['second:1', 'first', 'second:2']);
  });

  test('Host scope does not duplicate or forget a disposer that outlives the cleanup timeout', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope = new CortxHostScope('timeout', 'session', undefined, 10);
    scope.defer(async () => {
      calls++;
      await gate;
    });

    await expect(scope.close()).rejects.toThrow('cleanup stuck');
    await expect(scope.retryFailedCleanup()).rejects.toThrow('cleanup stuck');
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scope.retryFailedCleanup();
    expect(calls).toBe(1);
  });

  test(
    'ProjectDomain close waits for an in-flight start and retries registry close failures',
    async () => {
    const runtimeDomainId = `test:${crypto.randomUUID()}`;
    const registry = new PluginRegistry({
      domain: createMemoryPluginRuntimeDomain({
        runtimeDomainId,
        root: tempRoot('project-domain-race'),
        secretsBackend: new MemoryPluginSecretsBackend('cortx-test'),
      }),
    });
    const originalStart = registry.start.bind(registry);
    const originalClose = registry.close.bind(registry);
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let closeCalls = 0;
    registry.start = async () => {
      await startGate;
      await originalStart();
    };
    registry.close = async () => {
      closeCalls++;
      if (closeCalls === 1) throw new Error('close once');
      await originalClose();
    };
    const project = new ProjectDomain({ registry, runtimeDomainId });

    const starting = project.start();
    const firstClose = project.close();
    releaseStart();
    await starting;
    await expect(firstClose).rejects.toThrow('close once');
    expect(closeCalls).toBe(1);
    await project.close();
      expect(closeCalls).toBe(2);
    },
    15_000,
  );

  test('ProjectDomain adopts the Registry runtime domain as authoritative and rejects a mismatch', () => {
    const runtimeDomainId = `test:${crypto.randomUUID()}`;
    const registry = new PluginRegistry({
      domain: createMemoryPluginRuntimeDomain({
        runtimeDomainId,
        root: tempRoot('project-domain-adoption'),
        secretsBackend: new MemoryPluginSecretsBackend('cortx-test'),
      }),
    });

    expect(new ProjectDomain({ registry }).runtimeDomainId).toBe(runtimeDomainId);
    expect(() => new ProjectDomain({ registry, runtimeDomainId: `${runtimeDomainId}:forged` })).toThrow(
      'does not match Registry runtime domain',
    );
  });

  test('filesystem composition creates one ProjectDomain writer and excludes a second Manager', async () => {
    const runtimeDomainId = `filesystem:${crypto.randomUUID()}`;
    const appName = `cortx-project-domain-${crypto.randomUUID()}`;
    const first = createFilesystemProjectDomain({
      appName,
      runtimeDomainId,
      secretsBackend: new MemoryPluginSecretsBackend(`first:${runtimeDomainId}`),
    });
    const second = createFilesystemProjectDomain({
      appName,
      runtimeDomainId,
      secretsBackend: new MemoryPluginSecretsBackend(`second:${runtimeDomainId}`),
    });
    await first.start();
    await expect(second.start()).rejects.toThrow('already holds runtime domain');
    await first.close();
    await second.start();
    await second.close();
  });

  test('ProjectDomain resolves canonical executable leases and metadata-only profiles', async () => {
    const runtimeDomainId = `test:${crypto.randomUUID()}`;
    const project = new ProjectDomain({
      domain: createMemoryPluginRuntimeDomain({
        runtimeDomainId,
        root: tempRoot('project-domain'),
        secretsBackend: new MemoryPluginSecretsBackend('cortx-test'),
      }),
    });
    await project.start();
    await project.register(
      definePluginContract({
        manifest: {
          manifestVersion: 1,
          id: '@test/cortx-plugin',
          name: 'Test Cortx plugin',
          version: '1.0.0',
          runtime: { main: 'inline' },
          contributes: {
            [AGENT_TOOL]: [
              defineCortxContributionDescriptor({ id: 'hello', displayName: 'Hello', executable: true }),
              defineCortxContributionDescriptor({ id: 'goodbye', displayName: 'Goodbye', executable: true }),
            ],
            [RUNTIME_TOOL_PROFILE]: [
              defineCortxContributionDescriptor({
                id: 'coding',
                displayName: 'Coding',
                executable: false,
                defaultOptions: { tools: ['@test/cortx-plugin/hello'] },
              }),
            ],
          },
        },
        setup(ctx) {
          ctx.bind(
            defineContributionBinding(AGENT_TOOL, 'hello', () => ({
              name: 'hello',
              inputSchema: { type: 'object' },
              async execute() {
                return { success: true, output: 'hello' };
              },
            })),
          );
          ctx.bind(
            defineContributionBinding(AGENT_TOOL, 'goodbye', () => ({
              name: 'goodbye',
              inputSchema: { type: 'object' },
              async execute() {
                return { success: true, output: 'goodbye' };
              },
            })),
          );
        },
      }),
    );

    const originalListCatalog = project.registry.listCatalog.bind(project.registry);
    let catalogCalls = 0;
    project.registry.listCatalog = (...args) => {
      catalogCalls++;
      return originalListCatalog(...args);
    };
    const scope = new CortxHostScope('session:test', 'session');
    const extensions = await project.createAgentExtensions(
      [{ use: '@test/cortx-plugin/hello' }, { use: '@test/cortx-plugin/goodbye' }],
      scope,
      { instanceId: 'session:test', sessionId: 'test', workingDirectory: tempRoot('workspace') },
    );
    expect(extensions.tools.map((tool) => tool.name)).toEqual(['hello', 'goodbye']);
    expect(catalogCalls).toBe(1);
    expect((await project.listToolProfiles()).map((profile) => profile.canonicalId)).toEqual([
      '@test/cortx-plugin/coding',
    ]);
    expect(() => project.parseReference('hello')).toThrow('canonical');
    await scope.close();
    await project.close();
  });

  test('project identity retains, clones, imports with audit, and fails collision before opening a domain', () => {
    const root = tempRoot('identity');
    const audits: string[] = [];
    const store = new ProjectIdentityStore({ projectRoot: root, audit: (event) => audits.push(event.action) });
    const created = store.resolve({ mode: 'create', generate: () => 'domain-created' });
    expect(store.resolve({ mode: 'retain' })).toEqual(created);
    const cloned = store.resolve({ mode: 'clone', generate: () => 'domain-cloned' });
    expect(cloned.runtimeDomainId).toBe('domain-cloned');
    const imported = store.resolve({ mode: 'import', importedRuntimeDomainId: 'domain-imported' });
    expect(imported.runtimeDomainId).toBe('domain-imported');
    expect(audits).toEqual(['create', 'retain', 'clone', 'import']);
    expect(() =>
      store.resolve({
        mode: 'import',
        importedRuntimeDomainId: 'domain-collision',
        claimedRuntimeDomainIds: ['domain-collision'],
      }),
    ).toThrow('collision');
    expect(JSON.parse(readFileSync(store.metadataPath, 'utf8')).runtimeDomainId).toBe('domain-imported');
  });

  test('project identity create elects one persisted winner across competing processes', async () => {
    const root = tempRoot('identity-race');
    const release = join(root, 'release');
    const ready = [join(root, 'ready-a'), join(root, 'ready-b')];
    const candidates = ['domain-a', 'domain-b'];
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { ProjectIdentityStore } from './packages/runtime/src/project-identity.ts';
      const root = process.env.CORTX_TEST_ROOT;
      const ready = process.env.CORTX_TEST_READY;
      const release = process.env.CORTX_TEST_RELEASE;
      const candidate = process.env.CORTX_TEST_CANDIDATE;
      if (!root || !ready || !release || !candidate) throw new Error('missing test environment');
      const store = new ProjectIdentityStore({ projectRoot: root });
      const result = store.resolve({ mode: 'create', generate: () => {
        writeFileSync(ready, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(release)) Atomics.wait(wait, 0, 0, 5);
        return candidate;
      }});
      process.stdout.write(JSON.stringify(result));
    `;
    const workers = candidates.map((candidate, index) =>
      Bun.spawn([process.execPath, '-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CORTX_TEST_ROOT: root,
          CORTX_TEST_READY: ready[index],
          CORTX_TEST_RELEASE: release,
          CORTX_TEST_CANDIDATE: candidate,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    await waitUntil(() => ready.every(existsSync), 10_000);
    writeFileSync(release, 'release');
    const results = await Promise.all(
      workers.map(async (worker) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ]);
        expect(stderr).toBe('');
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as { runtimeDomainId: string };
      }),
    );

    expect(results[0]).toEqual(results[1]);
    expect(new ProjectIdentityStore({ projectRoot: root }).read()).toMatchObject(results[0]!);
  });

  test('topologies close only owned resources and aggregate failures without skipping later owners', async () => {
    const calls: string[] = [];
    const closeable = (name: string, fail = false) => ({
      async close() {
        calls.push(name);
        if (fail) throw new Error(name);
      },
    });

    const standalone = createStandaloneCortxTopology({
      projectDomain: closeable('project'),
      synax: closeable('synax', true),
      runtime: closeable('runtime'),
      logger: closeable('logger'),
      storage: closeable('storage'),
    });
    await expect(standalone.close()).rejects.toThrow('topology close failed');
    await expect(standalone.close()).rejects.toThrow('topology close failed');
    expect(calls).toEqual(['runtime', 'synax', 'project', 'logger', 'storage']);

    calls.length = 0;
    const borrowedProject = closeable('borrowed-project');
    await createEmbeddedCortxTopology({
      projectDomain: borrowedProject,
      synax: closeable('embedded-synax'),
      runtime: closeable('embedded-runtime'),
    }).close();
    expect(calls).toEqual(['embedded-runtime', 'embedded-synax']);

    calls.length = 0;
    const remote = createRemoteCortxTopology({
      runtimeClient: closeable('runtime-client'),
      pluginAdminClient: closeable('plugin-client'),
    });
    expect('projectDomain' in remote).toBe(false);
    await remote.close();
    await remote.close();
    expect(calls).toEqual(['runtime-client', 'plugin-client']);
  });

  test('runtime records failed run contribution cleanup and exposes retry', async () => {
    let cleanupAttempts = 0;
    const project = new ProjectDomain({
      domain: createMemoryPluginRuntimeDomain({
        runtimeDomainId: `test:${crypto.randomUUID()}`,
        root: tempRoot('runtime-cleanup'),
        secretsBackend: new MemoryPluginSecretsBackend('cortx-test'),
      }),
    });
    await project.register(
      definePluginContract({
        manifest: {
          manifestVersion: 1,
          id: '@test/runtime-cleanup',
          name: 'Runtime cleanup test',
          version: '1.0.0',
          runtime: { main: 'inline' },
          contributes: {
            [AGENT_TOOL]: [defineCortxContributionDescriptor({ id: 'tracked', executable: true })],
          },
        },
        setup(ctx) {
          ctx.bind(
            defineContributionBinding(AGENT_TOOL, 'tracked', (_options, host) => {
              host.defer(() => {
                cleanupAttempts++;
                if (cleanupAttempts === 1) throw new Error('cleanup retry required');
              });
              return {
                name: 'tracked',
                inputSchema: { type: 'object' },
                async execute() {
                  return { success: true, output: 'ok' };
                },
              };
            }),
          );
        },
      }),
    );
    const runtime = new CortxRuntime({
      language: { stream: async function* () {} } as unknown as LanguageClient,
      model: 'before',
      defaultWorkingDirectory: tempRoot('runtime-cleanup-workspace'),
      projectDomain: project,
      contributions: [{ use: '@test/runtime-cleanup/tracked' }],
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'cleanup-session' });

    await runtime.prompt(session.id, 'exercise cleanup');
    await waitUntil(() => !runtime.getSession(session.id).isRunning);
    const [failure] = runtime.listCleanupFailures();
    expect(failure?.owner).toContain('settled run');
    await runtime.retryCleanup(failure!.id);
    expect(runtime.listCleanupFailures()).toEqual([]);

    await runtime.close();
    await project.close();
  });

  test('generation revocation aborts the active run and the next run rebuilds fresh contribution values', async () => {
    const scopes: Array<{ kind: string; signal: AbortSignal }> = [];
    const project = new ProjectDomain({
      domain: createMemoryPluginRuntimeDomain({
        runtimeDomainId: `test:${crypto.randomUUID()}`,
        root: tempRoot('runtime-generation'),
        secretsBackend: new MemoryPluginSecretsBackend('cortx-test'),
      }),
    });
    await project.register(
      definePluginContract({
        manifest: {
          manifestVersion: 1,
          id: '@test/runtime-generation',
          name: 'Runtime generation test',
          version: '1.0.0',
          runtime: { main: 'inline' },
          contributes: {
            [AGENT_TOOL]: [defineCortxContributionDescriptor({ id: 'proof', executable: true })],
          },
        },
        setup(ctx) {
          ctx.bind(
            defineContributionBinding(AGENT_TOOL, 'proof', (_options, host) => {
              scopes.push({ kind: host.scopeKind, signal: host.signal });
              return {
                name: 'proof',
                inputSchema: {},
                async execute() {
                  return { success: true, output: 'proof' };
                },
              };
            }),
          );
        },
      }),
    );

    let streamCount = 0;
    let started!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = new CortxRuntime({
      language: {
        stream: async function* (_request: unknown, options?: { signal?: AbortSignal }) {
          streamCount++;
          if (streamCount === 1) {
            started();
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
            return;
          }
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
        },
      } as unknown as LanguageClient,
      model: 'test',
      defaultWorkingDirectory: tempRoot('runtime-generation-workspace'),
      projectDomain: project,
      contributions: [{ use: '@test/runtime-generation/proof' }],
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'generation-session' });
    await runtime.prompt(session.id, 'first');
    await streamStarted;
    const disabled = await project.registry.disable('@test/runtime-generation');
    expect(disabled.accepted).toBe(true);
    await disabled.operation.wait();
    await waitUntil(() => !runtime.getSession(session.id).isRunning);

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ kind: 'run' });
    expect(scopes[0]!.signal.aborted).toBe(true);
    await expect(runtime.prompt(session.id, 'disabled')).rejects.toThrow('Contribution is unavailable');

    const enabled = await project.registry.enable('@test/runtime-generation');
    expect(enabled.accepted).toBe(true);
    await enabled.operation.wait();
    await runtime.prompt(session.id, 'second');
    await waitUntil(() => !runtime.getSession(session.id).isRunning);
    expect(scopes).toHaveLength(2);
    expect(scopes[1]).toMatchObject({ kind: 'run' });
    expect(scopes[1]!.signal).not.toBe(scopes[0]!.signal);
    expect(scopes[1]!.signal.aborted).toBe(true);

    await runtime.close();
    await project.close();
  });

  test('idle session destroy rejection is retained as a retryable cleanup failure', async () => {
    const runtime = new CortxRuntime({
      language: { stream: async function* () {} } as unknown as LanguageClient,
      model: 'test',
      defaultWorkingDirectory: tempRoot('idle-cleanup'),
      idleTimeoutMs: 10,
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'idle-cleanup-session' });
    const store = runtime.getLocalState(session.id).agentSessions;
    const originalAbortRunning = store.abortRunning.bind(store);
    store.abortRunning = async () => {
      throw new Error('idle child shutdown failed');
    };
    await waitUntil(() => runtime.listCleanupFailures().length === 1);
    const [failure] = runtime.listCleanupFailures();
    expect(failure).toMatchObject({ owner: 'idle session destroy:idle-cleanup-session' });

    store.abortRunning = originalAbortRunning;
    await runtime.retryCleanup(failure!.id);
    expect(runtime.listCleanupFailures()).toEqual([]);
    expect(runtime.listSessions()).toEqual([]);
    await runtime.close();
  });

  test('child contribution cleanup failures are retained and retryable', async () => {
    let childCleanupAttempts = 0;
    const project = new ProjectDomain({
      domain: createMemoryPluginRuntimeDomain({
        runtimeDomainId: `test:${crypto.randomUUID()}`,
        root: tempRoot('child-cleanup'),
        secretsBackend: new MemoryPluginSecretsBackend('cortx-test'),
      }),
    });
    await project.register(
      definePluginContract({
        manifest: {
          manifestVersion: 1,
          id: '@test/child-cleanup',
          name: 'Child cleanup test',
          version: '1.0.0',
          runtime: { main: 'inline' },
          contributes: {
            [AGENT_TOOL]: [defineCortxContributionDescriptor({ id: 'proof', executable: true })],
          },
        },
        setup(ctx) {
          ctx.bind(
            defineContributionBinding(AGENT_TOOL, 'proof', (_options, host) => {
              if (host.scopeKind === 'foreground-child') {
                host.defer(() => {
                  childCleanupAttempts++;
                  if (childCleanupAttempts === 1) throw new Error('child cleanup retry required');
                });
              }
              return {
                name: 'proof',
                inputSchema: {},
                async execute() {
                  return { success: true, output: 'proof' };
                },
              };
            }),
          );
        },
      }),
    );
    let response = 0;
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          response++;
          if (response === 1) {
            yield { type: 'tool-input-start', id: 'agent-call', toolName: 'agent' };
            yield { type: 'tool-input-delta', id: 'agent-call', delta: '{"prompt":"child work"}' };
            yield { type: 'tool-input-end', id: 'agent-call' };
            yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
            return;
          }
          yield { type: 'text-start', id: `text-${response}` };
          yield { type: 'text-delta', id: `text-${response}`, delta: response === 2 ? 'child' : 'parent' };
          yield { type: 'text-end', id: `text-${response}` };
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
        },
      } as unknown as LanguageClient,
      model: 'test',
      defaultWorkingDirectory: tempRoot('child-cleanup-workspace'),
      projectDomain: project,
      contributions: [{ use: '@test/child-cleanup/proof' }],
      capabilities: { skills: false, subAgents: true, approval: false },
    });
    const session = await runtime.createSession({ id: 'child-cleanup-session' });
    await runtime.prompt(session.id, 'delegate');
    await waitUntil(() => !runtime.getSession(session.id).isRunning);
    const failure = runtime.listCleanupFailures().find((item) => item.owner.includes('settled child'));
    expect(failure).toBeDefined();
    await runtime.retryCleanup(failure!.id);
    const parentFailure = runtime.listCleanupFailures().find((item) => item.owner.includes('settled run'));
    expect(parentFailure).toBeDefined();
    await runtime.retryCleanup(parentFailure!.id);
    expect(runtime.listCleanupFailures()).toEqual([]);
    expect(childCleanupAttempts).toBe(2);
    await runtime.close();
    await project.close();
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await Bun.sleep(5);
  }
}
