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

  // askUser callback: for tool permission prompts, we use a simple readline fallback
  // since Ink hasn't taken over stdin yet at this point
  const askUser = (question: string): Promise<string> => {
    // Will be wired into Ink's input system in future units
    // For now, return a default allow response
    log.info(`askUser: ${question}`);
    return Promise.resolve('yes');
  };

  const agent = new Cortx(language, {
    appName: 'cortx',
    model: config.model,
    system: config.system,
    maxIterations: config.maxIterations,
    workingDirectory: cwd,
    tools: createAllTools(cwd),
    registry,
    plugins: config.agentPlugins,
    askUser,
    logger: log,
  });

  const session = new CortxSession(agent);

  // Render Ink TUI (non-fullscreen with patchConsole so console.log output
  // appears above the Ink frame — gives native terminal scrollback)
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
