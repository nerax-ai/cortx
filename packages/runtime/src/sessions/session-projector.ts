import type {
  AgentDoneUsage,
  AgentEvent,
  ContextUsageBreakdownEntry,
  ContextUsageFacts,
} from '@cortx/sdk';
import {
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeEventEnvelopeSnapshot,
  type RuntimeSessionSnapshot,
} from '../durable/types.js';
import { estimateMessageTokens } from '../host/runtime-host-factory.js';
import type { ManagedRuntimeSession, RuntimeSessionInfo } from '../session.js';

export function projectRuntimeSession(
  session: ManagedRuntimeSession,
  runtimeIncarnation: string,
): RuntimeSessionInfo {
  return {
    id: session.id,
    creatorPrincipalId: session.creatorPrincipalId,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    workingDirectory: session.workingDirectory,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    system: session.system,
    maxIterations: session.maxIterations,
    contextWindowTokens: session.contextWindowTokens,
    contextWindowSource: session.contextWindowSource,
    toolMode: session.toolMode,
    toolProfile: session.toolProfile,
    pluginGeneration: session.pluginGeneration,
    approvalMode: session.approvalMode,
    capabilities: session.approvalMode === 'full-access'
      ? { ...session.requestedCapabilities, approval: false }
      : session.requestedCapabilities,
    skillPaths: session.skillPaths,
    skillPacks: session.skillPacks,
    promptHistory: session.promptHistory,
    usage: session.usage,
    runtimeIncarnation,
    projectionAsOfSequence: session.nextEventSequence,
    eventRetention: { ...session.eventRetention },
    runPhase: session.runPhase,
    sessionHealth: session.sessionHealth,
    resumable: session.resumable,
    acceptsPrompt: session.runPhase === 'idle' && session.sessionHealth !== 'durability_failed',
    pendingInteraction: session.pendingInteraction ? structuredClone(session.pendingInteraction) : null,
    queuedInputs: session.inputSource.visible(),
    isRunning: session.isRunning,
    eventCount: session.events.length,
    metadata: session.metadata,
  };
}

export function snapshotRuntimeSession(
  session: ManagedRuntimeSession,
  runtimeIncarnation: string,
): RuntimeSessionSnapshot {
  return {
    schemaVersion: RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
    id: session.id,
    creatorPrincipalId: session.creatorPrincipalId,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
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
    capabilities: session.requestedCapabilities,
    skillPaths: session.skillPaths,
    skillPacks: session.skillPacks,
    promptHistory: session.promptHistory,
    requestTools: session.requestTools,
    contributions: session.contributions.map((entry) => ({
      use: entry.use,
      ...(entry.options === undefined ? {} : { options: structuredClone(entry.options) }),
    })),
    usage: session.usage,
    runId: session.runId,
    nextEventSequence: session.nextEventSequence,
    runtimeIncarnation,
    runPhase: session.runPhase,
    sessionHealth: session.sessionHealth,
    resumable: session.resumable,
    pendingInteraction: session.pendingInteraction ? structuredClone(session.pendingInteraction) : undefined,
    queuedInputs: session.inputSource.values(),
    commandReceipts: session.commandLedger.values(),
    eventRetention: { ...session.eventRetention },
    metadata: session.metadata,
  };
}

export function applyRuntimeSessionEventProjection(
  session: ManagedRuntimeSession,
  event: AgentEvent,
  runtimeIncarnation: string,
): void {
  if (event.type === 'user_request') {
    session.pendingInteraction = {
      requestId: event.request.requestId,
      kind: event.request.kind === 'tool_approval' ? 'approval' : 'question',
      prompt: event.request.prompt,
      context: event.request.context,
      allowedResponses: event.request.allowedResponses,
      runId: session.runId,
      runtimeIncarnation,
      createdAt: session.lastActivityAt,
    };
    session.runPhase = event.request.kind === 'tool_approval' ? 'waiting_approval' : 'waiting_user';
    return;
  }
  if (event.type === 'user_question') {
    const existing = session.pendingInteraction;
    if (existing?.requestId !== event.toolCallId) {
      session.pendingInteraction = {
        requestId: event.toolCallId,
        kind: 'question',
        prompt: event.question,
        runId: session.runId,
        runtimeIncarnation,
        createdAt: session.lastActivityAt,
      };
      session.runPhase = 'waiting_user';
    }
    return;
  }
  if (event.type === 'user_answer') {
    if (session.pendingInteraction?.requestId === event.toolCallId) session.pendingInteraction = undefined;
    if (session.isRunning) session.runPhase = 'running';
    return;
  }
  if (event.type === 'follow_up') {
    if (event.inputId) session.inputSource.acknowledge(event.inputId);
    return;
  }
  if (event.type === 'error') {
    session.sessionHealth = event.code === 'user_abort' ? 'healthy' : 'run_failed';
    session.pendingInteraction = undefined;
    return;
  }
  if (event.type === 'done') session.pendingInteraction = undefined;
}

export function enrichRuntimeSessionEvent(session: ManagedRuntimeSession, event: AgentEvent): AgentEvent {
  if (event.type !== 'done' || !event.usage) return event;
  return {
    ...event,
    usage: {
      ...event.usage,
      context: createContextUsageFacts(session, event.usage, event.usage.context),
    },
  };
}

