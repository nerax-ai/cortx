import { Synax, type SynaxRegistry } from '@synax-ai/core';
import { PluginRegistry } from '@nerax-ai/plugin';
import { getStorage } from '@nerax-ai/storage';
import { createLogger } from '@nerax-ai/logger';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  FileDurableRunStore,
  type CortxFactoryMap,
  type CortxExtensionType,
  type CortxRegistry,
  type RuntimeApprovalMode,
  type WorkspaceToolMode,
} from '@cortx/runtime';
import { createServerRuntime } from './server.js';

interface CortxConfig {
  model: string;
  system?: string;
  maxIterations?: number;
  workingDirectory?: string;
  allowedWorkspaceRoots?: string[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
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

async function main() {
  const config = await loadServerConfig();
  if (!config) {
    console.error('No cortx config found. Run the TUI first to set up providers.');
    await log.close();
    process.exit(1);
  }

  const apiKey = process.env.CORTX_API_KEY || 'cortx-dev-key';

  const registry = PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({
    appName: 'cortx',
    logger: log,
  }) as CortxRegistry;
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

  const defaultWorkingDirectory = resolve(config.workingDirectory ?? findProjectRoot(process.cwd()));
  const allowedWorkspaceRoots = [...new Set([
    defaultWorkingDirectory,
    ...(config.allowedWorkspaceRoots ?? []),
  ].map((path) => resolve(path)))];

  const handle = createServerRuntime({
    apiKey,
    language: synax.language,
    model: config.model,
    system: config.system,
    maxIterations: config.maxIterations,
    registry,
    plugins: config.agentPlugins,
    defaultWorkingDirectory,
    allowedWorkspaceRoots,
    toolMode: config.toolMode ?? 'all',
    approvalMode: config.approvalMode ?? 'interactive',
    durableStore: new FileDurableRunStore(process.env.CORTX_DURABLE_DIR || resolve(defaultWorkingDirectory, '.cortx', 'runtime')),
    logger: log.scope('server'),
    maxSessions: 10,
    idleTimeoutMs: 30 * 60 * 1000,
  });
  await handle.runtime.restoreDurableSessions({ autoResume: false });

  const port = Number(process.env.PORT) || 3000;

  Bun.serve({ port, fetch: handle.app.fetch, idleTimeout: 255 });

  console.log(`\n  cortx web server`);
  console.log(`  ─────────────────`);
  console.log(`  API:   http://localhost:${port}`);
  console.log(`  Key:   ${apiKey}`);
  console.log(`  Model: ${config.model}\n`);
  console.log(`  Workspace: ${defaultWorkingDirectory}`);
  console.log(`  Roots: ${allowedWorkspaceRoots.join(', ')}\n`);
}

main().catch(async (e) => {
  log.error(e);
  await log.close();
  console.error(e);
  process.exit(1);
});
