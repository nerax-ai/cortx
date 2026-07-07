import type { LanguageClient } from '@synax-ai/core';
import type { AgentDurableRunStore, ContextUsageSource, Logger } from '@cortx/sdk';
import type { CortxRegistry, PluginConfig } from '@cortx/runtime';
import type { WorkspaceToolMode } from '@cortx/runtime';
import type { RuntimeApprovalMode } from '@cortx/runtime';
import type { ServerAuthKey } from './auth.js';

export interface ServerConfig {
  apiKey: string;
  apiKeys?: ServerAuthKey[];
  port?: number;
  host?: string;
  corsOrigin?: string;
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
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  defaultWorkingDirectory?: string;
  allowedWorkspaceRoots?: string[];
  agentSpecRoots?: string[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  logger?: Logger;
  durableStore?: AgentDurableRunStore;
  skillPackRegistryPath?: string;
}

export interface SessionInfo {
  id: string;
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
