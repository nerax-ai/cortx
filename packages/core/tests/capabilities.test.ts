import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cortx } from '../src/index.js';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageMessage } from '@cortx/sdk';
import { PluginRegistry } from '@nerax-ai/plugin';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `cortx-core-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  PluginRegistry.reset();
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

describe('Cortx capability mounting', () => {
  test('sub-agent tool can be disabled by configuration', () => {
    const cortx = new Cortx(capturingLanguage({}), {
      model: 'test',
      capabilities: { subAgents: 'disabled' },
    });

    expect((cortx as unknown as { tools: Map<string, unknown> }).tools.has('agent')).toBe(false);
  });

  test('skill bridge is enabled by default and can be disabled', async () => {
    await writeSkill('commit', 'Expanded commit body: $ARGUMENTS');

    const enabledCapture: { messages?: LanguageMessage[] } = {};
    const enabled = new Cortx(capturingLanguage(enabledCapture), {
      model: 'test',
      workingDirectory: testDir,
      capabilities: { subAgents: 'disabled' },
    });
    for await (const event of enabled.run('/commit fix: typo')) {
      if (event.type === 'done') break;
    }

    const disabledCapture: { messages?: LanguageMessage[] } = {};
    const disabled = new Cortx(capturingLanguage(disabledCapture), {
      model: 'test',
      workingDirectory: testDir,
      capabilities: { skills: 'disabled', subAgents: 'disabled' },
    });
    for await (const event of disabled.run('/commit fix: typo')) {
      if (event.type === 'done') break;
    }

    expect(messageText(enabledCapture.messages?.at(-1))).toContain('Expanded commit body: fix: typo');
    expect(messageText(disabledCapture.messages?.at(-1))).toBe('/commit fix: typo');
  });
});
