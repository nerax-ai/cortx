import { render } from 'ink';
import { createLogger } from '@nerax-ai/logger';
import { PluginRegistry } from '@nerax-ai/plugin';
import { Cortx, CortxSession, type CortxFactoryMap, type CortxExtensionType } from '@cortx/core';
import { createAllTools } from '@cortx/code';
import { ensureConfig } from './config.js';
import { createLanguageClient, type ProjectPluginRegistry } from './language.js';
import App from './app.js';

const log = createLogger({
  appName: 'cortx',
  console: false,
  files: [{ filename: 'cortx-%DATE%.log', level: 'debug' }],
});

async function main() {
  const config = await ensureConfig();
  const cwd = config.workingDirectory ?? process.cwd();
  const registry = PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({
    appName: 'cortx',
    logger: log,
  }) as ProjectPluginRegistry;
  const language = await createLanguageClient(config, log, registry);

  const agent = new Cortx(language, {
    appName: 'cortx',
    model: config.model,
    system: config.system,
    maxIterations: config.maxIterations,
    workingDirectory: cwd,
    tools: createAllTools(cwd),
    registry,
    plugins: config.agentPlugins,
    logger: log,
  });

  const session = new CortxSession(agent);

  // Render the whole conversation inside Ink so output stays between the header and composer.
  const { waitUntilExit } = render(
    <App session={session} model={config.model} cwd={cwd} logger={log.scope('tui')} />,
    { exitOnCtrlC: false, patchConsole: true },
  );

  await waitUntilExit();
  await log.close();
}

main().catch(async (e) => {
  log.error(e);
  await log.close();
  console.error(e);
  process.exit(1);
});
