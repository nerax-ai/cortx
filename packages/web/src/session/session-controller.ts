import type {
  AgentEvent,
  RuntimeAgentEventEnvelope,
  RuntimeAgentStreamFrameEnvelope,
} from '@cortx/sdk';
import { AgentStore, type AgentStoreEventInput } from '@cortx/store';
import { CortxApiClient, CortxApiError, isRuntimeEnvelope, sessionPath } from '../client/api-client';
import { FetchSseTransport, type SseSubscription } from '../client/sse-transport';
import type {
  SessionControllerSnapshot,
  WebAgentSpecLaunchRequest,
  WebCommandMetadata,
  WebCreateSessionRequest,
  WebEventHistoryResponse,
  WebRuntimeSessionInfo,
  WebSessionSummary,
  WebSkillInfo,
  WebUpdateSessionRequest,
  WebWorkspaceDirectoryListing,
} from '../client/types';

const HISTORY_PAGE_SIZE = 800;
const MAX_HISTORY_WINDOW = 2_000;
const MAX_LIVE_BUFFER = 256;
const RECONNECT_DELAY_MS = 750;

export interface SessionControllerOptions {
  apiKey?: string;
  baseUrl?: string;
  api?: CortxApiClient;
  transport?: FetchSseTransport;
  store?: AgentStore;
}

interface PendingInputCommand {
  kind: 'prompt' | 'follow-up';
  command: WebCommandMetadata;
}

