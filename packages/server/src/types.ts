import type { LanguageClient } from '@synax-ai/core';
import type { AgentDurableRunStore, Logger } from '@cortx/sdk';
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
  maxSessions?: number;
  maxEventsPerSession?: number;
  idleTimeoutMs?: number;
  language: LanguageClient;
  model: string;
  system?: string;
  maxIterations?: number;
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  defaultWorkingDirectory?: string;
  allowedWorkspaceRoots?: string[];
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
  toolMode: WorkspaceToolMode;
  approvalMode: RuntimeApprovalMode;
  skillPacks?: string[];
  isRunning: boolean;
  eventCount: number;
  metadata?: Record<string, unknown>;
}
