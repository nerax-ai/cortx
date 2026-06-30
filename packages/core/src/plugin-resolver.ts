import { PluginRegistry } from '@nerax-ai/plugin';
import {
  AGENT_CONTEXT_OVERFLOW,
  AGENT_ERROR_RECOVER,
  AGENT_EVENT_OBSERVER,
  AGENT_EXTENSION_TYPES,
  AGENT_MESSAGES_TRANSFORM,
  AGENT_SYSTEM_TRANSFORM,
  AGENT_TOOL,
  AGENT_TOOL_AFTER,
  AGENT_TOOL_BEFORE,
  CORTX_LEGACY_PLUGIN,
  noopLogger,
  type AgentContextOverflowContribution,
  type AgentErrorRecoverContribution,
  type AgentEventObserverContribution,
  type AgentMessagesTransformContribution,
  type AgentSystemTransformContribution,
  type AgentToolAfterContribution,
  type AgentToolBeforeContribution,
  type CortxExtensionType,
  type CortxFactoryMap,
  type LanguageMessage,
  type Tool,
  type ToolResult,
} from '@cortx/sdk';
import type { CortxConfig, CortxPlugin, CortxPluginRegistry, PluginConfig } from './types.js';
import { isPluginConfig } from './types.js';

type RegistryExtension = ReturnType<CortxPluginRegistry['listExtensions']>[number];

export function getRegistry(config: CortxConfig): CortxPluginRegistry {
  if (config.registry) return config.registry;
  return PluginRegistry.getInstance<CortxExtensionType, CortxFactoryMap>({
    appName: config.appName ?? 'cortx',
    logger: config.logger ?? noopLogger,
  });
}

export async function resolvePlugins(
  entries: CortxConfig['plugins'],
  registry: CortxPluginRegistry,
  namespace: string,
  logger: CortxConfig['logger'],
): Promise<CortxPlugin[]> {
  if (!entries?.length) return [];
  const resolved: CortxPlugin[] = [];

  for (const entry of entries) {
    if (!isPluginConfig(entry)) {
      resolved.push(entry as CortxPlugin);
      continue;
    }

    const legacyExtension = registry
      .listExtensions(CORTX_LEGACY_PLUGIN)
      .find((ext) => matchesConfiguredUse(ext, entry.use));
    if (legacyExtension) {
      resolved.push(await registry.create(
        CORTX_LEGACY_PLUGIN,
        legacyExtension.fullId,
        `${namespace}:${legacyExtension.fullId}`,
        entry.options,
        namespace,
      ) as CortxPlugin);
    }

    const contributions = await collectAgentContributions(entry, registry, namespace);
    const compiled = compileAgentContributions({ ...contributions, logger });
    if (compiled) resolved.push(compiled);

    if (!legacyExtension && !contributions.matched) {
      resolved.push(await registry.create(
        CORTX_LEGACY_PLUGIN,
        entry.use,
        `${namespace}:${entry.use}`,
        entry.options,
        namespace,
      ) as CortxPlugin);
    }
  }

  return resolved;
}

function matchesConfiguredUse(ext: RegistryExtension, use: string): boolean {
  return ext.id === use || ext.fullId === use || ext.packageName === use;
}

async function collectAgentContributions(
  entry: PluginConfig,
  registry: CortxPluginRegistry,
  namespace: string,
) {
  const tools: Tool[] = [];
  const systemTransforms: AgentSystemTransformContribution[] = [];
  const messagesTransforms: AgentMessagesTransformContribution[] = [];
  const toolBefores: AgentToolBeforeContribution[] = [];
  const toolAfters: AgentToolAfterContribution[] = [];
  const errorRecovers: AgentErrorRecoverContribution[] = [];
  const contextOverflows: AgentContextOverflowContribution[] = [];
  const eventObservers: AgentEventObserverContribution[] = [];
  let matched = false;

  for (const type of AGENT_EXTENSION_TYPES) {
    const extensions = registry.listExtensions(type).filter((ext) => matchesConfiguredUse(ext, entry.use));
    for (const ext of extensions) {
      matched = true;
      const value = await registry.create(
        type,
        ext.fullId,
        `${namespace}:${ext.type}:${ext.fullId}`,
        entry.options,
        namespace,
      );
      if (type === AGENT_TOOL) tools.push(value as Tool);
      else if (type === AGENT_SYSTEM_TRANSFORM) systemTransforms.push(value as AgentSystemTransformContribution);
      else if (type === AGENT_MESSAGES_TRANSFORM) messagesTransforms.push(value as AgentMessagesTransformContribution);
      else if (type === AGENT_TOOL_BEFORE) toolBefores.push(value as AgentToolBeforeContribution);
      else if (type === AGENT_TOOL_AFTER) toolAfters.push(value as AgentToolAfterContribution);
      else if (type === AGENT_ERROR_RECOVER) errorRecovers.push(value as AgentErrorRecoverContribution);
      else if (type === AGENT_CONTEXT_OVERFLOW) contextOverflows.push(value as AgentContextOverflowContribution);
      else if (type === AGENT_EVENT_OBSERVER) eventObservers.push(value as AgentEventObserverContribution);
    }
  }

  return {
    matched,
    tools,
    systemTransforms,
    messagesTransforms,
    toolBefores,
    toolAfters,
    errorRecovers,
    contextOverflows,
    eventObservers,
  };
}

function normalizeSystemResult(result: Awaited<ReturnType<AgentSystemTransformContribution['transformSystem']>>): string {
  return typeof result === 'string' ? result : result.system;
}

