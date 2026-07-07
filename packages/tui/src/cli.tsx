import { render } from 'ink';
import { createLogger } from '@nerax-ai/logger';
import { PluginRegistry } from '@nerax-ai/plugin';
import { cpSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import type { CortxFactoryMap, CortxExtensionType } from '@cortx/runtime';
import { ensureConfig, type CortxConfig } from './config.js';
import { createLanguageClient, type ProjectPluginRegistry } from './language.js';
import { RemoteRuntimeClient } from './remote-client.js';
import { createLocalRuntimeSession, createRemoteRuntimeSession, type TuiRuntimeMode } from './runtime-session.js';
import App from './app.js';

const log = createLogger({
  appName: 'cortx',
  console: false,
  files: [{ filename: 'cortx-%DATE%.log', level: 'debug' }],
});

function runtimeMode(config: CortxConfig): TuiRuntimeMode {
  const value = process.env.CORTX_TUI_MODE ?? process.env.CORTX_MODE ?? config.runtime?.mode ?? 'local';
  if (value === 'local' || value === 'remote') return value;
  throw new Error(`Unsupported CORTX_TUI_MODE: ${value}`);
}

function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, '.git')) || existsSync(resolve(current, 'bun.lock')) || existsSync(resolve(current, 'package.json'))) {
      if (existsSync(resolve(current, 'packages')) || existsSync(resolve(current, '.git'))) return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function resolveWorkspaceToolsPluginSource(config: CortxConfig, cwd: string): string | undefined {
  if (config.workspaceToolsPlugin === false) return undefined;
  if (typeof config.workspaceToolsPlugin === 'string' && config.workspaceToolsPlugin.trim()) {
    return config.workspaceToolsPlugin.trim();
  }
  const envSource = process.env.CORTX_WORKSPACE_TOOLS_PLUGIN;
  if (envSource?.trim()) return envSource.trim();
  const candidate = resolve(findProjectRoot(cwd), '..', 'cortx-plugins', 'workspace-tools');
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

function remoteOption(
  config: CortxConfig,
  key: 'baseUrl' | 'apiKey' | 'sessionId' | 'workingDirectory',
): string | undefined {
  const env: Record<typeof key, string | undefined> = {
    baseUrl: process.env.CORTX_SERVER_URL,
    apiKey: process.env.CORTX_API_KEY,
    sessionId: process.env.CORTX_SESSION_ID,
    workingDirectory: process.env.CORTX_WORKING_DIRECTORY,
  };
  return env[key] ?? config.runtime?.server?.[key];
}

async function main() {
  const config = await ensureConfig();
  const cwd = config.workingDirectory ?? process.cwd();
  const mode = runtimeMode(config);
  const session =
    mode === 'remote'
      ? await createRemoteRuntimeSession({
          client: new RemoteRuntimeClient({
            baseUrl: remoteOption(config, 'baseUrl') ?? 'http://localhost:3000',
            apiKey: remoteOption(config, 'apiKey') ?? 'cortx-dev-key',
          }),
          sessionId: remoteOption(config, 'sessionId'),
          create: {
            workingDirectory: remoteOption(config, 'workingDirectory') ?? cwd,
            model: config.model,
            system: config.system,
            maxIterations: config.maxIterations,
            plugins: config.agentPlugins,
          },
        })
      : await (async () => {
          const registry = PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({
            appName: 'cortx',
            logger: log,
          }) as ProjectPluginRegistry;
          const configuredWorkspaceToolsPluginSource = resolveWorkspaceToolsPluginSource(config, cwd);
          const workspaceToolsPluginSource = configuredWorkspaceToolsPluginSource
            ? cleanLocalPluginSource(configuredWorkspaceToolsPluginSource, 'cortx-workspace-tools-plugin-')
            : undefined;
          if (workspaceToolsPluginSource) await registry.load(workspaceToolsPluginSource);
          const language = await createLanguageClient(config, log, registry);
          return createLocalRuntimeSession({
            language,
            model: config.model,
            system: config.system,
            maxIterations: config.maxIterations,
            workingDirectory: cwd,
            registry,
            plugins: config.agentPlugins,
            toolMode: workspaceToolsPluginSource ? 'all' : 'none',
            logger: log,
          });
        })();

  // Render the whole conversation inside Ink so output stays between the header and composer.
  const { waitUntilExit } = render(<App session={session} logger={log.scope('tui')} />, {
    exitOnCtrlC: false,
    patchConsole: true,
  });

  await waitUntilExit();
  await log.close();
}

main().catch(async (e) => {
  log.error(e);
  await log.close();
  console.error(e);
  process.exit(1);
});
