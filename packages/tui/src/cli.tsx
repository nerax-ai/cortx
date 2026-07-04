import { render } from 'ink';
import { createLogger } from '@nerax-ai/logger';
import { PluginRegistry } from '@nerax-ai/plugin';
import type { CortxFactoryMap, CortxExtensionType } from '@cortx/core';
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
          const language = await createLanguageClient(config, log, registry);
          return createLocalRuntimeSession({
            language,
            model: config.model,
            system: config.system,
            maxIterations: config.maxIterations,
            workingDirectory: cwd,
            registry,
            plugins: config.agentPlugins,
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