export class SessionController {
  readonly api: CortxApiClient;
  readonly transport: FetchSseTransport;
  readonly store: AgentStore;
  readonly #listeners = new Set<() => void>();
  readonly #sessions = new Map<string, WebRuntimeSessionInfo>();
  readonly #pendingCommands = new Map<string, WebCommandMetadata>();
  readonly #pendingInputs = new Map<string, PendingInputCommand>();
  #snapshot: SessionControllerSnapshot;
  #sessionStream?: SseSubscription;
  #summaryStream?: SseSubscription;
  #storeUnsubscribe?: () => void;
  #lifecycleGeneration = 0;
  #activeGeneration = 0;
  #summaryGeneration = 0;
  #started = false;
  #closed = false;
  #loadedEnvelopes: RuntimeAgentEventEnvelope[] = [];
  #liveBuffer: unknown[] = [];
  #resyncPromise?: Promise<void>;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #summaryReconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(options: SessionControllerOptions = {}) {
    this.api = options.api ?? new CortxApiClient(options.apiKey, options.baseUrl);
    this.transport = options.transport ?? new FetchSseTransport(options.apiKey, options.baseUrl);
    this.store = options.store ?? new AgentStore();
    this.#snapshot = {
      phase: 'connecting',
      error: null,
      activeSessionId: null,
      session: null,
      sessions: [],
      models: [],
      toolProfiles: [],
      agentSpecs: [],
      skillPacks: [],
      connection: { phase: 'closed', updatedAt: Date.now() },
      history: { hasMoreBefore: false, loadedEvents: 0, loadingOlder: false },
      agent: this.store.getState() as SessionControllerSnapshot['agent'],
    };
    this.#attachStore();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): SessionControllerSnapshot => this.#snapshot;

  async start(): Promise<void> {
    if (this.#started && !this.#closed) return;
    const lifecycleGeneration = ++this.#lifecycleGeneration;
    this.#started = true;
    if (this.#closed) this.#attachStore();
    this.#closed = false;
    this.#patch({ phase: 'connecting', error: null });
    try {
      const [sessions, models, toolProfiles, agentSpecs, skillPacks] = await Promise.all([
        this.api.listSessions(),
        this.api.listModels().catch(() => []),
        this.api.listToolProfiles().catch(() => []),
        this.api.listAgentSpecs().catch(() => []),
        this.api.listSkillPacks().catch(() => []),
      ]);
      if (this.#closed || lifecycleGeneration !== this.#lifecycleGeneration) return;
      this.#sessions.clear();
      sessions.forEach((session) => this.#sessions.set(session.id, normalizeSession(session)));
      let target = latestSession([...this.#sessions.values()]);
      if (!target) {
        const canonicalProfile = toolProfiles.find((profile) => profile.id !== 'none')?.use ?? toolProfiles[0]?.use;
        target = normalizeSession(await this.api.createSession({
          ...(canonicalProfile ? { toolMode: canonicalProfile } : {}),
          approvalMode: 'interactive',
        }));
        if (this.#closed || lifecycleGeneration !== this.#lifecycleGeneration) return;
        this.#sessions.set(target.id, target);
      }
      this.#patch({
        models,
        toolProfiles,
        agentSpecs,
        skillPacks,
        sessions: this.#sortedSessions(),
      });
      await this.#startSummaryFeed();
      if (this.#closed || lifecycleGeneration !== this.#lifecycleGeneration) return;
      await this.activate(target.id);
      if (this.#closed || lifecycleGeneration !== this.#lifecycleGeneration) return;
      this.#patch({ phase: 'ready', error: null });
    } catch (error) {
      if (!this.#closed && lifecycleGeneration === this.#lifecycleGeneration) {
        this.#patch({ phase: 'failed', error: errorMessage(error) });
      }
      throw error;
    }
  }

  async activate(sessionId: string): Promise<void> {
    const generation = ++this.#activeGeneration;
    this.#stopSessionStream();
    this.#loadedEnvelopes = [];
    this.#liveBuffer = [];
    this.store.reset(sessionId);
    this.#patch({
      activeSessionId: sessionId,
      session: this.#sessions.get(sessionId) ?? null,
      error: null,
      connection: {
        phase: 'connecting',
        sessionId,
        message: 'Loading Runtime session',
        updatedAt: Date.now(),
      },
      history: { sessionId, hasMoreBefore: false, loadedEvents: 0, loadingOlder: false },
    });

    const [session, history] = await Promise.all([
      this.api.getSession(sessionId),
      this.api.getEventHistory(sessionId, { limit: HISTORY_PAGE_SIZE }),
    ]);
    if (!this.#isCurrent(generation, sessionId)) return;
    const normalizedSession = normalizeSession(session);
    this.#sessions.set(sessionId, normalizedSession);
    this.#loadedEnvelopes = normalizeEnvelopes(history.events, sessionId).slice(-MAX_HISTORY_WINDOW);
    this.#replayHistory(normalizedSession);
    this.#patch({
      session: normalizedSession,
      sessions: this.#sortedSessions(),
      runtimeIncarnation: normalizedSession.runtimeIncarnation,
      connection: {
        phase: 'replaying',
        sessionId,
        lastSequence: this.#lastSequence(),
        lastEventAt: this.#loadedEnvelopes.at(-1)?.timestamp,
        message: history.resetRequired ? 'History boundary changed; replayed retained facts' : 'Replaying durable history',
        updatedAt: Date.now(),
      },
      history: historyState(sessionId, this.#loadedEnvelopes, history, false),
    });
    this.#openSessionStream(generation, sessionId);
  }

  async recover(): Promise<void> {
    const sessionId = this.#snapshot.activeSessionId;
    if (!sessionId) return this.start();
    await this.activate(sessionId);
  }

  async send(message: string): Promise<void> {
    const session = this.#requireActiveSession();
    const key = mutationKey(session.id, 'input', message);
    let pending = this.#pendingInputs.get(key);
    if (!pending || pending.command.expectedRuntimeIncarnation !== session.runtimeIncarnation) {
      const kind = session.runPhase === 'running' || session.runPhase === 'waiting_user' || session.runPhase === 'waiting_approval'
        ? 'follow-up'
        : session.runPhase === 'idle' && session.acceptsPrompt
          ? 'prompt'
          : undefined;
      if (!kind) {
        throw new Error(`Session cannot accept input while ${session.runPhase}/${session.sessionHealth}`);
      }
      const command = this.#newCommand(session);
      pending = { kind, command };
      this.#pendingInputs.set(key, pending);
    }
    let next: WebRuntimeSessionInfo;
    if (pending.kind === 'follow-up') {
      next = await this.api.followUp(session.id, message, pending.command.commandId, pending.command);
    } else {
      next = await this.api.prompt(session.id, message, pending.command);
    }
    this.#pendingInputs.delete(key);
    this.#acceptProjection(next);
  }

  async steer(message: string): Promise<void> {
    const session = this.#requireActiveSession();
    this.#acceptProjection(await this.#withStableCommand(session, mutationKey(session.id, 'steer', message), (command) =>
      this.api.steer(session.id, message, command)));
  }

  async cancelFollowUp(inputId: string): Promise<void> {
    const session = this.#requireActiveSession();
    this.#acceptProjection(await this.#withStableCommand(session, mutationKey(session.id, 'cancel-follow-up', inputId), (command) =>
      this.api.cancelFollowUp(session.id, inputId, command)));
  }

  async answer(toolCallId: string, response: string): Promise<void> {
    const session = this.#requireActiveSession();
    this.#acceptProjection(await this.#withStableCommand(
      session,
      mutationKey(session.id, 'answer', toolCallId, response),
      (command) => this.api.answer(session.id, toolCallId, response, command),
    ));
  }

  async abort(): Promise<void> {
    const session = this.#requireActiveSession();
    this.#acceptProjection(await this.#withStableCommand(session, mutationKey(session.id, 'abort'), (command) =>
      this.api.abort(session.id, command)));
  }

  async resume(): Promise<void> {
    const session = this.#requireActiveSession();
    this.#acceptProjection(await this.#withStableCommand(session, mutationKey(session.id, 'resume'), (command) =>
      this.api.resume(session.id, command)));
  }

  async updateActiveSession(request: WebUpdateSessionRequest): Promise<WebRuntimeSessionInfo> {
    const session = this.#requireActiveSession();
    const next = await this.#withStableCommand(
      session,
      mutationKey(session.id, 'update', JSON.stringify(request)),
      (command) => this.api.updateSession(session.id, request, command),
    );
    this.#acceptProjection(next);
    return normalizeSession(next);
  }

  async createSession(request: WebCreateSessionRequest): Promise<WebRuntimeSessionInfo> {
    const session = normalizeSession(await this.api.createSession(request));
    this.#sessions.set(session.id, session);
    this.#patch({ sessions: this.#sortedSessions() });
    await this.activate(session.id);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const deleted = this.#sessions.get(sessionId);
    await this.api.deleteSession(sessionId);
    this.#clearPendingCommands(sessionId);
    this.#sessions.delete(sessionId);
    if (this.#snapshot.activeSessionId !== sessionId) {
      this.#patch({ sessions: this.#sortedSessions() });
      return;
    }
    let target = latestSession(
      [...this.#sessions.values()].filter((session) => session.workingDirectory === deleted?.workingDirectory),
    ) ?? latestSession([...this.#sessions.values()]);
    if (!target) {
      target = normalizeSession(await this.api.createSession({
        workingDirectory: deleted?.workingDirectory,
        model: deleted?.model,
        reasoningEffort: deleted?.reasoningEffort,
        toolMode: deleted?.toolProfile ?? deleted?.toolMode,
        approvalMode: deleted?.approvalMode,
        skillPacks: deleted?.skillPacks,
      }));
      this.#sessions.set(target.id, target);
    }
    await this.activate(target.id);
  }

  async launchAgentSpec(request: WebAgentSpecLaunchRequest): Promise<WebRuntimeSessionInfo> {
    const session = normalizeSession(await this.api.launchAgentSpec(request));
    this.#sessions.set(session.id, session);
    await this.activate(session.id);
    return session;
  }

  listSessionSkills(sessionId: string): Promise<WebSkillInfo[]> {
    return this.api.listSessionSkills(sessionId);
  }

  listWorkspaceDirectories(path?: string): Promise<WebWorkspaceDirectoryListing> {
    return this.api.listWorkspaceDirectories(path);
  }

  async refreshAssets(): Promise<void> {
    const [agentSpecs, skillPacks] = await Promise.all([
      this.api.listAgentSpecs(),
      this.api.listSkillPacks(),
    ]);
    this.#patch({ agentSpecs, skillPacks });
  }

  async loadOlderHistory(): Promise<void> {
    const sessionId = this.#snapshot.activeSessionId;
    const generation = this.#activeGeneration;
    const before = this.#loadedEnvelopes[0]?.sequence;
    if (!sessionId || before === undefined || this.#snapshot.history.loadingOlder) return;
    this.#patch({ history: { ...this.#snapshot.history, loadingOlder: true } });
    try {
      const response = await this.api.getEventHistory(sessionId, { before, limit: HISTORY_PAGE_SIZE });
      if (!this.#isCurrent(generation, sessionId)) return;
      const older = normalizeEnvelopes(response.events, sessionId);
      this.#loadedEnvelopes = mergeEnvelopes(older, this.#loadedEnvelopes).slice(-MAX_HISTORY_WINDOW);
      this.#replayHistory(this.#requireActiveSession());
      this.#patch({ history: historyState(sessionId, this.#loadedEnvelopes, response, false) });
    } finally {
      if (this.#isCurrent(generation, sessionId)) {
        this.#patch({ history: { ...this.#snapshot.history, loadingOlder: false } });
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    this.#lifecycleGeneration++;
    this.#activeGeneration++;
    this.#summaryGeneration++;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#summaryReconnectTimer);
    this.#stopSessionStream();
    this.#summaryStream?.close();
    this.#summaryStream = undefined;
    this.#storeUnsubscribe?.();
    this.#storeUnsubscribe = undefined;
    this.store.dispose();
    this.#patch({
      phase: 'closed',
      connection: { phase: 'closed', updatedAt: Date.now(), message: 'Runtime connection closed' },
    });
  }

  async #startSummaryFeed(): Promise<void> {
    const generation = ++this.#summaryGeneration;
    clearTimeout(this.#summaryReconnectTimer);
    this.#summaryStream?.close();
    const baseline = await this.api.getSessionBaseline();
    if (!this.#isSummaryCurrent(generation)) return;
    const missing = await Promise.all(baseline.sessions
      .filter((summary) => !this.#sessions.has(summary.id))
      .map(async (summary) => {
        try {
          return normalizeSession(await this.api.getSession(summary.id));
        } catch (error) {
          if (error instanceof CortxApiError && error.status === 404) return undefined;
          throw error;
        }
      }));
    if (!this.#isSummaryCurrent(generation)) return;
    const visibleIds = new Set(baseline.sessions.map((summary) => summary.id));
    for (const id of [...this.#sessions.keys()]) {
      if (!visibleIds.has(id)) this.#sessions.delete(id);
    }
    for (const session of missing) if (session) this.#sessions.set(session.id, session);
    for (const summary of baseline.sessions) this.#mergeSummary(summary);
    this.#patch({ runtimeIncarnation: baseline.runtimeIncarnation, sessions: this.#sortedSessions() });
    this.#summaryStream = this.transport.connect(
      `/sessions/feed?after=${encodeURIComponent(baseline.cursor)}`,
      {
        onFrame: (value) => {
          if (this.#isSummaryCurrent(generation)) this.#handleSummaryFrame(value);
        },
        onDisconnect: () => {
          if (!this.#isSummaryCurrent(generation)) return;
          clearTimeout(this.#summaryReconnectTimer);
          this.#summaryReconnectTimer = setTimeout(() => {
            if (!this.#closed) {
              void this.#startSummaryFeed().catch((error) => this.#patch({ error: errorMessage(error) }));
            }
          }, RECONNECT_DELAY_MS);
        },
      },
    );
  }

  #handleSummaryFrame(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === 'reset-required') {
      this.#summaryStream?.close();
      void this.#startSummaryFeed().catch((error) => this.#patch({ error: errorMessage(error) }));
      return;
    }
    if (value.type !== 'session-change') return;
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined;
    if (!sessionId) return;
    if (value.changeType === 'removed') {
      this.#sessions.delete(sessionId);
      this.#patch({ sessions: this.#sortedSessions() });
      return;
    }
    const payloadType = typeof value.type === 'string' ? value.type : undefined;
    const nestedType = typeof value.changeType === 'string' ? value.changeType : undefined;
    const actualType = nestedType ?? (payloadType === 'session-change' && typeof value.summary === 'object' ? 'updated' : undefined);
    const summary = isRecord(value.summary) ? value.summary as unknown as WebSessionSummary : undefined;
    if (summary) this.#mergeSummary(summary);
    if (!this.#sessions.has(sessionId) || actualType === 'added') {
      void this.api.getSession(sessionId).then((session) => this.#acceptProjection(session)).catch(() => undefined);
    } else {
      this.#patch({ sessions: this.#sortedSessions() });
      if (this.#snapshot.activeSessionId === sessionId) {
        void this.api.getSession(sessionId).then((session) => this.#acceptProjection(session)).catch(() => undefined);
      }
    }
  }

  #isSummaryCurrent(generation: number): boolean {
    return !this.#closed && generation === this.#summaryGeneration;
  }

  #openSessionStream(generation: number, sessionId: string): void {
    this.#stopSessionStream();
    const lastSequence = this.#lastSequence();
    const params = new URLSearchParams({ format: 'envelope', protocol: 'frames', replay: 'false' });
    if (lastSequence !== undefined) params.set('after', String(lastSequence));
    this.#sessionStream = this.transport.connect(`${sessionPath(sessionId)}/events?${params.toString()}`, {
      onOpen: () => {
        if (!this.#isCurrent(generation, sessionId)) return;
        this.#patch({
          connection: {
            ...this.#snapshot.connection,
            phase: 'replaying',
            sessionId,
            message: 'Synchronizing live tail',
            updatedAt: Date.now(),
          },
        });
      },
      onFrame: (value) => this.#handleSessionFrame(generation, sessionId, value),
      onDisconnect: (error) => this.#scheduleReconnect(generation, sessionId, error),
    });
  }

  #handleSessionFrame(generation: number, sessionId: string, value: unknown): void {
    if (!this.#isCurrent(generation, sessionId) || !isRecord(value)) return;
    if (value.type === 'heartbeat') return;
    if (value.type === 'reset-required') {
      void this.#resync(generation, sessionId, true);
      return;
    }
    if (value.type === 'replay-complete') {
      this.#patch({
        connection: {
          phase: 'live',
          sessionId,
          lastSequence: this.#lastSequence(),
          lastEventAt: this.#loadedEnvelopes.at(-1)?.timestamp,
          message: 'Live Runtime stream',
          updatedAt: Date.now(),
        },
      });
      for (const buffered of this.#liveBuffer.splice(0)) this.#applyStreamPayload(generation, sessionId, buffered);
      void this.api.getSession(sessionId).then((session) => this.#acceptProjection(session)).catch(() => undefined);
      return;
    }
    if (this.#snapshot.connection.phase === 'resyncing') {
      if (this.#liveBuffer.length >= MAX_LIVE_BUFFER) {
        this.#liveBuffer = [];
        void this.#resync(generation, sessionId, true);
      } else {
        this.#liveBuffer.push(value);
      }
      return;
    }
    this.#applyStreamPayload(generation, sessionId, value);
  }

  #applyStreamPayload(generation: number, sessionId: string, value: unknown): void {
    if (!this.#isCurrent(generation, sessionId) || !isRecord(value)) return;
    if (value.type === 'durable-event' && isRuntimeEnvelope(value.envelope)) {
      const envelope = normalizeEnvelope(value.envelope);
      const last = this.#lastSequence() ?? 0;
      if (envelope.sequence <= last) return;
      if (envelope.sequence !== last + 1) {
        this.#liveBuffer.push(value);
        void this.#resync(generation, sessionId, false);
        return;
      }
      this.#loadedEnvelopes = [...this.#loadedEnvelopes, envelope].slice(-MAX_HISTORY_WINDOW);
      this.store.dispatch(envelope.event, envelope.timestamp);
      this.#patch({
        connection: {
          ...this.#snapshot.connection,
          lastSequence: envelope.sequence,
          lastEventAt: envelope.timestamp,
          updatedAt: Date.now(),
        },
        history: {
          ...this.#snapshot.history,
          loadedEvents: this.#loadedEnvelopes.length,
          firstSequence: this.#loadedEnvelopes[0]?.sequence,
          lastSequence: envelope.sequence,
        },
      });
      return;
    }
    if (value.type === 'stream-frame' && isRuntimeFrame(value.frame)) {
      const frame = value.frame;
      if (frame.sessionId !== sessionId) return;
      this.store.dispatch(normalizeEvent(frame.event), frame.timestamp);
    }
  }

  #resync(generation: number, sessionId: string, full: boolean): Promise<void> {
    if (this.#resyncPromise) return this.#resyncPromise;
    this.#patch({
      connection: {
        ...this.#snapshot.connection,
        phase: 'resyncing',
        message: full ? 'Runtime requested a full history reset' : 'Sequence gap detected; filling durable tail',
        updatedAt: Date.now(),
      },
    });
    const operation = (async () => {
      const after = full ? undefined : this.#lastSequence();
      let response = await this.api.getEventHistory(sessionId, {
        ...(after !== undefined ? { after } : {}),
        limit: MAX_HISTORY_WINDOW,
      });
      if (!this.#isCurrent(generation, sessionId)) return;
      if (full || response.resetRequired) {
        this.#loadedEnvelopes = normalizeEnvelopes(response.events, sessionId).slice(-MAX_HISTORY_WINDOW);
        this.#replayHistory(this.#requireActiveSession());
      } else {
        for (const envelope of normalizeEnvelopes(response.events, sessionId)) {
          const last = this.#lastSequence() ?? 0;
          if (envelope.sequence <= last) continue;
          if (envelope.sequence !== last + 1) {
            response = await this.api.getEventHistory(sessionId, { limit: MAX_HISTORY_WINDOW });
            if (!this.#isCurrent(generation, sessionId)) return;
            this.#loadedEnvelopes = normalizeEnvelopes(response.events, sessionId).slice(-MAX_HISTORY_WINDOW);
            this.#replayHistory(this.#requireActiveSession());
            break;
          }
          this.#loadedEnvelopes = [...this.#loadedEnvelopes, envelope].slice(-MAX_HISTORY_WINDOW);
          this.store.dispatch(envelope.event, envelope.timestamp);
        }
      }
      this.#patch({ history: historyState(sessionId, this.#loadedEnvelopes, response, false) });
      const buffered = this.#liveBuffer.splice(0);
      for (const item of buffered) this.#applyStreamPayload(generation, sessionId, item);
      if (this.#liveBuffer.length) {
        response = await this.api.getEventHistory(sessionId, { limit: MAX_HISTORY_WINDOW });
        if (!this.#isCurrent(generation, sessionId)) return;
        this.#loadedEnvelopes = normalizeEnvelopes(response.events, sessionId).slice(-MAX_HISTORY_WINDOW);
        this.#replayHistory(this.#requireActiveSession());
        const afterFullReplay = this.#liveBuffer.splice(0);
        for (const item of afterFullReplay) this.#applyStreamPayload(generation, sessionId, item);
      }
      if (this.#liveBuffer.length) {
        this.#liveBuffer = [];
        this.#patch({
          history: { ...historyState(sessionId, this.#loadedEnvelopes, response, false), truncated: true },
        });
        this.#openSessionStream(generation, sessionId);
        return;
      }
      this.#patch({
        connection: {
          phase: 'live',
          sessionId,
          lastSequence: this.#lastSequence(),
          lastEventAt: this.#loadedEnvelopes.at(-1)?.timestamp,
          message: 'Live Runtime stream',
          updatedAt: Date.now(),
        },
      });
    })().catch((error) => {
      if (this.#isCurrent(generation, sessionId)) {
        this.#patch({ error: errorMessage(error), connection: {
          ...this.#snapshot.connection,
          phase: 'disconnected',
          message: errorMessage(error),
          updatedAt: Date.now(),
        } });
      }
    }).finally(() => {
      if (this.#resyncPromise === operation) this.#resyncPromise = undefined;
    });
    this.#resyncPromise = operation;
    return operation;
  }

  #scheduleReconnect(generation: number, sessionId: string, error?: unknown): void {
    if (!this.#isCurrent(generation, sessionId) || this.#closed) return;
    this.#patch({
      connection: {
        ...this.#snapshot.connection,
        phase: 'reconnecting',
        message: error ? errorMessage(error) : 'Runtime stream disconnected',
        updatedAt: Date.now(),
      },
    });
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      if (this.#isCurrent(generation, sessionId)) this.#openSessionStream(generation, sessionId);
    }, RECONNECT_DELAY_MS);
  }

  #replayHistory(session: WebRuntimeSessionInfo): void {
    this.store.reset(session.id);
    const history: AgentStoreEventInput[] = this.#loadedEnvelopes.map((envelope) => ({
      event: normalizeEvent(envelope.event),
      timestamp: envelope.timestamp,
    }));
    this.store.dispatchMany(history);
    this.store.syncRuntimeSession({
      sessionId: session.id,
      isRunning: session.isRunning,
      tokenUsage: session.usage,
      contextUsage: session.usage?.context,
    });
  }

  #mergeSummary(summary: WebSessionSummary): void {
    const current = this.#sessions.get(summary.id);
    if (!current) return;
    this.#sessions.set(summary.id, normalizeSession({ ...current, ...summary }));
  }

  #acceptProjection(value: WebRuntimeSessionInfo): void {
    const session = normalizeSession(value);
    const previous = this.#sessions.get(session.id);
    if (previous && previous.runtimeIncarnation !== session.runtimeIncarnation) {
      this.#clearPendingCommands(session.id);
    }
    this.#sessions.set(session.id, session);
    if (this.#snapshot.activeSessionId === session.id) {
      this.store.syncRuntimeSession({
        sessionId: session.id,
        isRunning: session.isRunning,
        tokenUsage: session.usage,
        contextUsage: session.usage?.context,
      });
      this.#patch({ session, runtimeIncarnation: session.runtimeIncarnation, sessions: this.#sortedSessions() });
    } else {
      this.#patch({ sessions: this.#sortedSessions() });
    }
  }

  async #withStableCommand<T>(
    session: WebRuntimeSessionInfo,
    key: string,
    operation: (command: WebCommandMetadata) => Promise<T>,
  ): Promise<T> {
    let command = this.#pendingCommands.get(key);
    if (!command || command.expectedRuntimeIncarnation !== session.runtimeIncarnation) {
      command = this.#newCommand(session);
      this.#pendingCommands.set(key, command);
    }
    const result = await operation(command);
    this.#pendingCommands.delete(key);
    return result;
  }

  #newCommand(session: WebRuntimeSessionInfo): WebCommandMetadata {
    return {
      commandId: crypto.randomUUID(),
      expectedRuntimeIncarnation: session.runtimeIncarnation,
    };
  }

  #clearPendingCommands(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#pendingCommands.keys()) {
      if (key.startsWith(prefix)) this.#pendingCommands.delete(key);
    }
    for (const key of this.#pendingInputs.keys()) {
      if (key.startsWith(prefix)) this.#pendingInputs.delete(key);
    }
  }

  #requireActiveSession(): WebRuntimeSessionInfo {
    const session = this.#snapshot.session;
    if (!session) throw new Error('No active Runtime session');
    return session;
  }

  #lastSequence(): number | undefined {
    return this.#loadedEnvelopes.at(-1)?.sequence;
  }

  #isCurrent(generation: number, sessionId: string): boolean {
    return !this.#closed && generation === this.#activeGeneration && this.#snapshot.activeSessionId === sessionId;
  }

  #stopSessionStream(): void {
    clearTimeout(this.#reconnectTimer);
    this.#sessionStream?.close();
    this.#sessionStream = undefined;
  }

  #sortedSessions(): WebRuntimeSessionInfo[] {
    return [...this.#sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  #attachStore(): void {
    this.#storeUnsubscribe?.();
    this.#storeUnsubscribe = this.store.onChange(() => this.#patch({}));
  }

  #patch(patch: Partial<SessionControllerSnapshot>): void {
    this.#snapshot = {
      ...this.#snapshot,
      ...patch,
      agent: this.store.getState() as SessionControllerSnapshot['agent'],
    };
    for (const listener of [...this.#listeners]) listener();
  }
}

