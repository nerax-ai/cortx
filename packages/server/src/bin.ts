import { Synax, type SynaxRegistry } from '@synax-ai/core';
import { PluginRegistry } from '@nerax-ai/plugin';
import { getStorage } from '@nerax-ai/storage';
import { createLogger } from '@nerax-ai/logger';
import type { CortxFactoryMap, CortxExtensionType, CortxRegistry } from '@cortx/core';
import { createServer } from './server.js';

interface CortxConfig {
  model: string;
  system?: string;
  maxIterations?: number;
  workingDirectory?: string;
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

  const app = createServer({
    apiKey,
    language: synax.language,
    model: config.model,
    system: config.system,
    maxIterations: config.maxIterations,
    registry,
    plugins: config.agentPlugins,
    defaultWorkingDirectory: config.workingDirectory ?? process.cwd(),
    allowedWorkspaceRoots: [config.workingDirectory ?? process.cwd()],
    toolMode: 'all',
    approvalMode: 'interactive',
    logger: log.scope('server'),
    maxSessions: 10,
    idleTimeoutMs: 30 * 60 * 1000,
  });

  const port = Number(process.env.PORT) || 3000;

  Bun.serve({ port, fetch: app.fetch, idleTimeout: 255 });

  console.log(`\n  cortx web server`);
  console.log(`  ─────────────────`);
  console.log(`  API:   http://localhost:${port}`);
  console.log(`  Key:   ${apiKey}`);
  console.log(`  Model: ${config.model}\n`);
}

main().catch(async (e) => {
  log.error(e);
  await log.close();
  console.error(e);
  process.exit(1);
});
