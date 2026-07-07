import type { LanguageClient } from '@synax-ai/core';
import type { LanguageMessage, Logger } from '@cortx/sdk';
import { join } from 'node:path';
import type {
  CortxFactoryMap,
  CortxExtensionType,
  CortxRegistry,
  DiscoveredAgentSpec,
  InstalledSkillPack,
  PluginConfig,
  WorkspaceToolMode,
} from '@cortx/runtime';
import {
  CortxRuntime,
  SubAgentSessionStore,
  discoverAgentSpecs,
  installSkillPack,
  listInstalledSkillPacks,
  resolveWorkspace,
  type RuntimeSessionCreateRequest,
  type RuntimeSessionInfo,
} from '@cortx/runtime';
import type { ProjectPluginRegistry } from './language.js';
import { RemoteRuntimeClient } from './remote-client.js';

export type TuiRuntimeMode = 'local' | 'remote';
export type TuiAgentSpecInfo = DiscoveredAgentSpec;
export type TuiSkillPackInfo = InstalledSkillPack;

export interface TuiSessionAdapter {
  readonly mode: TuiRuntimeMode;
  readonly agentSessions: SubAgentSessionStore;
  readonly supportsMessageRestore: boolean;
  getInfo(): RuntimeSessionInfo;
  subscribe(listener: (event: import('@cortx/sdk').AgentEvent) => void): () => void;
  prompt(message: string): Promise<void>;
  listSessions(): Promise<RuntimeSessionInfo[]>;
  switchSession(sessionId: string): Promise<TuiSessionAdapter>;
  createSessionForWorkspace(workingDirectory: string): Promise<TuiSessionAdapter>;
  listAgentSpecs(): Promise<TuiAgentSpecInfo[]>;
  launchAgentSpec(identifier: string): Promise<TuiSessionAdapter>;
  listSkillPacks(): Promise<TuiSkillPackInfo[]>;
  installSkillPack(path: string, id?: string): Promise<TuiSkillPackInfo>;
  createSession(request?: RuntimeSessionCreateRequest): Promise<TuiSessionAdapter>;
  steer(message: string): void | Promise<void>;
  followUp(message: string): void | Promise<void>;
  resume(): Promise<void>;
  answerUser(toolCallId: string, response: string): void | Promise<void>;
  abort(reason?: string): void | Promise<void>;
  getAgentMessages(): LanguageMessage[];
  replaceAgentMessages(messages: LanguageMessage[]): void;
  dispose(): void;
}

export interface LocalRuntimeSessionOptions {
  language: LanguageClient;
  model: string;
  system?: string;
  maxIterations?: number;
  workingDirectory: string;
  registry?: ProjectPluginRegistry | CortxRegistry;
  plugins?: PluginConfig[];
  toolMode?: WorkspaceToolMode;
  logger?: Logger;
  skillPackRegistryPath?: string;
}

export interface RemoteRuntimeSessionOptions {
  client: RemoteRuntimeClient;
  sessionId?: string;
  create?: RuntimeSessionCreateRequest;
}

class LocalRuntimeSessionAdapter implements TuiSessionAdapter {
  readonly mode = 'local' as const;
  readonly agentSessions: SubAgentSessionStore;
  readonly supportsMessageRestore = true;
  private readonly localState: ReturnType<CortxRuntime['getLocalState']>;
  private ownsRuntime = true;

  constructor(
    private readonly runtime: CortxRuntime,
    private readonly sessionId: string,
    private readonly skillPackRegistryPath: string,
    ownsRuntime = true,
  ) {
    this.ownsRuntime = ownsRuntime;
    this.localState = runtime.getLocalState(sessionId);
    this.agentSessions = this.localState.agentSessions;
  }

  getInfo(): RuntimeSessionInfo {
    return this.runtime.getSession(this.sessionId);
  }

  subscribe(listener: Parameters<TuiSessionAdapter['subscribe']>[0]): () => void {
    return this.runtime.subscribe(this.sessionId, listener);
  }

  listAgentSpecs(): Promise<TuiAgentSpecInfo[]> {
    return discoverAgentSpecs({
      roots: [this.getInfo().workingDirectory],
      installedSkillPackRegistryPath: this.skillPackRegistryPath,
    });
  }

  async listSessions(): Promise<RuntimeSessionInfo[]> {
    return this.runtime.listSessions();
  }

  async switchSession(sessionId: string): Promise<TuiSessionAdapter> {
    const info = this.runtime.getSession(sessionId);
    this.ownsRuntime = false;
    return new LocalRuntimeSessionAdapter(this.runtime, info.id, this.skillPackRegistryPath, true);
  }

