import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart } from '@synax-ai/sdk';
import { AgentStore } from '../packages/store/src/index';
import { createServerRuntime, type ServerRuntimeHandle } from '../packages/server/src/server';
import { OFFICIAL_TOOL_PROFILE_ALIASES, type ProjectDomain } from '../packages/runtime/src/index';
import { createWorkspaceToolProjectDomain } from '../packages/runtime/tests/helpers/project-domain';
import { CortxApiError } from '../packages/web/src/client/api-client';
import { SessionController } from '../packages/web/src/session/session-controller';
import { RemoteRuntimeClient } from '../packages/tui/src/remote-client';

const BASE_URL = 'http://cortx-smoke.test';
const originalFetch = globalThis.fetch;

let tmpRoot: string;
let activeFetch: ((input: string | URL, init?: RequestInit) => Promise<Response>) | undefined;
let transportRequests: Array<{
  path: string;
  method: string;
  authorization: string | null;
  accept: string | null;
}>;

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
    transportRequests.push({
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization'),
      accept: headers.get('Accept'),
    });
    const requestInit: RequestInit = {
      method: init.method,
      headers,
      body: init.body,
      signal: init.signal,
    };
    return handle.app.request(`${url.pathname}${url.search}`, requestInit, { remoteAddress: '127.0.0.1' });
  };
}

async function createRuntimeHandle(input: {
  language: LanguageClient;
  rootA: string;
  rootB?: string;
  stateDir: string;
  approvalMode?: 'interactive' | 'full-access';
}): Promise<{ handle: ServerRuntimeHandle; projectDomain: ProjectDomain }> {
  const projectDomain = await createWorkspaceToolProjectDomain();
  const handle = createServerRuntime({
    apiKey: 'root-key',
    apiKeys: [
      {
        id: 'project-a',
        key: 'key-a',
        allowedWorkspaceRoots: [input.rootA],
        allowedToolProfiles: [OFFICIAL_TOOL_PROFILE_ALIASES.all],
        approvalMode: input.approvalMode ?? 'interactive',
      },
      ...(input.rootB
        ? [
            {
              id: 'project-b',
              key: 'key-b',
              allowedWorkspaceRoots: [input.rootB],
              allowedToolProfiles: [OFFICIAL_TOOL_PROFILE_ALIASES['read-only']],
              approvalMode: 'deny' as const,
            },
          ]
        : []),
    ],
    projectDomain,
    language: input.language,
    model: 'smoke-model',
    defaultWorkingDirectory: input.rootA,
    allowedWorkspaceRoots: input.rootB ? [input.rootA, input.rootB] : [input.rootA],
    toolMode: OFFICIAL_TOOL_PROFILE_ALIASES.all,
    approvalMode: input.approvalMode ?? 'interactive',
    skillPackRegistryPath: join(input.stateDir, 'skill-packs.json'),
  });
  return { handle, projectDomain };
}

function installAppTransport(handle: ServerRuntimeHandle): void {
  activeFetch = createAppFetch(handle);
  globalThis.fetch = activeFetch as typeof fetch;
}

function createSkillPack(root: string): string {
  const packDir = join(root, 'review-pack');
  const skillDir = join(packDir, 'skills', 'review');
  const agentsDir = join(packDir, 'agents');
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(packDir, 'skill-pack.json'), JSON.stringify({ name: 'Review Pack', version: '1.0.0' }), 'utf8');
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: review\ndescription: Review project changes.\n---\nReview the change.',
    'utf8',
  );
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

