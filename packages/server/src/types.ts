import type { LanguageClient } from '@synax-ai/core';
import type {
  AgentDurableRunStore,
  ContextUsageSource,
  CortxContributionConfig,
  Logger,
} from '@cortx/sdk';
import type {
  CortxRuntime,
  PluginAdminSubscriptionLimits,
  ProjectDomain,
  RuntimeApprovalMode,
  RuntimeDefaultCapabilities,
  WorkspaceToolMode,
} from '@cortx/runtime';
import type { ServerAuthKey } from './auth.js';

export interface ServerConfig {
  apiKey: string;
  apiKeys?: ServerAuthKey[];
  port?: number;
  host?: string;
  corsOrigin?: string;
  security?: {
    allowedOrigins?: string[];
    trustedProxy?: {
      addresses: string[];
      forwardedProtoHeader?: string;
    };
  };
  pluginSubscriptions?: Partial<PluginAdminSubscriptionLimits>;
  sessionFeeds?: {
    maxConnectionsGlobal?: number;
    maxConnectionsPerPrincipal?: number;
    maxBufferedFramesPerConnection?: number;
  };
  /** Maximum sessions allowed to run concurrently. Idle loaded sessions do not count toward this limit. */
  maxSessions?: number;
  maxEventsPerSession?: number;
  idleTimeoutMs?: number;
  language: LanguageClient;
  model: string;
  models?: unknown[];
  modelCatalog?: unknown[];
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  projectDomain: ProjectDomain;
  contributions?: CortxContributionConfig[];
  runtime?: { value: CortxRuntime; ownership: 'owned' | 'borrowed' };
  defaultWorkingDirectory?: string;
  allowedWorkspaceRoots?: string[];
  agentSpecRoots?: string[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  capabilities?: RuntimeDefaultCapabilities;
  logger?: Logger;
  durableStore?: AgentDurableRunStore;
  skillPackRegistryPath?: string;
}

export interface SessionInfo {
  id: string;
  creatorPrincipalId?: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: ContextUsageSource;
  toolMode: WorkspaceToolMode;
  approvalMode: RuntimeApprovalMode;
  skillPacks?: string[];
  isRunning: boolean;
  eventCount: number;
  metadata?: Record<string, unknown>;
}
