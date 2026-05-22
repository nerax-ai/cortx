/**
 * TuiRegistry — thin wrapper around @nerax-ai/plugin's PluginRegistry
 * that provides TUI-specific query methods.
 *
 * Usage:
 *   const registry = new TuiRegistry();
 *   await registry.init(); // loads built-in plugins
 *   const commands = registry.getCommands();
 */

import { PluginRegistry } from '@nerax-ai/plugin';
import { noopLogger, type Logger } from '@nerax-ai/logger';
import type { Extension, InlinePlugin, PluginStorage } from '@nerax-ai/plugin';
import type { CommandDef, RegionDef, RendererDef, KeyBindDef, TuiFactoryMap, TuiExtensionType, CommandContext } from './types/tui-plugin.js';
import { TUI_COMMAND, TUI_REGION, TUI_RENDERER, TUI_KEYBIND } from './types/tui-plugin.js';
import { commandPlugin } from './plugins/command-plugin.js';
import { markdownPlugin } from './plugins/markdown-plugin.js';

export interface TuiRegistryOptions {
  logger?: Logger;
  storage?: PluginStorage;
}

function createMemoryStorage(): PluginStorage {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

class ScopedPluginStorage implements PluginStorage {
  constructor(
    private readonly parent: PluginStorage,
    private readonly scope: string,
  ) {}

  async get<T>(key: string) {
    return this.parent.get<T>(this.key(key));
  }

  async set<T>(key: string, value: T) {
    await this.parent.set(this.key(key), value);
  }

  async delete(key: string) {
    await this.parent.delete(this.key(key));
  }

  private key(key: string) {
    return `${this.scope}:${key}`;
  }
}

export class TuiRegistry {
  private readonly registry: PluginRegistry<TuiExtensionType, TuiFactoryMap>;
  private readonly logger: Logger;
  private readonly storage: PluginStorage;
  private readonly errors: Array<{ source: string; error: Error; timestamp: number }> = [];

  constructor(options: TuiRegistryOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.storage = options.storage ?? createMemoryStorage();
    this.registry = new PluginRegistry<TuiExtensionType, TuiFactoryMap>({
      appName: 'cortx',
      logger: this.logger.scope('tui'),
      storageFactory: (packageName) => this.scopedStorage(packageName),
    });
  }

  /**
   * Initialize the registry and load built-in TUI plugins.
   * Must be called before any query methods.
   */
  async init(): Promise<void> {
    // Register built-in plugins
    await this.registerPlugin(commandPlugin());
    await this.registerPlugin(markdownPlugin());
  }

  /**
   * Register an inline plugin (e.g. a built-in plugin).
   */
  async registerPlugin(plugin: InlinePlugin<TuiExtensionType, TuiFactoryMap>): Promise<void> {
    await this.registry.register(plugin);
  }

  /**
   * List all registered commands.
   */
  getCommands(): CommandDef[] {
    const extensions = this.registry.listExtensions(TUI_COMMAND);
    const commands: CommandDef[] = [];
    for (const ext of extensions) {
      try {
        const cmd = ext.factory(this.factoryContext(ext, ext.defaultOptions ?? {})) as CommandDef;
        commands.push(cmd);
      } catch (err) {
        this.logError(`getCommands(${ext.fullId})`, err);
      }
    }
    return commands;
  }

  /**
   * List regions for a given layout position.
   */
  getRegions(position?: string): RegionDef[] {
    const extensions = this.registry.listExtensions(TUI_REGION);
    const regions: RegionDef[] = [];
    for (const ext of extensions) {
      try {
        const region = ext.factory(this.factoryContext(ext, ext.defaultOptions ?? {})) as RegionDef;
        if (!position || region.position === position) {
          regions.push(region);
        }
      } catch (err) {
        this.logError(`getRegions(${ext.fullId})`, err);
      }
    }
    return regions;
  }

  /**
   * List renderers for a given event type.
   */
  getRenderers(eventType?: string): RendererDef[] {
    const extensions = this.registry.listExtensions(TUI_RENDERER);
    const renderers: RendererDef[] = [];
    for (const ext of extensions) {
      try {
        const renderer = ext.factory(this.factoryContext(ext, ext.defaultOptions ?? {})) as RendererDef;
        if (!eventType || renderer.eventType === eventType) {
          renderers.push(renderer);
        }
      } catch (err) {
        this.logError(`getRenderers(${ext.fullId})`, err);
      }
    }
    return renderers;
  }

  /**
   * List all registered key bindings.
   */
  getKeyBindings(): KeyBindDef[] {
    const extensions = this.registry.listExtensions(TUI_KEYBIND);
    const bindings: KeyBindDef[] = [];
    for (const ext of extensions) {
      try {
        const binding = ext.factory(this.factoryContext(ext, ext.defaultOptions ?? {})) as KeyBindDef;
        bindings.push(binding);
      } catch (err) {
        this.logError(`getKeyBindings(${ext.fullId})`, err);
      }
    }
    return bindings;
  }

  /**
   * Look up a command by name and execute its handler with error isolation.
   * Returns true if the command was found and executed (even if it threw).
   * Returns false if the command was not found.
   */
  async executeCommand(name: string, args: string, cmdCtx: CommandContext): Promise<boolean> {
    const commands = this.getCommands();
    const cmd = commands.find((c) => c.name === name);
    if (!cmd) return false;

    try {
      await cmd.handler(args, cmdCtx);
    } catch (err) {
      this.logError(`executeCommand(${name})`, err);
    }
    return true;
  }

  /**
   * Return collected errors (useful for diagnostics and testing).
   */
  getErrors(): ReadonlyArray<{ source: string; error: Error; timestamp: number }> {
    return this.errors;
  }

  /**
   * Access the underlying PluginRegistry for advanced operations.
   */
  getPluginRegistry(): PluginRegistry<TuiExtensionType, TuiFactoryMap> {
    return this.registry;
  }

  private factoryContext(ext: Extension<TuiExtensionType, TuiFactoryMap>, options: Record<string, unknown>) {
    return {
      instanceId: ext.fullId,
      options,
      logger: this.logger.scope(ext.packageName).scope(ext.id),
      storage: this.scopedStorage(ext.packageName),
    };
  }

  private scopedStorage(scope: string) {
    return new ScopedPluginStorage(this.storage, scope);
  }

  private logError(source: string, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.errors.push({ source, error, timestamp: Date.now() });
    this.logger.scope('TuiRegistry').error(source, error);
  }
}
