import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentController, CortxConfig, CortxPlugin, PluginEntry } from './types.js';
import type { LanguageMessage, Tool } from '@cortx/sdk';
import { AgentLoopController, isPluginConfig } from './types.js';
import { PluginRegistry } from '@nerax-ai/plugin';
import { agentLoop } from './loop.js';
import { discoverSkills } from './skill/discover.js';
import { createSkillPlugin } from './skill/plugin.js';

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
  private _skillPlugin: CortxPlugin | null = null;

  constructor(language: LanguageClient, config: CortxConfig) {
    this.language = language;
    this.config = config;
    for (const t of config.tools ?? []) this.tools.set(t.name, t);
    this.tools.set('agent', this.createAgentTool());
  }

  get messages(): LanguageMessage[] { return [...this._messages]; }
  get controller(): AgentController { return this._controller; }

  registerTool(tool: Tool): void { this.tools.set(tool.name, tool); }

  steer(message: string | LanguageMessage): void { this._controller.steer(message); }
  followUp(message: string | LanguageMessage): void { this._controller.followUp(message); }
  abort(reason?: string): void { this._controller.abort(reason); }

  async *run(userMessage: string | LanguageMessage): AsyncGenerator<AgentEvent> {
    const plugins = await resolvePlugins(this.config.plugins);

    // Discover skills and create skill plugin
    const cwd = this.config.workingDirectory ?? process.cwd();
    const skills = await discoverSkills(cwd, this.config);
    this._skillPlugin = skills.length ? createSkillPlugin(skills, cwd) : null;

    const allPlugins = this._skillPlugin ? [this._skillPlugin, ...plugins] : plugins;
    const messages = [...this._messages];
    messages.push(typeof userMessage === 'string' ? { role: 'user', content: userMessage } : userMessage);

    for await (const event of agentLoop({
      ...this.config,
      plugins: allPlugins,
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
    const allPlugins = this._skillPlugin ? [this._skillPlugin, ...plugins] : plugins;
    const messages = [...this._messages];
    for await (const event of agentLoop({
      ...this.config,
      plugins: allPlugins,
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

  private createAgentTool(): Tool {
    const language = this.language;
    const config = this.config;
    const getTools = () => [...this.tools.values()].filter(t => t.name !== 'agent');

    return {
      name: 'agent',
      description: 'Launch a sub-agent to handle a specific sub-task in isolation. The sub-agent has access to file tools (Read, Write, Edit, Bash, Grep, Find) and can perform research, analysis, or implementation work.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task description for the sub-agent' },
          description: { type: 'string', description: 'Short description (3-5 words) of the task' },
        },
        required: ['prompt'],
      },
      async execute(input: Record<string, unknown>, ctx): Promise<import('@cortx/sdk').ToolResult> {
        const prompt = input.prompt as string;
        if (!prompt || typeof prompt !== 'string') {
          return { success: false, error: 'Parameter "prompt" is required and must be a non-empty string.' };
        }

        const desc = (input.description as string | undefined) ?? 'sub-agent';
        ctx.reportProgress(`⏳ ${desc}: starting...`);
        const subSystem = `You are a sub-agent. Complete the task using available tools.`;

        let output = '';
        let iterations = 0;
        let toolCallCount = 0;
        try {
          for await (const event of agentLoop({
            language,
            model: config.model,
            system: subSystem,
            tools: getTools(),
            messages: [{ role: 'user', content: prompt } as unknown as LanguageMessage],
            workingDirectory: ctx.workingDirectory,
            logger: ctx.logger,
            maxIterations: 10,
            maxOutputTokens: config.maxOutputTokens,
          })) {
            if (event.type === 'turn_start') {
              iterations++;
              if (iterations > 1) ctx.reportProgress(`⏳ ${desc}: iteration ${iterations}...`);
            }
            if (event.type === 'tool_use') {
              toolCallCount++;
              const tcInput = typeof event.toolCall.input === 'string'
                ? (() => { try { return JSON.parse(event.toolCall.input); } catch { return {}; } })()
                : event.toolCall.input ?? {};
              const summary = event.toolCall.toolName === 'bash'
                ? String(tcInput.command ?? '').slice(0, 60)
                : event.toolCall.toolName === 'read' || event.toolCall.toolName === 'write' || event.toolCall.toolName === 'edit'
                  ? String(tcInput.file_path ?? tcInput.path ?? '')
                  : event.toolCall.toolName === 'grep'
                    ? String(tcInput.pattern ?? '').slice(0, 40)
                    : '';
              ctx.reportProgress(`  → ${event.toolCall.toolName}${summary ? ': ' + summary : ''}`);
            }
            if (event.type === 'text') output += event.content;
            if (event.type === 'done' || event.type === 'error') break;
          }
          ctx.reportProgress(`✓ ${desc}: done (${iterations} iterations, ${toolCallCount} tool calls)`);
          const preview = output.length > 800 ? output.slice(0, 800) + `\n... (${output.length} chars total)` : output;
          return { success: true, output: preview || '(sub-agent produced no text output)' };
        } catch (e) {
          ctx.reportProgress(`✗ ${desc}: failed`);
          return { success: false, error: `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    };
  }
}
