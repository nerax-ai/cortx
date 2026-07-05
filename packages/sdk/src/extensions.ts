import type { Logger } from '@nerax-ai/logger';
import type { ExtensionOptions, InlinePlugin, PluginContext, PluginStorage } from '@nerax-ai/plugin';
import type { LanguageMessage, LanguageToolCallContent } from '@synax-ai/sdk';
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
export const CORTX_EXTENSION_SCHEMA_VERSION = 1;

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

export const CORTX_EXTENSION_TYPES = [...AGENT_EXTENSION_TYPES] as const;

export type AgentExtensionType = (typeof AGENT_EXTENSION_TYPES)[number];
export type CortxExtensionType = (typeof CORTX_EXTENSION_TYPES)[number];
export type CortxExtensionSchemaVersion = 0 | typeof CORTX_EXTENSION_SCHEMA_VERSION;

export interface CortxFactoryContext {
  instanceId: string;
  options: Record<string, unknown>;
  logger: Logger;
  storage: PluginStorage;
}

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

export interface CortxFactoryMap {
  [AGENT_TOOL]: (ctx: CortxFactoryContext) => Tool | Promise<Tool>;
  [AGENT_SYSTEM_TRANSFORM]: (
    ctx: CortxFactoryContext,
  ) => AgentSystemTransformContribution | Promise<AgentSystemTransformContribution>;
  [AGENT_MESSAGES_TRANSFORM]: (
    ctx: CortxFactoryContext,
  ) => AgentMessagesTransformContribution | Promise<AgentMessagesTransformContribution>;
  [AGENT_TOOL_BEFORE]: (ctx: CortxFactoryContext) => AgentToolBeforeContribution | Promise<AgentToolBeforeContribution>;
  [AGENT_TOOL_AFTER]: (ctx: CortxFactoryContext) => AgentToolAfterContribution | Promise<AgentToolAfterContribution>;
  [AGENT_ERROR_RECOVER]: (
    ctx: CortxFactoryContext,
  ) => AgentErrorRecoverContribution | Promise<AgentErrorRecoverContribution>;
  [AGENT_CONTEXT_OVERFLOW]: (
    ctx: CortxFactoryContext,
  ) => AgentContextOverflowContribution | Promise<AgentContextOverflowContribution>;
  [AGENT_EVENT_OBSERVER]: (
    ctx: CortxFactoryContext,
  ) => AgentEventObserverContribution | Promise<AgentEventObserverContribution>;
  [AGENT_SESSION_POLICY]: (
    ctx: CortxFactoryContext,
  ) => AgentSessionPolicyContribution | Promise<AgentSessionPolicyContribution>;
}

export function defineCortxPlugin<T extends InlinePlugin<CortxExtensionType, CortxFactoryMap>>(plugin: T): T {
  return plugin;
}

export type CortxContributionFactory<T extends CortxExtensionType> = CortxFactoryMap[T];

export function defineContributionFactory<T extends CortxExtensionType>(
  _type: T,
  factory: CortxContributionFactory<T>,
): CortxContributionFactory<T> {
  return factory;
}

export interface CortxCapabilityContribution<T extends CortxExtensionType> {
  schemaVersion?: CortxExtensionSchemaVersion;
  type: T;
  id: string;
  factory: CortxContributionFactory<T>;
  options?: ExtensionOptions;
}

export type AnyCortxCapabilityContribution = {
  [T in CortxExtensionType]: CortxCapabilityContribution<T>;
}[CortxExtensionType];

export type NormalizedCortxCapabilityContribution<T extends CortxExtensionType> = Omit<
  CortxCapabilityContribution<T>,
  'schemaVersion'
> & {
  schemaVersion: typeof CORTX_EXTENSION_SCHEMA_VERSION;
};

export type AnyNormalizedCortxCapabilityContribution = {
  [T in CortxExtensionType]: NormalizedCortxCapabilityContribution<T>;
}[CortxExtensionType];

type NormalizeCapabilityContributions<TContributions extends readonly AnyCortxCapabilityContribution[]> = {
  readonly [K in keyof TContributions]: TContributions[K] extends CortxCapabilityContribution<infer T>
    ? NormalizedCortxCapabilityContribution<T>
    : never;
};

export interface RuntimeCapabilityDefinition<
  TContributions extends readonly AnyCortxCapabilityContribution[] = readonly AnyCortxCapabilityContribution[],
> {
  schemaVersion?: CortxExtensionSchemaVersion;
  id: string;
  displayName?: string;
  description?: string;
  contributions: TContributions;
  metadata?: Record<string, unknown>;
}

