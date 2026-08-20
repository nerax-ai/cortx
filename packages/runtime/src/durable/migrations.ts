import type { AgentRunCheckpoint, CortxContributionConfig, Tool } from '@cortx/sdk';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION } from '@cortx/sdk';
import { DEFAULT_RUNTIME_CAPABILITIES } from '../default-capabilities.js';
import {
  RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeSessionSnapshot,
  type RuntimeSubAgentSessionSnapshot,
} from './types.js';

export function parseAgentRunCheckpoint(value: unknown): AgentRunCheckpoint | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.schemaVersion !== AGENT_RUN_CHECKPOINT_SCHEMA_VERSION ||
    typeof value.sessionId !== 'string' ||
    typeof value.iteration !== 'number' ||
    !isObject(value.state)
  ) {
    return undefined;
  }
  return value as unknown as AgentRunCheckpoint;
}

export function parseRuntimeSessionSnapshot(value: unknown): RuntimeSessionSnapshot | undefined {
  if (!isObject(value)) return undefined;
  if (value.schemaVersion === RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION) {
    return isCurrentRuntimeSessionSnapshot(value)
      ? ({
          ...value,
          creatorPrincipalId: typeof value.creatorPrincipalId === 'string' ? value.creatorPrincipalId : undefined,
          reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : undefined,
          promptHistory: stringArray(value.promptHistory),
          requestTools: toolArray(value.requestTools),
          toolProfile: typeof value.toolProfile === 'string' ? value.toolProfile : undefined,
          contributions: contributionArray(value.contributions),
          pendingInteraction: parsePendingInteraction(value.pendingInteraction),
          queuedInputs: parseQueuedInputs(value.queuedInputs),
          eventRetention: parseEventRetention(value.eventRetention, value.nextEventSequence as number),
        } as unknown as RuntimeSessionSnapshot)
      : undefined;
  }
  if (value.schemaVersion === 1) return migrateRuntimeSessionSnapshotV1(value);
  if (value.schemaVersion === 0) return migrateRuntimeSessionSnapshotV0(value);
  return undefined;
}

export function parseRuntimeSubAgentSessionSnapshot(value: unknown): RuntimeSubAgentSessionSnapshot | undefined {
  if (!isObject(value)) return undefined;
  if (value.schemaVersion === RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION) {
    return isCurrentRuntimeSubAgentSessionSnapshot(value) ? (value as unknown as RuntimeSubAgentSessionSnapshot) : undefined;
  }
  if (value.schemaVersion === 0) return migrateRuntimeSubAgentSessionSnapshotV0(value);
  return undefined;
}

export function parseRuntimeEventEnvelopeSnapshot(value: unknown): RuntimeEventEnvelopeSnapshot | undefined {
  if (!isObject(value)) return undefined;
  if (value.schemaVersion === RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION) {
    return isCurrentRuntimeEventEnvelopeSnapshot(value) ? normalizeRuntimeEventEnvelope(value) : undefined;
  }
  if (value.schemaVersion === 0) return migrateRuntimeEventEnvelopeSnapshotV0(value);
  return undefined;
}

export function serializeRuntimeEventEnvelopeSnapshot(snapshot: RuntimeEventEnvelopeSnapshot): unknown {
  if (snapshot.event.type !== 'error') return snapshot;
  return {
    ...snapshot,
    event: {
      ...snapshot.event,
      error: {
        name: snapshot.event.error.name,
        message: snapshot.event.error.message,
      },
    },
  };
}

function migrateRuntimeSessionSnapshotV0(value: Record<string, unknown>): RuntimeSessionSnapshot | undefined {
  return migrateLegacyRuntimeSessionSnapshot(value);
}

function migrateRuntimeSessionSnapshotV1(value: Record<string, unknown>): RuntimeSessionSnapshot | undefined {
  return migrateLegacyRuntimeSessionSnapshot(value);
}

