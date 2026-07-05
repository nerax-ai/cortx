import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, AgentRuntimeExtensions, LanguageMessage, Logger, Tool, ToolResult } from '@cortx/sdk';
import { formatToolSummary, mergeAgentRuntimeExtensions } from '@cortx/sdk';
import {
  AgentLoopController,
  agentLoop,
  resolveExtensions,
  type CortxRegistry,
  type PluginConfig,
} from '@cortx/core';
import type { SubAgentSession, SubAgentSessionStore } from './session-store.js';

export interface SubAgentToolOptions {
  language: LanguageClient;
  model: string;
  maxOutputTokens?: number;
  limits?: import('@cortx/sdk').AgentRunLimits;
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  getTools(): Tool[];
  getExtensions(): AgentRuntimeExtensions;
  agentSessions: SubAgentSessionStore;
  onAgentEvent(event: AgentEvent): void;
}

function createUserMessage(text: string): LanguageMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as LanguageMessage;
}

async function runSubAgentLoop(input: {
  loopOpts: Parameters<typeof agentLoop>[0];
  session: SubAgentSession;
  toolCallId: string;
  controller: AgentLoopController;
  bridgeAskUser?: (event: Extract<AgentEvent, { type: 'user_request' | 'user_question' }>) => Promise<void>;
  reportProgress?: (text: string) => void;
  onAgentEvent(event: AgentEvent): void;
}): Promise<void> {
  const { loopOpts, session, toolCallId, controller, bridgeAskUser, reportProgress, onAgentEvent } = input;
  const bridgedQuestions = new Set<string>();
  try {
    for await (const event of agentLoop(loopOpts)) {
      session.events.push(event);
      if (event.type === 'user_request' || event.type === 'user_question') {
        const requestId = event.type === 'user_request' ? event.request.requestId : event.toolCallId;
        if (!bridgedQuestions.has(requestId) && bridgeAskUser) {
          bridgedQuestions.add(requestId);
          await bridgeAskUser(event);
        }
        if (event.type === 'user_question' && bridgedQuestions.has(requestId)) {
          continue;
        }
      }
      if (event.type === 'turn_start') session.iterations = event.iteration;
      if (event.type === 'tool_use') {
        session.toolCallCount++;
        const summary = formatToolSummary(event.toolCall.toolName, event.toolCall.input, { maxLength: 60 });
        const progressText = `  -> ${event.toolCall.toolName}${summary ? ': ' + summary : ''}`;
        reportProgress?.(progressText);
        onAgentEvent({ type: 'agent_progress', toolCallId, text: progressText });
      }
      if (event.type === 'text') session.output += event.content;
      if (event.type === 'error') throw event.error;
      if (event.type === 'done') break;
    }
  } finally {
    controller.rejectPendingQuestions('Sub-agent loop completed');
  }
}

async function applySubAgentPolicies(input: {
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

export function createSubAgentTool(options: SubAgentToolOptions): Tool {
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
      const prompt = input.prompt;
      if (!prompt || typeof prompt !== 'string') {
        return { success: false, error: 'Parameter "prompt" is required and must be a non-empty string.' };
      }

      const description = (input.description as string | undefined) ?? 'sub-agent';
      const isBackground = input.run_in_background === true;
      const toolCallId = ctx.toolCallId;
      const pluginExtensions = options.registry
        ? await resolveExtensions(options.plugins, options.registry, `agent-${toolCallId}`)
        : undefined;
      const childExtensions = mergeAgentRuntimeExtensions(options.getExtensions(), pluginExtensions);
      const policyResult = await applySubAgentPolicies({
        sessionId: ctx.sessionId,
        parentToolCallId: toolCallId,
        prompt,
        description,
        isBackground,
        extensions: childExtensions,
      });
      if (policyResult) return policyResult;

      const session = options.agentSessions.create(toolCallId, description, isBackground, ctx.sessionId);
      ctx.reportProgress?.(`starting ${description}...`);
      options.onAgentEvent({ type: 'agent_started', toolCallId, description, isBackground });

      const childController = new AgentLoopController();
      const abortChild = () => childController.abort('parent aborted');
      if (ctx.signal?.aborted) abortChild();
      ctx.signal?.addEventListener('abort', abortChild, { once: true });
      const bridgeAskUser = ctx.askUser
        ? async (event: Extract<AgentEvent, { type: 'user_request' | 'user_question' }>) => {
            const childToolCallId = event.type === 'user_request' ? event.request.requestId : event.toolCallId;
            const question = event.type === 'user_request' ? event.request.prompt : event.question;
            const request =
              event.type === 'user_request'
                ? {
                    ...event.request,
                    requestId: toolCallId,
                    context: {
                      ...event.request.context,
                      parentToolCallId: toolCallId,
                      childToolCallId,
                    },
                  }
                : {
                    requestId: toolCallId,
                    kind: 'question' as const,
                    prompt: question,
                    context: { parentToolCallId: toolCallId, childToolCallId },
                  };
            options.onAgentEvent({ type: 'user_request', request });
            const response = await ctx.askUser!(question);
            childController.answerUser(childToolCallId, response);
          }
        : undefined;

      const loopOpts: Parameters<typeof agentLoop>[0] = {
        language: options.language,
        model: options.model,
        system: 'You are a sub-agent. Complete the task using available tools.',
        tools: options.getTools().filter((tool) => tool.name !== 'agent'),
        extensions: childExtensions,
        messages: [createUserMessage(prompt)],
        workingDirectory: ctx.workingDirectory,
        logger: ctx.logger as Logger,
        maxIterations: 10,
        maxOutputTokens: options.maxOutputTokens,
        controller: childController,
        limits: options.limits,
      };

      if (isBackground) {
        void (async () => {
          try {
            await runSubAgentLoop({
              loopOpts,
              session,
              toolCallId,
              controller: childController,
              bridgeAskUser,
              onAgentEvent: options.onAgentEvent,
            });
            options.agentSessions.complete(toolCallId, false);
            options.onAgentEvent({
              type: 'agent_completed',
              toolCallId,
              output: session.output,
              iterations: session.iterations,
              toolCallCount: session.toolCallCount,
            });
          } catch (error) {
            ctx.logger.error(`Background agent "${description}" failed: ${error instanceof Error ? error.message : String(error)}`);
            options.agentSessions.complete(toolCallId, true);
            options.onAgentEvent({
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

        return { success: true, output: `Background agent started: ${description} [ID: ${toolCallId}]` };
      }

      try {
        await runSubAgentLoop({
          loopOpts,
          session,
          toolCallId,
          controller: childController,
          bridgeAskUser,
          reportProgress: (text) => ctx.reportProgress?.(text),
          onAgentEvent: options.onAgentEvent,
        });

        ctx.reportProgress?.(`done ${description} (${session.iterations} iterations, ${session.toolCallCount} tool calls)`);
        options.agentSessions.complete(toolCallId, false);
        options.onAgentEvent({
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
      } catch (error) {
        options.agentSessions.complete(toolCallId, true);
        options.onAgentEvent({
          type: 'agent_completed',
          toolCallId,
          output: '',
          iterations: session.iterations,
          toolCallCount: session.toolCallCount,
          isError: true,
        });
        ctx.reportProgress?.(`failed ${description}`);
        return { success: false, error: `Sub-agent failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        ctx.signal?.removeEventListener('abort', abortChild);
      }
    },
  };
}
