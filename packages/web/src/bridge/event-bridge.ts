import type { AgentEvent, RuntimeAgentEventEnvelope } from '@cortx/sdk';
import type { AgentStore } from '@cortx/store';
import { createAuthClient, getAuthToken, apiFetch, type AuthClient } from './auth';

export type WebWorkspaceToolMode = 'none' | 'read-only' | 'coding' | 'all';
export type WebApprovalMode = 'deny' | 'interactive' | 'full-access';
export type WebEventConnectionPhase =
  | 'connecting'
  | 'replaying'
  | 'live'
  | 'reconnecting'
  | 'disconnected'
  | 'closed';

export interface WebEventConnectionState {
  phase: WebEventConnectionPhase;
  sessionId?: string;
  lastSequence?: number;
  lastEventAt?: number;
  message?: string;
  updatedAt: number;
}

export interface EventBridgeOptions {
  onConnectionState?: (state: WebEventConnectionState) => void;
}

export interface WebRuntimeSessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  system?: string;
  maxIterations?: number;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  capabilities?: Record<string, unknown>;
  skillPaths?: string[];
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

export interface WebAgentSpecLaunchRequest {
  spec?: Record<string, unknown>;
  path?: string;
}

export interface WebAgentSpecInfo {
  path: string;
  relativePath: string;
  sourceRoot: string;
  name: string;
  promptPreview: string;
  workingDirectory?: string;
  toolMode?: WebWorkspaceToolMode;
  approvalMode?: WebApprovalMode;
  skillPacks?: string[];
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

function isEnvelope(value: unknown): value is RuntimeAgentEventEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    'timestamp' in value &&
    typeof (value as { timestamp: unknown }).timestamp === 'number'
  );
}

export class EventBridge {
  readonly store: AgentStore;
  private client: AuthClient;
  private eventSource: EventSource | null = null;
  private activeSessionId: string | null = null;
  private connectionState: WebEventConnectionState = { phase: 'closed', updatedAt: Date.now() };

  constructor(
    store: AgentStore,
    apiKey = '',
    baseUrl = '',
    private readonly options: EventBridgeOptions = {},
  ) {
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

  async listAgentSpecs(): Promise<WebAgentSpecInfo[]> {
    const res = await apiFetch(this.client, '/agent-specs');
    await throwIfError(res, 'List AgentSpecs failed');
    const data = (await res.json()) as { agentSpecs: WebAgentSpecInfo[] };
    return data.agentSpecs;
  }

  async launchAgentSpec(request: WebAgentSpecLaunchRequest): Promise<WebRuntimeSessionInfo> {
    const res = await apiFetch(this.client, '/agent-specs/launch', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    await throwIfError(res, 'Launch AgentSpec failed');
    const data = (await res.json()) as { session: WebRuntimeSessionInfo };
    return data.session;
  }

  async connect(sessionId: string): Promise<void> {
    this.disconnect();
    this.activeSessionId = sessionId;
    this.emitConnection({ phase: 'connecting', sessionId, message: 'Opening event stream' });
    this.store.reset(sessionId);
    try {
      const token = await getAuthToken(this.client);
      const url = `${this.client.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events?format=envelope&token=${encodeURIComponent(token)}`;
      const source = new EventSource(url);
      this.eventSource = source;
      this.emitConnection({ phase: 'replaying', sessionId, message: 'Restoring event history' });
      source.onopen = () => {
        if (this.eventSource === source) {
          this.emitConnection({ phase: 'replaying', sessionId, message: 'Restoring event history' });
        }
      };
      source.onmessage = (e) => this.handleSseMessage(source, sessionId, e.data);
      source.onerror = () => {
        if (this.eventSource === source) {
          this.emitConnection({ phase: 'reconnecting', sessionId, message: 'Event stream interrupted' });
        }
      };
    } catch (error) {
      this.emitConnection({
        phase: 'disconnected',
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private handleSseMessage(source: EventSource, sessionId: string, data: string): void {
    if (this.eventSource !== source) return;
    try {
      if (!data || data === '{}') {
        this.emitConnection({ phase: 'live', sessionId, message: 'Live event stream' });
        return;
      }
      const parsed = JSON.parse(data) as AgentEvent | RuntimeAgentEventEnvelope;
      const envelope = isEnvelope(parsed) ? parsed : null;
      const event = envelope ? normalizeEvent(envelope.event) : normalizeEvent(parsed as AgentEvent);
      if (event.type) {
        this.store.dispatch(event, envelope?.timestamp);
        this.emitConnection({
          phase: 'live',
          sessionId,
          lastSequence: envelope?.sequence,
          lastEventAt: envelope?.timestamp,
          message: 'Live event stream',
        });
      }
    } catch {
      /* ignore parse errors */
    }
  }

  private emitConnection(next: Omit<WebEventConnectionState, 'updatedAt'>): void {
    const sameSession = next.sessionId !== undefined && next.sessionId === this.connectionState.sessionId;
    this.connectionState = {
      phase: next.phase,
      sessionId: next.sessionId,
      lastSequence: next.lastSequence ?? (sameSession ? this.connectionState.lastSequence : undefined),
      lastEventAt: next.lastEventAt ?? (sameSession ? this.connectionState.lastEventAt : undefined),
      message: next.message,
      updatedAt: Date.now(),
    };
    this.options.onConnectionState?.(this.connectionState);
  }

  getConnectionState(): WebEventConnectionState {
    return this.connectionState;
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
    const sessionId = this.activeSessionId ?? undefined;
    this.eventSource?.close();
    this.eventSource = null;
    this.activeSessionId = null;
    if (sessionId) {
      this.emitConnection({ phase: 'closed', sessionId, message: 'Event stream closed' });
    }
  }
}
