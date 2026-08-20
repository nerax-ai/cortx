import type {
  AgentDoneUsage,
  ContextUsageSource,
  RuntimeAgentEventEnvelope,
} from '@cortx/sdk';
import type { AgentState } from '@cortx/store';

export type WebWorkspaceToolMode = string;
export type WebApprovalMode = 'deny' | 'interactive' | 'full-access';
export type WebRunPhase = 'idle' | 'running' | 'waiting_user' | 'waiting_approval' | 'aborting' | 'interrupted';
export type WebSessionHealth = 'healthy' | 'run_failed' | 'durability_failed';
export type WebEventConnectionPhase =
  | 'connecting'
  | 'replaying'
  | 'live'
  | 'resyncing'
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

export interface WebEventHistoryState {
  sessionId?: string;
  hasMoreBefore: boolean;
  loadedEvents: number;
  firstSequence?: number;
  lastSequence?: number;
  loadingOlder: boolean;
  truncated?: boolean;
}

export interface WebRuntimeEventRetention {
  oldestAvailableSequence: number | null;
  lastAvailableSequence: number;
}

export interface WebFollowUpAdmission {
  inputId: string;
  message: string;
  acceptedAt: number;
  admissionSequence: number;
  state: 'queued' | 'delivered' | 'interrupted';
}

export interface WebPendingInteraction {
  requestId: string;
  kind: 'question' | 'approval';
  prompt: string;
  allowedResponses?: string[];
  context?: Record<string, unknown>;
  runId: number;
  runtimeIncarnation: string;
  createdAt: number;
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
  toolProfile?: string;
  pluginGeneration?: string;
  approvalMode: WebApprovalMode;
  capabilities?: Record<string, unknown>;
  skillPaths?: string[];
  skillPacks?: string[];
  promptHistory?: string[];
  usage?: AgentDoneUsage;
  runtimeIncarnation: string;
  projectionAsOfSequence: number;
  eventRetention: WebRuntimeEventRetention;
  runPhase: WebRunPhase;
  sessionHealth: WebSessionHealth;
  resumable: boolean;
  acceptsPrompt: boolean;
  pendingInteraction: WebPendingInteraction | null;
  queuedInputs: WebFollowUpAdmission[];
  isRunning: boolean;
  eventCount: number;
  metadata?: Record<string, unknown>;
}

export interface WebSessionSummary {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  model: string;
  toolProfile: string;
  pluginGeneration: string;
  runtimeIncarnation: string;
  projectionAsOfSequence: number;
  runPhase: WebRunPhase;
  sessionHealth: WebSessionHealth;
  resumable: boolean;
  acceptsPrompt: boolean;
  isRunning: boolean;
}

export interface WebSessionBaseline {
  runtimeIncarnation: string;
  cursor: string;
  sessions: WebSessionSummary[];
}

export interface WebCreateSessionRequest {
  workingDirectory?: string;
  model?: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  /** Must be a canonical runtime.toolProfile `use`; aliases are display-only. */
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

export interface WebCommandMetadata {
  commandId: string;
  expectedRuntimeIncarnation: string;
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

export interface WebToolProfileInfo {
  id: string;
  use: string;
  name?: string;
  description?: string;
  pluginId?: string;
  packageName?: string;
  tools: Array<{ use: string; options?: Record<string, unknown> }>;
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

export interface WebEventHistoryResponse {
  events: RuntimeAgentEventEnvelope[];
  runtimeIncarnation?: string;
  retention?: WebRuntimeEventRetention;
  resetRequired?: boolean;
  replayComplete?: boolean;
  page?: {
    hasMoreBefore?: boolean;
    hasMoreAfter?: boolean;
    firstSequence?: number;
    lastSequence?: number;
  };
}

export interface SessionControllerSnapshot {
  phase: 'connecting' | 'ready' | 'failed' | 'closed';
  error: string | null;
  runtimeIncarnation?: string;
  activeSessionId: string | null;
  session: WebRuntimeSessionInfo | null;
  sessions: WebRuntimeSessionInfo[];
  models: WebModelInfo[];
  toolProfiles: WebToolProfileInfo[];
  agentSpecs: WebAgentSpecInfo[];
  skillPacks: WebSkillPackInfo[];
  connection: WebEventConnectionState;
  history: WebEventHistoryState;
  agent: AgentState;
}
