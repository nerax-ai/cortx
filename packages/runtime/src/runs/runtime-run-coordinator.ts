import type { AgentEvent } from '@cortx/sdk';
import { RuntimeError, toRuntimeError } from '../errors.js';
import type { RuntimeHostFactory } from '../host/runtime-host-factory.js';
import type { CortxHostScope } from '../host-scope.js';
import type { ManagedRuntimeSession } from '../session.js';
import type { RuntimeSessionRegistry } from '../sessions/session-registry.js';
import type { SessionCommandQueue } from './session-command-queue.js';

export interface RuntimeRunCoordinatorOptions {
  maxSessions: number;
  commandQueue: SessionCommandQueue;
  hostFactory: RuntimeHostFactory;
  sessionRegistry: RuntimeSessionRegistry<ManagedRuntimeSession>;
  effects: RuntimeRunCoordinatorEffects;
}

export interface RuntimeRunCoordinatorEffects {
  isSessionDeleted(sessionId: string): boolean;
  assertSessionMutable(session: ManagedRuntimeSession): void;
  broadcast(session: ManagedRuntimeSession, event: AgentEvent): Promise<void>;
  persist(session: ManagedRuntimeSession): Promise<void>;
  publish(session: ManagedRuntimeSession): void;
  resetIdleTimer(session: ManagedRuntimeSession): void;
  closeScope(scope: CortxHostScope, owner: string): Promise<void>;
}

export interface RuntimeRunAbortOptions {
  abortReason: string;
  pendingQuestionReason: string;
  internal?: boolean;
  beforeAbort?(session: ManagedRuntimeSession): boolean | Promise<boolean>;
  afterAbort?(session: ManagedRuntimeSession): void | Promise<void>;
}

interface RuntimeAbortState {
  session: ManagedRuntimeSession;
  previousRun?: Promise<void>;
  childShutdown: Promise<void>;
}

/**
 * Owns run admission, consumption, settlement, and abort coordination.
 * Session storage and durable sequencing remain delegated to their owners.
 */
export class RuntimeRunCoordinator {
  readonly #options: RuntimeRunCoordinatorOptions;

  constructor(options: RuntimeRunCoordinatorOptions) {
    this.#options = options;
  }

