import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentController, CortxConfig, CortxRegistry } from './types.js';
import type { AgentRunCheckpoint, LanguageMessage, Tool, ToolResult } from '@cortx/sdk';
import {
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  formatToolSummary,
  mergeAgentRuntimeExtensions,
  type AgentRuntimeExtensions,
} from '@cortx/sdk';
import { AgentLoopController } from './types.js';
import { agentLoop } from './loop.js';
import { discoverSkills } from './skill/discover.js';
import { createSkillExtensions } from './skill/plugin.js';
import { SubAgentSessionStore } from './sub-agent-session.js';
import { createUserMessage } from './message-helpers.js';
import { getRegistry, resolveExtensions } from './plugin-resolver.js';

async function runSubAgentLoop(
  loopOpts: Parameters<typeof agentLoop>[0],
  session: import('./sub-agent-session.js').SubAgentSession,
  toolCallId: string,
  reportProgress: ((text: string) => void) | undefined,
  onAgentEvent: ((event: AgentEvent) => void) | undefined,
): Promise<void> {
  for await (const event of agentLoop(loopOpts)) {
    session.events.push(event);
    if (event.type === 'turn_start') {
      session.iterations = event.iteration;
    }
    if (event.type === 'tool_use') {
      session.toolCallCount++;
      const summary = formatToolSummary(event.toolCall.toolName, event.toolCall.input, { maxLength: 60 });
      const progressText = `  → ${event.toolCall.toolName}${summary ? ': ' + summary : ''}`;
      reportProgress?.(progressText);
      onAgentEvent?.({ type: 'agent_progress', toolCallId, text: progressText });
    }
    if (event.type === 'text') session.output += event.content;
    if (event.type === 'error') throw event.error;
    if (event.type === 'done') break;
  }
}

export class Cortx {
  private readonly language: LanguageClient;
  private readonly config: CortxConfig;
  private readonly registry: CortxRegistry;
  private readonly tools = new Map<string, Tool>();
  private _messages: LanguageMessage[] = [];
  private readonly _sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  private _controller = new AgentLoopController();
  private _skillExtensions: AgentRuntimeExtensions | null = null;
  readonly agentSessions = new SubAgentSessionStore();
  onAgentEvent?: (event: AgentEvent) => void;

