import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageClient } from '@synax-ai/core';
import type { Tool } from '@cortx/sdk';
import { CortxRuntime } from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-session-projection-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started >= timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('runtime session projection', () => {
  test('projects idle/running phase and stable running-only follow-up admission', async () => {
    const gate = deferred();
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          await gate.promise;
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'projection' });

    expect(session).toMatchObject({
      runtimeIncarnation: runtime.runtimeIncarnation,
      projectionAsOfSequence: 0,
      runPhase: 'idle',
      sessionHealth: 'healthy',
      pendingInteraction: null,
      acceptsPrompt: true,
      isRunning: false,
    });
    expect(() => runtime.followUp(session.id, 'too early', 'input:idle')).toThrow(/running session/i);

    await runtime.prompt(session.id, 'start');
    expect(runtime.getSession(session.id)).toMatchObject({ runPhase: 'running', acceptsPrompt: false, isRunning: true });

    const first = runtime.followUp(session.id, 'continue', 'input:stable');
    const retry = runtime.followUp(session.id, 'continue', 'input:stable');
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ inputId: 'input:stable', message: 'continue' });
    expect(first.admissionSequence).toBeGreaterThan(0);
    expect(() => runtime.followUp(session.id, 'different', 'input:stable')).toThrow(/different payload/i);

    gate.resolve();
    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    await runtime.close();
  });

  test('rejects reconfiguration while running without staging a divergent host', async () => {
    const gate = deferred();
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          await gate.promise;
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'busy-reconfigure' });
    await runtime.prompt(session.id, 'start');

    await expect(runtime.updateSession(session.id, { model: 'other-model' })).rejects.toMatchObject({ kind: 'session_busy' });
    expect(runtime.getSession(session.id).model).toBe('test-model');

    gate.resolve();
    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    await runtime.close();
  });

  test('projects pending approval and clears it after the matching answer', async () => {
    let executed = false;
    const tool: Tool = {
      name: 'writeFile',
      sideEffects: 'write',
      inputSchema: {},
      execute: async () => {
        executed = true;
        return { success: true, output: 'written' };
      },
    };
    let response = 0;
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          if (response++ === 0) {
            yield { type: 'tool-input-start', id: 'write-call', toolName: 'writeFile' };
            yield { type: 'tool-input-delta', id: 'write-call', delta: '{}' };
            yield { type: 'tool-input-end', id: 'write-call' };
            yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
          } else {
            yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
          }
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'interactive',
      tools: [tool],
      capabilities: { skills: false, subAgents: false, approval: true },
    });
    const session = await runtime.createSession({ id: 'approval' });
    await runtime.prompt(session.id, 'write');
    await waitFor(() => runtime.getSession(session.id).runPhase === 'waiting_approval');

    expect(runtime.getSession(session.id).pendingInteraction).toMatchObject({
      requestId: 'write-call',
      kind: 'approval',
      runtimeIncarnation: runtime.runtimeIncarnation,
    });
    expect(runtime.answer(session.id, 'other-call', 'yes')).toBe(false);
    expect(runtime.getSession(session.id).runPhase).toBe('waiting_approval');
    expect(runtime.answer(session.id, 'write-call', 'yes')).toBe(true);

    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    expect(runtime.getSession(session.id).pendingInteraction).toBeNull();
    expect(executed).toBe(true);
    await runtime.close();
  });
});
