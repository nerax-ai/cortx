import { Synax, type SynaxRegistry } from '@synax-ai/core';
import { PluginRegistry } from '@nerax-ai/plugin';
import { getStorage } from '@nerax-ai/storage';
import { createLogger } from '@nerax-ai/logger';
import type { ContextUsageSource } from '@cortx/sdk';
import { cpSync, existsSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { delimiter, dirname, parse, resolve } from 'path';
import {
  FileDurableRunStore,
  type CortxFactoryMap,
  type CortxExtensionType,
  type CortxRegistry,
  type RuntimeApprovalMode,
  type WorkspaceToolMode,
} from '@cortx/runtime';
import { createServerRuntime } from './server.js';
import type { ServerAuthKey } from './auth.js';

interface CortxConfig {
  model: string;
  system?: string;
  maxIterations?: number;
  maxSessions?: number;
  maxEventsPerSession?: number;
  idleTimeoutMs?: number;
  contextWindowTokens?: number;
  workingDirectory?: string;
  allowedWorkspaceRoots?: string[];
  agentSpecRoots?: string[];
  apiKeys?: ServerAuthKey[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  workspaceToolsPlugin?: string | false;
  plugins?: string[];
  agentPlugins?: Array<{ use: string; options?: Record<string, unknown> }>;
  providers?: Array<{ id: string; use: string; options: Record<string, unknown> }>;
  groups?: Array<{ id: string; members: Array<{ provider: string; model: string }> }>;
}

export async function loadServerConfig(): Promise<CortxConfig | undefined> {
  const storage = getStorage('cortx');
  return storage.config.readJSON<CortxConfig>('cortx.json');
}

const log = createLogger({
  appName: 'cortx',
  console: false,
  files: [{ filename: 'server-%DATE%.log', level: 'debug' }],
});

function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(`${current}/.git`) || existsSync(`${current}/bun.lock`) || existsSync(`${current}/package.json`)) {
      if (existsSync(`${current}/packages`) || existsSync(`${current}/.git`)) return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function readEnvPathList(name: string): string[] {
  const value = process.env[name];
  if (!value?.trim()) return [];
  return value
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean);
}

function readPositiveEnvNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function modelContextWindowFromSynax(synax: Synax, model: string): number | undefined {
  const found = synax.listModels().find((entry) => entry.id === model || entry.name === model);
  const context = found?.limits?.context;
  return typeof context === 'number' && Number.isFinite(context) && context > 0 ? Math.floor(context) : undefined;
}

function resolveContextWindow(config: CortxConfig, synax: Synax): { tokens?: number; source?: ContextUsageSource } {
  const envContext = readPositiveEnvNumber('CORTX_CONTEXT_WINDOW_TOKENS');
  if (envContext !== undefined) return { tokens: envContext, source: 'configured' };
  if (config.contextWindowTokens !== undefined) return { tokens: config.contextWindowTokens, source: 'configured' };
  const modelContext = modelContextWindowFromSynax(synax, config.model);
  if (modelContext !== undefined) return { tokens: modelContext, source: 'model_metadata' };
  return {};
}

function resolveMaxSessions(config: CortxConfig): number {
  return (
    readPositiveEnvNumber('CORTX_MAX_RUNNING_SESSIONS') ??
    readPositiveEnvNumber('CORTX_MAX_SESSIONS') ??
    config.maxSessions ??
    10
  );
}

function defaultAgentSpecRoots(defaultWorkingDirectory: string): string[] {
  return [
    resolve(homedir(), '.cortx', 'agents'),
    resolve(homedir(), '.cortx', 'agent-specs'),
    resolve(defaultWorkingDirectory, '.cortx', 'agents'),
    resolve(defaultWorkingDirectory, '.cortx', 'agent-specs'),
  ];
}

function resolveWorkspaceToolsPluginSource(config: CortxConfig, projectRoot: string): string | undefined {
  if (config.workspaceToolsPlugin === false) return undefined;
  if (typeof config.workspaceToolsPlugin === 'string' && config.workspaceToolsPlugin.trim()) {
    return config.workspaceToolsPlugin.trim();
  }
  const envSource = process.env.CORTX_WORKSPACE_TOOLS_PLUGIN;
  if (envSource?.trim()) return envSource.trim();
  const candidate = resolve(projectRoot, '..', 'cortx-plugins', 'workspace-tools');
  return existsSync(resolve(candidate, 'manifest.json')) ? candidate : undefined;
}

function cleanLocalPluginSource(source: string, prefix: string): string {
  const localSource = source.startsWith('file:') ? source.slice(5) : source;
  if (/^[a-z][a-z\d+.-]*:/i.test(localSource) && !localSource.startsWith('/')) return source;
  const dir = resolve(localSource);
  if (!existsSync(resolve(dir, 'manifest.json')) || !existsSync(resolve(dir, 'src'))) return source;
  const cleanDir = mkdtempSync(resolve(tmpdir(), prefix));
  cpSync(resolve(dir, 'manifest.json'), resolve(cleanDir, 'manifest.json'));
  cpSync(resolve(dir, 'src'), resolve(cleanDir, 'src'), { recursive: true });
  return cleanDir;
}

async function main() {
  const config = await loadServerConfig();
  if (!config) {
    console.error('No cortx config found. Run the TUI first to set up providers.');
    await log.close();
    process.exit(1);
  }

  const apiKey = process.env.CORTX_API_KEY || 'cortx-dev-key';
  const projectRoot = findProjectRoot(process.cwd());
  const configuredWorkspaceToolsPluginSource = resolveWorkspaceToolsPluginSource(config, projectRoot);
  const workspaceToolsPluginSource = configuredWorkspaceToolsPluginSource
    ? cleanLocalPluginSource(configuredWorkspaceToolsPluginSource, 'cortx-workspace-tools-plugin-')
    : undefined;

  const registry = PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({
    appName: 'cortx',
    logger: log,
  }) as CortxRegistry;
  if (workspaceToolsPluginSource) {
    await registry.load(workspaceToolsPluginSource);
  }
  for (const source of config.plugins ?? []) {
    await registry.load(source);
  }

  const synax = new Synax({
    appName: 'cortx',
    registry: registry as unknown as SynaxRegistry,
    providers: [],
    groups: config.groups ?? [],
    logger: log.scope('synax'),
  });
  for (const p of config.providers ?? []) {
    await synax.addProvider(p);
  }

  const defaultWorkingDirectory = resolve(config.workingDirectory ?? projectRoot);
  const configuredRoots = [...readEnvPathList('CORTX_WORKSPACE_ROOTS'), ...(config.allowedWorkspaceRoots ?? [])];
  const browseRoots = configuredRoots.length ? configuredRoots : [parse(defaultWorkingDirectory).root];
  const allowedWorkspaceRoots = [...new Set([...browseRoots, defaultWorkingDirectory].map((path) => resolve(path)))];
  const configuredAgentSpecRoots = [...readEnvPathList('CORTX_AGENT_SPEC_ROOTS'), ...(config.agentSpecRoots ?? [])];
  const agentSpecRoots = [
    ...new Set(
      (configuredAgentSpecRoots.length ? configuredAgentSpecRoots : defaultAgentSpecRoots(defaultWorkingDirectory)).map((path) =>
        resolve(path),
      ),
    ),
  ];
  const contextWindow = resolveContextWindow(config, synax);
  const maxSessions = resolveMaxSessions(config);
  const maxEventsPerSession = readPositiveEnvNumber('CORTX_MAX_EVENTS_PER_SESSION') ?? config.maxEventsPerSession;
  const idleTimeoutMs = readPositiveEnvNumber('CORTX_IDLE_TIMEOUT_MS') ?? config.idleTimeoutMs ?? 30 * 60 * 1000;

  const handle = createServerRuntime({
    apiKey,
    language: synax.language,
    model: config.model,
    models: synax.listModels(),
    modelCatalog: synax.listModelCatalog(),
    system: config.system,
    maxIterations: config.maxIterations,
    contextWindowTokens: contextWindow.tokens,
    contextWindowSource: contextWindow.source,
    registry,
    plugins: config.agentPlugins,
    apiKeys: config.apiKeys,
    defaultWorkingDirectory,
    allowedWorkspaceRoots,
    agentSpecRoots,
    toolMode: config.toolMode ?? (workspaceToolsPluginSource ? 'all' : 'none'),
    approvalMode: config.approvalMode ?? 'interactive',
    durableStore: new FileDurableRunStore(
      process.env.CORTX_DURABLE_DIR || resolve(defaultWorkingDirectory, '.cortx', 'runtime'),
    ),
    logger: log.scope('server'),
    maxSessions,
    maxEventsPerSession,
    idleTimeoutMs,
  });
  await handle.runtime.restoreDurableSessions({ autoResume: false });

  const port = Number(process.env.PORT) || 3000;

  const server = Bun.serve({ port, fetch: handle.app.fetch, idleTimeout: 255 });

  console.log(`\n  cortx web server`);
  console.log(`  ─────────────────`);
  console.log(`  API:   http://localhost:${port}`);
  console.log(`  Key:   ${apiKey}`);
  console.log(`  Model: ${config.model}\n`);
  console.log(`  Context: ${contextWindow.tokens ? `${contextWindow.tokens} tokens (${contextWindow.source})` : 'unknown'}\n`);
  console.log(`  Concurrency: ${maxSessions} running sessions`);
  console.log(`  Idle TTL: ${idleTimeoutMs} ms\n`);
  console.log(`  Workspace: ${defaultWorkingDirectory}`);
  console.log(`  Roots: ${allowedWorkspaceRoots.join(', ')}\n`);
  console.log(`  Workspace tools: ${workspaceToolsPluginSource ?? 'disabled'}\n`);
  console.log(`  AgentSpecs: ${agentSpecRoots.join(', ')}\n`);

  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

  await new Promise<void>((resolve) => {
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      clearInterval(keepAlive);
      server.stop();
      handle.dispose();
      await log.close();
      resolve();
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
}

main().catch(async (e) => {
  log.error(e);
  await log.close();
  console.error(e);
  process.exit(1);
});
