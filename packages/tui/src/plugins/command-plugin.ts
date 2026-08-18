import type { RuntimeSessionInfo } from '@cortx/runtime';
import type { TuiAgentSpecInfo, TuiSkillPackInfo } from '../runtime-session.js';
import {
  TUI_COMMAND,
  defineTuiContributionBinding,
  defineTuiContributionDescriptor,
  type CommandDef,
  type TuiPlugin,
  type TuiPluginContext,
} from '../types/tui-plugin.js';

export interface CommandPluginDeps {
  exit(): void;
  clear(): void;
  steer(message: string): void | Promise<void>;
  resume(): void | Promise<void>;
  getConfig(): Record<string, unknown>;
  listAgentSpecs(): Promise<TuiAgentSpecInfo[]>;
  launchAgentSpec(identifier: string): void | Promise<void>;
  openAgentSpecPicker(): void | Promise<void>;
  listSessions(): Promise<RuntimeSessionInfo[]>;
  switchSession(sessionId: string): void | Promise<void>;
  createWorkspaceSession(workingDirectory: string): void | Promise<void>;
  listSkillPacks(): Promise<TuiSkillPackInfo[]>;
  installSkillPack(path: string, id?: string): Promise<TuiSkillPackInfo>;
  createSkillPackSession(ids: string[]): void | Promise<void>;
  showNotice(message: string): void;
  showError(message: string): void;
  getCommands?(): CommandDef[];
}

const commandMetadata = {
  exit: ['/exit', 'Exit the TUI application'],
  quit: ['/quit', 'Exit the TUI application (alias for /exit)'],
  clear: ['/clear', 'Clear the output and reset conversation state'],
  config: ['/config', 'Show current configuration'],
  steer: ['/steer', 'Steer the active run with a new instruction'],
  resume: ['/resume', 'Resume the active Runtime or Server session'],
  sessions: ['/sessions', 'List Runtime or Server sessions'],
  session: ['/session', 'Switch sessions or create one for a workspace'],
  agents: ['/agents', 'List available AgentSpec agents'],
  agent: ['/agent', 'Launch an AgentSpec by name or path'],
  'skill-packs': ['/skill-packs', 'List installed SkillPacks'],
  'skill-pack': ['/skill-pack', 'Install or enable SkillPacks'],
  help: ['/help', 'List all available commands'],
} as const satisfies Record<string, readonly [string, string]>;

type CommandId = keyof typeof commandMetadata;

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
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length === 0 ? path || '/' : parts.slice(-2).join('/');
}

function compactSessionId(id: string): string {
  return id.length <= 15 ? id : id.slice(0, 15);
}

