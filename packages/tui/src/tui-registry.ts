import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger, type Logger } from '@nerax-ai/logger';
import {
  MemoryPluginSecretsBackend,
  PluginRegistry,
  createMemoryPluginRuntimeDomain,
  normalizeContributionDescriptors,
  type ContributionLease,
  type DeclarativePlugin,
} from '@nerax-ai/plugin';
import { CortxHostScope } from '@cortx/runtime';
import {
  TUI_COMMAND,
  TUI_RENDERER,
  isTuiContributionType,
  type CommandContext,
  type CommandDef,
  type RendererDef,
  type TuiContributionHostContext,
  type TuiContributionMap,
  type TuiContributionType,
} from './types/tui-plugin.js';

export interface TuiRegistryOptions {
  logger?: Logger;
  runtimeDomainId?: string;
  root?: string;
}

type TuiLease<TType extends TuiContributionType> = ContributionLease<
  TuiContributionMap[TType],
  TuiContributionHostContext<TuiContributionMap[TType]>
>;

interface TuiSnapshot {
  scope: CortxHostScope;
  commands: CommandDef[];
  renderers: RendererDef[];
}

export class TuiRegistry {
  readonly runtimeDomainId: string;
  readonly #registry: PluginRegistry;
  readonly #logger: Logger;
  readonly #ownedRoot?: string;
  readonly #hostScope: CortxHostScope;
  readonly #errors: Array<{ source: string; error: Error; timestamp: number }> = [];
  #snapshot: TuiSnapshot;
  #started = false;
  #closed = false;
  #closeResult?: Promise<void>;

