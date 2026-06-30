import { PluginRegistry } from '@nerax-ai/plugin';
import {
  AGENT_CONTEXT_OVERFLOW,
  AGENT_ERROR_RECOVER,
  AGENT_EVENT_OBSERVER,
  AGENT_EXTENSION_TYPES,
  AGENT_MESSAGES_TRANSFORM,
  AGENT_SESSION_POLICY,
  AGENT_SYSTEM_TRANSFORM,
  AGENT_TOOL,
  AGENT_TOOL_AFTER,
  AGENT_TOOL_BEFORE,
  createEmptyAgentRuntimeExtensions,
  noopLogger,
  type AgentRuntimeExtensions,
  type CortxExtensionType,
  type CortxFactoryMap,
} from '@cortx/sdk';
import type { CortxConfig, CortxRegistry, PluginConfig } from './types.js';

type RegistryExtension = ReturnType<CortxRegistry['listExtensions']>[number];

export function getRegistry(config: CortxConfig): CortxRegistry {
  if (config.registry) return config.registry;
  return PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({
    appName: config.appName ?? 'cortx',
    logger: config.logger ?? noopLogger,
  });
}

export async function resolveExtensions(
  entries: CortxConfig['plugins'],
  registry: CortxRegistry,
  namespace: string,
): Promise<AgentRuntimeExtensions> {
  const resolved = createEmptyAgentRuntimeExtensions();
  if (!entries?.length) return resolved;

  for (const entry of entries) {
    const extensions = findConfiguredExtensions(registry, entry);
    if (!extensions.length) throw new Error(`agent extension not found: "${entry.use}"`);

    for (const ext of extensions) {
      const value = await registry.create(
        ext.type,
        ext.fullId,
        `${namespace}:${ext.type}:${ext.fullId}`,
        entry.options,
        namespace,
      );
      if (ext.type === AGENT_TOOL) resolved.tools.push(value as AgentRuntimeExtensions['tools'][number]);
      else if (ext.type === AGENT_SYSTEM_TRANSFORM) resolved.systemTransforms.push(value as AgentRuntimeExtensions['systemTransforms'][number]);
      else if (ext.type === AGENT_MESSAGES_TRANSFORM) resolved.messagesTransforms.push(value as AgentRuntimeExtensions['messagesTransforms'][number]);
      else if (ext.type === AGENT_TOOL_BEFORE) resolved.toolBefores.push(value as AgentRuntimeExtensions['toolBefores'][number]);
      else if (ext.type === AGENT_TOOL_AFTER) resolved.toolAfters.push(value as AgentRuntimeExtensions['toolAfters'][number]);
      else if (ext.type === AGENT_ERROR_RECOVER) resolved.errorRecovers.push(value as AgentRuntimeExtensions['errorRecovers'][number]);
      else if (ext.type === AGENT_CONTEXT_OVERFLOW) resolved.contextOverflows.push(value as AgentRuntimeExtensions['contextOverflows'][number]);
      else if (ext.type === AGENT_EVENT_OBSERVER) resolved.eventObservers.push(value as AgentRuntimeExtensions['eventObservers'][number]);
      else if (ext.type === AGENT_SESSION_POLICY) resolved.sessionPolicies.push(value as AgentRuntimeExtensions['sessionPolicies'][number]);
    }
  }

  return resolved;
}

function findConfiguredExtensions(registry: CortxRegistry, entry: PluginConfig): RegistryExtension[] {
  const matches: RegistryExtension[] = [];
  for (const type of AGENT_EXTENSION_TYPES) {
    matches.push(...registry.listExtensions(type).filter((ext) => matchesConfiguredUse(ext, entry.use)));
  }
  return matches;
}

function matchesConfiguredUse(ext: RegistryExtension, use: string): boolean {
  return ext.id === use || ext.fullId === use || ext.packageName === use;
}
