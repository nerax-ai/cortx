import type { LanguageClient } from '@synax-ai/core';
import type { Logger } from '@cortx/sdk';
import type { CortxRegistry, PluginConfig } from '@cortx/core';

export interface ServerConfig {
  apiKey: string;
  port?: number;
  host?: string;
  corsOrigin?: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  language: LanguageClient;
  model: string;
  system?: string;
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  logger?: Logger;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
}
