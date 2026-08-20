import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageClient } from '@synax-ai/core';
import type { Tool } from '@cortx/sdk';
import { CortxRuntime, FileDurableRunStore } from '../src/index';

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
  test('does not publish a registry entry when initial Host creation fails', async () => {
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          yield { type: 'finish', finishReason: 'stop' };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const brokenTool = {
      name: 'broken',
      inputSchema: {},
      execute: async () => ({ success: true }),
    } as Tool;
    Object.defineProperty(brokenTool, 'sideEffects', {
      get() {
        throw new Error('host assembly failed');
      },
    });

    await expect(runtime.createSession({ id: 'broken-host', tools: [brokenTool] })).rejects.toThrow('host assembly failed');
    expect(runtime.listSessions()).toEqual([]);
    expect(runtime.getSessionSummaryBaseline().sessions).toEqual([]);
    await runtime.close();
  });

  test('exposes a detail-free summary baseline and no-window facade change feed', async () => {
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const first = await runtime.createSession({ id: 'feed:first' });
    const baseline = runtime.getSessionSummaryBaseline();
    const changes: ReturnType<CortxRuntime['getSessionSummaryChanges']> = [];
    const unsubscribe = runtime.subscribeSessionSummaries(baseline.cursor, (change) => changes.push(change));

    const second = await runtime.createSession({ id: 'feed:second' });
    await runtime.updateSession(first.id, { model: 'updated-model' });
    await runtime.deleteSession(second.id);

    expect(baseline.sessions).toEqual([
      expect.objectContaining({ id: first.id, pluginGeneration: expect.any(String) }),
    ]);
    expect(baseline.sessions[0]).not.toHaveProperty('queuedInputs');
    expect(baseline.sessions[0]).not.toHaveProperty('pendingInteraction');
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'added', sessionId: second.id }),
      expect.objectContaining({ type: 'updated', sessionId: first.id }),
      expect.objectContaining({ type: 'removed', sessionId: second.id }),
    ]));
    expect(runtime.getSessionSummaryChanges(baseline.cursor)).toEqual(changes);

    unsubscribe();
    await runtime.close();
  });

  test('keeps plugin generation stable across runs and changes it only when the capability assembly changes', async () => {
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          yield { type: 'finish', finishReason: 'stop' };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      approvalMode: 'interactive',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'stable-plugin-generation' });
    const initial = session.pluginGeneration;

    await runtime.prompt(session.id, 'first');
    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    await runtime.prompt(session.id, 'second');
    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    expect(runtime.getSession(session.id).pluginGeneration).toBe(initial);

    const updated = await runtime.updateSession(session.id, { approvalMode: 'deny' });
    expect(updated.pluginGeneration).not.toBe(initial);
    await runtime.close();
  });

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
    await expect(runtime.followUp(session.id, 'too early', 'input:idle')).rejects.toThrow(/running session/i);

    await runtime.prompt(session.id, 'start');
    expect(runtime.getSession(session.id)).toMatchObject({ runPhase: 'running', acceptsPrompt: false, isRunning: true });

    const first = await runtime.followUp(session.id, 'continue', 'input:stable');
    const retry = await runtime.followUp(session.id, 'continue', 'input:stable');
    expect(retry).toEqual(first);
    expect(runtime.getSession(session.id).promptHistory).toEqual(['start', 'continue']);
    expect(first).toMatchObject({ inputId: 'input:stable', message: 'continue' });
    expect(first.admissionSequence).toBeGreaterThan(0);
    await expect(runtime.followUp(session.id, 'different', 'input:stable')).rejects.toThrow(/different payload/i);

    gate.resolve();
    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    await runtime.close();
  });

  test('deduplicates accepted mutations by command id and rejects conflicting retries', async () => {
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
    const session = await runtime.createSession({ id: 'command-idempotency' });
    const options = {
      commandId: 'command:prompt:1',
      expectedRuntimeIncarnation: runtime.runtimeIncarnation,
    };

    await Promise.all([
      runtime.prompt(session.id, 'start once', options),
      runtime.prompt(session.id, 'start once', options),
    ]);
    await runtime.prompt(session.id, 'start once', options);

    expect(runtime.getSession(session.id).promptHistory).toEqual(['start once']);
    expect(runtime.getEventHistory(session.id).filter((event) => event.type === 'user_message')).toHaveLength(1);
    await expect(runtime.prompt(session.id, 'different payload', options)).rejects.toMatchObject({ kind: 'conflict' });
    await expect(runtime.followUp(session.id, 'continue', 'input:stale', {
      commandId: 'command:follow-up:stale',
      expectedRuntimeIncarnation: 'runtime:stale',
    })).rejects.toMatchObject({ kind: 'conflict' });

    gate.resolve();
    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    await runtime.close();
  });

  test('persists command receipts while fencing retries from an older runtime incarnation', async () => {
    const durableDir = join(tmpDir, 'command-receipts');
    const firstStore = new FileDurableRunStore(durableDir);
    const first = new CortxRuntime({
      language: {
        stream: async function* () {
          yield { type: 'finish', finishReason: 'stop' };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      durableStore: firstStore,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await first.createSession({ id: 'durable-command-receipt' });
    const oldIncarnation = first.runtimeIncarnation;
    const options = {
      commandId: 'command:update:1',
      expectedRuntimeIncarnation: oldIncarnation,
    };
    await first.updateSession(session.id, { model: 'updated-model' }, options);
    expect((await firstStore.loadRuntimeSession(session.id))?.commandReceipts).toEqual([
      expect.objectContaining({ commandId: options.commandId, kind: 'update_session' }),
    ]);
    firstStore.releaseOwnership();

    const secondStore = new FileDurableRunStore(durableDir);
    const second = new CortxRuntime({
      language: {
        stream: async function* () {
          yield { type: 'finish', finishReason: 'stop' };
        },
      } as unknown as LanguageClient,
      model: 'fallback-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      durableStore: secondStore,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    await second.restoreDurableSessions();

    expect((await secondStore.loadRuntimeSession(session.id))?.commandReceipts).toEqual([
      expect.objectContaining({ commandId: options.commandId, kind: 'update_session' }),
    ]);
    await expect(second.updateSession(session.id, { model: 'updated-model' }, options)).rejects.toMatchObject({
      kind: 'conflict',
    });

    await second.close();
    await first.close();
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

  test('projects durability failure and refuses later mutations', async () => {
    const store = new FileDurableRunStore(join(tmpDir, 'durable-failure'));
    const runtime = new CortxRuntime({
      language: {
        stream: async function* () {
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
        },
      } as unknown as LanguageClient,
      model: 'test-model',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      durableStore: store,
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const session = await runtime.createSession({ id: 'durability-failure' });
    store.saveEventEnvelope = async () => { throw new Error('disk unavailable'); };

    await expect(runtime.prompt(session.id, 'must be durable')).rejects.toMatchObject({ kind: 'runtime_failure' });
    expect(runtime.getSession(session.id)).toMatchObject({
      sessionHealth: 'durability_failed',
      acceptsPrompt: false,
      runPhase: 'interrupted',
    });
    await expect(runtime.prompt(session.id, 'retry')).rejects.toMatchObject({ kind: 'runtime_failure' });
    await runtime.deleteSession(session.id);
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
    expect(await runtime.answer(session.id, 'other-call', 'yes')).toBe(false);
    expect(runtime.getSession(session.id).runPhase).toBe('waiting_approval');
    expect(await runtime.answer(session.id, 'write-call', 'yes')).toBe(true);

    await waitFor(() => runtime.getSession(session.id).runPhase === 'idle');
    expect(runtime.getSession(session.id).pendingInteraction).toBeNull();
    expect(executed).toBe(true);
    await runtime.close();
  });
});