  constructor(options: TuiRegistryOptions = {}) {
    this.runtimeDomainId = options.runtimeDomainId ?? `cortx-tui:${crypto.randomUUID()}`;
    this.#logger = options.logger ?? noopLogger;
    this.#ownedRoot = options.root ? undefined : mkdtempSync(join(tmpdir(), 'cortx-tui-plugin-domain-'));
    const root = options.root ?? this.#ownedRoot!;
    this.#registry = new PluginRegistry({
      domain: createMemoryPluginRuntimeDomain({
        runtimeDomainId: this.runtimeDomainId,
        root,
        secretsBackend: new MemoryPluginSecretsBackend(`memory:${this.runtimeDomainId}`),
        logger: this.#logger.scope('plugins'),
      }),
    });
    this.#hostScope = new CortxHostScope(`tui-host:${this.runtimeDomainId}`, 'tui');
    this.#snapshot = {
      scope: this.#hostScope.child('empty-snapshot', 'tui'),
      commands: [],
      renderers: [],
    };
  }

  async start(): Promise<void> {
    this.#assertOpen();
    if (this.#started) return;
    await this.#registry.start();
    this.#started = true;
  }

  async registerPlugin(plugin: DeclarativePlugin): Promise<void> {
    this.#assertSupportedPlugin(plugin);
    await this.start();
    const mutation = await this.#registry.register(plugin, { enabled: true });
    if (!mutation.accepted) throw new Error(`TUI plugin desired revision conflict: ${mutation.currentRevision}`);
    const operation = await mutation.operation.wait();
    if (operation.status !== 'succeeded') {
      throw new Error(operation.diagnostic?.message ?? `TUI plugin settled as ${operation.status}`);
    }
    await this.#refreshSnapshot();
  }

  getCommands(): CommandDef[] {
    return this.#snapshot.commands;
  }

  getRenderers(eventType?: string): RendererDef[] {
    return eventType
      ? this.#snapshot.renderers.filter((renderer) => renderer.eventType === eventType)
      : this.#snapshot.renderers;
  }

  async executeCommand(name: string, args: string, cmdCtx: CommandContext): Promise<boolean> {
    const command = this.#snapshot.commands.find((candidate) => candidate.name === name);
    if (!command) return false;
    try {
      await command.handler(args, cmdCtx);
    } catch (error) {
      this.#logError(`executeCommand(${name})`, error);
    }
    return true;
  }

  getErrors(): ReadonlyArray<{ source: string; error: Error; timestamp: number }> {
    return this.#errors;
  }

  close(): Promise<void> {
    if (this.#closeResult) return this.#closeResult;
    this.#closed = true;
    this.#closeResult = this.#closeOwners();
    return this.#closeResult;
  }

  async #refreshSnapshot(): Promise<void> {
    const candidateScope = this.#hostScope.child(`snapshot:${crypto.randomUUID()}`, 'tui');
    const candidate: TuiSnapshot = { scope: candidateScope, commands: [], renderers: [] };
    try {
      for (const entry of await this.#registry.listCatalog()) {
        const normalized = normalizeContributionDescriptors(entry.manifest.contributes ?? {});
        if (!normalized.ok || !normalized.descriptors) {
          throw new Error(`Invalid TUI contribution descriptors: ${entry.id}`);
        }
        for (const descriptor of normalized.descriptors) {
          if (!isTuiContributionType(descriptor.type) || !descriptor.executable) continue;
          const value = await this.#invoke(entry.id, descriptor.type, descriptor.id, candidateScope);
          if (descriptor.type === TUI_COMMAND) candidate.commands.push(value as CommandDef);
          if (descriptor.type === TUI_RENDERER) candidate.renderers.push(value as RendererDef);
        }
      }
    } catch (error) {
      await candidateScope.close(error).catch((cleanupError) => this.#logError('candidate-cleanup', cleanupError));
      throw error;
    }

    candidate.commands.sort((left, right) => left.name.localeCompare(right.name));
    candidate.renderers.sort((left, right) => left.eventType.localeCompare(right.eventType));
    const previous = this.#snapshot;
    this.#snapshot = candidate;
    try {
      await previous.scope.close(new Error('TUI contribution snapshot replaced'));
    } catch (error) {
      this.#logError('snapshot-cleanup', error);
    }
  }

  async #invoke<TType extends TuiContributionType>(
    pluginId: string,
    type: TType,
    contributionId: string,
    scope: CortxHostScope,
  ): Promise<TuiContributionMap[TType]> {
    const lease = await this.#registry.resolveContribution(pluginId, type, contributionId) as TuiLease<TType>;
    return lease.invoke({}, {
      instanceId: `${this.runtimeDomainId}:${lease.canonicalId}`,
      signal: scope.signal,
      logger: this.#logger.scope(lease.canonicalId),
      abort: (reason) => scope.abort(reason),
      dispose: (_value, reason) => scope.close(reason),
      defer: (disposer, label) => scope.defer(disposer, label),
      acquire: (acquire, dispose, label) => scope.acquire(acquire, dispose, label),
    });
  }

  #assertSupportedPlugin(plugin: DeclarativePlugin): void {
    const normalized = normalizeContributionDescriptors(plugin.manifest.contributes ?? {});
    if (!normalized.ok || !normalized.descriptors) {
      throw new Error(normalized.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
    }
    const unsupported = normalized.descriptors.find((descriptor) => !isTuiContributionType(descriptor.type));
    if (unsupported) throw new Error(`Unsupported TUI contribution type: ${unsupported.type}`);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('TUI registry is closed');
  }

  async #closeOwners(): Promise<void> {
    const failures: unknown[] = [];
    for (const close of [
      () => this.#snapshot.scope.close(new Error('TUI registry closed')),
      () => this.#registry.close(),
      () => this.#hostScope.close(new Error('TUI registry closed')),
    ]) {
      try { await close(); }
      catch (error) { failures.push(error); }
    }
    if (this.#ownedRoot) {
      try { rmSync(this.#ownedRoot, { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'TUI registry close failed');
  }

  #logError(source: string, value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    this.#errors.push({ source, error, timestamp: Date.now() });
    this.#logger.scope('TuiRegistry').error(source, error);
  }
}
