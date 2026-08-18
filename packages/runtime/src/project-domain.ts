import {
  PluginRegistry,
  createFilesystemPluginRegistry,
  normalizeContributionDescriptors,
  type JsonObject,
  type PluginRegistryConfig,
  type FilesystemPluginRegistryOptions,
  type PluginRuntimeDomain,
  type DeclarativePlugin,
  type ContributionLease,
  type ContributionDescriptor,
} from '@nerax-ai/plugin';
import {
  appendAgentRuntimeExtension,
  createEmptyAgentRuntimeExtensions,
  isAgentExtensionType,
  isProjectContributionType,
  noopLogger,
  parseCortxContributionReference,
  type AgentRuntimeExtensions,
  type CortxContributionConfig,
  type CortxContributionHostContext,
  type CortxContributionLease,
  type CortxContributionMap,
  type CortxExecutableContributionType,
  type CortxHostScopeKind,
  type Logger,
  type ProjectContributionType,
} from '@cortx/sdk';
import { CortxHostScope } from './host-scope.js';

export interface ProjectContributionDescriptorView extends ContributionDescriptor<ProjectContributionType> {
  pluginId: string;
  contributionId: string;
  canonicalId: string;
}

export interface ProjectToolProfile {
  id: string;
  pluginId: string;
  canonicalId: string;
  name?: string;
  description?: string;
  tools: Array<{ use: string; options?: JsonObject }>;
}

export interface ProjectDomainOptions {
  domain?: PluginRuntimeDomain;
  registry?: PluginRegistry;
  runtimeDomainId?: string;
  managerOptions?: PluginRegistryConfig['managerOptions'];
  authorizeConfiguration?: PluginRegistryConfig['authorizeConfiguration'];
  logger?: Logger;
}

export type FilesystemProjectDomainOptions = FilesystemPluginRegistryOptions;

export function createFilesystemProjectDomain(options: FilesystemProjectDomainOptions): ProjectDomain {
  return new ProjectDomain({
    registry: createFilesystemPluginRegistry(options),
    runtimeDomainId: options.runtimeDomainId,
    logger: options.logger,
  });
}

export interface CreateAgentExtensionsContext {
  instanceId: string;
  sessionId?: string;
  runId?: number;
  workingDirectory?: string;
}

export class ProjectDomain {
  readonly registry: PluginRegistry;
  readonly runtimeDomainId: string;
  readonly #logger: Logger;
  #started = false;
  #closed = false;
  #closeRequested = false;
  #startPromise?: Promise<void>;
  #closePromise?: Promise<void>;