function migrateLegacyRuntimeSessionSnapshot(value: Record<string, unknown>): RuntimeSessionSnapshot | undefined {
  if (
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'number' ||
    typeof value.lastActivityAt !== 'number' ||
    typeof value.workingDirectory !== 'string' ||
    typeof value.model !== 'string'
  ) {
    return undefined;
  }

  return {
    schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
    id: value.id,
    creatorPrincipalId: typeof value.creatorPrincipalId === 'string' ? value.creatorPrincipalId : undefined,
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    workingDirectory: value.workingDirectory,
    model: value.model,
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : undefined,
    system: typeof value.system === 'string' ? value.system : undefined,
    maxIterations: typeof value.maxIterations === 'number' ? value.maxIterations : undefined,
    contextWindowTokens: typeof value.contextWindowTokens === 'number' ? value.contextWindowTokens : undefined,
    contextWindowSource: parseContextWindowSource(value.contextWindowSource),
    toolMode: parseToolMode(value.toolMode),
    toolProfile: typeof value.toolProfile === 'string' ? value.toolProfile : undefined,
    approvalMode: parseApprovalMode(value.approvalMode),
    capabilities: isObject(value.capabilities) ? { ...DEFAULT_RUNTIME_CAPABILITIES, ...value.capabilities } : { skills: false, subAgents: false, approval: false },
    skillPaths: stringArray(value.skillPaths),
    skillPacks: stringArray(value.skillPacks),
    promptHistory: stringArray(value.promptHistory),
    requestTools: toolArray(value.requestTools),
    contributions: contributionArray(value.contributions),
    runId: typeof value.runId === 'number' ? value.runId : 0,
    nextEventSequence: typeof value.nextEventSequence === 'number' ? value.nextEventSequence : 0,
    runtimeIncarnation: typeof value.runtimeIncarnation === 'string' ? value.runtimeIncarnation : 'legacy',
    runPhase: parseRunPhase(value.runPhase),
    sessionHealth: parseSessionHealth(value.sessionHealth),
    resumable: value.resumable === true,
    pendingInteraction: parsePendingInteraction(value.pendingInteraction),
    queuedInputs: parseQueuedInputs(value.queuedInputs) ?? [],
    eventRetention: parseEventRetention(
      value.eventRetention,
      typeof value.nextEventSequence === 'number' ? value.nextEventSequence : 0,
    ),
    metadata: isObject(value.metadata) ? value.metadata : undefined,
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function toolArray(value: unknown): Tool[] | undefined {
  return Array.isArray(value) &&
    value.every((item) => isObject(item) && typeof item.name === 'string' && typeof item.execute === 'function')
    ? (value as Tool[])
    : undefined;
}

function contributionArray(value: unknown): CortxContributionConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: CortxContributionConfig[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.use !== 'string') return undefined;
    if (item.options !== undefined && !isObject(item.options)) return undefined;
    result.push({
      use: item.use,
      ...(item.options === undefined
        ? {}
        : { options: { ...item.options } as CortxContributionConfig['options'] }),
    });
  }
  return result;
}

function migrateRuntimeSubAgentSessionSnapshotV0(value: Record<string, unknown>): RuntimeSubAgentSessionSnapshot | undefined {
  if (
    typeof value.parentSessionId !== 'string' ||
    typeof value.toolCallId !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.isBackground !== 'boolean' ||
    !isSubAgentStatus(value.status) ||
    typeof value.output !== 'string' ||
    typeof value.iterations !== 'number' ||
    typeof value.toolCallCount !== 'number' ||
    typeof value.startedAt !== 'number'
  ) {
    return undefined;
  }

  return {
    schemaVersion: RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
    runId: typeof value.runId === 'string' ? value.runId : `${value.parentSessionId}:${value.toolCallId}`,
    parentSessionId: value.parentSessionId,
    parentRunId: typeof value.parentRunId === 'number' ? value.parentRunId : undefined,
    toolCallId: value.toolCallId,
    description: value.description,
    isBackground: value.isBackground,
    status: value.status,
    output: value.output,
    iterations: value.iterations,
    toolCallCount: value.toolCallCount,
    startedAt: value.startedAt,
    completedAt: typeof value.completedAt === 'number' ? value.completedAt : undefined,
  };
}

function migrateRuntimeEventEnvelopeSnapshotV0(value: Record<string, unknown>): RuntimeEventEnvelopeSnapshot | undefined {
  if (!isBaseEventEnvelope(value)) return undefined;
  return normalizeRuntimeEventEnvelope({
    ...value,
    schemaVersion: RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION,
  });
}

function isCurrentRuntimeSessionSnapshot(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.lastActivityAt === 'number' &&
    typeof value.workingDirectory === 'string' &&
    typeof value.model === 'string' &&
    typeof value.toolMode === 'string' &&
    typeof value.approvalMode === 'string' &&
    isObject(value.capabilities) &&
    typeof value.runId === 'number' &&
    typeof value.nextEventSequence === 'number' &&
    typeof value.runtimeIncarnation === 'string' &&
    isRunPhase(value.runPhase) &&
    isSessionHealth(value.sessionHealth) &&
    typeof value.resumable === 'boolean' &&
    (value.pendingInteraction === undefined || parsePendingInteraction(value.pendingInteraction) !== undefined) &&
    parseQueuedInputs(value.queuedInputs) !== undefined &&
    isEventRetention(value.eventRetention)
  );
}

function parseQueuedInputs(value: unknown): RuntimeSessionSnapshot['queuedInputs'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const inputs: RuntimeSessionSnapshot['queuedInputs'] = [];
  for (const input of value) {
    if (
      !isObject(input) ||
      typeof input.inputId !== 'string' ||
      typeof input.message !== 'string' ||
      typeof input.acceptedAt !== 'number' ||
      typeof input.admissionSequence !== 'number' ||
      (input.state !== 'queued' && input.state !== 'delivered' && input.state !== 'interrupted')
    ) {
      return undefined;
    }
    inputs.push({
      inputId: input.inputId,
      message: input.message,
      acceptedAt: input.acceptedAt,
      admissionSequence: input.admissionSequence,
      state: input.state,
    });
  }
  return inputs;
}

