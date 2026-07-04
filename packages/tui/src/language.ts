import { Synax, type SynaxRegistry } from '@synax-ai/core';
import { PluginRegistry } from '@nerax-ai/plugin';
import type { Logger } from '@nerax-ai/logger';
import type { CortxConfig } from './config.js';
import type { CortxFactoryMap, CortxExtensionType, CortxRegistry } from '@cortx/runtime';

export type ProjectPluginRegistry = CortxRegistry & SynaxRegistry;

export async function createLanguageClient(config: CortxConfig, logger?: Logger, registry?: ProjectPluginRegistry) {
  const projectRegistry = registry ?? PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({
    appName: 'cortx',
    logger,
  }) as ProjectPluginRegistry;
  for (const source of config.plugins ?? []) {
    await projectRegistry.load(source);
  }

  const synax = new Synax({
    appName: 'cortx',
    registry: projectRegistry,
    providers: [],
    groups: config.groups ?? [],
    logger,
  });
  for (const p of config.providers ?? []) {
    await synax.addProvider(p);
  }

  return synax.language;
}
