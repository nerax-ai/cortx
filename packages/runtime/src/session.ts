import type { AgentEvent, LanguageMessage, Tool } from '@cortx/sdk';
import type { Cortx, PluginConfig, CortxRegistry } from '@cortx/core';
import type { RuntimeDefaultCapabilities } from './default-capabilities.js';
import type { SubAgentSessionStore } from './capabilities/sub-agent/session-store.js';

export interface RuntimeSessionMetadata {
  [key: string]: unknown;
}

export interface RuntimeSessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  maxIterations?: number;
  toolMode: import('./tool-mount.js').WorkspaceToolMode;
  approvalMode: 'deny' | 'interactive';
  isRunning: boolean;
  eventCount: number;
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSessionCreateRequest {
  id?: string;
  workingDirectory?: string;
  model?: string;
  system?: string;
  maxIterations?: number;
  tools?: Tool[];
  toolMode?: import('./tool-mount.js').WorkspaceToolMode;
  approvalMode?: 'deny' | 'interactive';
  capabilities?: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  metadata?: RuntimeSessionMetadata;
}

export interface ManagedRuntimeSession {
  id: string;
  cortx: Cortx;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  maxIterations?: number;
  toolMode: import('./tool-mount.js').WorkspaceToolMode;
  approvalMode: 'deny' | 'interactive';
  events: AgentEvent[];
  eventEnvelopes: import('@cortx/sdk').RuntimeAgentEventEnvelope[];
  subscribers: Set<(event: AgentEvent) => void>;
  envelopeSubscribers: Set<(event: import('@cortx/sdk').RuntimeAgentEventEnvelope) => void>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  isRunning: boolean;
  runId: number;
  nextEventSequence: number;
  agentSessions: SubAgentSessionStore;
  metadata?: RuntimeSessionMetadata;
}

export interface RuntimeSessionLocalState {
  agentSessions: SubAgentSessionStore;
  getMessages(): LanguageMessage[];
  replaceMessages(messages: LanguageMessage[]): void;
}