function normalizeSession(session: WebRuntimeSessionInfo): WebRuntimeSessionInfo {
  const isRunning = Boolean(session.isRunning);
  const runPhase = session.runPhase ?? (isRunning ? 'running' : 'idle');
  return {
    ...session,
    toolProfile: session.toolProfile ?? session.toolMode,
    runtimeIncarnation: session.runtimeIncarnation ?? '',
    projectionAsOfSequence: session.projectionAsOfSequence ?? 0,
    eventRetention: session.eventRetention ?? { oldestAvailableSequence: null, lastAvailableSequence: session.eventCount ?? 0 },
    runPhase,
    sessionHealth: session.sessionHealth ?? 'healthy',
    resumable: session.resumable ?? false,
    acceptsPrompt: session.acceptsPrompt ?? runPhase === 'idle',
    pendingInteraction: session.pendingInteraction ?? null,
    queuedInputs: session.queuedInputs ?? [],
    isRunning,
  };
}

function normalizeEnvelopes(items: RuntimeAgentEventEnvelope[], sessionId: string): RuntimeAgentEventEnvelope[] {
  return mergeEnvelopes(items.filter((item) => isRuntimeEnvelope(item) && item.sessionId === sessionId).map(normalizeEnvelope));
}

function normalizeEnvelope(envelope: RuntimeAgentEventEnvelope): RuntimeAgentEventEnvelope {
  return { ...envelope, event: normalizeEvent(envelope.event) };
}

