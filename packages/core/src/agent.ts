import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentController, CortxConfig, CortxRegistry } from './types.js';
import type { AgentRunCheckpoint, LanguageMessage, Tool } from '@cortx/sdk';
import {
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  mergeAgentRuntimeExtensions,
} from '@cortx/sdk';
import { AgentLoopController } from './types.js';
import { agentLoop } from './loop.js';
import { getRegistry, resolveExtensions } from './plugin-resolver.js';

export class Cortx {
  private readonly language: LanguageClient;
  private readonly config: CortxConfig;
  private readonly registry: CortxRegistry;
  private readonly tools = new Map<string, Tool>();
  private _messages: LanguageMessage[] = [];
  private readonly _sessionId: string;
  private _runId: number | undefined;
  private _controller = new AgentLoopController();
  onAgentEvent?: (event: AgentEvent) => void;

  constructor(language: LanguageClient, config: CortxConfig) {
    this.language = language;
    this.config = config;
    this.registry = getRegistry(config);
    this._sessionId = config.sessionId ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this._runId = config.runId;
    for (const t of config.tools ?? []) this.tools.set(t.name, t);
  }

  get messages(): LanguageMessage[] {
    return [...this._messages];
  }
  get controller(): AgentController {
    return this._controller;
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  setRunId(runId: number): void {
    this._runId = runId;
  }

  steer(message: string | LanguageMessage): void {
    this._controller.steer(message);
  }
  followUp(message: string | LanguageMessage): void {
    this._controller.followUp(message);
  }
  abort(reason?: string): void {
    this._controller.abort(reason);
  }

  async *run(userMessage: string | LanguageMessage): AsyncGenerator<AgentEvent> {
    this.resetControllerIfAborted();
    const namespace = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const configuredExtensions = await resolveExtensions(this.config.plugins, this.registry, namespace);
    const extensions = mergeAgentRuntimeExtensions(this.config.extensions, configuredExtensions);
    const messages = [...this._messages];
    messages.push(
      typeof userMessage === 'string'
        ? { role: 'user' as const, content: [{ type: 'text' as const, text: userMessage }] }
        : userMessage,
    );

    for await (const event of agentLoop({
      ...this.config,
      extensions,
      language: this.language,
      tools: [...this.tools.values()],
      messages,
      controller: this._controller,
      sessionId: this._sessionId,
      runId: this._runId,
    })) {
      yield event;
      if (event.type === 'done' || event.type === 'error') this._messages = messages;
    }
  }

  async *continue(): AsyncGenerator<AgentEvent> {
    this.resetControllerIfAborted();
    const namespace = `continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const configuredExtensions = await resolveExtensions(this.config.plugins, this.registry, namespace);
    const extensions = mergeAgentRuntimeExtensions(this.config.extensions, configuredExtensions);
    const checkpoint = await this.loadResumeCheckpoint();
    const messages = checkpoint?.state.messages?.map((message) => ({ ...message })) ?? [...this._messages];
    for await (const event of agentLoop({
      ...this.config,
      extensions,
      language: this.language,
      tools: [...this.tools.values()],
      messages,
      controller: this._controller,
      sessionId: this._sessionId,
      runId: this._runId,
      resumeCheckpoint: checkpoint,
      skipInitialLlm: !checkpoint,
    })) {
      yield event;
      if (event.type === 'done' || event.type === 'error') this._messages = messages;
    }
  }

  async runSimple(userMessage: string): Promise<string> {
    let text = '';
    for await (const event of this.run(userMessage)) {
      if (event.type === 'text') text += event.content;
    }
    return text;
  }

  clearHistory(): void {
    this._messages = [];
  }
  replaceMessages(messages: LanguageMessage[]): void {
    this._messages = messages.slice();
  }

  private async loadResumeCheckpoint(): Promise<AgentRunCheckpoint | undefined> {
    const checkpoint = await this.config.durableStore?.loadCheckpoint(this._sessionId);
    if (!checkpoint) return undefined;
    if (checkpoint.schemaVersion !== AGENT_RUN_CHECKPOINT_SCHEMA_VERSION) return checkpoint;
    if (checkpoint.state.terminal) return undefined;
    if (!checkpoint.state.messages?.length) return undefined;
    return checkpoint;
  }

  private resetControllerIfAborted(): void {
    if (this._controller.isAborted) this._controller = new AgentLoopController();
  }
}
