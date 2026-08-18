import type { AgentEvent, RuntimeAgentEventEnvelope } from '@cortx/sdk';
import type { DiscoveredAgentSpec, InstalledSkillPack, RuntimeSessionCreateRequest, RuntimeSessionInfo } from '@cortx/runtime';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RemoteRuntimeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
}

export interface RemoteEventSubscription {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface RemoteAgentSpecLaunchRequest {
  spec?: Record<string, unknown>;
  path?: string;
}

export type RemoteAgentSpecInfo = DiscoveredAgentSpec;
export type RemoteSkillPackInfo = InstalledSkillPack;

export interface RemoteSkillPackInstallRequest {
  path: string;
  id?: string;
}

export class RemoteRuntimeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RemoteRuntimeError';
  }
}

export class RemoteRuntimeClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #eventSequences = new Map<string, number>();
  readonly #subscriptions = new Set<RemoteEventSubscription>();
  #closed = false;
  #closeResult?: Promise<void>;

  constructor(options: RemoteRuntimeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!options.apiKey.trim()) throw new Error('Remote Runtime API key is required');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async createSession(request: RuntimeSessionCreateRequest = {}): Promise<RuntimeSessionInfo> {
    const data = await this.#request<{ session: RuntimeSessionInfo }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return data.session;
  }

  async getSession(sessionId: string): Promise<RuntimeSessionInfo> {
    const data = await this.#request<{ session: RuntimeSessionInfo }>(`/sessions/${encodeURIComponent(sessionId)}`);
    return data.session;
  }

  async listSessions(): Promise<RuntimeSessionInfo[]> {
    return (await this.#request<{ sessions: RuntimeSessionInfo[] }>('/sessions')).sessions;
  }

  async launchAgentSpec(request: RemoteAgentSpecLaunchRequest): Promise<RuntimeSessionInfo> {
    return (await this.#request<{ session: RuntimeSessionInfo }>('/agent-specs/launch', {
      method: 'POST',
      body: JSON.stringify(request),
    })).session;
  }

  async listAgentSpecs(): Promise<RemoteAgentSpecInfo[]> {
    return (await this.#request<{ agentSpecs: RemoteAgentSpecInfo[] }>('/agent-specs')).agentSpecs;
  }

  async listSkillPacks(): Promise<RemoteSkillPackInfo[]> {
    return (await this.#request<{ skillPacks: RemoteSkillPackInfo[] }>('/skill-packs')).skillPacks;
  }

  async installSkillPack(request: RemoteSkillPackInstallRequest): Promise<RemoteSkillPackInfo> {
    return (await this.#request<{ skillPack: RemoteSkillPackInfo }>('/skill-packs/install', {
      method: 'POST',
      body: JSON.stringify(request),
    })).skillPack;
  }

  prompt(sessionId: string, message: string): Promise<void> {
    return this.#postMessage(sessionId, 'prompt', message);
  }

  steer(sessionId: string, message: string): Promise<void> {
    return this.#postMessage(sessionId, 'steer', message);
  }

  followUp(sessionId: string, message: string): Promise<void> {
    return this.#postMessage(sessionId, 'follow-up', message);
  }

  async resume(sessionId: string): Promise<void> {
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' });
  }

  async answer(sessionId: string, toolCallId: string, response: string): Promise<void> {
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId, response }),
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
  }

  async connectEvents(sessionId: string, onEvent: (event: AgentEvent) => void): Promise<RemoteEventSubscription> {
    this.#assertOpen();
    const controller = new AbortController();
    const params = new URLSearchParams({ format: 'envelope' });
    const lastSequence = this.#eventSequences.get(sessionId);
    if (lastSequence !== undefined) params.set('after', String(lastSequence));
    const response = await this.#fetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events?${params}`,
      { method: 'GET', headers: this.#headers(), signal: controller.signal },
    );
    if (!response.ok) throw await remoteError(response);
    if (!response.body) throw new RemoteRuntimeError('Event stream response has no body', response.status);

    const reader = response.body.getReader();
    let closeResult: Promise<void> | undefined;
    const closed = pumpSse(reader, (data) => {
      const parsed = parseEvent(data, sessionId, this.#eventSequences);
      if (parsed) onEvent(parsed);
    }, controller.signal).catch((error) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      onEvent({ type: 'error', error: asError(error), code: 'stream_error' });
    });
    const subscription: RemoteEventSubscription = {
      closed,
      close() {
        closeResult ??= (async () => {
          controller.abort(new Error('Remote event subscription closed'));
          await reader.cancel().catch(() => undefined);
          await closed;
        })();
        return closeResult;
      },
    };
    this.#subscriptions.add(subscription);
    void closed.finally(() => this.#subscriptions.delete(subscription));
    return subscription;
  }

  close(): Promise<void> {
    if (this.#closeResult) return this.#closeResult;
    this.#closed = true;
    this.#closeResult = closeSubscriptions(this.#subscriptions);
    return this.#closeResult;
  }

  async #postMessage(sessionId: string, action: 'prompt' | 'steer' | 'follow-up', message: string): Promise<void> {
    await this.#request(`/sessions/${encodeURIComponent(sessionId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async #request<T = { ok: boolean }>(path: string, init: RequestInit = {}): Promise<T> {
    this.#assertOpen();
    const headers = this.#headers(init.headers);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await this.#fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw await remoteError(response);
    return response.json() as Promise<T>;
  }

  #headers(input?: HeadersInit): Headers {
    const headers = new Headers(input);
    headers.set('Authorization', `Bearer ${this.#apiKey}`);
    return headers;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Remote Runtime client is closed');
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error('Remote Runtime baseUrl must be an absolute HTTP(S) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Remote Runtime baseUrl must use HTTP(S)');
  }
  if (url.username || url.password) throw new Error('Remote Runtime baseUrl must not contain credentials');
  if (url.search || url.hash) throw new Error('Remote Runtime baseUrl must not contain query parameters or fragments');
  return url.toString().replace(/\/+$/, '');
}