function normalizeEvent(event: AgentEvent): AgentEvent {
  if (event.type !== 'error' || event.error instanceof Error) return event;
  const raw = event.error as unknown;
  const message = isRecord(raw) && 'message' in raw ? String(raw.message) : String(raw);
  return { ...event, error: new Error(message) };
}

function mergeEnvelopes(...groups: RuntimeAgentEventEnvelope[][]): RuntimeAgentEventEnvelope[] {
  const bySequence = new Map<number, RuntimeAgentEventEnvelope>();
  for (const group of groups) for (const envelope of group) bySequence.set(envelope.sequence, envelope);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

function isRuntimeFrame(value: unknown): value is RuntimeAgentStreamFrameEnvelope {
  if (!isRecord(value)) return false;
  return value.kind === 'frame' &&
    typeof value.offset === 'number' &&
    typeof value.timestamp === 'number' &&
    typeof value.sessionId === 'string' &&
    typeof value.runId === 'number' &&
    isRecord(value.event);
}

function historyState(
  sessionId: string,
  envelopes: RuntimeAgentEventEnvelope[],
  response?: WebEventHistoryResponse,
  loadingOlder = false,
): SessionControllerSnapshot['history'] {
  return {
    sessionId,
    hasMoreBefore: Boolean(response?.page?.hasMoreBefore),
    loadedEvents: envelopes.length,
    firstSequence: envelopes[0]?.sequence,
    lastSequence: envelopes.at(-1)?.sequence,
    loadingOlder,
    truncated: response?.resetRequired === true,
  };
}

function latestSession(sessions: WebRuntimeSessionInfo[]): WebRuntimeSessionInfo | undefined {
  return [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
}

function mutationKey(sessionId: string, ...parts: string[]): string {
  return [sessionId, ...parts].join('\u0000');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
