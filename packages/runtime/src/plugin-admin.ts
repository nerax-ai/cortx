import {
  ManagerAuthorizationError,
  normalizeContributionDescriptors,
  type EventSubscription,
  type ManagerEvent,
  type ManagerMutationResult,
  type ManagerOperationResult,
  type ManagerSnapshot,
} from '@nerax-ai/plugin';
import { isProjectContributionType } from '@cortx/sdk';
import {
  decodePluginAdminAction,
  normalizePluginAdminError,
  pluginAdminResultAction,
  pluginAdminDiagnostic,
  redactSecrets,
  withPluginAdminObservationTimeout,
  type PluginAdminAction,
  type PluginAdminCatalogEntry,
  type PluginAdminContext,
  type PluginAdminDescriptor,
  type PluginAdminEventDelivery,
  type PluginAdminGrant,
  type PluginAdminLock,
  type PluginAdminOperation,
  type PluginAdminPayload,
  type PluginAdminResult,
  type PluginAdminService,
  type PluginAdminSnapshot,
  type PluginAdminSourceInspection,
  type PluginAdminSubscription,
} from '@synax-ai/sdk';
import type { ProjectDomain } from './project-domain.js';

export interface CortxPluginAdminServiceOptions {
  projectDomain: ProjectDomain;
  authorize?: (context: PluginAdminContext, grant: PluginAdminGrant) => boolean | Promise<boolean>;
  limits?: Partial<PluginAdminSubscriptionLimits>;
}

export interface PluginAdminSubscriptionLimits {
  global: number;
  perPrincipal: number;
  creationsPerMinute: number;
  idleTimeoutMs: number;
  maximumLifetimeMs: number;
  snapshotBytes: number;
}

const defaultLimits: PluginAdminSubscriptionLimits = {
  global: 64,
  perPrincipal: 4,
  creationsPerMinute: 20,
  idleTimeoutMs: 30_000,
  maximumLifetimeMs: 60 * 60_000,
  snapshotBytes: 1024 * 1024,
};

export class CortxPluginAdminService implements PluginAdminService {
  readonly #projectDomain: ProjectDomain;
  readonly #authorize: NonNullable<CortxPluginAdminServiceOptions['authorize']>;
  readonly #limits: PluginAdminSubscriptionLimits;
  readonly #subscriptions = new Map<string, number>();
  readonly #creationTimes = new Map<string, number[]>();
  readonly #activeClosers = new Set<() => Promise<void>>();
  #subscriptionCount = 0;
  #closed = false;