async function remoteError(response: Response): Promise<RemoteRuntimeError> {
  let body: { error?: string; kind?: string; details?: Record<string, unknown> } = {};
  try { body = await response.json() as typeof body; }
  catch { /* response status remains authoritative */ }
  return new RemoteRuntimeError(
    body.error ?? `Request failed: ${response.status}`,
    response.status,
    body.kind,
    body.details,
  );
}

async function pumpSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onData: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      dispatchSseFrame(buffer.slice(0, separator), onData);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatchSseFrame(buffer, onData);
}

function dispatchSseFrame(frame: string, onData: (data: string) => void): void {
  const data = frame.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (data && data !== '{}') onData(data);
}

function parseEvent(data: string, sessionId: string, sequences: Map<string, number>): AgentEvent | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    const envelope = isEnvelope(parsed) ? parsed : undefined;
    if (envelope) {
      const current = sequences.get(sessionId);
      if (current !== undefined && envelope.sequence <= current) return undefined;
      sequences.set(sessionId, envelope.sequence);
    }
    return serializeEvent(envelope ? envelope.event : parsed as AgentEvent);
  } catch {
    return undefined;
  }
}

function serializeEvent(event: AgentEvent): AgentEvent {
  if (event.type !== 'error') return event;
  return { ...event, error: asError(event.error) };
}

function isEnvelope(value: unknown): value is RuntimeAgentEventEnvelope {
  return typeof value === 'object' && value !== null
    && typeof (value as { sequence?: unknown }).sequence === 'number'
    && typeof (value as { timestamp?: unknown }).timestamp === 'number'
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && typeof (value as { runId?: unknown }).runId === 'number'
    && typeof (value as { event?: unknown }).event === 'object'
    && (value as { event?: unknown }).event !== null;
}

async function closeSubscriptions(subscriptions: Set<RemoteEventSubscription>): Promise<void> {
  const failures: unknown[] = [];
  for (const subscription of [...subscriptions]) {
    try { await subscription.close(); }
    catch (error) { failures.push(error); }
  }
  subscriptions.clear();
  if (failures.length > 0) throw new AggregateError(failures, 'Remote Runtime client close failed');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'object' && value !== null && 'message' in value) return new Error(String(value.message));
  return new Error(String(value));
}
