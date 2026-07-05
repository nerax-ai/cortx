import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import { AgentStore } from '../packages/store/src/index';
import { createServerRuntime, type ServerRuntimeHandle } from '../packages/server/src/server';
import { EventBridge, EventBridgeError } from '../packages/web/src/bridge/event-bridge';
import { RemoteRuntimeClient } from '../packages/tui/src/remote-client';

const BASE_URL = 'http://cortx-smoke.test';
const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as unknown as { EventSource?: unknown }).EventSource;

let tmpRoot: string;
let activeFetch: ((input: string | URL, init?: RequestInit) => Promise<Response>) | undefined;

function textParts(text: string): LanguageStreamPart[] {
  const id = `text-${Math.random().toString(36).slice(2)}`;
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
  ];
}

function toolCallParts(toolCallId: string, toolName: string, input: Record<string, unknown>): LanguageStreamPart[] {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: JSON.stringify(input) },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
  ];
}

function queuedLanguage(responses: LanguageStreamPart[][]): LanguageClient {
  let index = 0;
  return {
    stream: async function* () {
      const parts = responses[index++] ?? responses.at(-1) ?? [];
      for (const part of parts) yield part;
    },
  } as unknown as LanguageClient;
}

function createAppFetch(handle: ServerRuntimeHandle): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = new URL(String(input), BASE_URL);
    const headers = new Headers(init.headers);
    const requestInit: RequestInit = {
      method: init.method,
      headers,
      body: init.body,
      signal: init.signal,
    };
    return handle.app.request(`${url.pathname}${url.search}`, requestInit);
  };
}

class ServerBackedEventSource {
  static instances: ServerBackedEventSource[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly messages: string[] = [];
  private readonly controller = new AbortController();
  private closed = false;

  constructor(readonly url: string) {
    ServerBackedEventSource.instances.push(this);
    void this.open();
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
  }

  private async open(): Promise<void> {
    try {
      if (!activeFetch) throw new Error('No app-backed fetch is active for the smoke EventSource.');
      const response = await activeFetch(this.url, { signal: this.controller.signal });
      if (!response.ok) throw new Error(`SSE failed: ${response.status}`);
      this.onopen?.({});
      await this.readStream(response);
    } catch (error) {
      if (!this.closed) this.onerror?.(error);
    }
  }

  private async readStream(response: Response): Promise<void> {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!this.closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = this.drain(buffer);
    }
  }

  private drain(input: string): string {
    let buffer = input;
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) return buffer;
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        this.messages.push(data);
        this.onmessage?.({ data });
      }
    }
  }
}

function createRuntimeHandle(input: {
  language: LanguageClient;
  rootA: string;
  rootB?: string;
  stateDir: string;
  approvalMode?: 'interactive' | 'full-access';
}): ServerRuntimeHandle {
  return createServerRuntime({
    apiKey: 'root-key',
    apiKeys: [
      {
        id: 'project-a',
        key: 'key-a',
        allowedWorkspaceRoots: [input.rootA],
        toolMode: 'all',
        approvalMode: input.approvalMode ?? 'interactive',
      },
      ...(input.rootB
        ? [
            {
              id: 'project-b',
              key: 'key-b',
              allowedWorkspaceRoots: [input.rootB],
              toolMode: 'read-only' as const,
              approvalMode: 'deny' as const,
            },
          ]
        : []),
    ],
    language: input.language,
    model: 'smoke-model',
    defaultWorkingDirectory: input.rootA,
    allowedWorkspaceRoots: input.rootB ? [input.rootA, input.rootB] : [input.rootA],
    toolMode: 'all',
    approvalMode: input.approvalMode ?? 'interactive',
    skillPackRegistryPath: join(input.stateDir, 'skill-packs.json'),
  });
}

function installAppTransport(handle: ServerRuntimeHandle): void {
  activeFetch = createAppFetch(handle);
  globalThis.fetch = activeFetch as typeof fetch;
  (globalThis as unknown as { EventSource?: typeof ServerBackedEventSource }).EventSource = ServerBackedEventSource;
}

function createSkillPack(root: string): string {
  const packDir = join(root, 'review-pack');
  const skillDir = join(packDir, 'skills', 'review');
  const agentsDir = join(packDir, 'agents');
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(packDir, 'skill-pack.json'), JSON.stringify({ name: 'Review Pack', version: '1.0.0' }), 'utf8');
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: Review project changes.\n---\nReview the change.', 'utf8');
  writeFileSync(
    join(agentsDir, 'reviewer.json'),
    JSON.stringify({
      name: 'pack-reviewer',
      prompt: 'Review the installed pack workspace.',
      toolMode: 'read-only',
      approvalMode: 'deny',
      capabilities: { skills: true, subAgents: false, approval: false },
    }),
    'utf8',
  );
  return packDir;
}

