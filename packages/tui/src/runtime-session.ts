import type { LanguageClient } from '@synax-ai/core';
import type { LanguageMessage, Logger } from '@cortx/sdk';
import type { CortxFactoryMap, CortxExtensionType, CortxRegistry, PluginConfig } from '@cortx/core';
import { SubAgentSessionStore } from '@cortx/core';
import { CortxRuntime, type RuntimeSessionCreateRequest, type RuntimeSessionInfo } from '@cortx/runtime';
import type { ProjectPluginRegistry } from './language.js';
import { RemoteRuntimeClient } from './remote-client.js';

export type TuiRuntimeMode = 'local' | 'remote';

export interface TuiSessionAdapter {
  readonly mode: TuiRuntimeMode;
  readonly agentSessions: SubAgentSessionStore;
  readonly supportsMessageRestore: boolean;
  getInfo(): RuntimeSessionInfo;
  subscribe(listener: (event: import('@cortx/sdk').AgentEvent) => void): () => void;
  prompt(message: string): Promise<void>;
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
  logger?: Logger;
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

  constructor(
    private readonly runtime: CortxRuntime,
    private readonly sessionId: string,
  ) {
    this.localState = runtime.getLocalState(sessionId);
    this.agentSessions = this.localState.agentSessions;
  }

  getInfo(): RuntimeSessionInfo {
    return this.runtime.getSession(this.sessionId);
  }

  subscribe(listener: Parameters<TuiSessionAdapter['subscribe']>[0]): () => void {
    return this.runtime.subscribe(this.sessionId, listener);
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

  abort(): void {
    this.runtime.abort(this.sessionId);
  }

  getAgentMessages(): LanguageMessage[] {
    return this.localState.getMessages();
  }

  replaceAgentMessages(messages: LanguageMessage[]): void {
    this.localState.replaceMessages(messages);
  }

  dispose(): void {
    this.runtime.dispose();
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
    toolMode: 'all',
    approvalMode: 'interactive',
    logger: options.logger,
  });
  const info = await runtime.createSession({
    workingDirectory: options.workingDirectory,
    model: options.model,
    system: options.system,
    maxIterations: options.maxIterations,
    registry: options.registry as CortxRegistry | undefined,
    plugins: options.plugins,
    metadata: { tuiMode: 'local' },
  });
  return new LocalRuntimeSessionAdapter(runtime, info.id);
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
