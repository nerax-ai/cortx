import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryPluginSecretsBackend,
  createMemoryPluginRuntimeDomain,
  definePluginContract,
  type DeclarativePlugin,
} from '@nerax-ai/plugin';
import type { PluginAdminContext } from '@synax-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortxPluginAdminService, ProjectDomain } from '../src';

const roots: string[] = [];
const domains: ProjectDomain[] = [];

afterEach(async () => {
  await Promise.allSettled(domains.splice(0).map((domain) => domain.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CortxPluginAdminService', () => {
  test('uses inspect, observe, and manage as independent grants', async () => {
    const domain = await createDomain(adminPlugin(), false);
    const service = new CortxPluginAdminService({ projectDomain: domain });
    const observer = context('observer', ['plugins.inspect', 'plugins.observe']);

    expect((await service.execute({ type: 'catalog.list' }, observer)).ok).toBe(true);
    expect((await service.execute({ type: 'snapshot.get' }, observer)).ok).toBe(true);
    expect(await service.execute({ type: 'plugin.enable', pluginId: 'test.admin' }, observer)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  test('projects every Project contribution type and keeps tool profiles metadata-only', async () => {
    const domain = await createDomain(projectDescriptorPlugin(), false);
    const service = new CortxPluginAdminService({ projectDomain: domain });
    const result = await service.execute(
      { type: 'descriptor.list' },
      context('inspector', ['plugins.inspect']),
    );

    expect(result.ok).toBe(true);
    const descriptors = result.ok ? (result.data as Array<{ type: string; canonicalId: string; resolvable: boolean }>) : [];
    expect(new Set(descriptors.map((descriptor) => descriptor.type))).toEqual(
      new Set([
        'agent.tool',
        'agent.systemTransform',
        'agent.messagesTransform',
        'agent.toolBefore',
        'agent.toolAfter',
        'agent.errorRecover',
        'agent.contextOverflow',
        'agent.eventObserver',
        'agent.sessionPolicy',
        'runtime.toolProfile',
        'provider',
        'dispatcher',
        'endpoint',
        'api',
      ]),
    );
    expect(descriptors.find((descriptor) => descriptor.type === 'runtime.toolProfile')).toMatchObject({
      canonicalId: 'test.descriptors/default',
      executable: false,
      metadata: { tools: ['test.descriptors/agent-tool'] },
      pluginState: 'installed',
      resolvable: false,
    });
    expect(structuredClone(result)).toEqual(result);
  });

  test('bounds subscriptions and rechecks grants after context revocation', async () => {
    const domain = await createDomain(adminPlugin(), true);
    let allowed = true;
    const service = new CortxPluginAdminService({
      projectDomain: domain,
      authorize: () => allowed,
      limits: {
        global: 1,
        perPrincipal: 1,
        creationsPerMinute: 2,
        idleTimeoutMs: 20,
        maximumLifetimeMs: 100,
        snapshotBytes: 1024 * 1024,
      },
    });
    const observer = context('observer', ['plugins.observe']);
    const first = await service.subscribe({}, observer);
    await expect(service.subscribe({}, observer)).rejects.toThrow('capacity');
    allowed = false;
    await expect(first.next()).rejects.toThrow();
  });

  test('releases never-consumed subscriptions on idle and service close', async () => {
    const domain = await createDomain(adminPlugin(), true);
    const service = new CortxPluginAdminService({
      projectDomain: domain,
      limits: {
        global: 1,
        perPrincipal: 1,
        creationsPerMinute: 10,
        idleTimeoutMs: 10,
        maximumLifetimeMs: 100,
        snapshotBytes: 1024 * 1024,
      },
    });
    const observer = context('observer', ['plugins.observe']);
    await service.subscribe({}, observer);
    await Bun.sleep(20);
    const replacement = await service.subscribe({}, observer);
    await service.close();
    expect((await replacement.next()).done).toBe(true);
    await expect(service.subscribe({}, observer)).rejects.toThrow('closed');
  });

  test('rejects forged plugin ids before mutation', async () => {
    const domain = await createDomain(adminPlugin(), true);
    const service = new CortxPluginAdminService({ projectDomain: domain });
    const before = await domain.registry.snapshot();

    expect(
      await service.execute(
        { type: 'plugin.disable', pluginId: '../test.admin' },
        context('operator', ['plugins.manage']),
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect((await domain.registry.snapshot()).desiredRevision).toBe(before.desiredRevision);
  });
});

async function createDomain(plugin: DeclarativePlugin, enabled: boolean): Promise<ProjectDomain> {
  const root = mkdtempSync(join(tmpdir(), 'cortx-plugin-admin-'));
  roots.push(root);
  const domain = new ProjectDomain({
    domain: createMemoryPluginRuntimeDomain({
      runtimeDomainId: `cortx-admin:${crypto.randomUUID()}`,
      root,
      secretsBackend: new MemoryPluginSecretsBackend('cortx-admin-test'),
    }),
  });
  domains.push(domain);
  await domain.start();
  await domain.register(plugin, { enabled });
  return domain;
}

function adminPlugin(): DeclarativePlugin {
  return definePluginContract({
    manifest: {
      manifestVersion: 1,
      id: 'test.admin',
      name: 'Admin Test',
      version: '1.0.0',
      runtime: { main: 'inline' },
      contributes: { 'agent.eventObserver': { id: 'main', executable: true } },
    },
    setup(ctx) {
      ctx.bind({ type: 'agent.eventObserver', id: 'main', factory: () => ({ onAgentEvent() {} }) });
    },
  });
}

function projectDescriptorPlugin(): DeclarativePlugin {
  const types = [
    'agent.tool',
    'agent.systemTransform',
    'agent.messagesTransform',
    'agent.toolBefore',
    'agent.toolAfter',
    'agent.errorRecover',
    'agent.contextOverflow',
    'agent.eventObserver',
    'agent.sessionPolicy',
    'provider',
    'dispatcher',
    'endpoint',
    'api',
  ];
  return definePluginContract({
    manifest: {
      manifestVersion: 1,
      id: 'test.descriptors',
      name: 'Descriptor Test',
      version: '1.0.0',
      runtime: { main: 'inline' },
      contributes: {
        ...Object.fromEntries(
          types.map((type) => [type, { id: type.replaceAll('.', '-'), executable: true }]),
        ),
        'runtime.toolProfile': {
          id: 'default',
          executable: false,
          metadata: { tools: ['test.descriptors/agent-tool'] },
        },
      },
    },
    setup() {},
  });
}

function context(principalId: string, grants: PluginAdminContext['grants']): PluginAdminContext {
  return { principalId, grants, transport: 'direct' };
}
