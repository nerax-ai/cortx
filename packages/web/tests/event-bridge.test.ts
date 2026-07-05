import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { AgentStore } from '@cortx/store';
import { EventBridge, EventBridgeError, type WebEventConnectionState } from '../src/bridge/event-bridge';

const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as unknown as { EventSource?: unknown }).EventSource;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function sessionBody(isRunning = false) {
  return {
    session: {
      id: 'sess_web',
      createdAt: 1,
      lastActivityAt: 1,
      workingDirectory: '/repo/cortx',
      model: 'default',
      toolMode: 'all',
      approvalMode: 'interactive',
      isRunning,
      eventCount: 0,
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(condition: () => boolean, timeoutMs = 200): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await flushAsyncWork();
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as unknown as { EventSource?: unknown }).EventSource = originalEventSource;
  FakeEventSource.instances = [];
});

describe('EventBridge', () => {
  test('uses the runtime session API and dispatches SSE events into the store', async () => {
    const calls: Array<{ path: string; method: string; auth: string | null; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://web');
      calls.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('Authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      if (url.pathname === '/sessions' && init?.method === 'POST') return jsonResponse(sessionBody());
      if (url.pathname === '/sessions/sess_web' && init?.method === 'PATCH') {
        return jsonResponse({
          session: {
            ...sessionBody().session,
            toolMode: 'read-only',
            approvalMode: 'deny',
            skillPacks: ['review-pack'],
          },
        });
      }
      if (url.pathname === '/sessions/sess_web') return jsonResponse(sessionBody(true));
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    (globalThis as unknown as { EventSource?: typeof FakeEventSource }).EventSource = FakeEventSource;

    const store = new AgentStore();
    const bridge = new EventBridge(store, 'api-key');
    const session = await bridge.createSession({ workingDirectory: '/repo/cortx', metadata: { source: 'web' } });
    await bridge.connect(session.id);
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({
        sequence: 1,
        timestamp: 1000,
        sessionId: 'sess_web',
        runId: 1,
        event: { type: 'text_delta', delta: 'hi' },
      }),
    });
    FakeEventSource.instances[0].onmessage?.({ data: '{}' });

    await bridge.prompt(session.id, 'hello');
    await bridge.followUp(session.id, 'more');
    await bridge.steer(session.id, 'steer');
    await bridge.answer(session.id, 'tc_1', 'yes');
    await bridge.abort(session.id);
    await bridge.resume(session.id);
    const updated = await bridge.updateSession(session.id, {
      toolMode: 'read-only',
      approvalMode: 'deny',
      skillPacks: ['review-pack'],
    });
    const refreshed = await bridge.getSession(session.id);

    expect(updated).toMatchObject({ toolMode: 'read-only', approvalMode: 'deny', skillPacks: ['review-pack'] });
    expect(refreshed.isRunning).toBe(true);
    expect(store.getState().sessionId).toBe('sess_web');
    expect(store.getState().messages.currentText).toBe('hi');
    expect(FakeEventSource.instances[0].url).toBe('/sessions/sess_web/events?format=envelope&token=short-token');
    expect(calls.map((call) => call.path)).toEqual([
      '/auth/token',
      '/sessions',
      '/sessions/sess_web/prompt',
      '/sessions/sess_web/follow-up',
      '/sessions/sess_web/steer',
      '/sessions/sess_web/answer',
      '/sessions/sess_web/abort',
      '/sessions/sess_web/resume',
      '/sessions/sess_web',
      '/sessions/sess_web',
    ]);
    expect(calls[1].body).toEqual({ workingDirectory: '/repo/cortx', metadata: { source: 'web' } });
    expect(calls[8]).toMatchObject({
      method: 'PATCH',
      body: { toolMode: 'read-only', approvalMode: 'deny', skillPacks: ['review-pack'] },
    });
    expect(calls[0].auth).toBe('Bearer api-key');
    expect(calls.slice(1).every((call) => call.auth === 'Bearer short-token')).toBe(true);
  });

  test('emits event stream lifecycle state while replaying and reconnecting', async () => {
    const states: WebEventConnectionState[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), 'http://web');
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    (globalThis as unknown as { EventSource?: typeof FakeEventSource }).EventSource = FakeEventSource;

    const store = new AgentStore();
    const bridge = new EventBridge(store, 'api-key', '', {
      onConnectionState: (state) => states.push(state),
    });

    await bridge.connect('sess_events');
    FakeEventSource.instances[0].onopen?.({});
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({
        sequence: 4,
        timestamp: 1234,
        sessionId: 'sess_events',
        runId: 1,
        event: { type: 'text_delta', delta: 'restored' },
      }),
    });
    FakeEventSource.instances[0].onerror?.({});
    bridge.disconnect();

    expect(states.map((state) => state.phase)).toEqual([
      'connecting',
      'replaying',
      'replaying',
      'live',
      'reconnecting',
      'closed',
    ]);
    expect(states[3]).toMatchObject({
      sessionId: 'sess_events',
      lastSequence: 4,
      lastEventAt: 1234,
    });
    expect(store.getState().messages.currentText).toBe('restored');
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  test('marks empty replay streams as live on heartbeat', async () => {
    const phases: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), 'http://web');
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    (globalThis as unknown as { EventSource?: typeof FakeEventSource }).EventSource = FakeEventSource;

    const bridge = new EventBridge(new AgentStore(), 'api-key', '', {
      onConnectionState: (state) => phases.push(state.phase),
    });
    await bridge.connect('sess_empty');
    FakeEventSource.instances[0].onmessage?.({ data: '{}' });

    expect(phases).toEqual(['connecting', 'replaying', 'live']);
  });

  test('reconciles stale running replay state with stopped runtime session on heartbeat', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), 'http://web');
      calls.push(url.pathname);
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      if (url.pathname === '/sessions/sess_stale') {
        return jsonResponse({
          session: {
            ...sessionBody(false).session,
            id: 'sess_stale',
            eventCount: 3,
          },
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    (globalThis as unknown as { EventSource?: typeof FakeEventSource }).EventSource = FakeEventSource;

    const store = new AgentStore();
    const bridge = new EventBridge(store, 'api-key');
    await bridge.connect('sess_stale');
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({
        sequence: 1,
        timestamp: 1000,
        sessionId: 'sess_stale',
        runId: 1,
        event: { type: 'turn_start', iteration: 1 },
      }),
    });
    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({
        sequence: 2,
        timestamp: 1200,
        sessionId: 'sess_stale',
        runId: 1,
        event: { type: 'text_delta', delta: 'partial replay' },
      }),
    });
    expect(store.getState().status).toBe('running');

    FakeEventSource.instances[0].onmessage?.({ data: '{}' });
    await waitForCondition(() => store.getState().status === 'idle');

    expect(calls).toContain('/sessions/sess_stale');
    expect(store.getState().status).toBe('idle');
    expect(store.getState().messages.currentText).toBe('');
    expect(store.getState().messages.turns.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'partial replay',
    });
  });

  test('launches AgentSpec assets through the server bridge', async () => {
    const calls: Array<{ path: string; auth: string | null; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://web');
      calls.push({
        path: url.pathname,
        auth: new Headers(init?.headers).get('Authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      if (url.pathname === '/agent-specs/launch') {
        return jsonResponse({
          session: {
            id: 'sess_spec',
            createdAt: 1,
            lastActivityAt: 2,
            workingDirectory: '/repo/cortx',
            model: 'default',
            toolMode: 'read-only',
            approvalMode: 'deny',
            isRunning: true,
            eventCount: 1,
            metadata: { agentSpec: 'reviewer' },
          },
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const bridge = new EventBridge(new AgentStore(), 'api-key');
    const session = await bridge.launchAgentSpec({ path: 'examples/skill-packs/basic/agents/reviewer.json' });

    expect(session).toMatchObject({
      id: 'sess_spec',
      metadata: { agentSpec: 'reviewer' },
    });
    expect(calls.map((call) => call.path)).toEqual(['/auth/token', '/agent-specs/launch']);
    expect(calls[1].auth).toBe('Bearer short-token');
    expect(calls[1].body).toEqual({ path: 'examples/skill-packs/basic/agents/reviewer.json' });
  });

  test('lists discovered AgentSpec assets through the server bridge', async () => {
    const calls: Array<{ path: string; auth: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://web');
      calls.push({
        path: url.pathname,
        auth: new Headers(init?.headers).get('Authorization'),
      });
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      if (url.pathname === '/agent-specs') {
        return jsonResponse({
          agentSpecs: [
            {
              name: 'reviewer',
              path: '/repo/agents/reviewer.json',
              relativePath: 'agents/reviewer.json',
              sourceRoot: '/repo',
              promptPreview: 'Review the current diff',
              toolMode: 'read-only',
              approvalMode: 'deny',
            },
          ],
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const bridge = new EventBridge(new AgentStore(), 'api-key');
    const specs = await bridge.listAgentSpecs();

    expect(specs).toEqual([
      expect.objectContaining({
        name: 'reviewer',
        path: '/repo/agents/reviewer.json',
        promptPreview: 'Review the current diff',
      }),
    ]);
    expect(calls.map((call) => call.path)).toEqual(['/auth/token', '/agent-specs']);
    expect(calls[1].auth).toBe('Bearer short-token');
  });

  test('lists and installs SkillPacks through the server bridge', async () => {
    const calls: Array<{ path: string; auth: string | null; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://web');
      calls.push({
        path: url.pathname,
        auth: new Headers(init?.headers).get('Authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      if (url.pathname === '/skill-packs') {
        return jsonResponse({
          skillPacks: [
            {
              id: 'review-pack',
              name: 'Review Pack',
              sourcePath: '/repo/examples/review-pack',
              installedAt: 42,
              path: '/repo/examples/review-pack',
              skillPaths: ['/repo/examples/review-pack/skills'],
              agentSpecPaths: ['/repo/examples/review-pack/agents'],
            },
          ],
        });
      }
      if (url.pathname === '/skill-packs/install') {
        return jsonResponse({
          skillPack: {
            id: 'review-pack',
            name: 'Review Pack',
            sourcePath: '/repo/examples/review-pack',
            installedAt: 43,
            path: '/repo/examples/review-pack',
            skillPaths: ['/repo/examples/review-pack/skills'],
            agentSpecPaths: ['/repo/examples/review-pack/agents'],
          },
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const bridge = new EventBridge(new AgentStore(), 'api-key');
    const packs = await bridge.listSkillPacks();
    const installed = await bridge.installSkillPack({ path: 'examples/review-pack', id: 'review-pack' });

    expect(packs).toEqual([
      expect.objectContaining({
        id: 'review-pack',
        name: 'Review Pack',
        skillPaths: ['/repo/examples/review-pack/skills'],
      }),
    ]);
    expect(installed).toMatchObject({ id: 'review-pack', installedAt: 43 });
    expect(calls.map((call) => call.path)).toEqual([
      '/auth/token',
      '/skill-packs',
      '/skill-packs/install',
    ]);
    expect(calls[1].auth).toBe('Bearer short-token');
    expect(calls[2].body).toEqual({ path: 'examples/review-pack', id: 'review-pack' });
  });

  test('lists workspace directories through the server bridge', async () => {
    const calls: Array<{ path: string; search: string; auth: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://web');
      calls.push({
        path: url.pathname,
        search: url.search,
        auth: new Headers(init?.headers).get('Authorization'),
      });
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      if (url.pathname === '/workspaces/directories') {
        return jsonResponse({
          roots: ['/repo'],
          current: url.searchParams.get('path') ?? '/repo',
          parent: '/repo',
          entries: [{ name: 'cortx', path: '/repo/cortx' }],
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const bridge = new EventBridge(new AgentStore(), 'api-key');
    const listing = await bridge.listWorkspaceDirectories('/repo/cortx');

    expect(listing).toMatchObject({
      roots: ['/repo'],
      current: '/repo/cortx',
      entries: [{ name: 'cortx', path: '/repo/cortx' }],
    });
    expect(calls.map((call) => call.path)).toEqual(['/auth/token', '/workspaces/directories']);
    expect(calls[1].search).toBe('?path=%2Frepo%2Fcortx');
    expect(calls[1].auth).toBe('Bearer short-token');
  });

  test('surfaces typed server errors', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), 'http://web');
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      return jsonResponse({ error: 'outside root', kind: 'invalid_workspace' }, { status: 400 });
    }) as typeof fetch;

    const bridge = new EventBridge(new AgentStore(), 'api-key');
    await expect(bridge.createSession({ workingDirectory: '/etc' })).rejects.toBeInstanceOf(EventBridgeError);
    await expect(bridge.createSession({ workingDirectory: '/etc' })).rejects.toMatchObject({
      status: 400,
      kind: 'invalid_workspace',
    });
  });

  test('web package stays remote-only and does not depend on local agent packages', async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(deps['@cortx/core']).toBeUndefined();
    expect(deps['@cortx/runtime']).toBeUndefined();
    expect(deps['@cortx/code']).toBeUndefined();
  });
});
