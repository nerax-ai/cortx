import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentController, CortxConfig } from './types.js';
import type { AgentRunCheckpoint, LanguageMessage, Tool } from '@cortx/sdk';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION, createEmptyAgentRuntimeExtensions } from '@cortx/sdk';
import { AgentLoopController } from './types.js';
import { agentLoop } from './loop.js';

type ResumeCheckpointResult =
  | { kind: 'none' }
  | { kind: 'checkpoint'; checkpoint: AgentRunCheckpoint }
  | { kind: 'unsupported_schema'; schemaVersion: number };

export class Cortx {
  private readonly language: LanguageClient;
  private readonly config: CortxConfig;
  private readonly tools = new Map<string, Tool>();
  private _messages: LanguageMessage[] = [];
  private readonly _sessionId: string;
  private _runId: number | undefined;
  private _controller = new AgentLoopController();
  onAgentEvent?: (event: AgentEvent) => void;

  constructor(language: LanguageClient, config: CortxConfig) {
    this.language = language;
    this.config = config;
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
    const extensions = this.config.extensions ?? createEmptyAgentRuntimeExtensions();
    const messages = [...this._messages];
    messages.push(
      typeof userMessage === 'string'
        ? { role: 'user' as const, content: [{ type: 'text' as const, text: userMessage }] }
        : userMessage,
    );

    try {
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
      }
    } finally {
      this._messages = messages;
    }
  }

  async *continue(): AsyncGenerator<AgentEvent> {
    this.resetControllerIfAborted();
    const extensions = this.config.extensions ?? createEmptyAgentRuntimeExtensions();
    const resumeCheckpoint = await this.loadResumeCheckpoint();
    if (resumeCheckpoint.kind === 'unsupported_schema') {
      yield {
        type: 'error',
        error: new Error(`Unsupported checkpoint schema version: ${resumeCheckpoint.schemaVersion}`),
        code: 'client_error',
      };
      return;
    }
    const checkpoint = resumeCheckpoint.kind === 'checkpoint' ? resumeCheckpoint.checkpoint : undefined;
    const messages = checkpoint?.state.messages?.map((message) => ({ ...message })) ?? [...this._messages];
    try {
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
      }
    } finally {
      this._messages = messages;
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

  private async loadResumeCheckpoint(): Promise<ResumeCheckpointResult> {
    const checkpoint = await this.config.durableStore?.loadCheckpoint(this._sessionId);
    if (!checkpoint) return { kind: 'none' };
    if (checkpoint.schemaVersion !== AGENT_RUN_CHECKPOINT_SCHEMA_VERSION) {
      return { kind: 'unsupported_schema', schemaVersion: checkpoint.schemaVersion };
    }
    if (checkpoint.state.terminal) return { kind: 'none' };
    if (!checkpoint.state.messages?.length) return { kind: 'none' };
    return { kind: 'checkpoint', checkpoint };
  }

  private resetControllerIfAborted(): void {
    if (this._controller.isAborted) this._controller = new AgentLoopController();
  }
}
