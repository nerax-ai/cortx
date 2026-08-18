import type { Logger } from '@nerax-ai/logger';
import type { RuntimeSessionCreateRequest } from '@cortx/runtime';
import type { DeclarativePlugin } from '@nerax-ai/plugin';
import { commandPlugin } from './plugins/command-plugin.js';
import type {
  TuiAgentSpecInfo,
  TuiSessionAdapter,
  TuiSkillPackInfo,
} from './runtime-session.js';
import { TuiRegistry } from './tui-registry.js';

export interface TuiHostActions {
  exit(): void;
  clear(): void;
  getConfig(): Record<string, unknown>;
  openAgentSpecPicker(): void | Promise<void>;
  showNotice(message: string): void;
  showError(message: string): void;
}

export interface CreateTuiHostOptions {
  session: TuiSessionAdapter;
  logger?: Logger;
  actions?: Partial<TuiHostActions>;
  plugins?: readonly DeclarativePlugin[];
}

export interface TuiHost {
  readonly runtimeDomainId: string;
  readonly registry: TuiRegistry;
  readonly sessions: TuiSessionAuthority;
  updateActions(actions: Partial<TuiHostActions>): void;
  close(): Promise<void>;
}

type SessionListener = (session: TuiSessionAdapter) => void;

export class TuiSessionAuthority {
  #current: TuiSessionAdapter;
  readonly #listeners = new Set<SessionListener>();
  readonly #degradedCleanup = new Set<TuiSessionAdapter>();
  #closed = false;
  #closeResult?: Promise<void>;

  constructor(initial: TuiSessionAdapter) {
    this.#current = initial;
  }

  get current(): TuiSessionAdapter {
    return this.#current;
  }

  subscribe(listener: SessionListener): () => void {
    if (this.#closed) throw new Error('TUI session authority is closed');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  listSessions() {
    return this.#current.listSessions();
  }

  async switchSession(sessionId: string): Promise<TuiSessionAdapter> {
    return this.#replace(await this.#current.switchSession(sessionId));
  }

  async createSessionForWorkspace(workingDirectory: string): Promise<TuiSessionAdapter> {
    return this.#replace(await this.#current.createSessionForWorkspace(workingDirectory));
  }

  listAgentSpecs(): Promise<TuiAgentSpecInfo[]> {
    return this.#current.listAgentSpecs();
  }

  async launchAgentSpec(identifier: string): Promise<TuiSessionAdapter> {
    return this.#replace(await this.#current.launchAgentSpec(identifier));
  }

  listSkillPacks(): Promise<TuiSkillPackInfo[]> {
    return this.#current.listSkillPacks();
  }

  installSkillPack(path: string, id?: string): Promise<TuiSkillPackInfo> {
    return this.#current.installSkillPack(path, id);
  }

  async createSession(request?: RuntimeSessionCreateRequest): Promise<TuiSessionAdapter> {
    return this.#replace(await this.#current.createSession(request));
  }

  steer(message: string): void | Promise<void> {
    return this.#current.steer(message);
  }

  resume(): Promise<void> {
    return this.#current.resume();
  }

  async retryCleanup(): Promise<void> {
    const failures: unknown[] = [];
    for (const adapter of [...this.#degradedCleanup]) {
      try {
        await adapter.close();
        this.#degradedCleanup.delete(adapter);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'TUI session cleanup retry failed');
  }

  close(): Promise<void> {
    if (this.#closeResult) return this.#closeResult;
    this.#closed = true;
    this.#listeners.clear();
    this.#closeResult = closeAdapters('TUI session authority', [this.#current, ...this.#degradedCleanup]);
    return this.#closeResult;
  }

  async #replace(next: TuiSessionAdapter): Promise<TuiSessionAdapter> {
    if (this.#closed) {
      await next.close().catch(() => undefined);
      throw new Error('TUI session authority is closed');
    }
    if (next === this.#current) return next;
    const previous = this.#current;
    this.#current = next;
    for (const listener of this.#listeners) listener(next);
    try {
      await previous.close();
    } catch {
      this.#degradedCleanup.add(previous);
    }
    return next;
  }
}

export async function createTuiHost(options: CreateTuiHostOptions): Promise<TuiHost> {
  const registry = new TuiRegistry({ logger: options.logger });
  const sessions = new TuiSessionAuthority(options.session);
  let actions: Partial<TuiHostActions> = { ...options.actions };
  let closeResult: Promise<void> | undefined;

  const action = <TKey extends keyof TuiHostActions>(key: TKey, ...args: Parameters<TuiHostActions[TKey]>) => {
    const handler = actions[key] as ((...input: Parameters<TuiHostActions[TKey]>) => ReturnType<TuiHostActions[TKey]>) | undefined;
    return handler?.(...args);
  };

  try {
    await registry.registerPlugin(commandPlugin({
      exit: () => action('exit'),
      clear: () => action('clear'),
      getConfig: () => action('getConfig') ?? {},
      openAgentSpecPicker: () => action('openAgentSpecPicker'),
      showNotice: (message) => action('showNotice', message),
      showError: (message) => action('showError', message),
      steer: (message) => sessions.steer(message),
      resume: () => sessions.resume(),
      listSessions: () => sessions.listSessions(),
      switchSession: async (sessionId) => { await sessions.switchSession(sessionId); },
      createWorkspaceSession: async (workingDirectory) => { await sessions.createSessionForWorkspace(workingDirectory); },
      listAgentSpecs: () => sessions.listAgentSpecs(),
      launchAgentSpec: async (identifier) => { await sessions.launchAgentSpec(identifier); },
      listSkillPacks: () => sessions.listSkillPacks(),
      installSkillPack: (path, id) => sessions.installSkillPack(path, id),
      createSkillPackSession: async (ids) => { await sessions.createSession({ skillPacks: ids }); },
      getCommands: () => registry.getCommands(),
    }));
    for (const plugin of options.plugins ?? []) await registry.registerPlugin(plugin);
  } catch (error) {
    await closeOwners('TUI Host startup', [sessions, registry]).catch(() => undefined);
    throw error;
  }

  return {
    runtimeDomainId: registry.runtimeDomainId,
    registry,
    sessions,
    updateActions(next) {
      actions = { ...actions, ...next };
    },
    close() {
      closeResult ??= closeOwners('TUI Host', [sessions, registry]);
      return closeResult;
    },
  };
}

async function closeAdapters(label: string, adapters: TuiSessionAdapter[]): Promise<void> {
  const unique = [...new Set(adapters)];
  const failures: unknown[] = [];
  for (const adapter of unique) {
    try { await adapter.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${label} close failed`);
}

async function closeOwners(label: string, owners: Array<{ close(): Promise<void> }>): Promise<void> {
  const failures: unknown[] = [];
  for (const owner of owners) {
    try { await owner.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${label} close failed`);
}
