import { describe, test, expect } from 'bun:test';
import { Cortx } from '../src/index';
import type { AgentEvent } from '../src/index';
import type { LanguageClient } from '@synax-ai/core';

/**
 * Mock LanguageClient that yields a configurable set of events from agentLoop.
 * We instrument agentLoop by providing a language client whose stream yields
 * known stream parts. The agent tool's execute() is tested directly on the
 * Cortx instance.
 */

function mockLanguageClient(): LanguageClient {
  return {
    stream: async function* () {
      // Yield a simple text response
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', delta: 'background result' };
      yield { type: 'text-end', id: 't1' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } };
    },
  } as unknown as LanguageClient;
}

function failingLanguageClient(): LanguageClient {
  return {
    stream: async function* () {
      yield { type: 'tool-input-start', id: 'tc_fail', toolName: 'missing' };
      yield { type: 'tool-input-delta', id: 'tc_fail', delta: '{}' };
      yield { type: 'tool-input-end', id: 'tc_fail' };
      yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
    },
  } as unknown as LanguageClient;
}

function mockCtx(overrides?: Partial<Record<string, unknown>>) {
  const progressMessages: string[] = [];
  return {
    sessionId: 'test-session',
    toolCallId: 'tc_test_' + Date.now(),
    workingDirectory: '/tmp',
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      scope: function () { return this; },
    },
    reportProgress: (text: string) => progressMessages.push(text),
    progressMessages,
    ...overrides,
  };
}

describe('agent tool: run_in_background', () => {
  test('background mode returns immediately with reference ID', async () => {
    const cortx = new Cortx(mockLanguageClient(), { model: 'test' });
    const agentTool = cortx.tools.get('agent')!;

    const result = await agentTool.execute(
      { prompt: 'Do something', description: 'test task', run_in_background: true },
      mockCtx() as any,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Background agent started');
    expect(result.output).toContain('test task');
    expect(result.output).toMatch(/\[ID: /);
  });

  test('background mode creates a SubAgentSession marked as background', async () => {
    const cortx = new Cortx(mockLanguageClient(), { model: 'test' });
    const agentTool = cortx.tools.get('agent')!;
    const ctx = mockCtx();

    const result = await agentTool.execute(
      { prompt: 'Do something', run_in_background: true },
      ctx as any,
    );

    const toolCallId = ctx.toolCallId;
    const session = cortx.agentSessions.get(toolCallId);
    expect(session).toBeDefined();
    expect(session!.isBackground).toBe(true);
    expect(session!.description).toBe('sub-agent');
    expect(session!.status).toBe('running');
  });

  test('background session eventually completes and populates output', async () => {
    const cortx = new Cortx(mockLanguageClient(), { model: 'test' });
    const agentTool = cortx.tools.get('agent')!;
    const ctx = mockCtx();

    await agentTool.execute(
      { prompt: 'Do something', run_in_background: true },
      ctx as any,
    );

    const toolCallId = ctx.toolCallId;

    // Wait for the background agent to finish
    await new Promise(resolve => setTimeout(resolve, 200));

    const session = cortx.agentSessions.get(toolCallId)!;
    expect(session.status).toBe('completed');
    expect(session.output).toContain('background result');
    expect(session.completedAt).toBeDefined();
  });

  test('onAgentEvent receives agent_started and agent_completed for background agent', async () => {
    const cortx = new Cortx(mockLanguageClient(), { model: 'test' });
    const events: AgentEvent[] = [];
    cortx.onAgentEvent = (event: AgentEvent) => events.push(event);

    const agentTool = cortx.tools.get('agent')!;
    await agentTool.execute(
      { prompt: 'Do something', run_in_background: true },
      mockCtx() as any,
    );

    // agent_started should be emitted synchronously
    expect(events.some(e => e.type === 'agent_started')).toBe(true);

    // Wait for background agent to finish
    await new Promise(resolve => setTimeout(resolve, 200));

    const completed = events.find(e => e.type === 'agent_completed') as any;
    expect(completed).toBeDefined();
    expect(completed.output).toContain('background result');
    expect(completed.isError).toBeFalsy();
  });

  test('foreground mode (no run_in_background) behaves synchronously', async () => {
    const cortx = new Cortx(mockLanguageClient(), { model: 'test' });
    const agentTool = cortx.tools.get('agent')!;

    const result = await agentTool.execute(
      { prompt: 'Do something' },
      mockCtx() as any,
    );

    expect(result.success).toBe(true);
    // Foreground mode returns the actual output, not the background message
    expect(result.output).not.toContain('Background agent started');
    expect(result.output).toContain('background result');
  });

  test('foreground mode with run_in_background=false behaves synchronously', async () => {
    const cortx = new Cortx(mockLanguageClient(), { model: 'test' });
    const agentTool = cortx.tools.get('agent')!;

    const result = await agentTool.execute(
      { prompt: 'Do something', run_in_background: false },
      mockCtx() as any,
    );

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('Background agent started');
    expect(result.output).toContain('background result');
  });

  test('foreground session is not marked as background', async () => {
    const cortx = new Cortx(mockLanguageClient(), { model: 'test' });
    const events: AgentEvent[] = [];
    cortx.onAgentEvent = (event: AgentEvent) => events.push(event);

    const agentTool = cortx.tools.get('agent')!;
    await agentTool.execute(
      { prompt: 'Do something' },
      mockCtx() as any,
    );

    // Find the session via the agent_started event
    const started = events.find(e => e.type === 'agent_started') as any;
    const session = cortx.agentSessions.get(started.toolCallId);
    expect(session!.isBackground).toBe(false);
  });

  test('foreground sub-agent returns failure when loop emits an error', async () => {
    const cortx = new Cortx(failingLanguageClient(), { model: 'test', maxIterations: 1 });
    const events: AgentEvent[] = [];
    cortx.onAgentEvent = (event: AgentEvent) => events.push(event);
    const agentTool = cortx.tools.get('agent')!;

    const result = await agentTool.execute(
      { prompt: 'Do something' },
      mockCtx() as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Sub-agent failed');
    const completed = events.find(e => e.type === 'agent_completed') as any;
    expect(completed?.isError).toBe(true);
  });

  test('background sub-agent marks session failed when loop emits an error', async () => {
    const cortx = new Cortx(failingLanguageClient(), { model: 'test', maxIterations: 1 });
    const events: AgentEvent[] = [];
    const errors: string[] = [];
    cortx.onAgentEvent = (event: AgentEvent) => events.push(event);
    const ctx = mockCtx({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...args: unknown[]) => errors.push(String(args[0] ?? '')),
        scope: function () { return this; },
      },
    });
    const agentTool = cortx.tools.get('agent')!;

    const result = await agentTool.execute(
      { prompt: 'Do something', run_in_background: true },
      ctx as any,
    );
    expect(result.success).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 200));

    const session = cortx.agentSessions.get(ctx.toolCallId)!;
    expect(session.status).toBe('error');
    expect(events.some(e => e.type === 'agent_completed' && (e as any).isError === true)).toBe(true);
    expect(errors.some((message) => message.includes('Background agent'))).toBe(true);
  });
});
