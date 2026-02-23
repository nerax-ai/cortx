import { Synax } from '@synax-ai/core';
import { PluginRegistry } from '@nerax-ai/plugin';
import type { Logger } from '@nerax-ai/logger';
import type { CortxConfig } from './config.js';

export async function createLanguageClient(config: CortxConfig, logger?: Logger) {
  const registry = PluginRegistry.getInstance({
    appName: 'cortx',
    logger,
  });
  for (const source of config.plugins ?? []) {
    await registry.load(source);
  }

  const synax = new Synax({ providers: [], groups: config.groups ?? [], logger });
  for (const p of config.providers ?? []) {
    await synax.addProvider(p as any);
  }

  return synax.language;
}
