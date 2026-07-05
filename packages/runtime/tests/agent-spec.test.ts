import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, LanguageMessage } from '@cortx/sdk';
import { CortxRuntime, loadAgentSpecFile, parseAgentSpec } from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-agent-spec-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function capturingLanguage(captured: { messages?: LanguageMessage[]; tools?: unknown[] }): LanguageClient {
  return {
    stream: async function* (request: { messages: LanguageMessage[]; tools?: unknown[] }) {
      captured.messages = request.messages;
      captured.tools = request.tools;
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      };
    },
  } as unknown as LanguageClient;
}

function neverFinishingLanguage(captured: { messages?: LanguageMessage[]; tools?: unknown[] }): LanguageClient {
  return {
    stream: async function* (request: { messages: LanguageMessage[]; tools?: unknown[] }) {
      captured.messages = request.messages;
      captured.tools = request.tools;
      await new Promise(() => {});
    },
  } as unknown as LanguageClient;
}

function textOf(message: LanguageMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return content?.find((part) => part.type === 'text')?.text ?? '';
}

describe('AgentSpec asset launch', () => {
  test('validates prompt-only specs', () => {
    expect(parseAgentSpec({ prompt: 'hello' })).toMatchObject({ prompt: 'hello' });
    expect(() => parseAgentSpec({ prompt: '' })).toThrow('AgentSpec.prompt');
    expect(() => parseAgentSpec({ prompt: 'ok', skillPaths: [1] })).toThrow('AgentSpec.skillPaths');
    expect(() => parseAgentSpec({ prompt: 'ok', toolMode: 'everything' })).toThrow('AgentSpec.toolMode');
    expect(() => parseAgentSpec({ prompt: 'ok', approvalMode: 'ask' })).toThrow('AgentSpec.approvalMode');
    expect(() => parseAgentSpec({ prompt: 'ok', capabilities: { skills: 'yes' } })).toThrow(
      'AgentSpec.capabilities',
    );
  });

  test('launches a prompt-only agent without product defaults', async () => {
    const captured: { messages?: LanguageMessage[]; tools?: unknown[] } = {};
    const runtime = new CortxRuntime({
      language: capturingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'all',
    });
    const session = await runtime.launchAgentSpec({
      prompt: 'small agent task',
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));
    await waitForEvent(events, 'done');

    expect(textOf(captured.messages?.at(-1))).toBe('small agent task');
    expect(captured.tools ?? []).toEqual([]);
    runtime.dispose();
  });

  test('returns current session info after launching the AgentSpec prompt', async () => {
    const captured: { messages?: LanguageMessage[]; tools?: unknown[] } = {};
    const runtime = new CortxRuntime({
      language: neverFinishingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'all',
    });

    const session = await runtime.launchAgentSpec({
      prompt: 'long running task',
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });

    expect(session.isRunning).toBe(true);
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    runtime.dispose();
  });

  test('loads and launches an AgentSpec JSON file', async () => {
    const specPath = join(tmpDir, 'agent.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        name: 'file-agent',
        prompt: 'file task',
        toolMode: 'none',
        capabilities: { skills: false, subAgents: false, approval: false },
      }),
      'utf8',
    );
    const loaded = await loadAgentSpecFile(specPath);
    expect(loaded).toMatchObject({ name: 'file-agent', prompt: 'file task' });

    const captured: { messages?: LanguageMessage[]; tools?: unknown[] } = {};
    const runtime = new CortxRuntime({
      language: capturingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'all',
    });
    const session = await runtime.launchAgentSpecFile(specPath);
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));
    await waitForEvent(events, 'done');

    expect(session.metadata).toMatchObject({ agentSpec: 'file-agent' });
    expect(textOf(captured.messages?.at(-1))).toBe('file task');
    expect(captured.tools ?? []).toEqual([]);
    runtime.dispose();
  });
});

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type'], timeoutMs = 1_000): Promise<AgentEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = events.find((item) => item.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}
