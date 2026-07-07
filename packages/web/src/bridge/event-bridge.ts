import type { AgentDoneUsage, AgentEvent, ContextUsageSource, RuntimeAgentEventEnvelope } from '@cortx/sdk';
import type { AgentStore, AgentStoreEventInput } from '@cortx/store';
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
  onHistoryState?: (state: WebEventHistoryState) => void;
}

export interface WebEventHistoryState {
  sessionId?: string;
  hasMoreBefore: boolean;
  loadedEvents: number;
  firstSequence?: number;
  lastSequence?: number;
  loadingOlder: boolean;
}

export interface WebRuntimeSessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  capabilities?: Record<string, unknown>;
  skillPaths?: string[];
  skillPacks?: string[];
  promptHistory?: string[];
  usage?: AgentDoneUsage;
  isRunning: boolean;
  eventCount: number;
  metadata?: Record<string, unknown>;
}

export interface WebCreateSessionRequest {
  workingDirectory?: string;
  model?: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  toolMode?: WebWorkspaceToolMode;
  approvalMode?: WebApprovalMode;
  skillPacks?: string[];
  metadata?: Record<string, unknown>;
}

export interface WebUpdateSessionRequest {
  model?: string;
  reasoningEffort?: string | null;
  toolMode?: WebWorkspaceToolMode;
  approvalMode?: WebApprovalMode;
  contextWindowTokens?: number;
  skillPacks?: string[];
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

export interface WebSkillPackInfo {
  id: string;
  sourcePath: string;
  installedAt: number;
  path: string;
  name?: string;
  version?: string;
  description?: string;
  skillPaths: string[];
  agentSpecPaths: string[];
  metadata?: Record<string, unknown>;
}

export interface WebSkillPackInstallRequest {
  path: string;
  id?: string;
}

export interface WebWorkspaceDirectoryEntry {
  name: string;
  path: string;
}

export interface WebWorkspaceDirectoryListing {
  roots: string[];
  current: string;
  parent?: string;
  entries: WebWorkspaceDirectoryEntry[];
}

export interface WebSkillInfo {
  name: string;
  description: string;
  arguments?: string[];
  dirPath: string;
}

export interface WebReasoningEffortOption {
  value: string;
  label: string;
}

export interface WebModelInfo {
  id: string;
  name: string;
  contextWindowTokens?: number;
  reasoningEfforts?: WebReasoningEffortOption[];
}

interface WebEventHistoryPageInfo {
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
  firstSequence?: number;
  lastSequence?: number;
}

interface WebEventHistoryResponse {
  events?: RuntimeAgentEventEnvelope[];
  page?: WebEventHistoryPageInfo;
}

const EVENT_HISTORY_PAGE_SIZE = 800;

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
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sequence === 'number' &&
    typeof record.timestamp === 'number' &&
    typeof record.sessionId === 'string' &&
    typeof record.runId === 'number' &&
    typeof record.event === 'object' &&
    record.event !== null
  );
}