  createSessionForWorkspace(workingDirectory: string): Promise<TuiSessionAdapter> {
    return this.createSession({ workingDirectory });
  }

  async launchAgentSpec(identifier: string): Promise<TuiSessionAdapter> {
    const spec = await resolveAgentSpecIdentifier(await this.listAgentSpecs(), identifier);
    const info = await this.runtime.launchAgentSpecFile(spec.path);
    this.ownsRuntime = false;
    return new LocalRuntimeSessionAdapter(this.runtime, info.id, this.skillPackRegistryPath, true);
  }

  listSkillPacks(): Promise<TuiSkillPackInfo[]> {
    return listInstalledSkillPacks(this.skillPackRegistryPath);
  }

  async installSkillPack(path: string, id?: string): Promise<TuiSkillPackInfo> {
    const workspace = await resolveWorkspace({
      requested: path,
      defaultWorkingDirectory: this.getInfo().workingDirectory,
      allowedRoots: [this.getInfo().workingDirectory],
    });
    return installSkillPack({
      registryPath: this.skillPackRegistryPath,
      sourcePath: workspace.workingDirectory,
      id,
    });
  }

  async createSession(request: RuntimeSessionCreateRequest = {}): Promise<TuiSessionAdapter> {
    const current = this.getInfo();
    const info = await this.runtime.createSession({
      workingDirectory: current.workingDirectory,
      model: current.model,
      system: current.system,
      maxIterations: current.maxIterations,
      toolMode: current.toolMode,
      approvalMode: current.approvalMode,
      capabilities: current.capabilities,
      ...request,
      metadata: { ...request.metadata, tuiMode: 'local' },
    });
    this.ownsRuntime = false;
    return new LocalRuntimeSessionAdapter(this.runtime, info.id, this.skillPackRegistryPath, true);
  }

  prompt(message: string): Promise<void> {
    return this.runtime.prompt(this.sessionId, message);
  }

  steer(message: string): void {
    this.runtime.steer(this.sessionId, message);
  }

  followUp(message: string): void {
    this.runtime.followUp(this.sessionId, message);
  }

  resume(): Promise<void> {
    return this.runtime.resume(this.sessionId);
  }

  answerUser(toolCallId: string, response: string): void {
    this.runtime.answer(this.sessionId, toolCallId, response);
  }

  abort(): Promise<void> {
    return Promise.resolve(this.runtime.abort(this.sessionId));
  }

  getAgentMessages(): LanguageMessage[] {
    return this.localState.getMessages();
  }

  replaceAgentMessages(messages: LanguageMessage[]): void {
    this.localState.replaceMessages(messages);
  }

  dispose(): void {
    if (this.ownsRuntime) this.runtime.dispose();
  }
}

