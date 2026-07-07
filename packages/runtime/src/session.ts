import type { AgentDoneUsage, AgentEvent, ContextUsageSource, LanguageMessage, Tool } from '@cortx/sdk';
import type { Cortx, PluginConfig, CortxRegistry } from '@cortx/core';
import type { RuntimeDefaultCapabilities } from './default-capabilities.js';
import type { SubAgentSessionStore } from './capabilities/sub-agent/session-store.js';
import type { WorkspaceToolMode } from './workspace-tool-mode.js';

export interface RuntimeSessionMetadata {
  [key: string]: unknown;
}

export type RuntimeApprovalMode = 'deny' | 'interactive' | 'full-access';

export interface RuntimeSessionInfo {
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
  toolMode: WorkspaceToolMode;
  approvalMode: RuntimeApprovalMode;
  capabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  /** Original user-submitted prompts for input history; skill expansion does not rewrite these entries. */
  promptHistory?: string[];
  /** Cumulative provider usage across the session; context contains the latest request context facts. */
  usage?: AgentDoneUsage;
  isRunning: boolean;
  eventCount: number;
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSessionCreateRequest {
  id?: string;
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
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
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
  approvalMode: RuntimeApprovalMode;
  requestedCapabilities: RuntimeDefaultCapabilities;
  capabilities: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  promptHistory: string[];
  requestTools: Tool[];
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  events: AgentEvent[];
  eventEnvelopes: import('@cortx/sdk').RuntimeAgentEventEnvelope[];
  usage?: AgentDoneUsage;
  subscribers: Set<(event: AgentEvent) => void>;
  envelopeSubscribers: Set<(event: import('@cortx/sdk').RuntimeAgentEventEnvelope) => void>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  isRunning: boolean;
  runPromise?: Promise<void>;
  needsHostRefresh?: boolean;
  runId: number;
  nextEventSequence: number;
  agentSessions: SubAgentSessionStore;
  contextMetadata: RuntimeSessionContextMetadata;
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSessionLocalState {
  agentSessions: SubAgentSessionStore;
  getMessages(): LanguageMessage[];
  replaceMessages(messages: LanguageMessage[]): void;
}
