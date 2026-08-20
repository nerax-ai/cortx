import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeAgentEventEnvelope } from '@cortx/sdk';
import { CortxApiClient } from '../src/client/api-client';
import { FetchSseTransport, type SseHandlers, type SseSubscription } from '../src/client/sse-transport';
import type {
  WebCommandMetadata,
  WebEventHistoryResponse,
  WebRuntimeSessionInfo,
  WebSessionBaseline,
} from '../src/client/types';
import { SessionController } from '../src/session/session-controller';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SessionController', () => {
  test('fills durable sequence gaps before applying buffered live frames', async () => {
    const api = new FakeApi([session('a')]);
    api.history = (sessionId, options) => {
      if (sessionId !== 'a') return history([]);
      if (options.after === 1) return history([envelope('a', 2, { type: 'text_delta', delta: 'two' })]);
      return history([envelope('a', 1, { type: 'user_message', message: 'start', source: 'prompt' })]);
    };
    const transport = new FakeTransport();
    const controller = new SessionController({ api, transport });

    await controller.start();
    transport.emitSession('a', { type: 'replay-complete', lastSequence: 1 });
    transport.emitSession('a', {
      type: 'durable-event',
      envelope: envelope('a', 3, { type: 'text_delta', delta: 'three' }),
    });
    await waitFor(() => controller.getSnapshot().history.lastSequence === 3);

    expect(controller.getSnapshot().connection.phase).toBe('live');
    expect(controller.getSnapshot().agent.messages.currentText).toBe('twothree');
    expect(api.historyCalls).toContainEqual({ sessionId: 'a', options: { after: 1, limit: 2000 } });
    controller.close();
  });

  test('falls back to a full replay when one tail repair cannot close the live gap', async () => {
    const api = new FakeApi([session('a')]);
    api.history = (sessionId, options) => {
      if (sessionId !== 'a') return history([]);
      if (options.after === 1) return history([envelope('a', 2, { type: 'text_delta', delta: 'two' })]);
      if (options.limit === 2000) {
        return history([
          envelope('a', 1, { type: 'user_message', message: 'start', source: 'prompt' }),
          envelope('a', 2, { type: 'text_delta', delta: 'two' }),
          envelope('a', 3, { type: 'text_delta', delta: 'three' }),
        ]);
      }
      return history([envelope('a', 1, { type: 'user_message', message: 'start', source: 'prompt' })]);
    };
    const transport = new FakeTransport();
    const controller = new SessionController({ api, transport });

    await controller.start();
    transport.emitSession('a', { type: 'replay-complete', lastSequence: 1 });
    transport.emitSession('a', {
      type: 'durable-event',
      envelope: envelope('a', 4, { type: 'text_delta', delta: 'four' }),
    });
    await waitFor(() => controller.getSnapshot().history.lastSequence === 4);

    expect(controller.getSnapshot().agent.messages.currentText).toBe('twothreefour');
    expect(api.historyCalls).toContainEqual({ sessionId: 'a', options: { limit: 2000 } });
    controller.close();
  });

  test('uses an activation generation fence so a late session cannot replace the current one', async () => {
    const api = new FakeApi([session('a'), session('b')]);
    const pendingB = deferred<WebRuntimeSessionInfo>();
    api.getSessionOverride = (id) => (id === 'b' ? pendingB.promise : Promise.resolve(api.require(id)));
    const transport = new FakeTransport();
    const controller = new SessionController({ api, transport });
    await controller.start();

    const switchToB = controller.activate('b');
    const switchBackToA = controller.activate('a');
    await switchBackToA;
    pendingB.resolve(api.require('b'));
    await switchToB;

    expect(controller.getSnapshot().activeSessionId).toBe('a');
    expect(controller.getSnapshot().session?.id).toBe('a');
    controller.close();
  });

  test('ignores older-history responses after the active session changes', async () => {
    const api = new FakeApi([session('a'), session('b')]);
    const olderA = deferred<WebEventHistoryResponse>();
    api.history = (sessionId, options) => {
      if (sessionId === 'a' && options.before === 2) return olderA.promise;
      if (sessionId === 'a') return history([envelope('a', 2, { type: 'text', content: 'current-a' })]);
      return history([envelope('b', 1, { type: 'text', content: 'current-b' })]);
    };
    const controller = new SessionController({ api, transport: new FakeTransport() });
    await controller.start();

    const loadingOlder = controller.loadOlderHistory();
    await waitFor(() => controller.getSnapshot().history.loadingOlder);
    await controller.activate('b');
    olderA.resolve(history([envelope('a', 1, { type: 'text', content: 'older-a' })]));
    await loadingOlder;

    expect(controller.getSnapshot().activeSessionId).toBe('b');
    expect(controller.getSnapshot().history).toMatchObject({ sessionId: 'b', firstSequence: 1, lastSequence: 1 });
    expect(controller.getSnapshot().agent.messages.currentText).toBe('current-b');
    controller.close();
  });

  test('hydrates sessions that appear in the atomic baseline but not the initial list', async () => {
    const api = new FakeApi([session('a'), session('b')]);
    api.listSessionsOverride = async () => [api.require('a')];
    const controller = new SessionController({ api, transport: new FakeTransport() });

    await controller.start();

    expect(controller.getSnapshot().sessions.map((value) => value.id).sort()).toEqual(['a', 'b']);
    controller.close();
  });

  test('submits running input to the Runtime queue and cancels it through the command boundary', async () => {
    const running = session('run', {
      isRunning: true,
      runPhase: 'running',
      acceptsPrompt: false,
    });
    const api = new FakeApi([running]);
    const transport = new FakeTransport();
    const controller = new SessionController({ api, transport });
    await controller.start();

    await controller.send('next input');
    const followUp = api.followUps[0];
    expect(followUp.message).toBe('next input');
    expect(followUp.inputId).toBe(followUp.command.commandId);
    expect(followUp.command.expectedRuntimeIncarnation).toBe('runtime-1');
    expect(controller.getSnapshot().session?.queuedInputs).toEqual([
      expect.objectContaining({ inputId: followUp.inputId, message: 'next input', state: 'queued' }),
    ]);

    await controller.cancelFollowUp(followUp.inputId);
    expect(api.cancelledInputs).toEqual([followUp.inputId]);
    expect(controller.getSnapshot().session?.queuedInputs).toEqual([]);
    controller.close();
  });

  test('keeps command metadata stable in typed mutation payloads and submits canonical profile use', async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://web');
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ path: url.pathname, body });
      return jsonResponse({
        session: session('api', {
          toolMode: '@cortx-ai/workspace-tools/coding',
          toolProfile: '@cortx-ai/workspace-tools/coding',
        }),
      });
    }) as typeof fetch;
    const api = new CortxApiClient('secret');
    const command = { commandId: 'command-1', expectedRuntimeIncarnation: 'runtime-1' };

    await api.updateSession('api', { toolMode: '@cortx-ai/workspace-tools/coding' }, command);
    await api.prompt('api', 'hello', command);

    expect(calls[0]).toEqual({
      path: '/sessions/api',
      body: {
        toolMode: '@cortx-ai/workspace-tools/coding',
        commandId: 'command-1',
        expectedRuntimeIncarnation: 'runtime-1',
      },
    });
    expect(calls[1].body).toMatchObject(command);
  });

  test('reuses the original input command when an accepted response is lost', async () => {
    const api = new FakeApi([session('a')]);
    api.failNextPrompt = true;
    const controller = new SessionController({ api, transport: new FakeTransport() });
    await controller.start();

    await expect(controller.send('retry me')).rejects.toThrow('response lost');
    await controller.send('retry me');

    expect(api.prompts).toHaveLength(2);
    expect(api.prompts[1]?.command).toEqual(api.prompts[0]?.command);

    await controller.send('retry me');
    expect(api.prompts[2]?.command.commandId).not.toBe(api.prompts[0]?.command.commandId);
    controller.close();
  });

  test('restarts cleanly after a StrictMode-style close between starts', async () => {
    const api = new FakeApi([session('a')]);
    const transport = new FakeTransport();
    const controller = new SessionController({ api, transport });
    const first = controller.start();
    controller.close();
    await first.catch(() => undefined);
    await controller.start();

    expect(controller.getSnapshot().phase).toBe('ready');
    expect(controller.getSnapshot().session?.id).toBe('a');
    controller.close();
  });
});