export function formatRuntimeSessionList(sessions: RuntimeSessionInfo[]): string {
  if (sessions.length === 0) return 'No runtime sessions available.';
  const sorted = [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const maxIdLen = Math.max(...sorted.map((session) => compactSessionId(session.id).length));
  return [
    'Runtime sessions:',
    ...sorted.map((session) => {
      const id = compactSessionId(session.id).padEnd(maxIdLen);
      const state = session.isRunning ? 'running' : 'ready';
      return `  ${id}  - ${state} · ${compactPath(session.workingDirectory)} · ${session.toolMode}/${session.approvalMode}`;
    }),
  ].join('\n');
}

export function commandPlugin(deps: Partial<CommandPluginDeps> = {}): TuiPlugin {
  let fallbackLogger: TuiPluginContext['logger'] | undefined;
  const exit = deps.exit ?? (() => {});
  const clear = deps.clear ?? (() => {});
  const steer = deps.steer ?? (() => {});
  const resume = deps.resume ?? (() => {});
  const showNotice = deps.showNotice ?? ((message) => fallbackLogger?.info(message));
  const showError = deps.showError ?? ((message) => fallbackLogger?.error(message));

  return {
    manifest: {
      manifestVersion: 1,
      id: '@cortx/tui-commands',
      name: 'TUI Built-in Commands',
      version: '1.0.0',
      runtime: { main: 'inline' },
      description: 'Core slash commands for the Cortx TUI',
      contributes: {
        [TUI_COMMAND]: Object.entries(commandMetadata).map(([id, [displayName, description]]) =>
          defineTuiContributionDescriptor({ id, displayName, description, executable: true }),
        ),
      },
    },
    setup(ctx: TuiPluginContext): void {
      fallbackLogger = ctx.logger;
      const bind = (id: CommandId, handler: CommandDef['handler']) => {
        const [name, description] = commandMetadata[id];
        ctx.bind(defineTuiContributionBinding(TUI_COMMAND, id, () => ({ name, description, handler })));
      };

      bind('exit', () => exit());
      bind('quit', () => exit());
      bind('clear', () => clear());
      bind('config', () => ctx.logger.info(JSON.stringify(deps.getConfig?.() ?? {}, null, 2)));
      bind('steer', async (args) => {
        const message = args.trim();
        if (message) await steer(message);
      });
      bind('resume', async () => {
        try {
          await resume();
          showNotice('Resume requested for the active session.');
        } catch (error) {
          showError(`Failed to resume session: ${errorMessage(error)}`);
        }
      });
      bind('sessions', async () => {
        if (!deps.listSessions) return showError('Session listing is not available.');
        try { showNotice(formatRuntimeSessionList(await deps.listSessions())); }
        catch (error) { showError(`Failed to list sessions: ${errorMessage(error)}`); }
      });
      bind('session', async (args) => {
        const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (!action) return showError('Usage: /session <session-id> or /session new <workspace>');
        if (action === 'new') {
          const workingDirectory = rest.join(' ').trim();
          if (!deps.createWorkspaceSession) return showError('Session creation is not available.');
          if (!workingDirectory) return showError('Usage: /session new <workspace>');
          try {
            await deps.createWorkspaceSession(workingDirectory);
            showNotice(`Started session for: ${workingDirectory}`);
          } catch (error) { showError(`Failed to create session: ${errorMessage(error)}`); }
          return;
        }
        if (!deps.switchSession) return showError('Session switching is not available.');
        try {
          await deps.switchSession(action);
          showNotice(`Switched to session: ${action}`);
        } catch (error) { showError(`Failed to switch session: ${errorMessage(error)}`); }
      });
      bind('agents', async () => {
        if (!deps.listAgentSpecs) return showError('AgentSpec listing is not available.');
        try { showNotice(formatAgentSpecList(await deps.listAgentSpecs())); }
        catch (error) { showError(`Failed to list AgentSpecs: ${errorMessage(error)}`); }
      });
      bind('agent', async (args) => {
        const identifier = args.trim();
        try {
          if (identifier) {
            if (!deps.launchAgentSpec) return showError('AgentSpec launch is not available.');
            await deps.launchAgentSpec(identifier);
            showNotice(`Launched AgentSpec: ${identifier}`);
          } else if (deps.openAgentSpecPicker) {
            await deps.openAgentSpecPicker();
          } else {
            showError('AgentSpec picker is not available. Usage: /agent <name-or-path>');
          }
        } catch (error) { showError(`Failed to launch AgentSpec: ${errorMessage(error)}`); }
      });
      bind('skill-packs', async () => {
        if (!deps.listSkillPacks) return showError('SkillPack listing is not available.');
        try { showNotice(formatSkillPackList(await deps.listSkillPacks())); }
        catch (error) { showError(`Failed to list SkillPacks: ${errorMessage(error)}`); }
      });
      bind('skill-pack', async (args) => {
        const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === 'install') {
          const [path, id] = rest;
          if (!deps.installSkillPack) return showError('SkillPack install is not available.');
          if (!path) return showError('Usage: /skill-pack install <path> [id]');
          try { showNotice(`Installed SkillPack: ${(await deps.installSkillPack(path, id)).id}`); }
          catch (error) { showError(`Failed to install SkillPack: ${errorMessage(error)}`); }
          return;
        }
        if (action === 'session') {
          const ids = parseSkillPackSessionIds(rest.join(' '));
          if (!deps.createSkillPackSession) return showError('SkillPack session creation is not available.');
          if (ids.length === 0) return showError('Usage: /skill-pack session <id[,id...]>');
          try {
            await deps.createSkillPackSession(ids);
            showNotice(`Started session with SkillPacks: ${ids.join(', ')}`);
          } catch (error) { showError(`Failed to start SkillPack session: ${errorMessage(error)}`); }
          return;
        }
        showError('Usage: /skill-pack install <path> [id] or /skill-pack session <id[,id...]>');
      });
      bind('help', () => {
        const commands = deps.getCommands?.();
        if (!commands?.length) return ctx.logger.info('Available commands: ' + Object.values(commandMetadata).map(([name]) => name).join(', '));
        const maxNameLen = Math.max(...commands.map((command) => command.name.length));
        ctx.logger.info(['Available commands:', ...commands.slice().sort((a, b) => a.name.localeCompare(b.name)).map((command) =>
          `  ${command.name.padEnd(maxNameLen)}  - ${command.description}`,
        )].join('\n'));
      });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
