import type { AgentDoneUsage, AgentEvent, ContextUsageSource, CortxContributionConfig, LanguageMessage, RuntimeAgentStreamEnvelope, Tool } from '@cortx/sdk';
import type { Cortx } from '@cortx/core';
import type { RuntimeDefaultCapabilities } from './default-capabilities.js';
import type { SubAgentSessionStore } from './capabilities/sub-agent/session-store.js';
import type { CortxHostScope } from './host-scope.js';
import type { WorkspaceToolMode } from './workspace-tool-mode.js';

export interface RuntimeSessionMetadata {
  [key: string]: unknown;
}

export type RuntimeApprovalMode = 'deny' | 'interactive' | 'full-access';

export type RuntimeRunPhase =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'waiting_approval'
  | 'aborting'
  | 'interrupted';

export type RuntimeSessionHealth = 'healthy' | 'run_failed' | 'durability_failed';

export interface RuntimeFollowUpAdmission {
  inputId: string;
  message: string;
  acceptedAt: number;
  admissionSequence: number;
  state: 'queued' | 'delivered' | 'interrupted';
}

export interface RuntimeEventRetention {
  oldestAvailableSequence: number | null;
  lastAvailableSequence: number;
}

export interface RuntimePendingInteraction {
  requestId: string;
  kind: 'question' | 'approval';
  prompt: string;
  context?: Record<string, unknown>;
  allowedResponses?: string[];
  runId: number;
  runtimeIncarnation: string;
  createdAt: number;
}

export interface RuntimeSessionInfo {
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
  /** Canonical runtime.toolProfile contribution reference used by the Host. */
  toolProfile: string;
  approvalMode: RuntimeApprovalMode;
  capabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  /** Original user-submitted prompts for input history; skill expansion does not rewrite these entries. */
  promptHistory?: string[];
  /** Cumulative provider usage across the session; context contains the latest request context facts. */
  usage?: AgentDoneUsage;
  runtimeIncarnation: string;
  projectionAsOfSequence: number;
  eventRetention: RuntimeEventRetention;
  runPhase: RuntimeRunPhase;
  sessionHealth: RuntimeSessionHealth;
  resumable: boolean;
  acceptsPrompt: boolean;
  pendingInteraction: RuntimePendingInteraction | null;
  queuedInputs: RuntimeFollowUpAdmission[];
  /** Compatibility view. Prefer runPhase. */
  isRunning: boolean;
  eventCount: number;
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSessionCreateRequest {
  id?: string;
  creatorPrincipalId?: string;
  workingDirectory?: string;
  model?: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  tools?: Tool[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  capabilities?: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  contributions?: CortxContributionConfig[];
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSessionUpdateRequest {
  model?: string;
  reasoningEffort?: string | null;
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  contextWindowTokens?: number;
  capabilities?: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSessionContextMetadata {
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  systemPromptTokens: number;
  toolDefinitionTokens: number;
  toolCount: number;
  skillSummaryTokens: number;
  skillCount: number;
}

export interface ManagedRuntimeSession {
  id: string;
  cortx: Cortx;
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
  toolProfile: string;
  approvalMode: RuntimeApprovalMode;
  requestedCapabilities: RuntimeDefaultCapabilities;
  capabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  promptHistory: string[];
  requestTools: Tool[];
  contributions: CortxContributionConfig[];
  scope: CortxHostScope;
  runScope?: CortxHostScope;
  creatorPrincipalId?: string;
  events: AgentEvent[];
  eventEnvelopes: import('@cortx/sdk').RuntimeAgentEventEnvelope[];
  usage?: AgentDoneUsage;
  subscribers: Set<(event: AgentEvent) => void>;
  envelopeSubscribers: Set<(event: import('@cortx/sdk').RuntimeAgentEventEnvelope) => void>;
  streamSubscribers: Set<(event: RuntimeAgentStreamEnvelope) => void>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  isRunning: boolean;
  runPhase: RuntimeRunPhase;
  sessionHealth: RuntimeSessionHealth;
  pendingInteraction?: RuntimePendingInteraction;
  resumable: boolean;
  followUpAdmissions: Map<string, RuntimeFollowUpAdmission>;
  runPromise?: Promise<void>;
  runId: number;
  nextEventSequence: number;
  streamOffset: number;
  eventRetention: RuntimeEventRetention;
  agentSessions: SubAgentSessionStore;
  contextMetadata: RuntimeSessionContextMetadata;
  metadata?: RuntimeSessionMetadata;
}

export type SessionProjection = RuntimeSessionInfo;

export interface RuntimeSessionLocalState {
  agentSessions: SubAgentSessionStore;
  getMessages(): LanguageMessage[];
  replaceMessages(messages: LanguageMessage[]): void;
}