async function fetchEnvelopeHistory(sessionId: string): Promise<Array<Record<string, unknown>>> {
  if (!activeFetch) throw new Error('No app-backed fetch is active for event history.');
  const response = await activeFetch(
    `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/events/history?format=envelope`,
    { headers: { Authorization: 'Bearer key-a' } },
  );
  if (!response.ok) throw new Error(`Event history failed: ${response.status}`);
  return ((await response.json()) as { events: Array<Record<string, unknown>> }).events;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cortx-product-smoke-'));
  transportRequests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    const { handle, projectDomain } = await createRuntimeHandle({
      rootA,
      rootB,
      stateDir,
      language: queuedLanguage([
        toolCallParts('write-call', 'write', { path: 'approved.txt', content: 'approved by smoke' }),
        textParts('approval complete'),
      ]),
    });
    installAppTransport(handle);
    const webStore = new AgentStore();
    const web = new SessionController({ store: webStore, apiKey: 'key-a', baseUrl: BASE_URL });
    const replayStore = new AgentStore();
    const replayWeb = new SessionController({ store: replayStore, apiKey: 'key-a', baseUrl: BASE_URL });
    const tuiB = new RemoteRuntimeClient({ baseUrl: BASE_URL, apiKey: 'key-b', fetch: activeFetch });
    const tuiA = new RemoteRuntimeClient({ baseUrl: BASE_URL, apiKey: 'key-a', fetch: activeFetch });

    try {
      const webSession = await web.createSession({
        workingDirectory: rootA,
        toolMode: OFFICIAL_TOOL_PROFILE_ALIASES.all,
        approvalMode: 'interactive',
      });
      const tuiSession = await tuiB.createSession({
        workingDirectory: rootB,
        toolMode: OFFICIAL_TOOL_PROFILE_ALIASES['read-only'],
        approvalMode: 'deny',
      });

      expect(webSession.toolMode).toBe(OFFICIAL_TOOL_PROFILE_ALIASES.all);
      expect(tuiSession.toolMode).toBe(OFFICIAL_TOOL_PROFILE_ALIASES['read-only']);
      expect((await web.api.listToolProfiles()).map((profile) => profile.use)).toEqual([OFFICIAL_TOOL_PROFILE_ALIASES.all]);

      const webSessions = await web.api.listSessions();
      expect(webSessions.map((session) => session.id)).toEqual([webSession.id]);
      expect((await tuiB.listSessions()).map((session) => session.id)).toEqual([tuiSession.id]);
      await expect(tuiB.getSession(webSession.id)).rejects.toMatchObject({ kind: 'permission_denied' });
      await expect(web.api.getSession(tuiSession.id)).rejects.toBeInstanceOf(CortxApiError);
      await expect(web.api.getSession(tuiSession.id)).rejects.toMatchObject({ kind: 'permission_denied' });

      const promptRun = web.send('write an approved smoke file');
      await waitUntil(() => webStore.getState().pendingQuestion?.toolCallId === 'write-call', 'approval request');
      expect(webStore.getState().pendingQuestion).toMatchObject({
        kind: 'tool_approval',
        allowedResponses: ['yes', 'no'],
        context: { toolName: 'write', sideEffects: 'write' },
      });
      await web.answer('write-call', 'yes');
      await promptRun;
      await waitUntil(() => webStore.getState().status === 'idle', 'approved run completion');

      expect(readFileSync(join(rootA, 'approved.txt'), 'utf8')).toBe('approved by smoke');
      expect(webStore.getState().messages.turns.some((turn) => turn.content.includes('approval complete'))).toBe(true);
      expect(
        webStore.getState().activity.find((entry) => entry.kind === 'tool' && entry.id === 'write-call'),
      ).toMatchObject({
        kind: 'tool',
        entry: { status: 'complete', isError: false },
      });

      await replayWeb.activate(webSession.id);
      await waitUntil(
        () => replayStore.getState().messages.turns.some((turn) => turn.content.includes('approval complete')),
        'event replay',
      );

      const installed = await web.api.installSkillPack({ path: 'review-pack', id: 'review-pack' });
      expect(installed).toMatchObject({ id: 'review-pack', name: 'Review Pack', version: '1.0.0' });
      expect((await tuiA.listSkillPacks()).map((pack) => pack.id)).toContain('review-pack');
      expect((await web.api.listAgentSpecs()).map((spec) => spec.name)).toContain('pack-reviewer');

      await tuiB.abort(tuiSession.id);
      await expect(tuiB.resume(tuiSession.id)).rejects.toMatchObject({
        status: 409,
        kind: 'conflict',
      });
      expect((await tuiB.getSession(tuiSession.id)).workingDirectory).toBe(rootB);
      expect(
        transportRequests.some(
          (request) =>
            request.path.startsWith(`/sessions/${webSession.id}/events?`) &&
            request.authorization === 'Bearer key-a' &&
            request.accept === 'text/event-stream',
        ),
      ).toBe(true);
    } finally {
      replayWeb.close();
      web.close();
      await tuiA.close();
      await tuiB.close();
      await handle.close();
      await projectDomain.close();
    }
  });

  test('sub-agent lifecycle envelopes replay with parent attribution', async () => {
    const rootA = join(tmpRoot, 'project-a');
    const stateDir = join(tmpRoot, 'state');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const { handle, projectDomain } = await createRuntimeHandle({
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
    const store = new AgentStore();
    const web = new SessionController({ store, apiKey: 'key-a', baseUrl: BASE_URL });
    const replayStore = new AgentStore();
    const replayWeb = new SessionController({ store: replayStore, apiKey: 'key-a', baseUrl: BASE_URL });

    try {
      const session = await web.createSession({
        workingDirectory: rootA,
        toolMode: OFFICIAL_TOOL_PROFILE_ALIASES.all,
        approvalMode: 'full-access',
      });
      await web.send('run a child agent');
      await waitUntil(
        () => store.getState().agentSessions.get('agent-call')?.status === 'completed',
        'sub-agent completion',
      );

      expect(store.getState().agentSessions.get('agent-call')).toMatchObject({
        description: 'child check',
        status: 'completed',
        isBackground: false,
      });
      expect(store.getState().messages.turns.some((turn) => turn.content.includes('parent observed child'))).toBe(true);

      await replayWeb.activate(session.id);
      await waitUntil(
        () => replayStore.getState().agentSessions.get('agent-call')?.status === 'completed',
        'sub-agent replay',
      );
      expect(replayStore.getState().agentSessions.get('agent-call')).toMatchObject({
        description: 'child check',
        status: 'completed',
        isBackground: false,
      });
      expect(replayStore.getState().messages.turns.some((turn) => turn.content.includes('parent observed child'))).toBe(
        true,
      );

      const envelopes = await fetchEnvelopeHistory(session.id);
      const started = envelopes.find(
        (envelope) => (envelope.event as { type?: string } | undefined)?.type === 'agent_started',
      );
      const completed = envelopes.find(
        (envelope) => (envelope.event as { type?: string } | undefined)?.type === 'agent_completed',
      );

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
      expect(
        transportRequests.filter(
          (request) =>
            request.path.startsWith(`/sessions/${session.id}/events?`) &&
            request.authorization === 'Bearer key-a' &&
            request.accept === 'text/event-stream',
        ),
      ).toHaveLength(2);
    } finally {
      replayWeb.close();
      web.close();
      await handle.close();
      await projectDomain.close();
    }
  });
});
