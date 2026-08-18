import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentRuntimeExtensions, Tool } from '@cortx/sdk';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import { createEmptyAgentRuntimeExtensions } from '@cortx/sdk';
import {
  CortxRuntime,
  FileDurableRunStore,
  SubAgentSessionStore,
  createDefaultSafetyExtensions,
  createSubAgentTool,
} from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-runtime-sub-agent-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function textResponse(text: string): LanguageStreamPart[] {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function thinkingTextResponse(thinking: string, text: string): LanguageStreamPart[] {
  return [
    { type: 'reasoning-delta', id: 'r1', delta: thinking },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function toolCallResponse(toolCallId: string, toolName: string, input: string): LanguageStreamPart[] {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: input },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
}

function mockLanguage(responses: LanguageStreamPart[][]): LanguageClient {
  let index = 0;
  return {
    stream: async function* () {
      const parts = responses[index++] ?? responses.at(-1) ?? [];
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

function captureToolsLanguage(captured: { tools?: unknown[] }): LanguageClient {
  return {
    stream: async function* (request: { tools?: unknown[] }) {
      captured.tools = request.tools;
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      };
    },
  } as unknown as LanguageClient;
}

function abortAwareLanguage(): LanguageClient {
  return {
    stream: async function* (_request: unknown, options?: { signal?: AbortSignal }) {
      await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('child aborted')), { once: true });
      });
    },
  } as unknown as LanguageClient;
}

function logger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    scope() {
      return this;
    },
  };
}

function toolContext(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'parent-session',
    toolCallId: 'agent-call',
    workingDirectory: tmpDir,
    logger: logger(),
    reportProgress: () => {},
    ...overrides,
  };
}

