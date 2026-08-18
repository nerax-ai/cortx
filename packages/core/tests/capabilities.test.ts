import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cortx, createEmptyAgentRuntimeExtensions } from '../src/index.js';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageMessage } from '@cortx/sdk';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `cortx-core-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeSkill(name: string, body: string): Promise<void> {
  const skillDir = join(testDir, '.cortx', 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n${body}`);
}

function messageText(message: LanguageMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return content?.find((part) => part.type === 'text')?.text ?? '';
}

function capturingLanguage(captured: { messages?: LanguageMessage[] }): LanguageClient {
  return {
    stream: async function* (request: { messages: LanguageMessage[] }) {
      captured.messages = request.messages;
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      };
    },
  } as unknown as LanguageClient;
}

describe('Cortx kernel inputs', () => {
  test('does not mount a sub-agent tool by default', () => {
    const cortx = new Cortx(capturingLanguage({}), { model: 'test' });

    expect((cortx as unknown as { tools: Map<string, unknown> }).tools.has('agent')).toBe(false);
  });

  test('does not discover or expand skill assets by default', async () => {
    await writeSkill('commit', 'Expanded commit body: $ARGUMENTS');

    const captured: { messages?: LanguageMessage[] } = {};
    const cortx = new Cortx(capturingLanguage(captured), {
      model: 'test',
      workingDirectory: testDir,
    });
    for await (const event of cortx.run('/commit fix: typo')) {
      if (event.type === 'done') break;
    }

    expect(messageText(captured.messages?.at(-1))).toBe('/commit fix: typo');
  });

  test('keeps explicit tools and extensions as kernel inputs', async () => {
    const captured: { messages?: LanguageMessage[] } = {};
    const extensions = createEmptyAgentRuntimeExtensions();
    extensions.systemTransforms.push({
      transformSystem(input) {
        return { system: `${input.system}\nexplicit system extension` };
      },
    });
    const cortx = new Cortx(capturingLanguage(captured), {
      model: 'test',
      extensions,
      tools: [{
        name: 'readSomething',
        inputSchema: {},
        execute: async () => ({ success: true, output: 'ok' }),
      }],
    });
    expect((cortx as unknown as { tools: Map<string, unknown> }).tools.has('readSomething')).toBe(true);

    for await (const event of cortx.run('hello')) {
      if (event.type === 'done') break;
    }

    expect(messageText(captured.messages?.[0])).toContain('explicit system extension');
  });
});