class FakeApi extends CortxApiClient {
  readonly sessions = new Map<string, WebRuntimeSessionInfo>();
  readonly historyCalls: Array<{ sessionId: string; options: { after?: number; before?: number; limit?: number } }> = [];
  readonly followUps: Array<{ message: string; inputId: string; command: WebCommandMetadata }> = [];
  readonly prompts: Array<{ message: string; command: WebCommandMetadata }> = [];
  readonly cancelledInputs: string[] = [];
  failNextPrompt = false;
  history: (sessionId: string, options: { after?: number; before?: number; limit?: number }) => WebEventHistoryResponse | Promise<WebEventHistoryResponse> =
    () => history([]);
  getSessionOverride?: (id: string) => Promise<WebRuntimeSessionInfo>;
  listSessionsOverride?: () => Promise<WebRuntimeSessionInfo[]>;

  constructor(sessions: WebRuntimeSessionInfo[]) {
    super('fake');
    sessions.forEach((value) => this.sessions.set(value.id, value));
  }

  require(id: string): WebRuntimeSessionInfo {
    const value = this.sessions.get(id);
    if (!value) throw new Error(`Unknown session: ${id}`);
    return value;
  }

  override async listSessions() {
    return this.listSessionsOverride ? this.listSessionsOverride() : [...this.sessions.values()];
  }

  override async listModels() {
    return [];
  }