export type NormalizedRuntimeCapabilityDefinition<
  TContributions extends readonly AnyCortxCapabilityContribution[] = readonly AnyCortxCapabilityContribution[],
> = Omit<RuntimeCapabilityDefinition<TContributions>, 'schemaVersion' | 'contributions'> & {
  schemaVersion: typeof CORTX_EXTENSION_SCHEMA_VERSION;
  contributions: NormalizeCapabilityContributions<TContributions>;
};

export type CortxPluginContext = PluginContext<CortxExtensionType, CortxFactoryMap>;

export function defineCapabilityContribution<TContribution extends AnyCortxCapabilityContribution>(
  contribution: TContribution,
): TContribution extends CortxCapabilityContribution<infer T> ? NormalizedCortxCapabilityContribution<T> : never;
export function defineCapabilityContribution<T extends CortxExtensionType>(
  type: T,
  id: string,
  factory: CortxContributionFactory<T>,
  options?: ExtensionOptions,
): NormalizedCortxCapabilityContribution<T>;
export function defineCapabilityContribution(
  typeOrContribution: CortxExtensionType | AnyCortxCapabilityContribution,
  id?: string,
  factory?: CortxContributionFactory<CortxExtensionType>,
  options?: ExtensionOptions,
): AnyNormalizedCortxCapabilityContribution {
  if (isCapabilityContribution(typeOrContribution)) {
    return normalizeCortxCapabilityContribution(typeOrContribution) as AnyNormalizedCortxCapabilityContribution;
  }
  if (id === undefined || factory === undefined) {
    throw new Error('Cortx capability contribution requires type, id, and factory');
  }
  return normalizeCortxCapabilityContribution(
    options === undefined
      ? { type: typeOrContribution, id, factory }
      : { type: typeOrContribution, id, factory, options },
  ) as AnyNormalizedCortxCapabilityContribution;
}

export function defineRuntimeCapability<const TContributions extends readonly AnyCortxCapabilityContribution[]>(
  definition: RuntimeCapabilityDefinition<TContributions>,
): NormalizedRuntimeCapabilityDefinition<TContributions> {
  return normalizeRuntimeCapabilityDefinition(definition);
}

export function registerRuntimeCapability(
  ctx: CortxPluginContext,
  capability: RuntimeCapabilityDefinition,
): void {
  for (const contribution of normalizeRuntimeCapabilityDefinition(capability).contributions) {
    registerCapabilityContribution(ctx, contribution);
  }
}

export function normalizeRuntimeCapabilityDefinition<
  const TContributions extends readonly AnyCortxCapabilityContribution[],
>(definition: RuntimeCapabilityDefinition<TContributions>): NormalizedRuntimeCapabilityDefinition<TContributions> {
  assertSupportedSchemaVersion(definition.schemaVersion, 'RuntimeCapability');
  return {
    ...definition,
    schemaVersion: CORTX_EXTENSION_SCHEMA_VERSION,
    contributions: definition.contributions.map((contribution) =>
      normalizeCortxCapabilityContribution(contribution),
    ) as NormalizeCapabilityContributions<TContributions>,
  };
}

export function normalizeCortxCapabilityContribution<T extends CortxExtensionType>(
  contribution: CortxCapabilityContribution<T>,
): NormalizedCortxCapabilityContribution<T> {
  assertSupportedSchemaVersion(contribution.schemaVersion, 'CortxCapabilityContribution');
  return {
    ...contribution,
    schemaVersion: CORTX_EXTENSION_SCHEMA_VERSION,
  };
}

function registerCapabilityContribution<T extends CortxExtensionType>(
  ctx: CortxPluginContext,
  contribution: NormalizedCortxCapabilityContribution<T>,
): void {
  ctx.register(contribution.type, contribution.id, contribution.factory, contribution.options);
}

function assertSupportedSchemaVersion(value: unknown, label: string): void {
  if (value === undefined || value === 0 || value === CORTX_EXTENSION_SCHEMA_VERSION) return;
  throw new Error(`${label}.schemaVersion must be ${CORTX_EXTENSION_SCHEMA_VERSION}`);
}

function isCapabilityContribution(
  value: CortxExtensionType | AnyCortxCapabilityContribution,
): value is AnyCortxCapabilityContribution {
  return typeof value === 'object' && value !== null;
}

export function defineToolFactory<T extends CortxFactoryMap[typeof AGENT_TOOL]>(factory: T): T {
  return factory;
}

export function defineSessionPolicyFactory<T extends CortxFactoryMap[typeof AGENT_SESSION_POLICY]>(factory: T): T {
  return factory;
}

export function defineEventObserverFactory<T extends CortxFactoryMap[typeof AGENT_EVENT_OBSERVER]>(factory: T): T {
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