  constructor(options: ProjectDomainOptions) {
    if (options.domain && options.registry) throw new Error('ProjectDomain accepts either domain or registry, not both');
    if (!options.domain && !options.registry) throw new Error('ProjectDomain requires a domain or registry');
    if (
      options.registry &&
      options.runtimeDomainId !== undefined &&
      options.runtimeDomainId !== options.registry.runtimeDomainId
    ) {
      throw new Error(
        `ProjectDomain runtimeDomainId ${options.runtimeDomainId} does not match Registry runtime domain ${options.registry.runtimeDomainId}`,
      );
    }
    this.runtimeDomainId = options.domain?.runtimeDomainId ?? options.registry!.runtimeDomainId;
    this.registry =
      options.registry ??
      new PluginRegistry({
        domain: options.domain!,
        managerOptions: options.managerOptions,
        authorizeConfiguration: options.authorizeConfiguration,
      });
    this.#logger = options.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    if (this.#closed || this.#closeRequested) throw new Error('ProjectDomain is closed');
    if (this.#started) return;
    if (!this.#startPromise) {
      const start = this.registry.start().then(() => {
        this.#started = true;
      });
      this.#startPromise = start;
      void start.finally(() => {
        if (this.#startPromise === start) this.#startPromise = undefined;
      }).catch(() => undefined);
    }
    await this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closeRequested = true;
    if (this.#closePromise) return this.#closePromise;
    const close = (async () => {
      try {
        await this.#startPromise;
      } catch {
        // A failed start has no active writer to close.
      }
      if (this.#started) {
        await this.registry.close();
        this.#started = false;
      }
      this.#closed = true;
    })();
    this.#closePromise = close;
    void close.finally(() => {
      if (this.#closePromise === close) this.#closePromise = undefined;
    }).catch(() => undefined);
    return close;
  }

  parseReference(reference: string) {
    return parseCortxContributionReference(reference);
  }

  async register(plugin: DeclarativePlugin, options: { enabled?: boolean; configuration?: JsonObject } = {}): Promise<void> {
    await this.start();
    const mutation = await this.registry.register(plugin, { enabled: options.enabled ?? true, configuration: options.configuration });
    if (!mutation.accepted) throw new Error(`Project plugin desired revision conflict: ${mutation.currentRevision}`);
    const result = await mutation.operation.wait();
    if (result.status !== 'succeeded') {
      throw new Error(result.diagnostic?.message ?? `Project plugin settled as ${result.status}`);
    }
  }

  async install(source: string, options: { enabled?: boolean; configuration?: JsonObject; signal?: AbortSignal } = {}) {
    await this.start();
    const mutation = await this.registry.install(source, options);
    if (!mutation.accepted) throw new Error(`Project plugin desired revision conflict: ${mutation.currentRevision}`);
    const result = await mutation.operation.wait();
    if (result.status !== 'succeeded') {
      throw new Error(result.diagnostic?.message ?? `Project plugin settled as ${result.status}`);
    }
    return result;
  }

  async listContributionDescriptors(type?: ProjectContributionType): Promise<ProjectContributionDescriptorView[]> {
    const result: ProjectContributionDescriptorView[] = [];
    for (const entry of await this.registry.listCatalog()) {
      const normalized = normalizeContributionDescriptors(entry.manifest.contributes ?? {});
      if (!normalized.ok || !normalized.descriptors) continue;
      for (const descriptor of normalized.descriptors) {
        if (!isProjectContributionType(descriptor.type) || (type && descriptor.type !== type)) continue;
        const contributionType: ProjectContributionType = descriptor.type;
        result.push({
          ...descriptor,
          type: contributionType,
          pluginId: entry.id,
          contributionId: descriptor.id,
          canonicalId: `${entry.id}/${descriptor.id}`,
        });
      }
    }
    return result.sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
  }

  async listToolProfiles(): Promise<ProjectToolProfile[]> {
    const descriptors = await this.listContributionDescriptors('runtime.toolProfile');
    return descriptors.map((descriptor) => {
      if (descriptor.executable) throw new Error(`runtime.toolProfile must be metadata-only: ${descriptor.canonicalId}`);
      const source = descriptor.metadata ?? descriptor.defaultOptions ?? {};
      const rawTools = source.tools;
      if (!Array.isArray(rawTools)) throw new Error(`runtime.toolProfile must declare tools: ${descriptor.canonicalId}`);
      return {
        id: descriptor.id,
        pluginId: descriptor.pluginId,
        canonicalId: descriptor.canonicalId,
        name: descriptor.displayName,
        description: descriptor.description,
        tools: rawTools.map((value, index) => parseProfileTool(value, `${descriptor.canonicalId}.tools[${index}]`)),
      };
    });
  }

  async resolveContribution<TType extends CortxExecutableContributionType>(
    type: TType,
    reference: string,
  ): Promise<CortxContributionLease<TType>> {
    const parsed = this.parseReference(reference);
    const lease = (await this.registry.resolveContribution(
      parsed.pluginId,
      type,
      parsed.contributionId,
    )) as ContributionLease<
      CortxContributionMap[TType],
      CortxContributionHostContext<CortxContributionMap[TType]>
    >;
    if (lease.descriptor.type !== type || lease.canonicalId !== parsed.canonicalId) {
      throw new Error(`Cortx contribution type mismatch: ${parsed.canonicalId}`);
    }
    return lease;
  }

  async createAgentExtensions(
    contributions: readonly CortxContributionConfig[],
    scope: CortxHostScope,
    context: CreateAgentExtensionsContext,
  ): Promise<AgentRuntimeExtensions> {
    const extensions = createEmptyAgentRuntimeExtensions();
    const descriptors = await this.listContributionDescriptors();
    for (const contribution of contributions) {
      const parsed = this.parseReference(contribution.use);
      const descriptor = descriptors.find((item) => item.canonicalId === parsed.canonicalId);
      if (!descriptor || !isAgentExtensionType(descriptor.type) || !descriptor.executable) {
        throw new Error(`Cortx executable contribution not found: ${parsed.canonicalId}`);
      }
      const type = descriptor.type;
      const lease = await this.resolveContribution(type, contribution.use);
      const hostContext = this.#hostContext(scope, context);
      const value = await lease.invoke(contribution.options ?? {}, hostContext as never);
      appendAgentRuntimeExtension(extensions, type, value as never);
    }
    return extensions;
  }

  #hostContext<T>(
    scope: CortxHostScope,
    context: CreateAgentExtensionsContext,
  ): CortxContributionHostContext<T> {
    return {
      instanceId: context.instanceId,
      scopeKind: scope.kind,
      sessionId: context.sessionId,
      runId: context.runId,
      workingDirectory: context.workingDirectory,
      signal: scope.signal,
      logger: this.#logger.scope(`${scope.kind}:${context.instanceId}`),
      abort: (reason) => scope.abort(reason),
      dispose: (_value, reason) => scope.close(reason),
      defer: (disposer, label) => scope.defer(disposer, label),
      acquire: (acquire, dispose, label) => scope.acquire(acquire, dispose, label),
    };
  }
}

function parseProfileTool(value: unknown, label: string): { use: string; options?: JsonObject } {
  if (typeof value === 'string') return { use: parseCortxContributionReference(value).canonicalId };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be canonical tool reference`);
  const record = value as Record<string, unknown>;
  if (typeof record.use !== 'string') throw new Error(`${label}.use must be canonical tool reference`);
  const use = parseCortxContributionReference(record.use).canonicalId;
  if (record.options !== undefined && (!record.options || typeof record.options !== 'object' || Array.isArray(record.options))) {
    throw new Error(`${label}.options must be an object`);
  }
  return { use, options: record.options as JsonObject | undefined };
}