  async start(
    session: ManagedRuntimeSession,
    createGenerator: () => AsyncGenerator<AgentEvent>,
    onStarted?: () => void | Promise<void>,
  ): Promise<void> {
    this.#options.effects.assertSessionMutable(session);
    if (session.runPhase !== 'idle' && session.runPhase !== 'interrupted') {
      throw new RuntimeError('session_busy', 'Agent is already running', { runPhase: session.runPhase });
    }
    const runningSessions = this.#runningSessionCount();
    if (runningSessions >= this.#options.maxSessions) {
      throw new RuntimeError('capacity_exceeded', 'Maximum concurrent running sessions reached', {
        maxSessions: this.#options.maxSessions,
        runningSessions,
        loadedSessions: this.#options.sessionRegistry.size,
      });
    }

    session.lastActivityAt = Date.now();
    this.#options.effects.resetIdleTimer(session);
    const runId = ++session.runId;
    session.streamOffset = 0;
    const runScope = session.scope.child(`run:${session.id}:${runId}`, 'run');
    session.runScope = runScope;
    try {
      const host = await this.#options.hostFactory.create({
        id: session.id,
        workingDirectory: session.workingDirectory,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        system: session.system,
        maxIterations: session.maxIterations,
        contextWindowTokens: session.contextWindowTokens,
        contextWindowSource: session.contextWindowSource,
        toolMode: session.toolMode,
        toolProfile: session.toolProfile,
        approvalMode: session.approvalMode,
        requestedCapabilities: session.requestedCapabilities,
        skillPaths: session.skillPaths,
        requestTools: session.requestTools,
        contributions: session.contributions,
        scope: session.scope,
        projectScope: runScope,
        mountProjectContributions: true,
        runId,
        getRunScope: () => session.runScope,
        agentSessions: session.agentSessions,
        inputSource: session.inputSource,
        onAgentEvent: (event) => {
          void this.#options.effects.broadcast(session, event).catch(() => undefined);
        },
      });
      host.cortx.replaceMessages(session.cortx.messages);
      session.cortx = host.cortx;
      session.capabilities = host.capabilities;
      session.contextMetadata = host.contextMetadata;
      session.pluginGeneration = host.pluginGeneration;
    } catch (error) {
      if (session.runScope === runScope) session.runScope = undefined;
      await this.#options.effects.closeScope(runScope, `failed run host:${session.id}:${runId}`);
      throw error;
    }
    session.isRunning = true;
    session.runPhase = 'running';
    session.sessionHealth = 'healthy';
    session.pendingInteraction = undefined;
    session.resumable = false;
    session.inputSource.removeUndelivered();
    session.cortx.setRunId(runId);
    try {
      await onStarted?.();
      await this.#options.effects.persist(session);
      this.#options.effects.publish(session);
    } catch (error) {
      session.isRunning = false;
      session.runPhase = 'interrupted';
      if (session.runScope === runScope) session.runScope = undefined;
      await this.#options.effects.closeScope(runScope, `failed durable run admission:${session.id}:${runId}`);
      throw new RuntimeError('runtime_failure', `Failed to persist run admission for session "${session.id}"`, {
        sessionId: session.id,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!this.#options.sessionRegistry.has(session.id) || this.#options.effects.isSessionDeleted(session.id)) {
      session.isRunning = false;
      session.runPhase = 'idle';
      if (session.runScope === runScope) session.runScope = undefined;
      await this.#options.effects.closeScope(runScope, `cancelled deleted run admission:${session.id}:${runId}`);
      throw new RuntimeError('session_not_found', 'Session was deleted while the run admission was being persisted', {
        sessionId: session.id,
      });
    }

    const runPromise = this.#consume(session, runId, runScope, createGenerator);
    session.runPromise = runPromise;
    void runPromise;
  }

  async abort(sessionId: string, options: RuntimeRunAbortOptions): Promise<void> {
    const begin = async (): Promise<RuntimeAbortState | undefined> => {
      const session = this.#options.sessionRegistry.require(sessionId);
      if (options.beforeAbort && !(await options.beforeAbort(session))) return undefined;
      const previousRun = session.runPromise;
      session.runPhase = 'aborting';
      session.pendingInteraction = undefined;
      session.resumable = false;
      session.inputSource.removeUndelivered();
      session.cortx.abort(options.abortReason);
      const childShutdown = session.agentSessions.abortRunning(options.pendingQuestionReason);
      session.cortx.controller.rejectPendingQuestions(options.pendingQuestionReason);
      session.runId++;
      session.lastActivityAt = Date.now();
      this.#options.effects.publish(session);
      await this.#options.effects.persist(session).catch(() => undefined);
      return { session, previousRun, childShutdown };
    };
    const state = await (options.internal
      ? this.#options.commandQueue.runInternal(sessionId, begin)
      : this.#options.commandQueue.run(sessionId, begin));

    if (!state) return;
    if (state.previousRun) {
      try {
        await state.previousRun;
      } catch {
        /* run consumption already normalizes stream errors */
      }
    }
    await state.childShutdown;
    await this.#options.commandQueue.runInternal(sessionId, async () => {
      const session = this.#options.sessionRegistry.get(sessionId);
      if (!session) return;
      if (session.runPromise === state.previousRun) session.runPromise = undefined;
      session.isRunning = false;
      session.runPhase = 'idle';
      this.#options.effects.publish(session);
      await options.afterAbort?.(session);
      await this.#options.effects.persist(session).catch(() => undefined);
    });
  }

  #runningSessionCount(): number {
    let count = 0;
    for (const session of this.#options.sessionRegistry.values()) {
      if (session.isRunning) count++;
    }
    return count;
  }

  async #consume(
    session: ManagedRuntimeSession,
    runId: number,
    runScope: CortxHostScope,
    createGenerator: () => AsyncGenerator<AgentEvent>,
  ): Promise<void> {
    try {
      for await (const event of createGenerator()) {
        if (!this.#options.sessionRegistry.has(session.id) || session.runId !== runId) break;
        await this.#options.effects.broadcast(session, event);
      }
    } catch (error) {
      if (!this.#options.sessionRegistry.has(session.id) || session.runId !== runId) return;
      await this.#options.effects.broadcast(session, eventError(toRuntimeError(error))).catch(() => undefined);
    } finally {
      await this.#options.commandQueue.runInternal(session.id, async () => {
        await this.#options.effects.closeScope(runScope, `settled run:${session.id}:${runId}`);
        if (session.runScope === runScope) session.runScope = undefined;
        if (session.runId === runId) {
          session.isRunning = false;
          session.runPhase = 'idle';
          session.pendingInteraction = undefined;
          session.resumable = false;
          session.inputSource.interruptQueued();
          this.#options.effects.publish(session);
        }
        if (session.runPromise && session.runId === runId) session.runPromise = undefined;
        await this.#options.effects.persist(session).catch(() => undefined);
      });
    }
  }
}

function eventError(error: unknown): AgentEvent {
  return {
    type: 'error',
    error: error instanceof Error ? error : new Error(String(error)),
    code: 'stream_error',
  };
}
