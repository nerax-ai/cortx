import type { AgentEvent } from '@cortx/sdk';
import type { DiscoveredAgentSpec, RuntimeSessionCreateRequest, RuntimeSessionInfo } from '@cortx/runtime';

export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 30 * 1000;

export interface RemoteRuntimeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  eventSourceFactory?: EventSourceFactory;
}

export interface RemoteAgentSpecLaunchRequest {
  spec?: Record<string, unknown>;
  path?: string;
}

export type RemoteAgentSpecInfo = DiscoveredAgentSpec;

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function defaultEventSourceFactory(url: string): EventSourceLike {
  const ctor = (
    globalThis as unknown as {
      EventSource?: new (url: string) => EventSourceLike;
    }
  ).EventSource;
  if (!ctor) throw new Error('EventSource is not available in this runtime.');
  return new ctor(url);
}

function serializeEvent(event: AgentEvent): AgentEvent {
  if (event.type !== 'error') return event;
  const errorLike = event.error as unknown;
  if (errorLike instanceof Error) return event;
  const message =
    typeof errorLike === 'object' && errorLike !== null && 'message' in errorLike
      ? String((errorLike as { message: unknown }).message)
      : String(errorLike);
  return { ...event, error: new Error(message) };
}

export class RemoteRuntimeClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly eventSourceFactory: EventSourceFactory;
  private token: string | undefined;
  private tokenExpiresAt: number | undefined;

  constructor(options: RemoteRuntimeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
  }

  async createSession(request: RuntimeSessionCreateRequest = {}): Promise<RuntimeSessionInfo> {
    const data = await this.request<{ session: RuntimeSessionInfo }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return data.session;
  }

  async getSession(sessionId: string): Promise<RuntimeSessionInfo> {
    const data = await this.request<{ session: RuntimeSessionInfo }>(`/sessions/${encodeURIComponent(sessionId)}`);
    return data.session;
  }

  async launchAgentSpec(request: RemoteAgentSpecLaunchRequest): Promise<RuntimeSessionInfo> {
    const data = await this.request<{ session: RuntimeSessionInfo }>('/agent-specs/launch', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return data.session;
  }

  async listAgentSpecs(): Promise<RemoteAgentSpecInfo[]> {
    const data = await this.request<{ agentSpecs: RemoteAgentSpecInfo[] }>('/agent-specs');
    return data.agentSpecs;
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    await this.postMessage(sessionId, 'prompt', message);
  }

  async steer(sessionId: string, message: string): Promise<void> {
    await this.postMessage(sessionId, 'steer', message);
  }

  async followUp(sessionId: string, message: string): Promise<void> {
    await this.postMessage(sessionId, 'follow-up', message);
  }

  async resume(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' });
  }

  async answer(sessionId: string, toolCallId: string, response: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId, response }),
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
  }

  async connectEvents(sessionId: string, onEvent: (event: AgentEvent) => void): Promise<() => void> {
    const token = await this.exchangeToken();
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token)}`;
    const source = this.eventSourceFactory(url);
    source.onmessage = (message) => {
      if (!message.data || message.data === '{}') return;
      try {
        const event = serializeEvent(JSON.parse(message.data) as AgentEvent);
        if (event.type) onEvent(event);
      } catch {
        /* ignore malformed SSE payloads */
      }
    };
    source.onerror = () => {
      /* EventSource handles reconnects; UI state is driven by runtime events. */
    };
    return () => source.close();
  }

  private async postMessage(
    sessionId: string,
    action: 'prompt' | 'steer' | 'follow-up',
    message: string,
  ): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  private async exchangeToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt && this.tokenExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return this.token;
    }
    const data = await this.request<{ token: string; expiresAt?: number }>('/auth/token', { method: 'POST' });
    this.token = data.token;
    this.tokenExpiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : Date.now() + DEFAULT_TOKEN_TTL_MS;
    return data.token;
  }

  private async request<T = { ok: boolean }>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let body: { error?: string; kind?: string; details?: Record<string, unknown> } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        /* keep default body */
      }
      throw new RemoteRuntimeError(
        body.error ?? `Request failed: ${response.status}`,
        response.status,
        body.kind,
        body.details,
      );
    }

    return response.json() as Promise<T>;
  }
}