class RemoteRuntimeSessionAdapter implements TuiSessionAdapter {
  readonly mode = 'remote' as const;
  readonly agentSessions = new SubAgentSessionStore();
  readonly supportsMessageRestore = false;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly client: RemoteRuntimeClient,
    private info: RuntimeSessionInfo,
  ) {}

  getInfo(): RuntimeSessionInfo {
    return this.info;
  }

  subscribe(listener: Parameters<TuiSessionAdapter['subscribe']>[0]): () => void {
    let closed = false;
    this.client
      .connectEvents(this.info.id, listener)
      .then((unsubscribe) => {
        if (closed) {
          unsubscribe();
        } else {
          this.unsubscribe = unsubscribe;
        }
      })
      .catch((error) => {
        if (!closed) listener({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => {
      closed = true;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    };
  }

  async prompt(message: string): Promise<void> {
    await this.client.prompt(this.info.id, message);
    await this.refresh();
  }

  listSessions(): Promise<RuntimeSessionInfo[]> {
    return this.client.listSessions();
  }

  async switchSession(sessionId: string): Promise<TuiSessionAdapter> {
    const info = await this.client.getSession(sessionId);
    this.dispose();
    return new RemoteRuntimeSessionAdapter(this.client, info);
  }

  createSessionForWorkspace(workingDirectory: string): Promise<TuiSessionAdapter> {
    return this.createSession({ workingDirectory });
  }

  listAgentSpecs(): Promise<TuiAgentSpecInfo[]> {
    return this.client.listAgentSpecs();
  }

  async launchAgentSpec(identifier: string): Promise<TuiSessionAdapter> {
    const spec = await resolveAgentSpecIdentifier(await this.listAgentSpecs(), identifier);
    const info = await this.client.launchAgentSpec({ path: spec.path });
    this.dispose();
    return new RemoteRuntimeSessionAdapter(this.client, info);
  }

  listSkillPacks(): Promise<TuiSkillPackInfo[]> {
    return this.client.listSkillPacks();
  }

  installSkillPack(path: string, id?: string): Promise<TuiSkillPackInfo> {
    return this.client.installSkillPack({ path, id });
  }

  async createSession(request: RuntimeSessionCreateRequest = {}): Promise<TuiSessionAdapter> {
    const current = this.getInfo();
    const info = await this.client.createSession({
      workingDirectory: current.workingDirectory,
      model: current.model,
      system: current.system,
      maxIterations: current.maxIterations,
      toolMode: current.toolMode,
      approvalMode: current.approvalMode,
      capabilities: current.capabilities,
      ...request,
      metadata: { ...request.metadata, tuiMode: 'remote' },
    });
    this.dispose();
    return new RemoteRuntimeSessionAdapter(this.client, info);
  }

  async steer(message: string): Promise<void> {
    await this.client.steer(this.info.id, message);
  }

  async followUp(message: string): Promise<void> {
    await this.client.followUp(this.info.id, message);
  }

  async resume(): Promise<void> {
    await this.client.resume(this.info.id);
    await this.refresh();
  }

  async answerUser(toolCallId: string, response: string): Promise<void> {
    await this.client.answer(this.info.id, toolCallId, response);
  }

  async abort(): Promise<void> {
    await this.client.abort(this.info.id);
    await this.refresh();
  }

  getAgentMessages(): LanguageMessage[] {
    return [];
  }

  replaceAgentMessages(): void {
    // Remote sessions own their model history on the server side.
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async refresh(): Promise<void> {
    try {
      this.info = await this.client.getSession(this.info.id);
    } catch {
      // Rendering remains event-driven; stale metadata is better than hiding the session.
    }
  }
}

export async function createLocalRuntimeSession(options: LocalRuntimeSessionOptions): Promise<TuiSessionAdapter> {
  const skillPackRegistryPath = options.skillPackRegistryPath ?? join(options.workingDirectory, '.cortx', 'skill-packs', 'registry.json');
  const runtime = new CortxRuntime({
    appName: 'cortx',
    language: options.language,
    model: options.model,
    system: options.system,
    maxIterations: options.maxIterations,
    registry: options.registry as CortxRegistry | undefined,
    plugins: options.plugins,
    defaultWorkingDirectory: options.workingDirectory,
    allowedWorkspaceRoots: [options.workingDirectory],
    toolMode: options.toolMode ?? 'none',
    approvalMode: 'interactive',
    logger: options.logger,
    skillPackRegistryPath,
  });
  const info = await runtime.createSession({
    workingDirectory: options.workingDirectory,
    model: options.model,
    system: options.system,
    maxIterations: options.maxIterations,
    registry: options.registry as CortxRegistry | undefined,
    plugins: options.plugins,
    toolMode: options.toolMode,
    metadata: { tuiMode: 'local' },
  });
  return new LocalRuntimeSessionAdapter(runtime, info.id, skillPackRegistryPath);
}

export async function createRemoteRuntimeSession(options: RemoteRuntimeSessionOptions): Promise<TuiSessionAdapter> {
  const info = options.sessionId
    ? await options.client.getSession(options.sessionId)
    : await options.client.createSession({
        ...options.create,
        metadata: { ...options.create?.metadata, tuiMode: 'remote' },
      });
  return new RemoteRuntimeSessionAdapter(options.client, info);
}

export type { CortxFactoryMap, CortxExtensionType };

export async function resolveAgentSpecIdentifier(
  specs: TuiAgentSpecInfo[],
  identifier: string,
): Promise<TuiAgentSpecInfo> {
  const needle = identifier.trim();
  if (!needle) throw new Error('Agent name or path is required.');
  const matches = specs.filter(
    (spec) =>
      spec.name === needle ||
      spec.path === needle ||
      spec.relativePath === needle ||
      spec.path.endsWith(`/${needle}`) ||
      spec.path.endsWith(`\\${needle}`),
  );
  if (matches.length === 0) throw new Error(`No AgentSpec found for "${needle}". Run /agents to list available agents.`);
  if (matches.length > 1) {
    throw new Error(`AgentSpec "${needle}" is ambiguous. Use a full relative path from /agents.`);
  }
  return matches[0];
}
