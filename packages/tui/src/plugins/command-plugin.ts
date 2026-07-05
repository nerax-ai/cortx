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
import type { TuiAgentSpecInfo } from '../runtime-session.js';

export interface CommandPluginDeps {
  exit: () => void;
  clear: () => void;
  steer: (message: string) => void;
  getConfig: () => Record<string, unknown>;
  listAgentSpecs: () => Promise<TuiAgentSpecInfo[]>;
  launchAgentSpec: (identifier: string) => void | Promise<void>;
  showNotice: (message: string) => void;
  showError: (message: string) => void;
  /** Returns all registered commands (for /help). */
  getCommands?: () => CommandDef[];
}

export function formatAgentSpecList(specs: TuiAgentSpecInfo[]): string {
  if (specs.length === 0) return 'No AgentSpecs found in this workspace.';
  const sorted = [...specs].sort((a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath));
  const maxNameLen = Math.max(...sorted.map((spec) => spec.name.length));
  return [
    'Available agents:',
    ...sorted.map((spec) => {
      const mode = [spec.toolMode, spec.approvalMode].filter(Boolean).join('/');
      const suffix = mode ? ` · ${mode}` : '';
      return `  ${spec.name.padEnd(maxNameLen)}  - ${spec.relativePath}${suffix}\n      ${spec.promptPreview}`;
    }),
  ].join('\n');
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
  const listAgentSpecs = deps?.listAgentSpecs;
  const launchAgentSpec = deps?.launchAgentSpec;
  const showNotice = deps?.showNotice ?? ((message: string) => ctxLogFallback(message));
  const showError = deps?.showError ?? ((message: string) => ctxLogFallback(message));
  const getCommands = deps?.getCommands;

  let fallbackLogger: { info(message: string): void; error(message: string): void } | undefined;
  function ctxLogFallback(message: string): void {
    fallbackLogger?.info(message);
  }

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
      fallbackLogger = ctx.logger;
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

      ctx.register(TUI_COMMAND, 'agents', (_ctx) => ({
        name: '/agents',
        description: 'List available AgentSpec agents',
        handler: async () => {
          if (!listAgentSpecs) {
            showError('AgentSpec listing is not available in this session.');
            return;
          }
          try {
            showNotice(formatAgentSpecList(await listAgentSpecs()));
          } catch (error) {
            showError(`Failed to list AgentSpecs: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }));

      ctx.register(TUI_COMMAND, 'agent', (_ctx) => ({
        name: '/agent',
        description: 'Launch an AgentSpec by name or path',
        handler: async (args) => {
          const identifier = args.trim();
          if (!identifier) {
            showError('Usage: /agent <name-or-path>');
            return;
          }
          if (!launchAgentSpec) {
            showError('AgentSpec launch is not available in this session.');
            return;
          }
          try {
            await launchAgentSpec(identifier);
            showNotice(`Launched AgentSpec: ${identifier}`);
          } catch (error) {
            showError(`Failed to launch AgentSpec: ${error instanceof Error ? error.message : String(error)}`);
          }
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