  constructor(options: CortxPluginAdminServiceOptions) {
    this.#projectDomain = options.projectDomain;
    this.#authorize = options.authorize ?? ((context, grant) => context.grants.includes(grant));
    this.#limits = { ...defaultLimits, ...options.limits };
    validateLimits(this.#limits);
  }

  async execute(action: PluginAdminAction, context: PluginAdminContext): Promise<PluginAdminResult> {
    try {
      if (this.#closed)
        throw Object.assign(new Error('Plugin administration service is closed'), { code: 'not_found' });
      const actionName = pluginAdminResultAction(action);
      if (actionName !== 'unknown' && actionName !== 'subscription.open') {
        await this.#require(context, requiredGrant(actionName));
      }
      const input = decodePluginAdminAction(action);
      const data = await this.#executeAuthorized(input, context);
      return structuredClone({ ok: true, action: input.type, data });
    } catch (error) {
      return {
        ok: false,
        action: pluginAdminResultAction(action),
        error: normalizePluginAdminError(error),
      };
    }
  }

  async subscribe(
    input: { afterCursor?: number; capacity?: number },
    context: PluginAdminContext,
  ): Promise<PluginAdminSubscription> {
    if (this.#closed) throw new Error('Plugin administration service is closed');
    await this.#require(context, 'plugins.observe');
    this.#reserveSubscription(context.principalId);
    let source: EventSubscription<ManagerEvent>;
    try {
      source = await this.#projectDomain.registry.subscribe({ ...input, context });
    } catch (error) {
      this.#releaseSubscription(context.principalId);
      throw error;
    }
    return this.#wrapSubscription(source, context);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const results = await Promise.allSettled([...this.#activeClosers].map((close) => close()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Plugin administration close failed',
      );
    }
  }

  async #executeAuthorized(action: PluginAdminAction, context: PluginAdminContext): Promise<PluginAdminPayload> {
    const registry = this.#projectDomain.registry;
    switch (action.type) {
      case 'plugin.install':
        return this.#mutation(
          await registry.install(action.source, {
            enabled: action.enabled,
            configuration: action.configuration,
            expectedRevision: action.expectedRevision,
            context,
          }),
        );
      case 'plugin.enable':
        return this.#mutation(
          await registry.enable(action.pluginId, { expectedRevision: action.expectedRevision, context }),
        );
      case 'plugin.disable':
        return this.#mutation(
          await registry.disable(action.pluginId, { expectedRevision: action.expectedRevision, context }),
        );
      case 'plugin.configure':
        return this.#mutation(
          await registry.configure(action.pluginId, action.configuration, {
            expectedRevision: action.expectedRevision,
            context,
          }),
        );
      case 'plugin.refresh':
        return this.#mutation(
          await registry.refresh(action.pluginId, { expectedRevision: action.expectedRevision, context }),
        );
      case 'plugin.retry':
        return this.#mutation(
          await registry.retry(action.pluginId, { expectedRevision: action.expectedRevision, context }),
        );
      case 'plugin.uninstall':
        return this.#mutation(
          await registry.uninstall(action.pluginId, { expectedRevision: action.expectedRevision, context }),
        );
      case 'lock.apply': {
        const result = await registry.applyLock(action.lock as unknown as Parameters<typeof registry.applyLock>[0], {
          expectedRevision: action.expectedRevision,
          context,
        });
        return result.accepted
          ? { applied: true, desiredRevision: result.revision, operationId: result.operationId }
          : { applied: false };
      }
      case 'snapshot.get':
        return this.#boundedSnapshot(await registry.snapshot(context));
      case 'operation.query':
        return operationDto(await registry.queryOperation(action.operationId, context));
      case 'operation.wait':
        return operationDto(
          await withPluginAdminObservationTimeout(
            registry.waitOperation(action.operationId, context),
            action.timeoutMs,
          ),
        );
      case 'operation.cancel': {
        const snapshot = await registry.snapshot(context);
        return {
          cancelled: await registry.cancelOperation(action.operationId, context),
          managerEpoch: snapshot.managerEpoch,
        };
      }
      case 'catalog.list':
        return this.#catalog(context);
      case 'descriptor.list':
        return this.#descriptors(context, action.contributionType);
      case 'source.inspect':
        return this.#inspect(action.source, context);
      case 'lock.export':
        return sanitizeLock(await registry.exportLock(context));
    }
  }

  #mutation(result: ManagerMutationResult) {
    if (!result.accepted) {
      return {
        accepted: false as const,
        currentRevision: result.currentRevision,
        conflict: this.#boundedSnapshot(result.snapshot),
      };
    }
    return {
      accepted: true as const,
      desiredRevision: result.desiredRevision,
      managerEpoch: result.operation.managerEpoch,
      operationId: result.operation.id,
      targetGenerations: { ...result.targetGenerations },
    };
  }

  async #catalog(context: PluginAdminContext): Promise<PluginAdminCatalogEntry[]> {
    const registry = this.#projectDomain.registry;
    const [catalog, snapshot] = await Promise.all([registry.listCatalog(context), registry.snapshot(context)]);
    return catalog.map((entry) => {
      const state = snapshot.plugins[entry.id]?.state ?? 'not_installed';
      return {
        id: entry.id,
        name: entry.manifest.name,
        version: entry.version,
        state,
        enabled: state !== 'installed' && state !== 'absent',
      };
    });
  }

  async #descriptors(context: PluginAdminContext, type?: string): Promise<PluginAdminDescriptor[]> {
    if (type !== undefined && !isProjectContributionType(type)) {
      throw invalidRequest(`Unsupported Cortx project contribution type: ${type}`);
    }
    const registry = this.#projectDomain.registry;
    const [catalog, snapshot] = await Promise.all([registry.listCatalog(context), registry.snapshot(context)]);
    const result: PluginAdminDescriptor[] = [];
    for (const entry of catalog) {
      const normalized = normalizeContributionDescriptors(entry.manifest.contributes ?? {});
      if (!normalized.ok || !normalized.descriptors) continue;
      for (const descriptor of normalized.descriptors) {
        if (!isProjectContributionType(descriptor.type) || (type && descriptor.type !== type)) continue;
        const plugin = snapshot.plugins[entry.id];
        const projected = {
          pluginId: entry.id,
          contributionId: descriptor.id,
          canonicalId: `${entry.id}/${descriptor.id}`,
          type: descriptor.type,
          executable: descriptor.executable === true,
          displayName: descriptor.displayName,
          description: descriptor.description,
          schema: descriptor.schema,
          defaultOptions: descriptor.defaultOptions,
          metadata: descriptor.metadata,
          pluginState: plugin?.state ?? 'not_installed',
          resolvable:
            descriptor.executable === true &&
            plugin?.state === 'active' &&
            Boolean(plugin.contributions?.some((item) => item.type === descriptor.type && item.id === descriptor.id)),
        };
        result.push(projected);
      }
    }
    return result.sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
  }

  async #inspect(source: string, context: PluginAdminContext): Promise<PluginAdminSourceInspection> {
    const inspected = (await this.#projectDomain.registry.inspectSource(source, context)) as {
      id: string;
      version: string;
      manifest: import('@nerax-ai/plugin').PluginManifest;
    };
    const normalized = normalizeContributionDescriptors(inspected.manifest.contributes ?? {});
    const descriptors: PluginAdminDescriptor[] = (normalized.descriptors ?? [])
      .filter((descriptor) => isProjectContributionType(descriptor.type))
      .map((descriptor) => {
        const projected = {
          pluginId: inspected.id,
          contributionId: descriptor.id,
          canonicalId: `${inspected.id}/${descriptor.id}`,
          type: descriptor.type,
          executable: descriptor.executable === true,
          displayName: descriptor.displayName,
          description: descriptor.description,
          schema: descriptor.schema,
          defaultOptions: descriptor.defaultOptions,
          metadata: descriptor.metadata,
          pluginState: 'not_installed' as const,
          resolvable: false,
        };
        return projected;
      });
    return { id: inspected.id, name: inspected.manifest.name, version: inspected.version, descriptors };
  }

  #boundedSnapshot(snapshot: ManagerSnapshot): PluginAdminSnapshot {
    const projected = snapshotDto(snapshot);
    if (Buffer.byteLength(JSON.stringify(projected)) > this.#limits.snapshotBytes) {
      throw Object.assign(new Error('Plugin administration snapshot exceeds configured size limit'), {
        code: 'subscription_limit',
      });
    }
    return projected;
  }

  async #require(context: PluginAdminContext, grant: PluginAdminGrant): Promise<void> {
    if (!context?.principalId || !Array.isArray(context.grants) || !(await this.#authorize(context, grant))) {
      throw new ManagerAuthorizationError(grant);
    }
  }

  #reserveSubscription(principalId: string): void {
    const now = Date.now();
    const recent = (this.#creationTimes.get(principalId) ?? []).filter((value) => now - value < 60_000);
    if (
      this.#subscriptionCount >= this.#limits.global ||
      (this.#subscriptions.get(principalId) ?? 0) >= this.#limits.perPrincipal ||
      recent.length >= this.#limits.creationsPerMinute
    ) {
      throw Object.assign(new Error('Plugin subscription capacity is exhausted'), { code: 'subscription_limit' });
    }
    recent.push(now);
    this.#creationTimes.set(principalId, recent);
    this.#subscriptionCount++;
    this.#subscriptions.set(principalId, (this.#subscriptions.get(principalId) ?? 0) + 1);
  }

  #releaseSubscription(principalId: string): void {
    this.#subscriptionCount = Math.max(0, this.#subscriptionCount - 1);
    const count = Math.max(0, (this.#subscriptions.get(principalId) ?? 1) - 1);
    if (count === 0) this.#subscriptions.delete(principalId);
    else this.#subscriptions.set(principalId, count);
  }

  #wrapSubscription(source: EventSubscription<ManagerEvent>, context: PluginAdminContext): PluginAdminSubscription {
    const principalId = context.principalId;
    const startedAt = Date.now();
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      this.#activeClosers.delete(close);
      this.#releaseSubscription(principalId);
      await source.return();
    };
    const scheduleIdleClose = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void close().catch(() => undefined), this.#limits.idleTimeoutMs);
    };
    lifetimeTimer = setTimeout(() => void close().catch(() => undefined), this.#limits.maximumLifetimeMs);
    scheduleIdleClose();
    this.#activeClosers.add(close);
    const iterator: PluginAdminSubscription = {
      next: async () => {
        if (closed) return { done: true, value: undefined };
        if (Date.now() - startedAt >= this.#limits.maximumLifetimeMs) {
          await close();
          return { done: true, value: undefined };
        }
        try {
          await this.#require(context, 'plugins.observe');
          const delivery = await source
            .next()
            .then((result): IteratorResult<PluginAdminEventDelivery> =>
              result.done ? { done: true, value: undefined } : { done: false, value: eventDeliveryDto(result.value) },
            );
          if (delivery.done) {
            await close();
            return { done: true, value: undefined };
          }
          await this.#require(context, 'plugins.observe');
          scheduleIdleClose();
          return { done: false, value: delivery.value };
        } catch (error) {
          await close().catch(() => undefined);
          throw error;
        }
      },
      return: async () => {
        await close();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }
}

function requiredGrant(action: PluginAdminAction['type']): PluginAdminGrant {
  if (action === 'source.inspect' || action === 'catalog.list' || action === 'descriptor.list') {
    return 'plugins.inspect';
  }
  if (action === 'snapshot.get' || action === 'operation.query' || action === 'operation.wait') {
    return 'plugins.observe';
  }
  return 'plugins.manage';
}

function snapshotDto(snapshot: ManagerSnapshot): PluginAdminSnapshot {
  return {
    managerEpoch: snapshot.managerEpoch,
    desiredRevision: snapshot.desiredRevision,
    watermark: snapshot.watermark,
    plugins: Object.fromEntries(
      Object.entries(snapshot.plugins).map(([id, plugin]) => [
        id,
        {
          id: plugin.id,
          state: plugin.state,
          version: plugin.version,
          desiredRevision: plugin.desiredRevision,
          generation: plugin.generation,
          degraded: plugin.degraded,
          contributions: plugin.contributions?.map((item) => ({ ...item })),
          diagnostic: pluginAdminDiagnostic(plugin.diagnostic),
        },
      ]),
    ),
    operations: snapshot.operations
      ? Object.fromEntries(Object.entries(snapshot.operations).map(([id, operation]) => [id, operationDto(operation)]))
      : undefined,
  };
}

function operationDto(operation: ManagerOperationResult): PluginAdminOperation {
  return {
    id: operation.id,
    managerEpoch: operation.managerEpoch,
    affectedPluginIds: [...operation.affectedPluginIds],
    status: operation.status,
    desiredRevision: operation.desiredRevision,
    targetGenerations: { ...operation.targetGenerations },
    diagnostic: pluginAdminDiagnostic(operation.diagnostic),
  };
}

function eventDeliveryDto(delivery: import('@nerax-ai/plugin').EventDelivery<ManagerEvent>): PluginAdminEventDelivery {
  if (delivery.type === 'gap') return { ...delivery };
  return {
    type: 'event',
    cursor: delivery.cursor,
    value: {
      ...delivery.value,
      affectedPluginIds: [...delivery.value.affectedPluginIds],
      diagnostic: pluginAdminDiagnostic(delivery.value.diagnostic),
    },
  };
}

function sanitizeLock(lock: unknown): PluginAdminLock {
  return redactSecrets(structuredClone(lock)) as unknown as PluginAdminLock;
}

function validateLimits(limits: PluginAdminSubscriptionLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
}

function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}
