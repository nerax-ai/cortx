import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { PluginRegistry } from '../../../../nerax/packages/plugin/src/index.ts';
import {
  CortxRuntime,
  createWorkspaceToolPluginEntries,
  listRuntimeToolProfiles,
  resolveWorkspace,
  type CortxExtensionType,
  type CortxFactoryMap,
  type CortxRegistry,
} from '../src/index';
import type { AgentEvent } from '@cortx/sdk';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';

let rootDir: string;
let outsideDir: string;
let workspaceToolRegistryPromise: Promise<CortxRegistry> | undefined;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cortx-runtime-root-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'cortx-runtime-outside-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function toolCallParts(toolCallId: string, toolName: string, input: Record<string, unknown>): LanguageStreamPart[] {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: JSON.stringify(input) },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function textParts(text: string): LanguageStreamPart[] {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function mockLanguage(responses: LanguageStreamPart[][]): LanguageClient {
  let index = 0;
  return {
    stream: async function* () {
      const parts = responses[index++] ?? responses.at(-1) ?? [];
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

async function createWorkspaceToolRegistry(): Promise<CortxRegistry> {
  workspaceToolRegistryPromise ??= createFreshWorkspaceToolRegistry('cortx-runtime-workspace-tools-test');
  return workspaceToolRegistryPromise;
}

async function createFreshWorkspaceToolRegistry(appName: string): Promise<CortxRegistry> {
  const source = resolve(import.meta.dir, '../../../../cortx-plugins/workspace-tools');
  const cleanSource = mkdtempSync(join(tmpdir(), 'cortx-workspace-tools-plugin-'));
  cpSync(resolve(source, 'manifest.json'), resolve(cleanSource, 'manifest.json'));
  cpSync(resolve(source, 'src'), resolve(cleanSource, 'src'), { recursive: true });
  const registry = new PluginRegistry<CortxExtensionType, CortxFactoryMap>({ appName }) as CortxRegistry;
  await registry.load(cleanSource);
  return registry;
}

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type'], timeoutMs = 1_000): Promise<AgentEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

describe('workspace resolution', () => {
  test('accepts directories inside an allowed root', async () => {
    mkdirSync(join(rootDir, 'project'));
    const resolved = await resolveWorkspace({
      requested: 'project',
      defaultWorkingDirectory: rootDir,
      allowedRoots: [rootDir],
    });
    expect(resolved.workingDirectory).toBe(join(rootDir, 'project'));
  });

  test('rejects lexical escapes and absolute outside paths', async () => {
    mkdirSync(join(rootDir, 'project'));
    await expect(
      resolveWorkspace({
        requested: '../outside',
        defaultWorkingDirectory: join(rootDir, 'project'),
        allowedRoots: [rootDir],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_workspace' });
    await expect(
      resolveWorkspace({
        requested: outsideDir,
        defaultWorkingDirectory: rootDir,
        allowedRoots: [rootDir],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_workspace' });
  });

  test('rejects symlink escapes', async () => {
    symlinkSync(outsideDir, join(rootDir, 'outside-link'));
    await expect(
      resolveWorkspace({
        requested: 'outside-link',
        defaultWorkingDirectory: rootDir,
        allowedRoots: [rootDir],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_workspace' });
  });
});

describe('runtime-mounted workspace tools', () => {
  test('builds workspace tool plugin entries from plugin-provided profiles', async () => {
    const registry = await createWorkspaceToolRegistry();
    expect((await listRuntimeToolProfiles(registry)).map((profile) => profile.id)).toEqual([
      'none',
      'read-only',
      'coding',
      'all',
    ]);
    expect((await createWorkspaceToolPluginEntries(rootDir, 'none', registry)).map((entry) => entry.use)).toEqual([]);
    expect((await createWorkspaceToolPluginEntries(rootDir, 'read-only', registry)).map((entry) => entry.use)).toEqual([
      '@cortx-ai/workspace-tools/read',
      '@cortx-ai/workspace-tools/grep',
      '@cortx-ai/workspace-tools/find',
      '@cortx-ai/workspace-tools/ls',
    ]);
    expect((await createWorkspaceToolPluginEntries(rootDir, 'coding', registry)).map((entry) => entry.use)).toEqual([
      '@cortx-ai/workspace-tools/read',
      '@cortx-ai/workspace-tools/bash',
      '@cortx-ai/workspace-tools/edit',
      '@cortx-ai/workspace-tools/write',
    ]);
    expect((await createWorkspaceToolPluginEntries(rootDir, 'all', registry)).map((entry) => entry.use)).toEqual([
      '@cortx-ai/workspace-tools/read',
      '@cortx-ai/workspace-tools/bash',
      '@cortx-ai/workspace-tools/edit',
      '@cortx-ai/workspace-tools/write',
      '@cortx-ai/workspace-tools/grep',
      '@cortx-ai/workspace-tools/find',
      '@cortx-ai/workspace-tools/ls',
    ]);
  });

  test('mounts custom tool profiles contributed by another plugin', async () => {
    const registry = await createFreshWorkspaceToolRegistry('cortx-runtime-custom-tool-profile-test');
    const customSource = mkdtempSync(join(tmpdir(), 'cortx-ops-tool-profile-plugin-'));
    mkdirSync(join(customSource, 'src'));
    writeFileSync(join(customSource, 'src', 'index.ts'), 'export function setup() {}\n', 'utf8');
    writeFileSync(
      join(customSource, 'manifest.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: '@cortx-ai/ops-tools',
        name: 'Cortx Ops Tools',
        version: '0.0.1',
        runtime: { main: 'src/index.ts' },
        contributes: {
          'runtime.toolProfile': [
            {
              id: 'ops',
              name: 'Ops',
              description: 'Read operational workspace context.',
              tools: ['@cortx-ai/workspace-tools/read'],
            },
          ],
        },
      }),
      'utf8',
    );

    try {
      await registry.load(customSource);
      const profiles = await listRuntimeToolProfiles(registry);
      expect(profiles.map((profile) => profile.id)).toEqual(['none', 'read-only', 'coding', 'all', 'ops']);
      expect((await createWorkspaceToolPluginEntries(rootDir, 'ops', registry)).map((entry) => entry.use)).toEqual([
        '@cortx-ai/workspace-tools/read',
      ]);
    } finally {
      rmSync(customSource, { recursive: true, force: true });
    }
  });

  test('uses session workspace boundaries for mounted tools', async () => {
    const registry = await createWorkspaceToolRegistry();
    mkdirSync(join(rootDir, 'a'));
    mkdirSync(join(rootDir, 'b'));
    writeFileSync(join(rootDir, 'a', 'visible.txt'), 'visible');
    writeFileSync(join(rootDir, 'b', 'secret.txt'), 'secret');
    const runtime = new CortxRuntime({
      language: mockLanguage([
        toolCallParts('tc1', 'read', { path: 'visible.txt' }),
        textParts('done'),
        toolCallParts('tc2', 'read', { path: '../b/secret.txt' }),
        textParts('done'),
      ]),
      model: 'test-model',
      defaultWorkingDirectory: rootDir,
      allowedWorkspaceRoots: [rootDir],
      toolMode: 'all',
      registry,
    });
    const session = await runtime.createSession({ workingDirectory: 'a' });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'read visible');
    await waitForEvent(events, 'done');
    const firstResult = events.find((event) => event.type === 'tool_result');
    expect(firstResult).toMatchObject({ isError: false });
    expect(JSON.stringify(firstResult)).toContain('visible');

    events.length = 0;
    await runtime.prompt(session.id, 'read secret');
    await waitForEvent(events, 'done');
    const secondResult = events.find((event) => event.type === 'tool_result');
    expect(secondResult).toMatchObject({ isError: true });
    expect(JSON.stringify(secondResult)).toContain('workspace');
    runtime.dispose();
  });

  test('denies write tools without an approval channel before writing', async () => {
    const registry = await createWorkspaceToolRegistry();
    mkdirSync(join(rootDir, 'project'));
    const runtime = new CortxRuntime({
      language: mockLanguage([
        toolCallParts('tc1', 'write', { path: 'owned.txt', content: 'owned' }),
        textParts('done'),
      ]),
      model: 'test-model',
      defaultWorkingDirectory: rootDir,
      allowedWorkspaceRoots: [rootDir],
      toolMode: 'all',
      registry,
    });
    const session = await runtime.createSession({ workingDirectory: 'project' });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'write file');
    await waitForEvent(events, 'done');
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('not approved');
    expect(existsSync(join(rootDir, 'project', 'owned.txt'))).toBe(false);
    runtime.dispose();
  });

  test('rejects sessions outside allowed workspace roots', async () => {
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('ok')]),
      model: 'test-model',
      defaultWorkingDirectory: rootDir,
      allowedWorkspaceRoots: [rootDir],
    });
    await expect(runtime.createSession({ workingDirectory: outsideDir })).rejects.toMatchObject({
      kind: 'invalid_workspace',
    });
    runtime.dispose();
  });

  test('rejects sessions through symlinked workspace escapes', async () => {
    symlinkSync(outsideDir, join(rootDir, 'outside-link'));
    const runtime = new CortxRuntime({
      language: mockLanguage([textParts('ok')]),
      model: 'test-model',
      defaultWorkingDirectory: rootDir,
      allowedWorkspaceRoots: [rootDir],
    });
    await expect(runtime.createSession({ workingDirectory: 'outside-link' })).rejects.toMatchObject({
      kind: 'invalid_workspace',
    });
    runtime.dispose();
  });
});