  constructor(language: LanguageClient, config: CortxConfig) {
    this.language = language;
    this.config = config;
    this.registry = getRegistry(config);
    for (const t of config.tools ?? []) this.tools.set(t.name, t);
    this.tools.set('agent', this.createAgentTool());
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
    const namespace = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const configuredExtensions = await resolveExtensions(this.config.plugins, this.registry, namespace);

    const cwd = this.config.workingDirectory ?? process.cwd();
    const skills = await discoverSkills(cwd, this.config);
    this._skillExtensions = skills.length ? createSkillExtensions(skills) : null;

    const extensions = mergeAgentRuntimeExtensions(this._skillExtensions, configuredExtensions);
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
    })) {
      yield event;
      if (event.type === 'done' || event.type === 'error') this._messages = messages;
    }
  }

  async *continue(): AsyncGenerator<AgentEvent> {
    const namespace = `continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const configuredExtensions = await resolveExtensions(this.config.plugins, this.registry, namespace);
    const extensions = mergeAgentRuntimeExtensions(this._skillExtensions, configuredExtensions);
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
    if (checkpoint.schemaVersion !== AGENT_RUN_CHECKPOINT_SCHEMA_VERSION) return undefined;
    if (checkpoint.state.terminal) return undefined;
    if (!checkpoint.state.messages?.length) return undefined;
    return checkpoint;
  }

  private async applySubAgentPolicies(input: {
    sessionId: string;
    parentToolCallId: string;
    prompt: string;
    description: string;
    isBackground: boolean;
    extensions: AgentRuntimeExtensions;
  }): Promise<ToolResult | undefined> {
    for (const policy of input.extensions.sessionPolicies) {
      if (!policy.beforeSubAgent) continue;
      const decision = await policy.beforeSubAgent({
        sessionId: input.sessionId,
        parentToolCallId: input.parentToolCallId,
        prompt: input.prompt,
        description: input.description,
        isBackground: input.isBackground,
      });
      if (!decision || decision.action === 'allow') continue;
      if (decision.action === 'deny') {
        const result = decision.result;
        if (typeof result === 'object' && result !== null) return result;
        return { success: false, error: String(result ?? decision.reason ?? 'Denied by session policy') };
      }
    }
    return undefined;
  }

  private createAgentTool(): Tool {
    const language = this.language;
    const config = this.config;
    const cortx = this;
    const getTools = () => [...this.tools.values()].filter((t) => t.name !== 'agent');

    return {
      name: 'agent',
      description:
        'Launch a sub-agent to handle a complex sub-task that requires multiple tool calls in isolation. ONLY use this when the task is too complex for a single tool call and you need an autonomous loop. For simple questions, code explanations, and straightforward tasks, respond directly without using this tool.',
      sideEffects: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task description for the sub-agent' },
          description: { type: 'string', description: 'Short description (3-5 words) of the task' },
          run_in_background: {
            type: 'boolean',
            description: 'Start the agent in the background and return immediately. The agent will run asynchronously.',
          },
        },
        required: ['prompt'],
      },
      async execute(input: Record<string, unknown>, ctx): Promise<ToolResult> {
        const prompt = input.prompt as string;
        if (!prompt || typeof prompt !== 'string') {
          return { success: false, error: 'Parameter "prompt" is required and must be a non-empty string.' };
        }

        const desc = (input.description as string | undefined) ?? 'sub-agent';
        const isBackground = input.run_in_background === true;
        const toolCallId = ctx.toolCallId;
        const inheritedExtensions = await resolveExtensions(config.plugins, cortx.registry, `agent-${toolCallId}`);
        const childExtensions = mergeAgentRuntimeExtensions(cortx._skillExtensions, inheritedExtensions);
        const policyResult = await cortx.applySubAgentPolicies({
          sessionId: ctx.sessionId,
          parentToolCallId: toolCallId,
          prompt,
          description: desc,
          isBackground,
          extensions: childExtensions,
        });
        if (policyResult) return policyResult;

        const session = cortx.agentSessions.create(toolCallId, desc, isBackground, ctx.sessionId);

        ctx.reportProgress?.(`⏳ ${desc}: starting...`);
        cortx.onAgentEvent?.({ type: 'agent_started', toolCallId, description: desc, isBackground });

        const subSystem = `You are a sub-agent. Complete the task using available tools.`;
        const childController = new AgentLoopController();
        const abortChild = () => childController.abort('parent aborted');
        if (ctx.signal?.aborted) abortChild();
        ctx.signal?.addEventListener('abort', abortChild, { once: true });
        const loopOpts = {
          language,
          model: config.model,
          system: subSystem,
          tools: getTools(),
          extensions: childExtensions,
          messages: [createUserMessage(prompt)],
          workingDirectory: ctx.workingDirectory,
          logger: ctx.logger,
          maxIterations: 10,
          maxOutputTokens: config.maxOutputTokens,
          controller: childController,
          limits: config.limits,
        };

        if (isBackground) {
          (async () => {
            try {
              await runSubAgentLoop(loopOpts, session, toolCallId, undefined, cortx.onAgentEvent?.bind(cortx));
              cortx.agentSessions.complete(toolCallId, false);
              cortx.onAgentEvent?.({
                type: 'agent_completed',
                toolCallId,
                output: session.output,
                iterations: session.iterations,
                toolCallCount: session.toolCallCount,
              });
            } catch (e) {
              ctx.logger.error(`Background agent "${desc}" failed: ${e instanceof Error ? e.message : String(e)}`);
              cortx.agentSessions.complete(toolCallId, true);
              cortx.onAgentEvent?.({
                type: 'agent_completed',
                toolCallId,
                output: '',
                iterations: session.iterations,
                toolCallCount: session.toolCallCount,
                isError: true,
              });
            } finally {
              ctx.signal?.removeEventListener('abort', abortChild);
            }
          })();

          return { success: true, output: `Background agent started: ${desc} [ID: ${toolCallId}]` };
        }

        try {
          const turnProgress = (text: string) => ctx.reportProgress?.(text);
          await runSubAgentLoop(loopOpts, session, toolCallId, turnProgress, cortx.onAgentEvent?.bind(cortx));

          ctx.reportProgress?.(
            `✓ ${desc}: done (${session.iterations} iterations, ${session.toolCallCount} tool calls)`,
          );
          cortx.agentSessions.complete(toolCallId, false);
          cortx.onAgentEvent?.({
            type: 'agent_completed',
            toolCallId,
            output: session.output,
            iterations: session.iterations,
            toolCallCount: session.toolCallCount,
          });

          const preview =
            session.output.length > 800
              ? session.output.slice(0, 800) + `\n... (${session.output.length} chars total)`
              : session.output;
          return { success: true, output: preview || '(sub-agent produced no text output)' };
        } catch (e) {
          cortx.agentSessions.complete(toolCallId, true);
          cortx.onAgentEvent?.({
            type: 'agent_completed',
            toolCallId,
            output: '',
            iterations: session.iterations,
            toolCallCount: session.toolCallCount,
            isError: true,
          });
          ctx.reportProgress?.(`✗ ${desc}: failed`);
          return { success: false, error: `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}` };
        } finally {
          ctx.signal?.removeEventListener('abort', abortChild);
        }
      },
    };
  }
}
