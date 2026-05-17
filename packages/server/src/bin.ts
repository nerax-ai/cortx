import { Synax } from '@synax-ai/core';
import { PluginRegistry } from '@nerax-ai/plugin';
import { getStorage } from '@nerax-ai/storage';
import { createServer } from './server.js';

interface CortxConfig {
  model: string;
  system?: string;
  maxIterations?: number;
  workingDirectory?: string;
  plugins?: string[];
  providers?: Array<{ id: string; use: string; options: Record<string, unknown> }>;
  groups?: Array<{ id: string; members: Array<{ provider: string; model: string }> }>;
}

export async function loadServerConfig(): Promise<CortxConfig | undefined> {
  const storage = getStorage('cortx');
  return storage.config.readJSON<CortxConfig>('cortx.json');
}

async function main() {
  const config = await loadServerConfig();
  if (!config) {
    console.error('No cortx config found. Run the TUI first to set up providers.');
    process.exit(1);
  }

  const apiKey = process.env.CORTX_API_KEY || 'cortx-dev-key';

  const registry = PluginRegistry.getInstance({ appName: 'cortx' });
  for (const source of config.plugins ?? []) {
    await registry.load(source);
  }

  const synax = new Synax({ providers: [], groups: config.groups ?? [] });
  for (const p of config.providers ?? []) {
    await synax.addProvider(p);
  }

  const app = createServer({
    apiKey,
    language: synax.language,
    model: config.model,
    system: config.system,
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
