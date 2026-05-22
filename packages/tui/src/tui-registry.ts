import { PluginRegistry } from '@nerax-ai/plugin';
import { noopLogger, type Logger } from '@nerax-ai/logger';
import type { InlinePlugin, PluginStorage } from '@nerax-ai/plugin';
import type { CommandDef, RegionDef, RendererDef, KeyBindDef, TuiFactoryMap, TuiExtensionType, CommandContext } from './types/tui-plugin.js';
import { TUI_COMMAND, TUI_REGION, TUI_RENDERER, TUI_KEYBIND } from './types/tui-plugin.js';
import { commandPlugin } from './plugins/command-plugin.js';
import { markdownPlugin } from './plugins/markdown-plugin.js';

export interface TuiRegistryOptions {
  logger?: Logger;
  storage?: PluginStorage;
}

type ExtensionValue<T extends TuiExtensionType> =
  TuiFactoryMap[T] extends (ctx: any) => infer TResult ? TResult : never;

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

function scopedStorage(parent: PluginStorage, scope: string): PluginStorage {
  const key = (name: string) => `${scope}:${name}`;
  return {
    async get<T>(name: string) {
      return parent.get<T>(key(name));
    },
    async set<T>(name: string, value: T) {
      await parent.set(key(name), value);
    },
    async delete(name: string) {
      await parent.delete(key(name));
    },
  };
}

export class TuiRegistry {
  private readonly registry: PluginRegistry<TuiExtensionType, TuiFactoryMap>;
  private readonly logger: Logger;
  private readonly errors: Array<{ source: string; error: Error; timestamp: number }> = [];
  private readonly commands: CommandDef[] = [];
  private readonly regions: RegionDef[] = [];
  private readonly renderers: RendererDef[] = [];
  private readonly keyBindings: KeyBindDef[] = [];

  constructor(options: TuiRegistryOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    const storage = options.storage ?? createMemoryStorage();
    this.registry = new PluginRegistry<TuiExtensionType, TuiFactoryMap>({
      appName: 'cortx',
      logger: this.logger.scope('tui'),
      storageFactory: (packageName) => scopedStorage(storage, packageName),
    });
  }

  async init(): Promise<void> {
    await this.registerPlugin(commandPlugin());
    await this.registerPlugin(markdownPlugin());
  }

  async registerPlugin(plugin: InlinePlugin<TuiExtensionType, TuiFactoryMap>): Promise<void> {
    await this.registry.register(plugin);
    await this.refreshExtensions();
  }

  getCommands(): CommandDef[] {
    return this.commands;
  }

  getRegions(position?: string): RegionDef[] {
    return position ? this.regions.filter((region) => region.position === position) : this.regions;
  }

  getRenderers(eventType?: string): RendererDef[] {
    return eventType ? this.renderers.filter((renderer) => renderer.eventType === eventType) : this.renderers;
  }

  getKeyBindings(): KeyBindDef[] {
    return this.keyBindings;
  }

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

  getErrors(): ReadonlyArray<{ source: string; error: Error; timestamp: number }> {
    return this.errors;
  }

  getPluginRegistry(): PluginRegistry<TuiExtensionType, TuiFactoryMap> {
    return this.registry;
  }

  private async refreshExtensions(): Promise<void> {
    this.commands.splice(0, this.commands.length, ...await this.createExtensions(TUI_COMMAND));
    this.regions.splice(0, this.regions.length, ...await this.createExtensions(TUI_REGION));
    this.renderers.splice(0, this.renderers.length, ...await this.createExtensions(TUI_RENDERER));
    this.keyBindings.splice(0, this.keyBindings.length, ...await this.createExtensions(TUI_KEYBIND));
  }

  private async createExtensions<T extends TuiExtensionType>(type: T): Promise<Array<ExtensionValue<T>>> {
    const values: Array<ExtensionValue<T>> = [];
    for (const ext of this.registry.listExtensions(type)) {
      try {
        values.push(await this.registry.create(type, ext.fullId, `${type}:${ext.fullId}`, {}, 'tui') as ExtensionValue<T>);
      } catch (err) {
        this.logError(`create(${ext.fullId})`, err);
      }
    }
    return values;
  }

  private logError(source: string, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.errors.push({ source, error, timestamp: Date.now() });
    this.logger.scope('TuiRegistry').error(source, error);
  }
}
