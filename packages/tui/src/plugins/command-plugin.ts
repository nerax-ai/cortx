/**
 * Built-in command plugin — registers core TUI slash commands.
 *
 * Commands registered:
 *   /exit   — exit the TUI application
 *   /clear  — clear the output and reset state
 *   /config — show current configuration
 *   /help   — list all available commands
 *   /steer  — steer the active run
 *   /agents — list available AgentSpec agents
 *   /agent  — launch or pick an AgentSpec agent
 *   /skill-packs — list installed SkillPacks
 *   /skill-pack  — install or enable SkillPacks
 */

import type { InlinePlugin, PluginContext } from '@nerax-ai/plugin';
import type { TuiFactoryMap, TuiExtensionType, CommandDef } from '../types/tui-plugin.js';
import { TUI_COMMAND } from '../types/tui-plugin.js';
import type { TuiAgentSpecInfo, TuiSkillPackInfo } from '../runtime-session.js';
import type { RuntimeSessionInfo } from '@cortx/runtime';

export interface CommandPluginDeps {
  exit: () => void;
  clear: () => void;
  steer: (message: string) => void;
  getConfig: () => Record<string, unknown>;
  listAgentSpecs: () => Promise<TuiAgentSpecInfo[]>;
  launchAgentSpec: (identifier: string) => void | Promise<void>;
  openAgentSpecPicker: () => void | Promise<void>;
  listSessions: () => Promise<RuntimeSessionInfo[]>;
  switchSession: (sessionId: string) => void | Promise<void>;
  createWorkspaceSession: (workingDirectory: string) => void | Promise<void>;
  listSkillPacks: () => Promise<TuiSkillPackInfo[]>;
  installSkillPack: (path: string, id?: string) => Promise<TuiSkillPackInfo>;
  createSkillPackSession: (ids: string[]) => void | Promise<void>;
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

export function formatSkillPackList(packs: TuiSkillPackInfo[]): string {
  if (packs.length === 0) return 'No SkillPacks installed.';
  const sorted = [...packs].sort((a, b) => a.id.localeCompare(b.id));
  const maxIdLen = Math.max(...sorted.map((pack) => pack.id.length));
  return [
    'Installed SkillPacks:',
    ...sorted.map((pack) => {
      const name = pack.name && pack.name !== pack.id ? ` · ${pack.name}` : '';
      const version = pack.version ? ` @ ${pack.version}` : '';
      return `  ${pack.id.padEnd(maxIdLen)}  - ${pack.skillPaths.length} skills, ${pack.agentSpecPaths.length} agents${name}${version}\n      ${pack.sourcePath}`;
    }),
  ].join('\n');
}

export function parseSkillPackSessionIds(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return path || '/';
  return parts.slice(-2).join('/');
}

function compactSessionId(id: string): string {
  return id.length <= 15 ? id : id.slice(0, 15);
}

export function formatRuntimeSessionList(sessions: RuntimeSessionInfo[]): string {
  if (sessions.length === 0) return 'No remote sessions available.';
  const sorted = [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const maxIdLen = Math.max(...sorted.map((session) => compactSessionId(session.id).length));
  return [
    'Remote sessions:',
    ...sorted.map((session) => {
      const id = compactSessionId(session.id).padEnd(maxIdLen);
      const state = session.isRunning ? 'running' : 'ready';
      return `  ${id}  - ${state} · ${compactPath(session.workingDirectory)} · ${session.toolMode}/${session.approvalMode}`;
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
  const openAgentSpecPicker = deps?.openAgentSpecPicker;
  const listSessions = deps?.listSessions;
  const switchSession = deps?.switchSession;
  const createWorkspaceSession = deps?.createWorkspaceSession;
  const listSkillPacks = deps?.listSkillPacks;
  const installSkillPack = deps?.installSkillPack;
  const createSkillPackSession = deps?.createSkillPackSession;
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

      ctx.register(TUI_COMMAND, 'sessions', (_ctx) => ({
        name: '/sessions',
        description: 'List server runtime sessions',
        handler: async () => {
          if (!listSessions) {
            showError('Server session listing is not available in this session.');
            return;
          }
          try {
            showNotice(formatRuntimeSessionList(await listSessions()));
          } catch (error) {
            showError(`Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }));

      ctx.register(TUI_COMMAND, 'session', (_ctx) => ({
        name: '/session',
        description: 'Switch to a server session or create one for a workspace',
        handler: async (args) => {
          const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
          if (!action) {
            showError('Usage: /session <session-id> or /session new <workspace>');
            return;
          }

          if (action === 'new') {
            if (!createWorkspaceSession) {
              showError('Server session creation is not available in this session.');
              return;
            }
            const workingDirectory = rest.join(' ').trim();
            if (!workingDirectory) {
              showError('Usage: /session new <workspace>');
              return;
            }
            try {
              await createWorkspaceSession(workingDirectory);
              showNotice(`Started session for: ${workingDirectory}`);
            } catch (error) {
              showError(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
          }

          if (!switchSession) {
            showError('Server session switching is not available in this session.');
            return;
          }
          try {
            await switchSession(action);
            showNotice(`Switched to session: ${action}`);
          } catch (error) {
            showError(`Failed to switch session: ${error instanceof Error ? error.message : String(error)}`);
          }
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
            if (!openAgentSpecPicker) {
              showError('AgentSpec picker is not available in this session. Usage: /agent <name-or-path>');
              return;
            }
            try {
              await openAgentSpecPicker();
            } catch (error) {
              showError(`Failed to open AgentSpec picker: ${error instanceof Error ? error.message : String(error)}`);
            }
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

      ctx.register(TUI_COMMAND, 'skill-packs', (_ctx) => ({
        name: '/skill-packs',
        description: 'List installed SkillPacks',
        handler: async () => {
          if (!listSkillPacks) {
            showError('SkillPack listing is not available in this session.');
            return;
          }
          try {
            showNotice(formatSkillPackList(await listSkillPacks()));
          } catch (error) {
            showError(`Failed to list SkillPacks: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }));

      ctx.register(TUI_COMMAND, 'skill-pack', (_ctx) => ({
        name: '/skill-pack',
        description: 'Install or enable SkillPacks',
        handler: async (args) => {
          const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
          if (action === 'install') {
            if (!installSkillPack) {
              showError('SkillPack install is not available in this session.');
              return;
            }
            const [path, id] = rest;
            if (!path) {
              showError('Usage: /skill-pack install <path> [id]');
              return;
            }
            try {
              const pack = await installSkillPack(path, id);
              showNotice(`Installed SkillPack: ${pack.id}`);
            } catch (error) {
              showError(`Failed to install SkillPack: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
          }

          if (action === 'session') {
            if (!createSkillPackSession) {
              showError('SkillPack session creation is not available in this session.');
              return;
            }
            const ids = parseSkillPackSessionIds(rest.join(' '));
            if (ids.length === 0) {
              showError('Usage: /skill-pack session <id[,id...]>');
              return;
            }
            try {
              await createSkillPackSession(ids);
              showNotice(`Started session with SkillPacks: ${ids.join(', ')}`);
            } catch (error) {
              showError(`Failed to start SkillPack session: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
          }

          showError('Usage: /skill-pack install <path> [id] or /skill-pack session <id[,id...]>');
        },
      }));

      // /help — lists all registered commands
      ctx.register(TUI_COMMAND, 'help', (_ctx) => ({
        name: '/help',
        description: 'List all available commands',
        handler: async (_args, _cmdCtx) => {
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
              'Available commands: /exit, /quit, /clear, /config, /help, /steer, /sessions, /session, /agents, /agent, /skill-packs, /skill-pack',
            );
          }
        },
      }));
    },
  };
}
