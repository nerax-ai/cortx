import type { AgentDurableRunStore, RuntimeAgentEventEnvelope } from '@cortx/sdk';
import type { RuntimeDefaultCapabilities } from '../default-capabilities.js';
import type { RuntimeApprovalMode, RuntimeSessionMetadata } from '../session.js';
import type { WorkspaceToolMode } from '../tool-mount.js';

export const RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_EVENT_ENVELOPE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface RuntimeSessionSnapshot {
  schemaVersion: typeof RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION;
  id: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  system?: string;
  maxIterations?: number;
  toolMode: WorkspaceToolMode;
  approvalMode: RuntimeApprovalMode;
  capabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  runId: number;
  nextEventSequence: number;
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
  status: 'running' | 'completed' | 'error';
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
