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
  appendAgentRuntimeExtension,
  createEmptyAgentRuntimeExtensions,
  noopLogger,
  type AgentExtensionType,
  type AgentRuntimeExtensionValue,
  type AgentRuntimeExtensions,
  type CortxExtensionType,
  type CortxFactoryMap,
} from '@cortx/sdk';
import type { CortxConfig, CortxRegistry, PluginConfig } from './types.js';

type RegistryExtension = ReturnType<CortxRegistry['listExtensions']>[number];
type RegistryContribution = Awaited<ReturnType<CortxRegistry['listContributions']>>[number];
type ExtensionValidatorMap = {
  [T in AgentExtensionType]: (value: unknown) => value is AgentRuntimeExtensionValue<T>;
};

const extensionValidators = {
  [AGENT_TOOL]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_TOOL> =>
    hasString(value, 'name') && hasFunction(value, 'execute') && isRecord((value as { inputSchema?: unknown }).inputSchema),
  [AGENT_SYSTEM_TRANSFORM]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_SYSTEM_TRANSFORM> =>
    hasFunction(value, 'transformSystem'),
  [AGENT_MESSAGES_TRANSFORM]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_MESSAGES_TRANSFORM> =>
    hasFunction(value, 'transformMessages'),
  [AGENT_TOOL_BEFORE]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_TOOL_BEFORE> =>
    hasFunction(value, 'beforeToolExecute'),
  [AGENT_TOOL_AFTER]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_TOOL_AFTER> =>
    hasFunction(value, 'afterToolExecute'),
  [AGENT_ERROR_RECOVER]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_ERROR_RECOVER> =>
    hasFunction(value, 'recoverError'),
  [AGENT_CONTEXT_OVERFLOW]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_CONTEXT_OVERFLOW> =>
    hasFunction(value, 'handleContextOverflow'),
  [AGENT_EVENT_OBSERVER]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_EVENT_OBSERVER> =>
    hasFunction(value, 'onAgentEvent'),
  [AGENT_SESSION_POLICY]: (value: unknown): value is AgentRuntimeExtensionValue<typeof AGENT_SESSION_POLICY> =>
    isRecord(value),
} satisfies ExtensionValidatorMap;

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
    const extensions = await findConfiguredExtensions(registry, entry);
    if (!extensions.length) throw new Error(`agent extension not found: "${entry.use}"`);

    for (const ext of extensions) {
      const value = await registry.create(
        ext.type,
        ext.fullId,
        `${namespace}:${ext.type}:${ext.fullId}`,
        entry.options,
        namespace,
      );
      appendResolvedExtension(resolved, ext.type, assertExtensionValue(ext, value));
    }
  }

  return resolved;
}

function appendResolvedExtension<T extends AgentExtensionType>(
  resolved: AgentRuntimeExtensions,
  type: T,
  value: AgentRuntimeExtensionValue<T>,
): void {
  appendAgentRuntimeExtension(resolved, type, value);
}

function assertExtensionValue<T extends AgentExtensionType>(
  ext: RegistryExtension & { type: T },
  value: unknown,
): AgentRuntimeExtensionValue<T> {
  if (extensionValidators[ext.type](value)) return value;
  throw new Error(`agent extension "${ext.fullId}" (${ext.type}) returned an invalid contribution shape`);
}

async function findConfiguredExtensions(registry: CortxRegistry, entry: PluginConfig): Promise<RegistryExtension[]> {
  const matches = new Map<string, RegistryExtension>();
  for (const type of AGENT_EXTENSION_TYPES) {
    for (const ext of registry.listExtensions(type).filter((candidate) => matchesConfiguredUse(candidate, entry.use))) {
      matches.set(ext.fullId, ext);
    }
  }

  const contributions = await registry.listContributions();
  for (const contribution of contributions) {
    if (!isAgentExtensionType(contribution.type)) continue;
    if (!matchesConfiguredContribution(contribution, entry.use)) continue;
    const ext = registry
      .listExtensions(contribution.type)
      .find((candidate) => candidate.fullId === contribution.fullId);
    if (ext) matches.set(ext.fullId, ext);
  }

  return [...matches.values()];
}

function matchesConfiguredUse(ext: RegistryExtension, use: string): boolean {
  return ext.id === use || ext.fullId === use || ext.packageName === use;
}

function matchesConfiguredContribution(contribution: RegistryContribution, use: string): boolean {
  return (
    contribution.id === use ||
    contribution.fullId === use ||
    contribution.packageName === use ||
    contribution.pluginId === use ||
    `${contribution.pluginId}/${contribution.id}` === use
  );
}

function isAgentExtensionType(value: string): value is AgentExtensionType {
  return (AGENT_EXTENSION_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFunction(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === 'function';
}

function hasString(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === 'string';
}