async function waitUntil(assertion: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function parsedEnvelopeMessages(source: ServerBackedEventSource): Array<Record<string, unknown>> {
  return source.messages
    .filter((message) => message !== '{}')
    .map((message) => JSON.parse(message) as Record<string, unknown>);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cortx-product-smoke-'));
  ServerBackedEventSource.instances = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as unknown as { EventSource?: unknown }).EventSource = originalEventSource;
  activeFetch = undefined;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('product dogfood smoke', () => {
  test('Web and TUI remote clients drive scoped sessions, approval and assets through the server host', async () => {
    const rootA = join(tmpRoot, 'project-a');
    const rootB = join(tmpRoot, 'project-b');
    const stateDir = join(tmpRoot, 'state');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    createSkillPack(rootA);
    const handle = createRuntimeHandle({
      rootA,
      rootB,
      stateDir,
      language: queuedLanguage([
        toolCallParts('write-call', 'write', { path: 'approved.txt', content: 'approved by smoke' }),
        textParts('approval complete'),
      ]),
    });
    installAppTransport(handle);

    try {
      const webStore = new AgentStore();
      const web = new EventBridge(webStore, 'key-a', BASE_URL);
      const tuiB = new RemoteRuntimeClient({ baseUrl: BASE_URL, apiKey: 'key-b', fetch: activeFetch });
      const tuiA = new RemoteRuntimeClient({ baseUrl: BASE_URL, apiKey: 'key-a', fetch: activeFetch });

      const webSession = await web.createSession({
        workingDirectory: rootA,
        toolMode: 'all',
        approvalMode: 'interactive',
        capabilities: { skills: false, subAgents: true, approval: true },
      });
      await web.connect(webSession.id);
      const tuiSession = await tuiB.createSession({ workingDirectory: rootB, toolMode: 'read-only', approvalMode: 'deny' });

      const webSessions = await web.listSessions();
      expect(webSessions.map((session) => session.id)).toEqual([webSession.id]);
      await expect(tuiB.getSession(webSession.id)).rejects.toMatchObject({ kind: 'permission_denied' });
      await expect(web.getSession(tuiSession.id)).rejects.toBeInstanceOf(EventBridgeError);
      await expect(web.getSession(tuiSession.id)).rejects.toMatchObject({ kind: 'permission_denied' });

      const promptRun = web.prompt(webSession.id, 'write an approved smoke file');
      await waitUntil(() => webStore.getState().pendingQuestion?.toolCallId === 'write-call', 'approval request');
      expect(webStore.getState().pendingQuestion).toMatchObject({
        kind: 'tool_approval',
        allowedResponses: ['yes', 'no'],
        context: { toolName: 'write', sideEffects: 'write' },
      });
      await web.answer(webSession.id, 'write-call', 'yes');
      await promptRun;
      await waitUntil(() => webStore.getState().status === 'idle', 'approved run completion');

      expect(readFileSync(join(rootA, 'approved.txt'), 'utf8')).toBe('approved by smoke');
      expect(webStore.getState().messages.turns.some((turn) => turn.content.includes('approval complete'))).toBe(true);
      expect(webStore.getState().activity.find((entry) => entry.kind === 'tool' && entry.id === 'write-call')).toMatchObject({
        kind: 'tool',
        entry: { status: 'complete', isError: false },
      });

      const replayStore = new AgentStore();
      const replayWeb = new EventBridge(replayStore, 'key-a', BASE_URL);
      await replayWeb.connect(webSession.id);
      await waitUntil(() => replayStore.getState().messages.turns.some((turn) => turn.content.includes('approval complete')), 'event replay');

      const installed = await web.installSkillPack({ path: 'review-pack', id: 'review-pack' });
      expect(installed).toMatchObject({ id: 'review-pack', name: 'Review Pack', version: '1.0.0' });
      expect((await tuiA.listSkillPacks()).map((pack) => pack.id)).toContain('review-pack');
      expect((await web.listAgentSpecs()).map((spec) => spec.name)).toContain('pack-reviewer');

      await tuiB.abort(tuiSession.id);
      await tuiB.resume(tuiSession.id);
      expect((await tuiB.getSession(tuiSession.id)).workingDirectory).toBe(rootB);
    } finally {
      handle.dispose();
    }
  });

  test('sub-agent lifecycle envelopes replay with parent attribution', async () => {
    const rootA = join(tmpRoot, 'project-a');
    const stateDir = join(tmpRoot, 'state');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const handle = createRuntimeHandle({
      rootA,
      stateDir,
      approvalMode: 'full-access',
      language: queuedLanguage([
        toolCallParts('agent-call', 'agent', { prompt: 'inspect child context', description: 'child check' }),
        textParts('child output'),
        textParts('parent observed child'),
      ]),
    });
    installAppTransport(handle);

    try {
      const store = new AgentStore();
      const web = new EventBridge(store, 'key-a', BASE_URL);
      const session = await web.createSession({
        workingDirectory: rootA,
        toolMode: 'all',
        approvalMode: 'full-access',
        capabilities: { skills: false, subAgents: true, approval: true },
      });
      await web.connect(session.id);
      await web.prompt(session.id, 'run a child agent');
      await waitUntil(() => store.getState().agentSessions.get('agent-call')?.status === 'completed', 'sub-agent completion');

      expect(store.getState().agentSessions.get('agent-call')).toMatchObject({
        description: 'child check',
        status: 'completed',
        isBackground: false,
      });
      expect(store.getState().messages.turns.some((turn) => turn.content.includes('parent observed child'))).toBe(true);

      const source = ServerBackedEventSource.instances.at(-1);
      expect(source).toBeDefined();
      const envelopes = parsedEnvelopeMessages(source!);
      const started = envelopes.find((envelope) => (envelope.event as { type?: string } | undefined)?.type === 'agent_started');
      const completed = envelopes.find((envelope) => (envelope.event as { type?: string } | undefined)?.type === 'agent_completed');

      expect(started).toMatchObject({
        sessionId: session.id,
        parent: { sessionId: session.id, toolCallId: 'agent-call' },
        event: { type: 'agent_started', toolCallId: 'agent-call' },
      });
      expect(completed).toMatchObject({
        sessionId: session.id,
        parent: { sessionId: session.id, toolCallId: 'agent-call' },
        event: { type: 'agent_completed', toolCallId: 'agent-call' },
      });
    } finally {
      handle.dispose();
    }
  });
});
