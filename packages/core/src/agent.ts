import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentController, CortxConfig, CortxPlugin, PluginEntry } from './types.js';
import type { LanguageMessage, Tool } from '@cortx/sdk';
import { AgentLoopController, isPluginConfig } from './types.js';
import { PluginRegistry } from '@nerax-ai/plugin';
import { agentLoop } from './loop.js';

type CortxFactoryMap = { cortx: () => CortxPlugin | Promise<CortxPlugin> };

function getRegistry() {
  return PluginRegistry.getInstance<'cortx', CortxFactoryMap>();
}

async function resolvePlugins(entries: CortxConfig['plugins']): Promise<CortxPlugin[]> {
  if (!entries?.length) return [];
  return Promise.all(entries.map((e) =>
    isPluginConfig(e)
      ? getRegistry().create('cortx', e.use, e.use, e.options) as Promise<CortxPlugin>
      : Promise.resolve(e as CortxPlugin),
  ));
}

export class Cortx {
  private readonly language: LanguageClient;
  private readonly config: CortxConfig;
  private readonly tools = new Map<string, Tool>();
  private _messages: LanguageMessage[] = [];
  private _controller = new AgentLoopController();

  constructor(language: LanguageClient, config: CortxConfig) {
    this.language = language;
    this.config = config;
    for (const t of config.tools ?? []) this.tools.set(t.name, t);
  }

  get messages(): LanguageMessage[] { return [...this._messages]; }
  get controller(): AgentController { return this._controller; }

  registerTool(tool: Tool): void { this.tools.set(tool.name, tool); }

  steer(message: string | LanguageMessage): void { this._controller.steer(message); }
  followUp(message: string | LanguageMessage): void { this._controller.followUp(message); }
  abort(reason?: string): void { this._controller.abort(reason); }

  async *run(userMessage: string | LanguageMessage): AsyncGenerator<AgentEvent> {
    const plugins = await resolvePlugins(this.config.plugins);
    const messages = [...this._messages];
    messages.push(typeof userMessage === 'string' ? { role: 'user', content: userMessage } : userMessage);

    for await (const event of agentLoop({
      ...this.config,
      plugins,
      language: this.language,
      tools: [...this.tools.values()],
      messages,
      controller: this._controller,
    })) {
      yield event;
      if (event.type === 'done' || event.type === 'error') this._messages = messages;
    }
  }

  async *continue(): AsyncGenerator<AgentEvent> {
    const plugins = await resolvePlugins(this.config.plugins);
    const messages = [...this._messages];
    for await (const event of agentLoop({
      ...this.config,
      plugins,
      language: this.language,
      tools: [...this.tools.values()],
      messages,
      controller: this._controller,
      skipInitialLlm: true,
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
  replaceMessages(messages: LanguageMessage[]): void { this._messages = messages.slice(); }
}
