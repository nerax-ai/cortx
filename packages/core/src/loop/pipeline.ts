import type { LanguageClient } from '@synax-ai/core';
import type {
  AgentDurableRunStore,
  AgentEvent,
  AgentRunRecorder,
  AgentTraceSpan,
  AgentTracer,
  AgentRuntimeExtensions,
  Logger,
  LanguageMessage,
  LanguageToolResultContent,
} from '@cortx/sdk';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION as CHECKPOINT_SCHEMA_VERSION } from '@cortx/sdk';
import type { AgentController, CortxConfig } from '../types.js';
import { emit } from './events.js';
import { userAbortError } from './errors.js';

export interface AgentLoopRuntime extends Pick<
  CortxConfig,
  | 'model'
  | 'reasoning'
  | 'maxOutputTokens'
  | 'temperature'
  | 'workingDirectory'
  | 'autoContinueLimit'
  | 'toolResultBudget'
  | 'maxConcurrentTools'
  | 'maxConcurrentAgents'
  | 'limits'
> {
  language: LanguageClient;
  extensions: AgentRuntimeExtensions;
  logger: Logger;
  tracer?: AgentTracer;
  recorder?: AgentRunRecorder;
  durableStore?: AgentDurableRunStore;
  sessionId: string;
  runId?: number;
  abortController: AbortController;
  controller?: AgentController;
  askUser?: (question: string) => Promise<string>;
  askUserForTool?: (question: string, toolCallId: string) => Promise<string>;
  turnDeadline?: AgentTurnDeadline;
  checkpointState?: AgentCheckpointStateProvider;
}

export interface AgentLoopPhaseInput {
  runtime: AgentLoopRuntime;
}

export type AgentLoopPhaseName =
  | 'control'
  | 'policy'
  | 'turn'
  | 'model'
  | 'completion'
  | 'tool.prepare'
  | 'tool.execute';

export interface AgentCheckpointStateSnapshot {
  messages?: LanguageMessage[];
  pendingToolResults?: LanguageToolResultContent[];
}

export interface AgentCheckpointStateProvider {
  snapshot(): AgentCheckpointStateSnapshot;
}

export interface AgentLoopLimits {
  maxIterations: number;
  maxRetries: number;
  maxOverflowRecoveries: number;
}

export interface AgentTurnDeadline {
  iteration: number;
  timeoutMs: number;
  expiresAt: number;
  controller: AbortController;
}

export function createTurnDeadline(
  iteration: number,
  timeoutMs: number | undefined,
  controller: AbortController,
): AgentTurnDeadline | undefined {
  if (timeoutMs === undefined) return undefined;
  return { iteration, timeoutMs, expiresAt: Date.now() + timeoutMs, controller };
}

export function createTurnTimeoutError(deadline: AgentTurnDeadline): Error & { code: 'timeout' } {
  return Object.assign(new Error(`Turn ${deadline.iteration} timed out after ${deadline.timeoutMs}ms`), {
    code: 'timeout' as const,
  });
}

export async function withTurnDeadline<T>(deadline: AgentTurnDeadline | undefined, operation: Promise<T>): Promise<T> {
  if (!deadline) return operation;
  const remainingMs = deadline.expiresAt - Date.now();
  if (remainingMs <= 0) throw createTurnTimeoutError(deadline);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          const error = createTurnTimeoutError(deadline);
          deadline.controller.abort(error);
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function withAbortSignal<T>(signal: AbortSignal | undefined, operation: Promise<T>): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : userAbortError(String(signal.reason ?? 'aborted'));

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : userAbortError(String(signal.reason ?? 'aborted')));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function startPhaseSpan(
  runtime: AgentLoopRuntime,
  phase: AgentLoopPhaseName,
  attributes?: Record<string, unknown>,
): Promise<AgentTraceSpan | undefined> {
  return runtime.tracer?.startSpan(`agent.${phase}`, { sessionId: runtime.sessionId, phase, ...attributes });
}

export async function runLoopPhase<T>(
  runtime: AgentLoopRuntime,
  phase: AgentLoopPhaseName,
  attributes: Record<string, unknown>,
  operation: () => T | Promise<T>,
  errorOf: (outcome: T) => unknown = () => undefined,
): Promise<T> {
  const span = await startPhaseSpan(runtime, phase, attributes);
  try {
    const outcome = await operation();
    await span?.end(errorOf(outcome));
    return outcome;
  } catch (error) {
    await span?.end(error);
    throw error;
  }
}

export async function* runLoopPhaseGenerator<T>(
  runtime: AgentLoopRuntime,
  phase: AgentLoopPhaseName,
  attributes: Record<string, unknown>,
  generator: AsyncGenerator<AgentEvent, T>,
  errorOf: (outcome: T) => unknown = () => undefined,
): AsyncGenerator<AgentEvent, T> {
  const span = await startPhaseSpan(runtime, phase, attributes);
  try {
    const outcome = yield* generator;
    await span?.end(errorOf(outcome));
    return outcome;
  } catch (error) {
    await span?.end(error);
    throw error;
  }
}

export async function recordPhaseEvent(
  runtime: AgentLoopRuntime,
  phase: AgentLoopPhaseName,
  iteration: number,
  event: AgentEvent,
): Promise<void> {
  await runtime.recorder?.recordEvent(event, { sessionId: runtime.sessionId, iteration, phase });
}

export async function emitPhaseEvent(
  runtime: AgentLoopRuntime,
  phase: AgentLoopPhaseName,
  iteration: number,
  event: AgentEvent,
): Promise<AgentEvent> {
  await emit(runtime.extensions, event, runtime.logger);
  await recordPhaseEvent(runtime, phase, iteration, event);
  await recordEventCheckpoint(runtime, phase, iteration, event);
  return event;
}

async function recordEventCheckpoint(
  runtime: AgentLoopRuntime,
  phase: AgentLoopPhaseName,
  iteration: number,
  event: AgentEvent,
): Promise<void> {
  const kind =
    event.type === 'turn_start'
      ? 'turn_start'
      : event.type === 'turn_end'
        ? 'turn_end'
        : event.type === 'tool_result'
          ? 'tool_result'
          : event.type === 'done' || event.type === 'error'
            ? 'terminal'
            : undefined;
  if (!kind) return;

  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: runtime.sessionId,
    runId: runtime.runId,
    iteration,
    kind,
    state: {
      phase,
      lastEvent: event,
      terminal: kind === 'terminal',
      ...runtime.checkpointState?.snapshot(),
    },
  } as const;
  await runtime.recorder?.recordCheckpoint?.(checkpoint);
  await runtime.durableStore?.saveCheckpoint(checkpoint);
}