describe('runtime sub-agent capability', () => {
  test('runtime mounts agent tool only when sub-agent capability is enabled', async () => {
    const enabledCapture: { tools?: unknown[] } = {};
    const enabled = new CortxRuntime({
      language: captureToolsLanguage(enabledCapture),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: true, approval: false },
    });
    const enabledSession = await enabled.createSession();
    const enabledEvents: AgentEvent[] = [];
    enabled.subscribe(enabledSession.id, (event) => enabledEvents.push(event));
    await enabled.prompt(enabledSession.id, 'hello');

    const disabledCapture: { tools?: unknown[] } = {};
    const disabled = new CortxRuntime({
      language: captureToolsLanguage(disabledCapture),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const disabledSession = await disabled.createSession();
    const disabledEvents: AgentEvent[] = [];
    disabled.subscribe(disabledSession.id, (event) => disabledEvents.push(event));
    await disabled.prompt(disabledSession.id, 'hello');

    await waitForEvent(enabledEvents, 'done');
    await waitForEvent(disabledEvents, 'done');
    expect(((enabledCapture.tools ?? []) as Array<{ name: string }>).some((tool) => tool.name === 'agent')).toBe(true);
    expect(((disabledCapture.tools ?? []) as Array<{ name: string }>).some((tool) => tool.name === 'agent')).toBe(false);
    await enabled.close();
    await disabled.close();
  });

  test('foreground agent tool returns child output and lifecycle events', async () => {
    const events: AgentEvent[] = [];
    const store = new SubAgentSessionStore();
    const extensions = createEmptyAgentRuntimeExtensions();
    const tool = createSubAgentTool({
      language: mockLanguage([textResponse('child output')]),
      model: 'test',
      agentSessions: store,
      getTools: () => [],
      getExtensions: () => extensions,
      onAgentEvent: (event) => events.push(event),
    });

    const result = await tool.execute({ prompt: 'do child work', description: 'child task' }, toolContext() as never);

    expect(result).toMatchObject({ success: true });
    expect(String(result.output)).toContain('child output');
    expect(store.get('agent-call')).toMatchObject({ status: 'completed', isBackground: false, output: 'child output' });
    expect(events.find((event) => event.type === 'agent_started')).toMatchObject({ toolCallId: 'agent-call' });
    expect(events.find((event) => event.type === 'agent_completed')).toMatchObject({ output: 'child output' });
  });

  test('foreground agent bridges child tool approval through the parent tool question', async () => {
    let executed = false;
    const events: AgentEvent[] = [];
    const store = new SubAgentSessionStore();
    const tool = createSubAgentTool({
      language: mockLanguage([
        toolCallResponse('child-write', 'writeFile', '{"path":"child.txt"}'),
        textResponse('child output'),
      ]),
      model: 'test',
      agentSessions: store,
      getTools: () => [
        {
          name: 'writeFile',
          sideEffects: 'write',
          inputSchema: {},
          execute: async () => {
            executed = true;
            return { success: true, output: 'written by child' };
          },
        } satisfies Tool,
      ],
      getExtensions: () => createDefaultSafetyExtensions(),
      onAgentEvent: (event) => events.push(event),
    });

    const result = await tool.execute(
      { prompt: 'write from child', description: 'child approval' },
      toolContext({ askUser: async () => 'yes' }) as never,
    );

    expect(result).toMatchObject({ success: true });
    expect(executed).toBe(true);
    expect(String(result.output)).toContain('child output');
    expect(events.find((event) => event.type === 'user_request')).toMatchObject({
      type: 'user_request',
      request: {
        requestId: 'agent-call',
        kind: 'tool_approval',
        context: { toolName: 'writeFile', childToolCallId: 'child-write', parentToolCallId: 'agent-call' },
      },
    });
    expect(events.find((event) => event.type === 'agent_completed')).toMatchObject({
      type: 'agent_completed',
      toolCallId: 'agent-call',
    });
    expect((events.find((event) => event.type === 'agent_completed') as { isError?: boolean }).isError).not.toBe(true);
  });

  test('foreground agent bridges direct child tool askUser calls', async () => {
    const events: AgentEvent[] = [];
    const store = new SubAgentSessionStore();
    const tool = createSubAgentTool({
      language: mockLanguage([
        toolCallResponse('child-question', 'confirm', '{"message":"continue?"}'),
        textResponse('confirmed'),
      ]),
      model: 'test',
      agentSessions: store,
      getTools: () => [
        {
          name: 'confirm',
          sideEffects: 'read',
          inputSchema: {},
          execute: async (_input, ctx) => {
            const answer = await ctx.askUser?.('continue?');
            return { success: answer === 'yes', output: `answer=${answer}` };
          },
        } satisfies Tool,
      ],
      getExtensions: () => createEmptyAgentRuntimeExtensions(),
      onAgentEvent: (event) => events.push(event),
    });

    const result = await tool.execute(
      { prompt: 'ask from child', description: 'child question' },
      toolContext({ askUser: async () => 'yes' }) as never,
    );

    expect(result).toMatchObject({ success: true });
    expect(String(result.output)).toContain('confirmed');
    expect(events.find((event) => event.type === 'user_request')).toMatchObject({
      type: 'user_request',
      request: {
        requestId: 'agent-call',
        kind: 'question',
        context: { childToolCallId: 'child-question', parentToolCallId: 'agent-call' },
      },
    });
    const completed = events.find((event) => event.type === 'agent_completed');
    expect(completed).toMatchObject({ type: 'agent_completed' });
    expect((completed as { isError?: boolean } | undefined)?.isError).not.toBe(true);
  });

  test('foreground agent forwards child text thinking and tool results as parent progress', async () => {
    const events: AgentEvent[] = [];
    const store = new SubAgentSessionStore();
    const tool = createSubAgentTool({
      language: mockLanguage([
        toolCallResponse('child-read', 'readFile', '{"path":"child.txt"}'),
        thinkingTextResponse('checking result', 'child final answer'),
      ]),
      model: 'test',
      agentSessions: store,
      getTools: () => [
        {
          name: 'readFile',
          sideEffects: 'read',
          inputSchema: {},
          execute: async () => ({ success: true, output: 'child tool output' }),
        } satisfies Tool,
      ],
      getExtensions: () => createEmptyAgentRuntimeExtensions(),
      onAgentEvent: (event) => events.push(event),
    });

    const result = await tool.execute(
      { prompt: 'inspect child state', description: 'child progress' },
      toolContext() as never,
    );

    expect(result).toMatchObject({ success: true });
    const progress = events
      .filter((event): event is Extract<AgentEvent, { type: 'agent_progress' }> => event.type === 'agent_progress')
      .map((event) => event.text);
    expect(progress.some((text) => text.includes('readFile'))).toBe(true);
    expect(progress.some((text) => text.includes('child tool output'))).toBe(true);
    expect(progress.some((text) => text.includes('checking result'))).toBe(true);
    expect(progress.some((text) => text.includes('child final answer'))).toBe(true);
  });

  test('runtime envelopes child lifecycle events with parent attribution', async () => {
    const durableStore = new FileDurableRunStore(join(tmpDir, 'durable'));
    const runtime = new CortxRuntime({
      language: mockLanguage([
        toolCallResponse(
          'agent-call',
          'agent',
          '{"prompt":"do child work","description":"child task"}',
        ),
        textResponse('child output'),
        textResponse('parent done'),
      ]),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      capabilities: { skills: false, subAgents: true, approval: false },
      durableStore,
    });
    const session = await runtime.createSession({ id: 'parent-session' });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));

    await runtime.prompt(session.id, 'delegate');
    await waitForEvent(events, 'done');

    const agentStarted = runtime
      .getEventEnvelopeHistory(session.id)
      .find((event) => event.event.type === 'agent_started');
    expect(agentStarted).toMatchObject({
      sessionId: 'parent-session',
      runId: 1,
      parent: { sessionId: 'parent-session', runId: 1, toolCallId: 'agent-call' },
      event: { type: 'agent_started', toolCallId: 'agent-call' },
    });
    await waitFor(async () =>
      (await durableStore.listSubAgentSessions('parent-session')).some((snapshot) => snapshot.status === 'completed'),
      3_000,
    );
    expect(await durableStore.listSubAgentSessions('parent-session')).toMatchObject([
      {
        parentSessionId: 'parent-session',
        parentRunId: 1,
        toolCallId: 'agent-call',
        status: 'completed',
        output: 'child output',
      },
    ]);
    await runtime.close();
  });

  test('background agent tool returns immediately and completes the child session', async () => {
    const events: AgentEvent[] = [];
    const store = new SubAgentSessionStore();
    const tool = createSubAgentTool({
      language: mockLanguage([textResponse('background output')]),
      model: 'test',
      agentSessions: store,
      getTools: () => [],
      getExtensions: () => createEmptyAgentRuntimeExtensions(),
      onAgentEvent: (event) => events.push(event),
    });

    const result = await tool.execute(
      { prompt: 'do child work', description: 'background task', run_in_background: true },
      toolContext() as never,
    );

    expect(result.success).toBe(true);
    expect(String(result.output)).toContain('Background agent started');
    await waitFor(() => store.get('agent-call')?.status === 'completed');
    expect(store.get('agent-call')).toMatchObject({ isBackground: true, output: 'background output' });
    expect(events.some((event) => event.type === 'agent_completed')).toBe(true);
  });

  test('background agent can be cancelled after the tool returns', async () => {
    const events: AgentEvent[] = [];
    const store = new SubAgentSessionStore();
    const tool = createSubAgentTool({
      language: abortAwareLanguage(),
      model: 'test',
      agentSessions: store,
      getTools: () => [],
      getExtensions: () => createEmptyAgentRuntimeExtensions(),
      onAgentEvent: (event) => events.push(event),
    });

    const result = await tool.execute(
      { prompt: 'long child work', description: 'background task', run_in_background: true },
      toolContext() as never,
    );
    expect(result.success).toBe(true);

    await store.abortRunning('stop child');

    await waitFor(() => store.get('agent-call')?.status === 'cancelled');
    expect(events.find((event) => event.type === 'agent_completed')).toMatchObject({
      type: 'agent_completed',
      toolCallId: 'agent-call',
      isError: true,
    });
  });

  test('beforeSubAgent policy can deny before creating a child session', async () => {
    const store = new SubAgentSessionStore();
    const extensions: AgentRuntimeExtensions = createEmptyAgentRuntimeExtensions();
    extensions.sessionPolicies.push({
      beforeSubAgent() {
        return { action: 'deny', reason: 'sub-agents disabled' };
      },
    });
    const tool = createSubAgentTool({
      language: mockLanguage([textResponse('unused')]),
      model: 'test',
      agentSessions: store,
      getTools: () => [],
      getExtensions: () => extensions,
      onAgentEvent: () => {},
    });

    const result = await tool.execute({ prompt: 'do child work' }, toolContext() as never);

    expect(result).toEqual({ success: false, error: 'sub-agents disabled' });
    expect(store.get('agent-call')).toBeUndefined();
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