  override async listToolProfiles() {
    return [{ id: 'coding', use: '@cortx-ai/workspace-tools/coding', tools: [] }];
  }

  override async listAgentSpecs() {
    return [];
  }

  override async listSkillPacks() {
    return [];
  }

  override async getSessionBaseline(): Promise<WebSessionBaseline> {
    return {
      runtimeIncarnation: 'runtime-1',
      cursor: 'cursor-1',
      sessions: [...this.sessions.values()].map((value) => ({
        id: value.id,
        createdAt: value.createdAt,
        lastActivityAt: value.lastActivityAt,
        model: value.model,
        toolProfile: value.toolProfile ?? value.toolMode,
        pluginGeneration: value.pluginGeneration ?? 'plugins-1',
        runtimeIncarnation: value.runtimeIncarnation,
        projectionAsOfSequence: value.projectionAsOfSequence,
        runPhase: value.runPhase,
        sessionHealth: value.sessionHealth,
        resumable: value.resumable,
        acceptsPrompt: value.acceptsPrompt,
        isRunning: value.isRunning,
      })),
    };
  }

  override async getSession(id: string) {
    return this.getSessionOverride ? this.getSessionOverride(id) : this.require(id);
  }

  override async getEventHistory(
    sessionId: string,
    options: { after?: number; before?: number; limit?: number } = {},
  ) {
    this.historyCalls.push({ sessionId, options });
    return await this.history(sessionId, options);
  }

  override async createSession() {
    const created = session('created');
    this.sessions.set(created.id, created);
    return created;
  }

  override async prompt(sessionId: string, message: string, command: WebCommandMetadata) {
    this.prompts.push({ message, command });
    if (this.failNextPrompt) {
      this.failNextPrompt = false;
      throw new Error('response lost');
    }
    return this.require(sessionId);
  }

  override async followUp(
    sessionId: string,
    message: string,
    inputId: string,
    command: WebCommandMetadata,
  ) {
    this.followUps.push({ message, inputId, command });
    const current = this.require(sessionId);
    const next = {
      ...current,
      queuedInputs: [
        ...current.queuedInputs,
        {
          inputId,
          message,
          acceptedAt: 10,
          admissionSequence: 2,
          state: 'queued' as const,
        },
      ],
    };
    this.sessions.set(sessionId, next);
    return next;
  }

  override async cancelFollowUp(sessionId: string, inputId: string) {
    this.cancelledInputs.push(inputId);
    const current = this.require(sessionId);
    const next = { ...current, queuedInputs: current.queuedInputs.filter((input) => input.inputId !== inputId) };
    this.sessions.set(sessionId, next);
    return next;
  }
}

class FakeTransport extends FetchSseTransport {
  readonly connections: Array<{ path: string; handlers: SseHandlers; closed: boolean }> = [];

  constructor() {
    super('fake');
  }

  override connect(path: string, handlers: SseHandlers): SseSubscription {
    const connection = { path, handlers, closed: false };
    this.connections.push(connection);
    handlers.onOpen?.();
    return {
      close: () => {
        connection.closed = true;
      },
      done: Promise.resolve(),
    };
  }

  emitSession(sessionId: string, frame: unknown): void {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed && entry.path.includes(`/sessions/${sessionId}/events?`));
    if (!connection) throw new Error(`No stream for ${sessionId}`);
    connection.handlers.onFrame(frame);
  }
}

function session(id: string, patch: Partial<WebRuntimeSessionInfo> = {}): WebRuntimeSessionInfo {
  return {
    id,
    createdAt: 1,
    lastActivityAt: id === 'a' ? 2 : 1,
    workingDirectory: '/repo',
    model: 'model',
    toolMode: '@cortx-ai/workspace-tools/coding',
    toolProfile: '@cortx-ai/workspace-tools/coding',
    pluginGeneration: 'plugins-1',
    approvalMode: 'interactive',
    runtimeIncarnation: 'runtime-1',
    projectionAsOfSequence: 1,
    eventRetention: { oldestAvailableSequence: 1, lastAvailableSequence: 1 },
    runPhase: 'idle',
    sessionHealth: 'healthy',
    resumable: false,
    acceptsPrompt: true,
    pendingInteraction: null,
    queuedInputs: [],
    isRunning: false,
    eventCount: 1,
    ...patch,
  };
}

function envelope(sessionId: string, sequence: number, event: RuntimeAgentEventEnvelope['event']): RuntimeAgentEventEnvelope {
  return {
    sequence,
    timestamp: 1000 + sequence,
    sessionId,
    runId: 1,
    event,
  };
}

function history(events: RuntimeAgentEventEnvelope[]): WebEventHistoryResponse {
  return {
    events,
    replayComplete: true,
    page: {
      hasMoreBefore: false,
      firstSequence: events[0]?.sequence,
      lastSequence: events.at(-1)?.sequence,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error('Timed out waiting for controller state');
}
