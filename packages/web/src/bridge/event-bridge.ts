import type { AgentEvent } from '@cortx/sdk';
import type { AgentStore } from '@cortx/store';
import { createAuthClient, getAuthToken, apiFetch, type AuthClient } from './auth';

export type WebWorkspaceToolMode = 'none' | 'read-only' | 'coding' | 'all';
export type WebApprovalMode = 'deny' | 'interactive' | 'full-access';

export interface WebRuntimeSessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  maxIterations?: number;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  isRunning: boolean;
  eventCount: number;
  metadata?: Record<string, unknown>;
}

export interface WebCreateSessionRequest {
  workingDirectory?: string;
  model?: string;
  system?: string;
  maxIterations?: number;
  toolMode?: WebWorkspaceToolMode;
  approvalMode?: WebApprovalMode;
  metadata?: Record<string, unknown>;
}

export class EventBridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EventBridgeError';
  }
}

async function throwIfError(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  let body: { error?: string; kind?: string; details?: Record<string, unknown> } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* keep default body */
  }
  throw new EventBridgeError(body.error ?? `${fallback}: ${res.status}`, res.status, body.kind, body.details);
}

function normalizeEvent(event: AgentEvent): AgentEvent {
  if (event.type !== 'error') return event;
  const raw = event.error as unknown;
  if (raw instanceof Error) return event;
  const message =
    typeof raw === 'object' && raw !== null && 'message' in raw
      ? String((raw as { message: unknown }).message)
      : String(raw);
  return { ...event, error: new Error(message) };
}

export class EventBridge {
  readonly store: AgentStore;
  private client: AuthClient;
  private eventSource: EventSource | null = null;

  constructor(store: AgentStore, apiKey = '', baseUrl = '') {
    this.store = store;
    this.client = createAuthClient(apiKey, baseUrl);
  }

  async createSession(request: WebCreateSessionRequest = {}): Promise<WebRuntimeSessionInfo> {
    const res = await apiFetch(this.client, '/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    await throwIfError(res, 'Create session failed');
    const data = (await res.json()) as { session: WebRuntimeSessionInfo };
    return data.session;
  }

  async getSession(sessionId: string): Promise<WebRuntimeSessionInfo> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}`);
    await throwIfError(res, 'Get session failed');
    const data = (await res.json()) as { session: WebRuntimeSessionInfo };
    return data.session;
  }

  async listSessions(): Promise<WebRuntimeSessionInfo[]> {
    const res = await apiFetch(this.client, '/sessions');
    await throwIfError(res, 'List sessions failed');
    const data = (await res.json()) as { sessions: WebRuntimeSessionInfo[] };
    return data.sessions;
  }

  async connect(sessionId: string): Promise<void> {
    this.disconnect();
    this.store.reset(sessionId);
    const token = await getAuthToken(this.client);
    const url = `${this.client.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token)}`;
    this.eventSource = new EventSource(url);
    this.eventSource.onmessage = (e) => {
      try {
        if (!e.data || e.data === '{}') return;
        const event = normalizeEvent(JSON.parse(e.data) as AgentEvent);
        if (event.type) {
          this.store.dispatch(event);
        }
      } catch {
        /* ignore parse errors */
      }
    };
    this.eventSource.onerror = () => {
      // Auto-reconnect is handled by EventSource
    };
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    this.store.addUserMessage(message);
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    await throwIfError(res, 'Prompt failed');
  }

  async steer(sessionId: string, message: string): Promise<void> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    await throwIfError(res, 'Steer failed');
  }

  async followUp(sessionId: string, message: string): Promise<void> {
    this.store.addUserMessage(message);
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}/follow-up`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    await throwIfError(res, 'Follow-up failed');
  }

  async resume(sessionId: string): Promise<void> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' });
    await throwIfError(res, 'Resume failed');
  }

  async abort(sessionId: string): Promise<void> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
    await throwIfError(res, 'Abort failed');
  }

  async answer(sessionId: string, toolCallId: string, response: string): Promise<void> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId, response }),
    });
    await throwIfError(res, 'Answer failed');
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
