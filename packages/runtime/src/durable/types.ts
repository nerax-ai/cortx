import type { AgentDoneUsage, AgentDurableRunStore, ContextUsageSource, CortxContributionConfig, RuntimeAgentEventEnvelope, Tool } from '@cortx/sdk';
import type { RuntimeDefaultCapabilities } from '../default-capabilities.js';
import type {
  RuntimeApprovalMode,
  RuntimeEventRetention,
  RuntimeFollowUpAdmission,
  RuntimePendingInteraction,
  RuntimeRunPhase,
  RuntimeSessionHealth,
  RuntimeSessionMetadata,
} from '../session.js';
import type { WorkspaceToolMode } from '../workspace-tool-mode.js';

export const RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface RuntimeSessionSnapshot {
  schemaVersion: typeof RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION;
  id: string;
  creatorPrincipalId?: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  toolMode: WorkspaceToolMode;
  toolProfile?: string;
  approvalMode: RuntimeApprovalMode;
  capabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  promptHistory?: string[];
  requestTools?: Tool[];
  contributions?: CortxContributionConfig[];
  usage?: AgentDoneUsage;
  runId: number;
  nextEventSequence: number;
  runtimeIncarnation: string;
  runPhase: RuntimeRunPhase;
  sessionHealth: RuntimeSessionHealth;
  resumable: boolean;
  pendingInteraction?: RuntimePendingInteraction;
  queuedInputs: RuntimeFollowUpAdmission[];
  eventRetention: RuntimeEventRetention;
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSubAgentSessionSnapshot {
  schemaVersion: typeof RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION;
  runId: string;
  parentSessionId: string;
  parentRunId?: number;
  toolCallId: string;
  description: string;
  isBackground: boolean;
  status: 'running' | 'completed' | 'error' | 'interrupted' | 'cancelled';
  output: string;
  iterations: number;
  toolCallCount: number;
  startedAt: number;
  completedAt?: number;
}

export interface RuntimeEventEnvelopeSnapshot extends RuntimeAgentEventEnvelope {
  schemaVersion: typeof RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION;
}

export interface RuntimeDurableRunStore extends AgentDurableRunStore {
  acquireOwnership?(): void;
  releaseOwnership?(): void | Promise<void>;
  saveRuntimeSession(snapshot: RuntimeSessionSnapshot): void | Promise<void>;
  loadRuntimeSession(sessionId: string): RuntimeSessionSnapshot | undefined | Promise<RuntimeSessionSnapshot | undefined>;
  listRuntimeSessions(): RuntimeSessionSnapshot[] | Promise<RuntimeSessionSnapshot[]>;
  deleteRuntimeSession(sessionId: string): void | Promise<void>;
  saveSubAgentSession(snapshot: RuntimeSubAgentSessionSnapshot): void | Promise<void>;
  listSubAgentSessions(parentSessionId: string): RuntimeSubAgentSessionSnapshot[] | Promise<RuntimeSubAgentSessionSnapshot[]>;
  deleteSubAgentSessions(parentSessionId: string): void | Promise<void>;
  saveEventEnvelope?(snapshot: RuntimeEventEnvelopeSnapshot): void | Promise<void>;
  listEventEnvelopes?(sessionId: string): RuntimeEventEnvelopeSnapshot[] | Promise<RuntimeEventEnvelopeSnapshot[]>;
  deleteEventEnvelopes?(sessionId: string): void | Promise<void>;
  getEventEnvelopeRetention?(sessionId: string): RuntimeEventRetention | Promise<RuntimeEventRetention>;
}

export function isRuntimeDurableRunStore(store: AgentDurableRunStore | undefined): store is RuntimeDurableRunStore {
  return Boolean(
    store &&
      typeof store.saveCheckpoint === 'function' &&
      typeof store.loadCheckpoint === 'function' &&
      typeof (store as RuntimeDurableRunStore).saveRuntimeSession === 'function' &&
      typeof (store as RuntimeDurableRunStore).loadRuntimeSession === 'function' &&
      typeof (store as RuntimeDurableRunStore).listRuntimeSessions === 'function' &&
      typeof (store as RuntimeDurableRunStore).deleteRuntimeSession === 'function' &&
      typeof (store as RuntimeDurableRunStore).saveSubAgentSession === 'function' &&
      typeof (store as RuntimeDurableRunStore).listSubAgentSessions === 'function' &&
      typeof (store as RuntimeDurableRunStore).deleteSubAgentSessions === 'function',
  );
}
