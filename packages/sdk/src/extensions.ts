import type { Logger } from '@nerax-ai/logger';
import {
  isValidPluginId,
  type ContributionBinding,
  type ContributionFactory,
  type ContributionHostContext,
  type ContributionLease,
  type DeclarativePlugin,
  type DeclarativePluginContext,
  type EffectDisposer,
  type JsonObject,
  type ManifestContributionDescriptor,
  type PluginStorage,
} from '@nerax-ai/plugin';
import type {
  LanguageMessage,
  LanguageToolCallContent,
  SynaxContributionMap,
  SynaxContributionType,
} from '@synax-ai/sdk';
import type { AgentEvent, ErrorCode } from './events.js';
import type { AgentSessionPolicyContribution } from './policy.js';
import type { Tool, ToolContext, ToolResult } from './tools.js';

export const AGENT_TOOL = 'agent.tool' as const;
export const AGENT_SYSTEM_TRANSFORM = 'agent.systemTransform' as const;
export const AGENT_MESSAGES_TRANSFORM = 'agent.messagesTransform' as const;
export const AGENT_TOOL_BEFORE = 'agent.toolBefore' as const;
export const AGENT_TOOL_AFTER = 'agent.toolAfter' as const;
export const AGENT_ERROR_RECOVER = 'agent.errorRecover' as const;
export const AGENT_CONTEXT_OVERFLOW = 'agent.contextOverflow' as const;
export const AGENT_EVENT_OBSERVER = 'agent.eventObserver' as const;
export const AGENT_SESSION_POLICY = 'agent.sessionPolicy' as const;
export const RUNTIME_TOOL_PROFILE = 'runtime.toolProfile' as const;

export const AGENT_EXTENSION_TYPES = [
  AGENT_TOOL,
  AGENT_SYSTEM_TRANSFORM,
  AGENT_MESSAGES_TRANSFORM,
  AGENT_TOOL_BEFORE,
  AGENT_TOOL_AFTER,
  AGENT_ERROR_RECOVER,
  AGENT_CONTEXT_OVERFLOW,
  AGENT_EVENT_OBSERVER,
  AGENT_SESSION_POLICY,
] as const;

export const CORTX_EXECUTABLE_CONTRIBUTION_TYPES = [...AGENT_EXTENSION_TYPES] as const;
export const CORTX_CONTRIBUTION_TYPES = [...AGENT_EXTENSION_TYPES, RUNTIME_TOOL_PROFILE] as const;
export const PROJECT_CONTRIBUTION_TYPES = [
  ...CORTX_CONTRIBUTION_TYPES,
  'provider',
  'dispatcher',
  'endpoint',
  'api',
] as const;

export type AgentExtensionType = (typeof AGENT_EXTENSION_TYPES)[number];
export type CortxContributionType = (typeof CORTX_CONTRIBUTION_TYPES)[number];
export type CortxExecutableContributionType = (typeof CORTX_EXECUTABLE_CONTRIBUTION_TYPES)[number];
export type ProjectContributionType = (typeof PROJECT_CONTRIBUTION_TYPES)[number];

export interface AgentSystemTransformInput {
  system: string;
}

export interface AgentSystemTransformResult {
  system: string;
}

export interface AgentSystemTransformContribution {
  transformSystem(input: AgentSystemTransformInput): AgentSystemTransformResult | Promise<AgentSystemTransformResult>;
}

export interface AgentMessagesTransformInput {
  messages: LanguageMessage[];
}

export interface AgentMessagesTransformResult {
  messages: LanguageMessage[];
}

export interface AgentMessagesTransformContribution {
  transformMessages(
    input: AgentMessagesTransformInput,
  ): AgentMessagesTransformResult | Promise<AgentMessagesTransformResult>;
}

export interface AgentToolBeforeInput {
  toolCall: LanguageToolCallContent;
  tool?: Tool;
  input: Record<string, unknown>;
  toolContext: ToolContext;
}

export type AgentToolBeforeResult =
  | { action?: 'allow' }
  | { action: 'rewrite'; input: string | Record<string, unknown> }
  | { action: 'deny'; reason?: string; result?: ToolResult | string }
  | { action: 'shortCircuit'; result: ToolResult | string; isError?: boolean };

export interface AgentToolBeforeContribution {
  beforeToolExecute(input: AgentToolBeforeInput): AgentToolBeforeResult | Promise<AgentToolBeforeResult>;
}

export interface AgentToolAfterInput {
  toolCall: LanguageToolCallContent;
  tool?: Tool;
  result: ToolResult;
}

export interface AgentToolAfterResult {
  result: ToolResult;
}

export interface AgentToolAfterContribution {
  afterToolExecute(input: AgentToolAfterInput): AgentToolAfterResult | Promise<AgentToolAfterResult>;
}

export interface AgentErrorRecoverInput {
  event: AgentEvent & { type: 'error' };
  error: Error;
  code?: ErrorCode;
}