function normalizeMessagesResult(result: Awaited<ReturnType<AgentMessagesTransformContribution['transformMessages']>>): LanguageMessage[] {
  return Array.isArray(result) ? result : result.messages;
}

function normalizeToolResult(result: Awaited<ReturnType<AgentToolAfterContribution['afterToolExecute']>>) {
  return 'result' in result ? result.result : result;
}

function normalizeRecoverResult(result: Awaited<ReturnType<AgentErrorRecoverContribution['recoverError']>>) {
  if ('retry' in result) return result;
  return result.action === 'retry'
    ? { retry: true, delay: result.delayMs }
    : { retry: false };
}

function normalizeContextOverflowResult(
  result: Awaited<ReturnType<AgentContextOverflowContribution['handleContextOverflow']>>,
): LanguageMessage[] | null {
  if (result === null) return null;
  if (Array.isArray(result)) return result;
  if ('messages' in result) return result.messages;
  return null;
}

function formatOutput(result: ToolResult, fallback: string): string {
  const value = !result.success && result.output === undefined
    ? result.error ?? fallback
    : result.output;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function shortCircuitResult(result: ToolResult | string, isError?: boolean) {
  const normalized: ToolResult = typeof result === 'string'
    ? { success: isError !== true, output: result }
    : result;
  return {
    action: 'shortCircuit' as const,
    skip: true,
    result: formatOutput(normalized, 'short-circuited'),
    isError: !normalized.success,
  };
}

function compileAgentContributions(input: {
  tools: Tool[];
  systemTransforms: AgentSystemTransformContribution[];
  messagesTransforms: AgentMessagesTransformContribution[];
  toolBefores: AgentToolBeforeContribution[];
  toolAfters: AgentToolAfterContribution[];
  errorRecovers: AgentErrorRecoverContribution[];
  contextOverflows: AgentContextOverflowContribution[];
  eventObservers: AgentEventObserverContribution[];
  logger: CortxConfig['logger'];
}): CortxPlugin | null {
  const {
    tools,
    systemTransforms,
    messagesTransforms,
    toolBefores,
    toolAfters,
    errorRecovers,
    contextOverflows,
    eventObservers,
    logger = noopLogger,
  } = input;

  if (
    tools.length === 0 &&
    systemTransforms.length === 0 &&
    messagesTransforms.length === 0 &&
    toolBefores.length === 0 &&
    toolAfters.length === 0 &&
    errorRecovers.length === 0 &&
    contextOverflows.length === 0 &&
    eventObservers.length === 0
  ) {
    return null;
  }

  const observerLogger = logger.scope('agent.eventObserver');
  const plugin: CortxPlugin = {};

  if (tools.length) plugin.tools = tools;
  if (systemTransforms.length) {
    plugin['system.transform'] = async (system) => {
      let next = system;
      for (const contribution of systemTransforms) {
        next = normalizeSystemResult(await contribution.transformSystem({ system: next }));
      }
      return next;
    };
  }
  if (messagesTransforms.length) {
    plugin['messages.transform'] = async (messages) => {
      let next = messages;
      for (const contribution of messagesTransforms) {
        next = normalizeMessagesResult(await contribution.transformMessages({ messages: next }));
      }
      return next;
    };
  }
  if (toolBefores.length) {
    plugin['tool.execute.before'] = async (toolCall, toolContext, tool, parsedInput = {}) => {
      let input = parsedInput;
      let rewrittenInput: string | Record<string, unknown> | undefined;
      for (const contribution of toolBefores) {
        const result = await contribution.beforeToolExecute({ toolCall, tool, input, toolContext });
        if (!result || result.action === 'allow') continue;
        if (result.action === 'rewrite') {
          input = typeof result.input === 'string'
            ? JSON.parse(result.input)
            : result.input;
          toolCall.input = result.input;
          rewrittenInput = result.input;
          continue;
        }
        if (result.action === 'deny') {
          const denied = typeof result.result === 'object' && result.result !== null
            ? result.result
            : { success: false, error: result.reason ?? String(result.result ?? 'Denied') };
          return shortCircuitResult(denied);
        }
        if (result.action === 'shortCircuit') {
          return shortCircuitResult(result.result, result.isError);
        }
      }
      return rewrittenInput === undefined ? {} : { action: 'rewrite', input: rewrittenInput };
    };
  }
  if (toolAfters.length) {
    plugin['tool.execute.after'] = async (toolCall, result, tool) => {
      let next = result;
      for (const contribution of toolAfters) {
        next = normalizeToolResult(await contribution.afterToolExecute({ toolCall, tool, result: next }));
      }
      return next;
    };
  }
  if (errorRecovers.length) {
    plugin['error.recover'] = async (event) => {
      for (const contribution of errorRecovers) {
        const result = normalizeRecoverResult(await contribution.recoverError({
          event,
          error: event.error,
          code: event.code,
        }));
        if (result.retry) return result;
      }
      return { retry: false };
    };
  }
  if (contextOverflows.length) {
    plugin['context.overflow'] = async (messages) => {
      for (const contribution of contextOverflows) {
        const result = normalizeContextOverflowResult(await contribution.handleContextOverflow({ messages }));
        if (result) return result;
      }
      return null;
    };
  }
  if (eventObservers.length) {
    plugin.event = async (event) => {
      for (const contribution of eventObservers) {
        try {
          await contribution.onAgentEvent(event);
        } catch (error) {
          observerLogger.warn(`agent.eventObserver failed for ${event.type}`, error);
        }
      }
    };
  }
  return plugin;
}
