import { render } from 'ink';
import { getLogger } from '@nerax-ai/logger';
import { Cortx, CortxSession } from '@cortx/core';
import { createAllTools } from '@cortx/code';
import { ensureConfig } from './config.js';
import { createLanguageClient } from './language.js';
import App from './app.js';

const log = getLogger('cortx', {
  console: false,
  files: [{ filename: 'cortx-%DATE%.log', level: 'debug' }],
});

async function main() {
  const config = await ensureConfig();
  const cwd = config.workingDirectory ?? process.cwd();
  const language = await createLanguageClient(config, log);

  // askUser callback: for tool permission prompts, we use a simple readline fallback
  // since Ink hasn't taken over stdin yet at this point
  const askUser = (question: string): Promise<string> => {
    // Will be wired into Ink's input system in future units
    // For now, return a default allow response
    log.info(`askUser: ${question}`);
    return Promise.resolve('yes');
  };

  const agent = new Cortx(language, {
    model: config.model,
    system: config.system,
    maxIterations: config.maxIterations,
    workingDirectory: cwd,
    tools: createAllTools(cwd),
    askUser,
    logger: log,
  });

  const session = new CortxSession(agent);

  // Render Ink TUI (alternateScreen for proper layout, no incrementalRendering to avoid content loss)
  const { waitUntilExit } = render(
    <App session={session} model={config.model} cwd={cwd} />,
    { exitOnCtrlC: false, alternateScreen: true },
  );

  await waitUntilExit();
}

main().catch((e) => {
  log.error(e);
  console.error(e);
  process.exit(1);
});