export type AgentErrorRecoverResult =
  | { action: 'retry'; delayMs?: number; reason?: string }
  | { action: 'decline'; reason?: string };

export interface AgentErrorRecoverContribution {
  recoverError(input: AgentErrorRecoverInput): AgentErrorRecoverResult | Promise<AgentErrorRecoverResult>;
}

export interface AgentContextOverflowInput {
  messages: LanguageMessage[];
}

export type AgentContextOverflowResult =
  | { action: 'recover'; messages: LanguageMessage[] }
  | { action: 'decline'; reason?: string };

export interface AgentContextOverflowContribution {
  handleContextOverflow(
    input: AgentContextOverflowInput,
  ): AgentContextOverflowResult | Promise<AgentContextOverflowResult>;
}

export interface AgentEventObserverContribution {
  onAgentEvent(event: AgentEvent): void | Promise<void>;
}

export interface AgentRuntimeExtensions {
  tools: Tool[];
  systemTransforms: AgentSystemTransformContribution[];
  messagesTransforms: AgentMessagesTransformContribution[];
  toolBefores: AgentToolBeforeContribution[];
  toolAfters: AgentToolAfterContribution[];
  errorRecovers: AgentErrorRecoverContribution[];
  contextOverflows: AgentContextOverflowContribution[];
  eventObservers: AgentEventObserverContribution[];
  sessionPolicies: AgentSessionPolicyContribution[];
}

export type AgentRuntimeExtensionBucket = keyof AgentRuntimeExtensions;

export const AGENT_EXTENSION_BUCKETS = {
  [AGENT_TOOL]: 'tools',
  [AGENT_SYSTEM_TRANSFORM]: 'systemTransforms',
  [AGENT_MESSAGES_TRANSFORM]: 'messagesTransforms',
  [AGENT_TOOL_BEFORE]: 'toolBefores',
  [AGENT_TOOL_AFTER]: 'toolAfters',
  [AGENT_ERROR_RECOVER]: 'errorRecovers',
  [AGENT_CONTEXT_OVERFLOW]: 'contextOverflows',
  [AGENT_EVENT_OBSERVER]: 'eventObservers',
  [AGENT_SESSION_POLICY]: 'sessionPolicies',
} as const satisfies Record<AgentExtensionType, AgentRuntimeExtensionBucket>;

export type AgentRuntimeExtensionValue<T extends AgentExtensionType> =
  AgentRuntimeExtensions[(typeof AGENT_EXTENSION_BUCKETS)[T]][number];

export interface CortxContributionMap {
  [AGENT_TOOL]: Tool;
  [AGENT_SYSTEM_TRANSFORM]: AgentSystemTransformContribution;
  [AGENT_MESSAGES_TRANSFORM]: AgentMessagesTransformContribution;
  [AGENT_TOOL_BEFORE]: AgentToolBeforeContribution;
  [AGENT_TOOL_AFTER]: AgentToolAfterContribution;
  [AGENT_ERROR_RECOVER]: AgentErrorRecoverContribution;
  [AGENT_CONTEXT_OVERFLOW]: AgentContextOverflowContribution;
  [AGENT_EVENT_OBSERVER]: AgentEventObserverContribution;
  [AGENT_SESSION_POLICY]: AgentSessionPolicyContribution;
  [RUNTIME_TOOL_PROFILE]: never;
}

export type ProjectContributionMap = CortxContributionMap & SynaxContributionMap;

export type CortxHostScopeKind =
  | 'application'
  | 'session'
  | 'run'
  | 'foreground-child'
  | 'background-child'
  | 'tui';

export interface CortxContributionHostContext<TValue = unknown> extends ContributionHostContext<TValue> {
  readonly instanceId: string;
  readonly scopeKind: CortxHostScopeKind;
  readonly sessionId?: string;
  readonly runId?: number;
  readonly workingDirectory?: string;
  readonly logger: Logger;
  readonly storage?: PluginStorage;
  defer(disposer: EffectDisposer, label?: string): void;
  acquire<T>(
    acquire: (signal: AbortSignal) => T | Promise<T>,
    dispose: (resource: T) => void | Promise<void>,
    label?: string,
  ): Promise<T>;
}

export type CortxContributionFactory<TType extends CortxExecutableContributionType> = ContributionFactory<
  CortxContributionMap[TType],
  CortxContributionHostContext<CortxContributionMap[TType]>
>;

export type CortxContributionBinding<TType extends CortxExecutableContributionType> = ContributionBinding<
  TType,
  CortxContributionMap[TType],
  CortxContributionHostContext<CortxContributionMap[TType]>
>;

export type CortxContributionLease<TType extends CortxExecutableContributionType> = ContributionLease<
  CortxContributionMap[TType],
  CortxContributionHostContext<CortxContributionMap[TType]>
>;

export type CortxPluginContext = Omit<DeclarativePluginContext, 'bind'> & {
  bind<TType extends CortxExecutableContributionType>(binding: CortxContributionBinding<TType>): void;
};

