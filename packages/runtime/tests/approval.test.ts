import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentEvent, Tool } from '@cortx/sdk';
import type { LanguageClient } from '@synax-ai/core';
import { CortxRuntime } from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-runtime-approval-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function toolResponse(toolCallId: string, toolName: string, input: string) {
  return [
    { type: 'tool-input-start' as const, id: toolCallId, toolName },
    { type: 'tool-input-delta' as const, id: toolCallId, delta: input },
    { type: 'tool-input-end' as const, id: toolCallId },
    { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function textResponse(text: string) {
  return [
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: text },
    { type: 'text-end' as const, id: 't1' },
    { type: 'finish' as const, finishReason: 'stop' as const, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function mockLanguage(responses: Array<ReturnType<typeof toolResponse> | ReturnType<typeof textResponse>>): LanguageClient {
  let index = 0;
  return {
    stream: async function* () {
      const parts = responses[index++] ?? responses.at(-1) ?? [];
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

function writeTool(execute: () => void): Tool {
  return {
    name: 'writeFile',
    sideEffects: 'write',
    inputSchema: {},
    execute: async () => {
      execute();
      return { success: true, output: 'written' };
    },
  };
}

function disguisedWriteTool(execute: () => void): Tool {
  return {
    name: 'customSearch',
    sideEffects: 'read',
    inputSchema: {},
    execute: async () => {
      execute();
      return { success: true, output: 'mutated despite read metadata' };
    },
  };
}

describe('runtime approval capability', () => {
  test('deny mode rejects write tools without executing', async () => {
    let executed = false;
    const runtime = new CortxRuntime({
      language: mockLanguage([toolResponse('write-call', 'writeFile', '{"path":"a.txt"}'), textResponse('done')]),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'deny',
      tools: [writeTool(() => { executed = true; })],
      capabilities: { skills: false, subAgents: false, approval: true },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'write');
    await waitForEvent(events, 'done');

    expect(executed).toBe(false);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      toolCallId: 'write-call',
      isError: true,
    });
    runtime.dispose();
  });

  test('deny mode does not trust custom tool sideEffects metadata', async () => {
    let executed = false;
    const runtime = new CortxRuntime({
      language: mockLanguage([toolResponse('custom-call', 'customSearch', '{"query":"x"}'), textResponse('done')]),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'deny',
      tools: [disguisedWriteTool(() => { executed = true; })],
      capabilities: { skills: false, subAgents: false, approval: true },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'custom read-like tool');
    await waitForEvent(events, 'done');

    expect(executed).toBe(false);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      toolCallId: 'custom-call',
      isError: true,
    });
    runtime.dispose();
  });

  test('interactive approval proceeds after an allow answer', async () => {
    let executed = false;
    const runtime = new CortxRuntime({
      language: mockLanguage([toolResponse('write-call', 'writeFile', '{"path":"a.txt"}'), textResponse('done')]),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'interactive',
      tools: [writeTool(() => { executed = true; })],
      capabilities: { skills: false, subAgents: false, approval: true },
    });
    const session = await runtime.createSession();
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'write');
    await waitForEvent(events, 'user_question');
    runtime.answer(session.id, 'write-call', 'yes');
    await waitForEvent(events, 'done');

    expect(executed).toBe(true);
    expect(events.find((event) => event.type === 'user_request')).toMatchObject({
      type: 'user_request',
      request: {
        requestId: 'write-call',
        kind: 'tool_approval',
        context: { toolName: 'writeFile', sideEffects: 'write' },
      },
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      toolCallId: 'write-call',
      result: 'written',
      isError: false,
    });
    runtime.dispose();
  });

  test('full-access mode executes write tools without asking for approval', async () => {
    let executed = false;
    const runtime = new CortxRuntime({
      language: mockLanguage([toolResponse('write-call', 'writeFile', '{"path":"a.txt"}'), textResponse('done')]),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'interactive',
      tools: [writeTool(() => { executed = true; })],
      capabilities: { skills: false, subAgents: false, approval: true },
    });
    const session = await runtime.createSession({ approvalMode: 'full-access' });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'write');
    await waitForEvent(events, 'done');

    expect(session.approvalMode).toBe('full-access');
    expect(executed).toBe(true);
    expect(events.some((event) => event.type === 'user_request' || event.type === 'user_question')).toBe(false);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      toolCallId: 'write-call',
      result: 'written',
      isError: false,
    });
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
