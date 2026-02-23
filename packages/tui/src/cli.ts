import * as readline from 'node:readline';
import { createInterface } from 'node:readline';
import { createLogger } from '@nerax-ai/logger';
import { Cortx } from '@cortx/core';
import { createCodingTools } from '@cortx/code';
import { ensureConfig } from './config.js';
import { createLanguageClient } from './language.js';

const log = createLogger({
  appName: 'cortx',
  files: [{ filename: 'cortx-%DATE%.log', level: 'debug' }],
});

async function main() {
  const config = await ensureConfig();
  const cwd = config.workingDirectory ?? process.cwd();
  const language = await createLanguageClient(config, log);

  const agent = new Cortx(language, {
    model: config.model,
    system: config.system,
    maxIterations: config.maxIterations,
    workingDirectory: cwd,
    tools: createCodingTools(cwd),
    askUser: (q) => ask(rl, q),
    logger: log,
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`cortx - coding agent (model: ${config.model}, cwd: ${cwd})`);
  console.log('Commands: /exit /clear /config\n');

  rl.on('close', () => process.exit(0));

  const prompt = () => rl.question('> ', async (input) => {
    const msg = input.trim();
    if (!msg) return prompt();
    if (msg === '/exit' || msg === '/quit') { rl.close(); return; }
    if (msg === '/clear') { agent.clearHistory(); console.log('History cleared.'); return prompt(); }
    if (msg === '/config') { console.log(JSON.stringify(config, null, 2)); return prompt(); }

    log.info(`user: ${msg}`);
    try {
      for await (const event of agent.run(msg)) {
        if (event.type === 'text_delta') process.stdout.write(event.delta);
        else if (event.type === 'text') process.stdout.write('\n');
        else if (event.type === 'turn_start') {
          console.log(`\n\x1b[2m─── iteration ${event.iteration} ───\x1b[0m`);
        }
        else if (event.type === 'tool_use') {
          const input = event.toolCall.input;
          let inputStr: string;
          try {
            // Try to parse as JSON if it's a string
            const parsed = typeof input === 'string' ? JSON.parse(input) : input;
            inputStr = JSON.stringify(parsed, null, 2);
          } catch {
            inputStr = String(input);
          }
          console.log(`\n\x1b[36m[tool: ${event.toolCall.toolName}]\x1b[0m`);
          console.log(`\x1b[2m${inputStr}\x1b[0m`);
          log.debug(`tool_use: ${event.toolCall.toolName} ${JSON.stringify(input)}`);
        }
        else if (event.type === 'tool_result') {
          const resultStr = String(event.result);
          const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + '... (truncated)' : resultStr;
          console.log(`\x1b[32m[result]\x1b[0m \x1b[2m${truncated}\x1b[0m`);
          log.debug(`tool_result: ${resultStr}`);
        }
        else if (event.type === 'error') { console.error(`\nError: ${event.error.message}`); log.error(event.error.message, event.error); }
        else if (event.type === 'done') { console.log('\n\x1b[2m─── done ───\x1b[0m'); }
      }
    } catch (e: any) {
      console.error(`\nFatal: ${e.message}`);
      log.error(`Fatal: ${e.message}`, e);
    }
    prompt();
  });

  prompt();
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(`${question} `, resolve));
}

main().catch((e) => { log.error(e); console.error(e); });
