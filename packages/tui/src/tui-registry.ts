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
import type { InlinePlugin } from '@nerax-ai/plugin';
import type { CommandDef, RegionDef, RendererDef, KeyBindDef, TuiFactoryMap, TuiExtensionType, CommandContext } from './types/tui-plugin.js';
import { TUI_COMMAND, TUI_REGION, TUI_RENDERER, TUI_KEYBIND } from './types/tui-plugin.js';
import { commandPlugin } from './plugins/command-plugin.js';
import { markdownPlugin } from './plugins/markdown-plugin.js';

export class TuiRegistry {
  private readonly registry: PluginRegistry<TuiExtensionType, TuiFactoryMap>;
  private readonly errors: Array<{ source: string; error: Error; timestamp: number }> = [];

  constructor() {
    this.registry = new PluginRegistry<TuiExtensionType, TuiFactoryMap>({
      appName: 'cortx',
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
        const ctx = {
          instanceId: ext.id,
          options: ext.defaultOptions ?? {},
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          storage: { get: async <T>() => undefined as T | undefined, set: async () => {} },
        };
        const cmd = ext.factory(ctx) as CommandDef;
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
        const ctx = {
          instanceId: ext.id,
          options: ext.defaultOptions ?? {},
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          storage: { get: async <T>() => undefined as T | undefined, set: async () => {} },
        };
        const region = ext.factory(ctx) as RegionDef;
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
        const ctx = {
          instanceId: ext.id,
          options: ext.defaultOptions ?? {},
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          storage: { get: async <T>() => undefined as T | undefined, set: async () => {} },
        };
        const renderer = ext.factory(ctx) as RendererDef;
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
        const ctx = {
          instanceId: ext.id,
          options: ext.defaultOptions ?? {},
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          storage: { get: async <T>() => undefined as T | undefined, set: async () => {} },
        };
        const binding = ext.factory(ctx) as KeyBindDef;
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

  private logError(source: string, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.errors.push({ source, error, timestamp: Date.now() });
    // In a real TUI, this would go through the logger and potentially
    // display an error notification in the status bar.
  }
}
