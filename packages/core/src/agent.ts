import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentController, CortxConfig, CortxPlugin } from './types.js';
import type { LanguageMessage, Tool } from '@cortx/sdk';
import { AgentLoopController, isPluginConfig } from './types.js';
import { PluginRegistry } from '@nerax-ai/plugin';
import { agentLoop } from './loop.js';
import { discoverSkills } from './skill/discover.js';
import { createSkillPlugin } from './skill/plugin.js';
import { SubAgentSessionStore } from './sub-agent-session.js';

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

function formatToolProgress(toolName: string, input: unknown): string {
  const parsed = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return {}; } })() : input ?? {};
  if (toolName === 'bash') return String(parsed.command ?? '').slice(0, 60);
  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') return String(parsed.file_path ?? parsed.path ?? '');
  if (toolName === 'grep') return String(parsed.pattern ?? '').slice(0, 40);
  return '';
}

interface SubAgentRunResult {
  output: string;
  iterations: number;
  toolCallCount: number;
}

async function runSubAgentLoop(
  loopOpts: Parameters<typeof agentLoop>[0],
  session: import('./sub-agent-session.js').SubAgentSession,
  toolCallId: string,
  reportProgress: ((text: string) => void) | undefined,
  onAgentEvent: ((event: AgentEvent) => void) | undefined,
): Promise<SubAgentRunResult> {
  for await (const event of agentLoop(loopOpts)) {
    session.events.push(event);
    if (event.type === 'turn_start') {
      session.iterations = event.iteration;
    }
    if (event.type === 'tool_use') {
      session.toolCallCount++;
      const summary = formatToolProgress(event.toolCall.toolName, event.toolCall.input);
      const progressText = `  → ${event.toolCall.toolName}${summary ? ': ' + summary : ''}`;
      reportProgress?.(progressText);
      onAgentEvent?.({ type: 'agent_progress', toolCallId, text: progressText });
    }
    if (event.type === 'text') session.output += event.content;
    if (event.type === 'done' || event.type === 'error') break;
  }
  return { output: session.output, iterations: session.iterations, toolCallCount: session.toolCallCount };
}

export class Cortx {
  private readonly language: LanguageClient;
  private readonly config: CortxConfig;
  private readonly tools = new Map<string, Tool>();
  private _messages: LanguageMessage[] = [];
  private _controller = new AgentLoopController();
  private _skillPlugin: CortxPlugin | null = null;
  readonly agentSessions = new SubAgentSessionStore();
  onAgentEvent?: (event: AgentEvent) => void;

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

    const cwd = this.config.workingDirectory ?? process.cwd();
    const skills = await discoverSkills(cwd, this.config);
    this._skillPlugin = skills.length ? createSkillPlugin(skills, cwd) : null;

    const allPlugins = this._skillPlugin ? [this._skillPlugin, ...plugins] : plugins;
    const messages = [...this._messages];
    messages.push(typeof userMessage === 'string' ? { role: 'user' as const, content: [{ type: 'text' as const, text: userMessage }] } : userMessage);

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
    const cortx = this;
    const getTools = () => [...this.tools.values()].filter(t => t.name !== 'agent');

    return {
      name: 'agent',
      description: 'Launch a sub-agent to handle a specific sub-task in isolation. The sub-agent has access to file tools (Read, Write, Edit, Bash, Grep, Find) and can perform research, analysis, or implementation work. IMPORTANT: When launching multiple independent sub-agents, issue ALL agent tool_calls in a single response so they execute concurrently. Do not wait for one agent to finish before calling the next if the tasks are independent. Each agent runs in its own isolated context.',
      sideEffects: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task description for the sub-agent' },
          description: { type: 'string', description: 'Short description (3-5 words) of the task' },
          run_in_background: { type: 'boolean', description: 'Start the agent in the background and return immediately. The agent will run asynchronously.' },
        },
        required: ['prompt'],
      },
      async execute(input: Record<string, unknown>, ctx): Promise<import('@cortx/sdk').ToolResult> {
        const prompt = input.prompt as string;
        if (!prompt || typeof prompt !== 'string') {
          return { success: false, error: 'Parameter "prompt" is required and must be a non-empty string.' };
        }

        const desc = (input.description as string | undefined) ?? 'sub-agent';
        const isBackground = input.run_in_background === true;
        const toolCallId = ctx.toolCallId;
        const session = cortx.agentSessions.create(toolCallId, desc, isBackground);

        ctx.reportProgress?.(`⏳ ${desc}: starting...`);
        cortx.onAgentEvent?.({ type: 'agent_started', toolCallId, description: desc, isBackground });

        const subSystem = `You are a sub-agent. Complete the task using available tools.`;
        const loopOpts = {
          language,
          model: config.model,
          system: subSystem,
          tools: getTools(),
          messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] } as unknown as LanguageMessage],
          workingDirectory: ctx.workingDirectory,
          logger: ctx.logger,
          maxIterations: 10,
          maxOutputTokens: config.maxOutputTokens,
        };

        if (isBackground) {
          (async () => {
            try {
              const result = await runSubAgentLoop(loopOpts, session, toolCallId, undefined, cortx.onAgentEvent?.bind(cortx));
              cortx.agentSessions.complete(toolCallId, false);
              cortx.onAgentEvent?.({ type: 'agent_completed', toolCallId, output: result.output, iterations: result.iterations, toolCallCount: result.toolCallCount });
            } catch {
              cortx.agentSessions.complete(toolCallId, true);
              cortx.onAgentEvent?.({ type: 'agent_completed', toolCallId, output: '', iterations: session.iterations, toolCallCount: session.toolCallCount, isError: true });
            }
          })();

          return { success: true, output: `Background agent started: ${desc} [ID: ${toolCallId}]` };
        }

        try {
          const turnProgress = (text: string) => ctx.reportProgress?.(text);
          const result = await runSubAgentLoop(loopOpts, session, toolCallId, turnProgress, cortx.onAgentEvent?.bind(cortx));

          ctx.reportProgress?.(`✓ ${desc}: done (${result.iterations} iterations, ${result.toolCallCount} tool calls)`);
          cortx.agentSessions.complete(toolCallId, false);
          cortx.onAgentEvent?.({ type: 'agent_completed', toolCallId, output: result.output, iterations: result.iterations, toolCallCount: result.toolCallCount });

          const preview = result.output.length > 800 ? result.output.slice(0, 800) + `\n... (${result.output.length} chars total)` : result.output;
          return { success: true, output: preview || '(sub-agent produced no text output)' };
        } catch (e) {
          cortx.agentSessions.complete(toolCallId, true);
          cortx.onAgentEvent?.({ type: 'agent_completed', toolCallId, output: '', iterations: session.iterations, toolCallCount: session.toolCallCount, isError: true });
          ctx.reportProgress?.(`✗ ${desc}: failed`);
          return { success: false, error: `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    };
  }
}
