import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { AgentStore } from '@cortx/store';
import { EventBridge, EventBridgeError } from '../src/bridge/event-bridge';

const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as unknown as { EventSource?: unknown }).EventSource;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as unknown as { EventSource?: unknown }).EventSource = originalEventSource;
  FakeEventSource.instances = [];
});

describe('EventBridge', () => {
  test('uses the runtime session API and dispatches SSE events into the store', async () => {
    const calls: Array<{ path: string; auth: string | null; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://web');
      calls.push({
        path: url.pathname,
        auth: new Headers(init?.headers).get('Authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === '/auth/token') return jsonResponse({ token: 'short-token' });
      if (url.pathname === '/sessions' && init?.method === 'POST') return jsonResponse(sessionBody());
      if (url.pathname === '/sessions/sess_web') return jsonResponse(sessionBody(true));
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    (globalThis as unknown as { EventSource?: typeof FakeEventSource }).EventSource = FakeEventSource;

    const store = new AgentStore();
    const bridge = new EventBridge(store, 'api-key');
    const session = await bridge.createSession({ workingDirectory: '/repo/cortx', metadata: { source: 'web' } });
    await bridge.connect(session.id);
    FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'text_delta', delta: 'hi' }) });
    FakeEventSource.instances[0].onmessage?.({ data: '{}' });

    await bridge.prompt(session.id, 'hello');
    await bridge.followUp(session.id, 'more');
    await bridge.steer(session.id, 'steer');
    await bridge.answer(session.id, 'tc_1', 'yes');
    await bridge.abort(session.id);
    await bridge.resume(session.id);
    const refreshed = await bridge.getSession(session.id);

    expect(refreshed.isRunning).toBe(true);
    expect(store.getState().sessionId).toBe('sess_web');
    expect(store.getState().messages.currentText).toBe('hi');
    expect(FakeEventSource.instances[0].url).toBe('/sessions/sess_web/events?token=short-token');
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
    ]);
    expect(calls[1].body).toEqual({ workingDirectory: '/repo/cortx', metadata: { source: 'web' } });
    expect(calls[0].auth).toBe('Bearer api-key');
    expect(calls.slice(1).every((call) => call.auth === 'Bearer short-token')).toBe(true);
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