function mergeEnvelopes(...groups: RuntimeAgentEventEnvelope[][]): RuntimeAgentEventEnvelope[] {
  const bySequence = new Map<number, RuntimeAgentEventEnvelope>();
  for (const group of groups) {
    for (const envelope of group) {
      bySequence.set(envelope.sequence, envelope);
    }
  }
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

export class EventBridge {
  readonly store: AgentStore;
  private client: AuthClient;
  private eventSource: EventSource | null = null;
  private activeSessionId: string | null = null;
  private connectionState: WebEventConnectionState = { phase: 'closed', updatedAt: Date.now() };
  private replaying = false;
  private replayBuffer: RuntimeAgentEventEnvelope[] = [];
  private replayLastSequence: number | undefined;
  private replayLastEventAt: number | undefined;
  private loadedEnvelopes: RuntimeAgentEventEnvelope[] = [];
  private historyHasMoreBefore = false;
  private loadingOlderHistory = false;

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

  async updateSession(sessionId: string, request: WebUpdateSessionRequest): Promise<WebRuntimeSessionInfo> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    });
    await throwIfError(res, 'Update session failed');
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

  async deleteSession(sessionId: string): Promise<void> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    await throwIfError(res, 'Delete session failed');
    if (this.activeSessionId === sessionId) this.disconnect();
  }

  async listModels(): Promise<WebModelInfo[]> {
    const res = await apiFetch(this.client, '/models');
    await throwIfError(res, 'List models failed');
    const data = (await res.json()) as { models: WebModelInfo[] };
    return data.models;
  }

  async listSessionSkills(sessionId: string): Promise<WebSkillInfo[]> {
    const res = await apiFetch(this.client, `/sessions/${encodeURIComponent(sessionId)}/skills`);
    await throwIfError(res, 'List session skills failed');
    const data = (await res.json()) as { skills: WebSkillInfo[] };
    return data.skills;
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

  async listSkillPacks(): Promise<WebSkillPackInfo[]> {
    const res = await apiFetch(this.client, '/skill-packs');
    await throwIfError(res, 'List SkillPacks failed');
    const data = (await res.json()) as { skillPacks: WebSkillPackInfo[] };
    return data.skillPacks;
  }

  async installSkillPack(request: WebSkillPackInstallRequest): Promise<WebSkillPackInfo> {
    const res = await apiFetch(this.client, '/skill-packs/install', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    await throwIfError(res, 'Install SkillPack failed');
    const data = (await res.json()) as { skillPack: WebSkillPackInfo };
    return data.skillPack;
  }

  async listWorkspaceDirectories(path?: string): Promise<WebWorkspaceDirectoryListing> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await apiFetch(this.client, `/workspaces/directories${query}`);
    await throwIfError(res, 'List workspace directories failed');
    return (await res.json()) as WebWorkspaceDirectoryListing;
  }

  async connect(sessionId: string): Promise<void> {
    this.disconnect();
    this.activeSessionId = sessionId;
    this.replaying = true;
    this.replayBuffer = [];
    this.replayLastSequence = undefined;
    this.replayLastEventAt = undefined;
    this.loadedEnvelopes = [];
    this.historyHasMoreBefore = false;
    this.loadingOlderHistory = false;
    this.emitHistoryState(sessionId);
    this.emitConnection({ phase: 'connecting', sessionId, message: 'Loading event history' });
    this.store.reset(sessionId);
    try {
      this.emitConnection({ phase: 'replaying', sessionId, message: 'Restoring event history' });
      await this.loadEventHistory(sessionId);
      if (this.activeSessionId !== sessionId) return;

      const token = await getAuthToken(this.client);
      const params = new URLSearchParams({
        format: 'envelope',
        replay: 'false',
        token,
      });
      if (this.replayLastSequence !== undefined) {
        params.set('after', String(this.replayLastSequence));
      }
      const url = `${this.client.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`;
      const source = new EventSource(url);
      this.eventSource = source;
      source.onopen = () => {
        if (this.eventSource === source) {
          this.emitConnection({ phase: 'replaying', sessionId, message: 'Syncing live tail' });
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

  private async loadEventHistory(sessionId: string): Promise<void> {
    const data = await this.fetchEventHistory(sessionId, { limit: EVENT_HISTORY_PAGE_SIZE });
    if (this.activeSessionId !== sessionId) return;
    this.loadedEnvelopes = this.normalizeHistoryEnvelopes(sessionId, data.events ?? []);
    this.historyHasMoreBefore = Boolean(data.page?.hasMoreBefore);
    this.replayLastSequence = this.loadedEnvelopes.at(-1)?.sequence;
    this.replayLastEventAt = this.loadedEnvelopes.at(-1)?.timestamp;
    this.replayLoadedHistory(sessionId, { reset: false });
    this.emitHistoryState(sessionId);
  }

  async loadOlderHistory(sessionId: string): Promise<WebEventHistoryState> {
    if (this.activeSessionId !== sessionId) {
      throw new EventBridgeError('Cannot load history for an inactive session', 409, 'invalid_request');
    }
    if (!this.historyHasMoreBefore || this.loadingOlderHistory) return this.currentHistoryState(sessionId);
    const before = this.loadedEnvelopes[0]?.sequence;
    if (before === undefined) return this.currentHistoryState(sessionId);

    this.loadingOlderHistory = true;
    this.emitHistoryState(sessionId);
    try {
      const data = await this.fetchEventHistory(sessionId, { before, limit: EVENT_HISTORY_PAGE_SIZE });
      if (this.activeSessionId !== sessionId) return this.currentHistoryState(sessionId);
      const older = this.normalizeHistoryEnvelopes(sessionId, data.events ?? []);
      this.loadedEnvelopes = mergeEnvelopes(older, this.loadedEnvelopes);
      this.historyHasMoreBefore = Boolean(data.page?.hasMoreBefore);
      this.replayLastSequence = this.loadedEnvelopes.at(-1)?.sequence;
      this.replayLastEventAt = this.loadedEnvelopes.at(-1)?.timestamp;
      this.replayLoadedHistory(sessionId);
      return this.currentHistoryState(sessionId);
    } finally {
      this.loadingOlderHistory = false;
      this.emitHistoryState(sessionId);
    }
  }

  private async fetchEventHistory(
    sessionId: string,
    options: { before?: number; limit?: number } = {},
  ): Promise<WebEventHistoryResponse> {
    const params = new URLSearchParams({ format: 'envelope' });
    if (options.before !== undefined) params.set('before', String(options.before));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const res = await apiFetch(
      this.client,
      `/sessions/${encodeURIComponent(sessionId)}/events/history?${params.toString()}`,
    );
    await throwIfError(res, 'Load event history failed');
    return (await res.json()) as WebEventHistoryResponse;
  }

  private normalizeHistoryEnvelopes(sessionId: string, items: RuntimeAgentEventEnvelope[]): RuntimeAgentEventEnvelope[] {
    const envelopes: RuntimeAgentEventEnvelope[] = [];
    for (const item of items) {
      if (!isEnvelope(item)) continue;
      if (item.sessionId !== sessionId) continue;
      const event = normalizeEvent(item.event);
      if (!event.type) continue;
      envelopes.push({ ...item, event });
    }
    return mergeEnvelopes(envelopes);
  }

  private replayLoadedHistory(sessionId: string, options: { reset?: boolean } = {}): void {
    if (options.reset ?? true) this.store.reset(sessionId);
    const history: AgentStoreEventInput[] = [];
    for (const item of this.loadedEnvelopes) {
      history.push({ event: item.event, timestamp: item.timestamp });
    }
    this.store.dispatchMany(history);
  }

  private handleSseMessage(source: EventSource, sessionId: string, data: string): void {
    if (this.eventSource !== source) return;
    try {
      if (!data || data === '{}') {
        this.flushReplayBuffer();
        this.replaying = false;
        this.emitConnection({
          phase: 'live',
          sessionId,
          lastSequence: this.replayLastSequence,
          lastEventAt: this.replayLastEventAt,
          message: 'Live event stream',
        });
        void this.reconcileRuntimeSession(sessionId);
        return;
      }
      const parsed = JSON.parse(data) as AgentEvent | RuntimeAgentEventEnvelope;
      const envelope = isEnvelope(parsed) ? parsed : null;
      const event = envelope ? normalizeEvent(envelope.event) : normalizeEvent(parsed as AgentEvent);
      if (event.type) {
        if (envelope?.sequence !== undefined && this.replayLastSequence !== undefined) {
          if (envelope.sequence <= this.replayLastSequence) return;
        }
        if (this.replaying) {
          if (envelope) this.replayBuffer.push({ ...envelope, event });
          this.replayLastSequence = envelope?.sequence ?? this.replayLastSequence;
          this.replayLastEventAt = envelope?.timestamp ?? this.replayLastEventAt;
          return;
        }
        if (envelope) {
          this.loadedEnvelopes = mergeEnvelopes(this.loadedEnvelopes, [{ ...envelope, event }]);
          this.emitHistoryState(sessionId);
        }
        this.store.dispatch(event, envelope?.timestamp);
        this.replayLastSequence = envelope?.sequence ?? this.replayLastSequence;
        this.replayLastEventAt = envelope?.timestamp ?? this.replayLastEventAt;
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

  private flushReplayBuffer(): void {
    if (this.replayBuffer.length === 0) return;
    this.loadedEnvelopes = mergeEnvelopes(this.loadedEnvelopes, this.replayBuffer);
    this.store.dispatchMany(this.replayBuffer.map((item) => ({ event: item.event, timestamp: item.timestamp })));
    this.replayBuffer = [];
    if (this.activeSessionId) this.emitHistoryState(this.activeSessionId);
  }

  private async reconcileRuntimeSession(sessionId: string): Promise<void> {
    try {
      const session = await this.getSession(sessionId);
      if (this.activeSessionId !== sessionId) return;
      this.store.syncRuntimeSession({
        sessionId,
        isRunning: session.isRunning,
        tokenUsage: session.usage,
        contextUsage: session.usage?.context,
      });
    } catch {
      /* Status reconciliation is best-effort; the SSE reconnect path remains authoritative. */
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

  private currentHistoryState(sessionId = this.activeSessionId ?? undefined): WebEventHistoryState {
    return {
      sessionId,
      hasMoreBefore: this.historyHasMoreBefore,
      loadedEvents: this.loadedEnvelopes.length,
      firstSequence: this.loadedEnvelopes[0]?.sequence,
      lastSequence: this.loadedEnvelopes.at(-1)?.sequence,
      loadingOlder: this.loadingOlderHistory,
    };
  }

  private emitHistoryState(sessionId = this.activeSessionId ?? undefined): void {
    this.options.onHistoryState?.(this.currentHistoryState(sessionId));
  }

  getConnectionState(): WebEventConnectionState {
    return this.connectionState;
  }

  async prompt(sessionId: string, message: string): Promise<void> {
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
    this.replaying = false;
    this.replayBuffer = [];
    this.replayLastSequence = undefined;
    this.replayLastEventAt = undefined;
    this.loadedEnvelopes = [];
    this.historyHasMoreBefore = false;
    this.loadingOlderHistory = false;
    this.emitHistoryState(undefined);
    if (sessionId) {
      this.emitConnection({ phase: 'closed', sessionId, message: 'Event stream closed' });
    }
  }
}
