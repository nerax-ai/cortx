import type { LanguageClient } from '@synax-ai/core';
import type { Logger } from '@cortx/sdk';

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
  logger?: Logger;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
}
