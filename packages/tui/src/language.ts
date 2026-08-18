import { Synax } from '@synax-ai/core';
import type { Logger } from '@nerax-ai/logger';
import type { ProjectDomain } from '@cortx/runtime';
import type { CortxConfig } from './config.js';

export interface TuiLanguageHost {
  readonly synax: Synax;
  readonly language: Synax['language'];
  close(): Promise<void>;
}

export async function createLanguageHost(
  config: CortxConfig,
  projectDomain?: ProjectDomain,
  logger?: Logger,
): Promise<TuiLanguageHost> {
  const synax = new Synax({
    registry: projectDomain?.registry,
    providers: [],
    groups: config.groups ?? [],
    logger,
  });
  try {
    for (const provider of config.providers ?? []) await synax.addProvider(provider);
  } catch (error) {
    await synax.close().catch(() => undefined);
    throw error;
  }
  return {
    synax,
    language: synax.language,
    close: () => synax.close(),
  };
}
