/**
 * Built-in command plugin — registers core TUI slash commands.
 *
 * Commands registered:
 *   /exit   — exit the TUI application
 *   /clear  — clear the output and reset state
 *   /config — show current configuration
 *   /help   — list all available commands
 *   /steer  — steer the active run
 */

import type { InlinePlugin, PluginContext } from '@nerax-ai/plugin';
import type { TuiFactoryMap, TuiExtensionType, CommandDef } from '../types/tui-plugin.js';
import { TUI_COMMAND } from '../types/tui-plugin.js';

export interface CommandPluginDeps {
  exit: () => void;
  clear: () => void;
  steer: (message: string) => void;
  getConfig: () => Record<string, unknown>;
  /** Returns all registered commands (for /help). */
  getCommands?: () => CommandDef[];
}

/**
 * Create the built-in command plugin.
 * Accepts dependency injection for testability.
 */
export function commandPlugin(deps?: Partial<CommandPluginDeps>): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  const exit = deps?.exit ?? (() => {});
  const clear = deps?.clear ?? (() => {});
  const steer = deps?.steer ?? (() => {});
  const getConfig = deps?.getConfig ?? (() => ({}));
  const getCommands = deps?.getCommands;

  return {
    manifest: {
      manifestVersion: 1,
      id: '@cortx/tui-commands',
      name: 'TUI Built-in Commands',
      version: '1.0.0',
      runtime: { main: 'inline' },
      description: 'Core slash commands for the cortx TUI',
    },

    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>): void {
      // /exit
      ctx.register(TUI_COMMAND, 'exit', (_ctx) => ({
        name: '/exit',
        description: 'Exit the TUI application',
        handler: async (_args, _cmdCtx) => {
          exit();
        },
      }));

      // /quit (alias for /exit)
      ctx.register(TUI_COMMAND, 'quit', (_ctx) => ({
        name: '/quit',
        description: 'Exit the TUI application (alias for /exit)',
        handler: async (_args, _cmdCtx) => {
          exit();
        },
      }));

      // /clear
      ctx.register(TUI_COMMAND, 'clear', (_ctx) => ({
        name: '/clear',
        description: 'Clear the output and reset conversation state',
        handler: async (_args, _cmdCtx) => {
          clear();
        },
      }));

      // /config
      ctx.register(TUI_COMMAND, 'config', (_ctx) => ({
        name: '/config',
        description: 'Show current configuration',
        handler: async (_args, _cmdCtx) => {
          const config = getConfig();
          // For now, just log it. In the full TUI this would render in output.
          ctx.logger.info(JSON.stringify(config, null, 2));
        },
      }));

      // /steer
      ctx.register(TUI_COMMAND, 'steer', (_ctx) => ({
        name: '/steer',
        description: 'Steer the active run with a new instruction',
        handler: async (args, _cmdCtx) => {
          const message = args.trim();
          if (message) steer(message);
        },
      }));

      // /help — lists all registered commands
      ctx.register(TUI_COMMAND, 'help', (_ctx) => ({
        name: '/help',
        description: 'List all available commands',
        handler: async (_args, cmdCtx) => {
          if (getCommands) {
            const commands = getCommands();
            const maxNameLen = Math.max(...commands.map((c) => c.name.length));
            const lines = commands
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((cmd) => `  ${cmd.name.padEnd(maxNameLen)}  - ${cmd.description}`);
            ctx.logger.info(
              ['Available commands:', ...lines].join('\n'),
            );
          } else {
            ctx.logger.info(
              'Available commands: /exit, /quit, /clear, /config, /help',
            );
          }
        },
      }));
    },
  };
}