export function aggregateRuntimeSessionUsage(
  session: ManagedRuntimeSession,
  snapshots: RuntimeEventEnvelopeSnapshot[],
): AgentDoneUsage | undefined {
  let usage: AgentDoneUsage | undefined;
  for (const snapshot of snapshots) {
    const event = enrichRuntimeSessionEvent(session, snapshot.event);
    if (event.type === 'done' && event.usage) usage = addRuntimeSessionUsage(usage, event.usage);
  }
  return usage;
}

export function addRuntimeSessionUsage(
  current: AgentDoneUsage | undefined,
  next: AgentDoneUsage,
): AgentDoneUsage {
  const usage: AgentDoneUsage = {
    inputTokens: usageToken(current?.inputTokens) + usageToken(next.inputTokens),
    outputTokens: usageToken(current?.outputTokens) + usageToken(next.outputTokens),
  };
  const noCacheInputTokens = addOptionalUsageToken(current?.noCacheInputTokens, next.noCacheInputTokens);
  const cacheReadTokens = addOptionalUsageToken(current?.cacheReadTokens, next.cacheReadTokens);
  const cacheCreationTokens = addOptionalUsageToken(current?.cacheCreationTokens, next.cacheCreationTokens);
  const reasoningTokens = addOptionalUsageToken(current?.reasoningTokens, next.reasoningTokens);
  if (noCacheInputTokens !== undefined) usage.noCacheInputTokens = noCacheInputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) usage.cacheCreationTokens = cacheCreationTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  if (next.context) usage.context = next.context;
  else if (current?.context) usage.context = current.context;
  return usage;
}

function createContextUsageFacts(
  session: ManagedRuntimeSession,
  usage: AgentDoneUsage,
  existing?: ContextUsageFacts,
): ContextUsageFacts {
  const messagesTokens = estimateMessageTokens(session.cortx.messages);
  const metadata = session.contextMetadata;
  const baseBreakdown: ContextUsageBreakdownEntry[] = existing?.breakdown?.length ? existing.breakdown : [
    {
      key: 'messages',
      label: 'Messages',
      tokens: messagesTokens,
      source: 'runtime_estimate',
      count: session.cortx.messages.length,
    },
    {
      key: 'tools',
      label: 'Tools',
      tokens: metadata.toolDefinitionTokens,
      source: 'runtime_estimate',
      count: metadata.toolCount,
    },
    {
      key: 'skills',
      label: 'Skills',
      tokens: metadata.skillSummaryTokens,
      source: 'runtime_estimate',
      count: metadata.skillCount,
    },
    {
      key: 'system_prompt',
      label: 'System Prompt',
      tokens: metadata.systemPromptTokens,
      source: 'runtime_estimate',
    },
  ];
  const knownTokens = baseBreakdown
    .filter((row) => row.key !== 'other')
    .reduce((total, row) => total + row.tokens, 0);
  const providerUsedTokens = contextInputTokens(usage);
  const usedTokens = Math.max(providerUsedTokens ?? 0, knownTokens) || undefined;
  const otherTokens = Math.max(0, (usedTokens ?? 0) - knownTokens);
  const existingOther = baseBreakdown.find((row) => row.key === 'other');
  const breakdown: ContextUsageBreakdownEntry[] = [
    ...baseBreakdown.filter((row) => row.key !== 'other'),
    {
      key: 'other',
      label: existingOther?.label ?? 'Other',
      tokens: otherTokens,
      source: usedTokens === undefined ? 'unknown' : 'provider',
      description:
        existingOther?.description ??
        'Provider-reported input tokens not attributed to runtime-known messages, tools, skills, or system prompt.',
    },
  ];
  return {
    usedTokens,
    requestInputTokens: optionalUsageToken(usage.inputTokens),
    requestOutputTokens: optionalUsageToken(usage.outputTokens),
    requestNoCacheInputTokens: optionalUsageToken(usage.noCacheInputTokens),
    requestCacheReadTokens: optionalUsageToken(usage.cacheReadTokens),
    requestCacheCreationTokens: optionalUsageToken(usage.cacheCreationTokens),
    windowTokens: metadata.contextWindowTokens,
    windowSource: metadata.contextWindowSource,
    model: session.model,
    percentUsed: percent(usedTokens, metadata.contextWindowTokens),
    cacheHitRate: percent(usage.cacheReadTokens, providerUsedTokens ?? usedTokens),
    breakdown,
  };
}

function addOptionalUsageToken(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + usageToken(next);
}

function contextInputTokens(usage: AgentDoneUsage): number | undefined {
  const inputTokens = usageToken(usage.inputTokens);
  const cacheReadTokens = usageToken(usage.cacheReadTokens);
  const cacheCreationTokens = usageToken(usage.cacheCreationTokens);
  const noCacheInputTokens =
    usage.noCacheInputTokens === undefined ? undefined : usageToken(usage.noCacheInputTokens);
  const total =
    noCacheInputTokens === undefined
      ? inputTokens + cacheReadTokens + cacheCreationTokens
      : Math.max(inputTokens, noCacheInputTokens + cacheReadTokens + cacheCreationTokens);
  return total > 0 ? total : undefined;
}

function percent(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

function usageToken(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function optionalUsageToken(value: number | undefined): number | undefined {
  return value === undefined ? undefined : usageToken(value);
}
