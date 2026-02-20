import type { LanguageClient } from '@synax-ai/core';
import type { AgentConfig, AgentEvent, AgentController, LanguageMessage, Tool } from '@cortx/sdk';
import { AgentLoopController } from '@cortx/sdk';
import { agentLoop } from './loop.js';

export class Agent {
  private readonly language: LanguageClient;
  private readonly config: Required<AgentConfig>;
  private readonly tools = new Map<string, Tool>();
  private _messages: LanguageMessage[] = [];
  private _controller = new AgentLoopController();

  constructor(language: LanguageClient, config: AgentConfig) {
    this.language = language;
    this.config = {
      model: config.model,
      system: config.system,
      tools: config.tools ?? [],
      maxIterations: config.maxIterations ?? 20,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      workingDirectory: config.workingDirectory ?? process.cwd(),
    };
    for (const t of this.config.tools) this.tools.set(t.name, t);
  }

  get messages(): LanguageMessage[] { return [...this._messages]; }
  get controller(): AgentController { return this._controller; }

  registerTool(tool: Tool): void { this.tools.set(tool.name, tool); }

  steer(message: string | LanguageMessage): void { this._controller.steer(message); }
  followUp(message: string | LanguageMessage): void { this._controller.followUp(message); }
  abort(reason?: string): void { this._controller.abort(reason); }

  async *run(userMessage: string | LanguageMessage): AsyncGenerator<AgentEvent> {
    const messages = [...this._messages];
    messages.push(typeof userMessage === 'string' ? { role: 'user', content: userMessage } : userMessage);

    for await (const event of agentLoop({
      ...this.config,
      language: this.language,
      tools: [...this.tools.values()],
      messages,
      controller: this._controller,
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

  clearHistory(): void { this._messages = []; }
}