export interface CortxPlugin extends Omit<DeclarativePlugin, 'setup' | 'teardown'> {
  setup(ctx: CortxPluginContext): void | Promise<void>;
  teardown?(ctx: CortxPluginContext): void | Promise<void>;
}

export interface CortxContributionReference {
  pluginId: string;
  contributionId: string;
  canonicalId: string;
}

export interface CortxContributionConfig {
  use: string;
  options?: JsonObject;
}

export function parseCortxContributionReference(reference: string): CortxContributionReference {
  const separator = reference.lastIndexOf('/');
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`Cortx contribution reference must be canonical: ${reference}`);
  }
  const pluginId = reference.slice(0, separator);
  const contributionId = reference.slice(separator + 1);
  if (
    pluginId !== pluginId.trim() ||
    pluginId.includes('..') ||
    pluginId.includes('\\') ||
    pluginId.includes(':') ||
    !isValidPluginId(pluginId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(contributionId)
  ) {
    throw new Error(`Cortx contribution reference must be canonical: ${reference}`);
  }
  return { pluginId, contributionId, canonicalId: reference };
}

export function isAgentExtensionType(value: string): value is AgentExtensionType {
  return (AGENT_EXTENSION_TYPES as readonly string[]).includes(value);
}

export function isProjectContributionType(value: string): value is ProjectContributionType {
  return (PROJECT_CONTRIBUTION_TYPES as readonly string[]).includes(value);
}

export function createEmptyAgentRuntimeExtensions(): AgentRuntimeExtensions {
  return {
    tools: [],
    systemTransforms: [],
    messagesTransforms: [],
    toolBefores: [],
    toolAfters: [],
    errorRecovers: [],
    contextOverflows: [],
    eventObservers: [],
    sessionPolicies: [],
  };
}

export function appendAgentRuntimeExtension<T extends AgentExtensionType>(
  extensions: AgentRuntimeExtensions,
  type: T,
  value: AgentRuntimeExtensionValue<T>,
): void {
  extensions[AGENT_EXTENSION_BUCKETS[type]].push(value as never);
}

export function mergeAgentRuntimeExtensions(
  ...sets: Array<AgentRuntimeExtensions | null | undefined>
): AgentRuntimeExtensions {
  const merged = createEmptyAgentRuntimeExtensions();
  for (const set of sets) {
    if (!set) continue;
    merged.tools.push(...set.tools);
    merged.systemTransforms.push(...set.systemTransforms);
    merged.messagesTransforms.push(...set.messagesTransforms);
    merged.toolBefores.push(...set.toolBefores);
    merged.toolAfters.push(...set.toolAfters);
    merged.errorRecovers.push(...set.errorRecovers);
    merged.contextOverflows.push(...set.contextOverflows);
    merged.eventObservers.push(...set.eventObservers);
    merged.sessionPolicies.push(...set.sessionPolicies);
  }
  return merged;
}

export function defineCortxPlugin<T extends CortxPlugin>(plugin: T): T & DeclarativePlugin {
  return plugin as T & DeclarativePlugin;
}

export function defineCortxContributionDescriptor<T extends ManifestContributionDescriptor>(descriptor: T): T {
  return descriptor;
}

export function defineContributionFactory<TType extends CortxExecutableContributionType>(
  _type: TType,
  factory: CortxContributionFactory<TType>,
): CortxContributionFactory<TType> {
  return factory;
}

export function defineContributionBinding<TType extends CortxExecutableContributionType>(
  type: TType,
  id: string,
  factory: CortxContributionFactory<TType>,
): CortxContributionBinding<TType> {
  return { type, id, factory };
}

export function defineToolFactory<T extends CortxContributionFactory<typeof AGENT_TOOL>>(factory: T): T {
  return factory;
}

export function defineSessionPolicyFactory<T extends CortxContributionFactory<typeof AGENT_SESSION_POLICY>>(factory: T): T {
  return factory;
}

export function defineEventObserverFactory<T extends CortxContributionFactory<typeof AGENT_EVENT_OBSERVER>>(factory: T): T {
  return factory;
}

export function defineSystemTransform<T extends AgentSystemTransformContribution>(contribution: T): T {
  return contribution;
}

export function defineMessagesTransform<T extends AgentMessagesTransformContribution>(contribution: T): T {
  return contribution;
}

export function defineToolBefore<T extends AgentToolBeforeContribution>(contribution: T): T {
  return contribution;
}

export function defineToolAfter<T extends AgentToolAfterContribution>(contribution: T): T {
  return contribution;
}

export function defineErrorRecover<T extends AgentErrorRecoverContribution>(contribution: T): T {
  return contribution;
}

export function defineContextOverflow<T extends AgentContextOverflowContribution>(contribution: T): T {
  return contribution;
}

export function defineEventObserver<T extends AgentEventObserverContribution>(contribution: T): T {
  return contribution;
}

export function defineSessionPolicy<T extends AgentSessionPolicyContribution>(contribution: T): T {
  return contribution;
}

export type { SynaxContributionType };
export type CortxContributionOptions = JsonObject;