function parsePendingInteraction(value: unknown): RuntimeSessionSnapshot['pendingInteraction'] {
  if (value === undefined) return undefined;
  if (
    !isObject(value) ||
    typeof value.requestId !== 'string' ||
    (value.kind !== 'question' && value.kind !== 'approval') ||
    typeof value.prompt !== 'string' ||
    typeof value.runId !== 'number' ||
    typeof value.runtimeIncarnation !== 'string' ||
    typeof value.createdAt !== 'number'
  ) {
    return undefined;
  }
  if (value.context !== undefined && !isObject(value.context)) return undefined;
  if (value.allowedResponses !== undefined && !stringArray(value.allowedResponses)) return undefined;
  return {
    requestId: value.requestId,
    kind: value.kind,
    prompt: value.prompt,
    context: value.context,
    allowedResponses: stringArray(value.allowedResponses),
    runId: value.runId,
    runtimeIncarnation: value.runtimeIncarnation,
    createdAt: value.createdAt,
  };
}

function parseEventRetention(value: unknown, fallbackLastSequence: number): RuntimeSessionSnapshot['eventRetention'] {
  if (isEventRetention(value)) {
    return {
      oldestAvailableSequence: value.oldestAvailableSequence,
      lastAvailableSequence: value.lastAvailableSequence,
    };
  }
  return {
    oldestAvailableSequence: fallbackLastSequence > 0 ? 1 : null,
    lastAvailableSequence: fallbackLastSequence,
  };
}

function isEventRetention(value: unknown): value is RuntimeSessionSnapshot['eventRetention'] {
  if (!isObject(value)) return false;
  const oldest = value.oldestAvailableSequence;
  const last = value.lastAvailableSequence;
  return (
    (oldest === null || (typeof oldest === 'number' && oldest >= 0)) &&
    typeof last === 'number' &&
    last >= 0 &&
    (oldest === null || oldest <= last)
  );
}

function parseRunPhase(value: unknown): RuntimeSessionSnapshot['runPhase'] {
  return isRunPhase(value) ? value : 'idle';
}

function isRunPhase(value: unknown): value is RuntimeSessionSnapshot['runPhase'] {
  return value === 'idle' ||
    value === 'running' ||
    value === 'waiting_user' ||
    value === 'waiting_approval' ||
    value === 'aborting' ||
    value === 'interrupted';
}

function parseSessionHealth(value: unknown): RuntimeSessionSnapshot['sessionHealth'] {
  return isSessionHealth(value) ? value : 'healthy';
}

function isSessionHealth(value: unknown): value is RuntimeSessionSnapshot['sessionHealth'] {
  return value === 'healthy' || value === 'run_failed' || value === 'durability_failed';
}

function isCurrentRuntimeSubAgentSessionSnapshot(value: Record<string, unknown>): boolean {
  return (
    typeof value.runId === 'string' &&
    typeof value.parentSessionId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.description === 'string' &&
    typeof value.isBackground === 'boolean' &&
    isSubAgentStatus(value.status) &&
    typeof value.output === 'string' &&
    typeof value.iterations === 'number' &&
    typeof value.toolCallCount === 'number' &&
    typeof value.startedAt === 'number'
  );
}

function isCurrentRuntimeEventEnvelopeSnapshot(value: Record<string, unknown>): boolean {
  return isBaseEventEnvelope(value);
}

function isBaseEventEnvelope(value: Record<string, unknown>): boolean {
  return (
    typeof value.sequence === 'number' &&
    typeof value.timestamp === 'number' &&
    typeof value.sessionId === 'string' &&
    typeof value.runId === 'number' &&
    isObject(value.event) &&
    typeof value.event.type === 'string'
  );
}

function normalizeRuntimeEventEnvelope(value: Record<string, unknown>): RuntimeEventEnvelopeSnapshot | undefined {
  if (!isBaseEventEnvelope(value)) return undefined;
  const event = value.event as Record<string, unknown>;
  if (event.type === 'error') {
    const error = event.error;
    if (!(error instanceof Error)) {
      if (!isObject(error) || typeof error.message !== 'string') return undefined;
      const restored = new Error(error.message);
      if (typeof error.name === 'string') restored.name = error.name;
      event.error = restored;
    }
  }
  return value as unknown as RuntimeEventEnvelopeSnapshot;
}

function parseToolMode(value: unknown): RuntimeSessionSnapshot['toolMode'] {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'none';
}

function parseApprovalMode(value: unknown): RuntimeSessionSnapshot['approvalMode'] {
  if (value === 'deny' || value === 'interactive' || value === 'full-access') return value;
  return 'deny';
}

function parseContextWindowSource(value: unknown): RuntimeSessionSnapshot['contextWindowSource'] {
  if (
    value === 'provider' ||
    value === 'runtime_exact' ||
    value === 'runtime_estimate' ||
    value === 'configured' ||
    value === 'model_metadata' ||
    value === 'unknown'
  ) {
    return value;
  }
  return undefined;
}

function isSubAgentStatus(value: unknown): value is RuntimeSubAgentSessionSnapshot['status'] {
  return value === 'running' || value === 'completed' || value === 'error' || value === 'interrupted' || value === 'cancelled';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
