import type { LanguageClient } from '@synax-ai/core';
import type { LanguageStreamPart, LanguageTokenUsage } from '@synax-ai/sdk';
import type { Logger, CortxPlugin, LanguageMessage, LanguageToolCallContent, LanguageToolResultContent, Tool, ToolContext } from '@cortx/sdk';
import type { CortxConfig, AgentController, AgentEvent } from './types.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  scope: function() { return this; },
};

export interface AgentLoopOptions extends Omit<CortxConfig, 'plugins'> {
  language: LanguageClient;
  plugins?: CortxPlugin[];
  messages?: LanguageMessage[];
  controller?: AgentController;
  skipInitialLlm?: boolean;
}

async function emit(plugins: CortxPlugin[], event: AgentEvent): Promise<void> {
  for (const p of plugins) await p['event']?.(event);
}

export async function* agentLoop(opts: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    language,
    model,
    system,
    tools = [],
    plugins = [],
    messages = [],
    maxIterations = 20,
    maxOutputTokens,
    temperature,
    workingDirectory = process.cwd(),
    logger = noopLogger,
    askUser,
    controller,
    skipInitialLlm = false,
  } = opts;

  // Merge plugin tools into toolMap
  const allTools = [...tools, ...plugins.flatMap((p) => p.tools ?? [])];
  const toolMap = new Map<string, Tool>(allTools.map((t) => [t.name, t]));
  const sdkTools = allTools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Apply system.transform hooks
  let resolvedSystem = system ?? '';
  for (const p of plugins) {
    if (p['system.transform']) resolvedSystem = await p['system.transform'](resolvedSystem);
  }
  const systemMessages: LanguageMessage[] = resolvedSystem ? [{ role: 'system', content: resolvedSystem }] : [];
  let iteration = 0;
  let resumeFromToolCalls: LanguageToolCallContent[] | undefined;

  // If skipInitialLlm, extract tool calls from last assistant message
  if (skipInitialLlm) {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && Array.isArray(last.content)) {
      resumeFromToolCalls = (last.content as LanguageToolCallContent[]).filter((c) => c.type === 'tool-call');
    }
    if (!resumeFromToolCalls?.length) {
      const e: AgentEvent = { type: 'error', error: new Error('continue() requires last message to be an assistant message with tool calls') };
      await emit(plugins, e); yield e; return;
    }
  }

  mainLoop: while (true) {
    const ctrl = controller;
    if (ctrl?.isAborted) {
      const e: AgentEvent = { type: 'error', error: new Error(ctrl.abortReason ?? 'aborted') };
      await emit(plugins, e); yield e; return;
    }
    if (iteration >= maxIterations) {
      const e: AgentEvent = { type: 'error', error: new Error(`Max iterations (${maxIterations}) reached`) };
      await emit(plugins, e); yield e; return;
    }
    iteration++;
    const turnStart: AgentEvent = { type: 'turn_start', iteration };
    await emit(plugins, turnStart); yield turnStart;

    // --- stream LLM response (or resume from persisted tool calls) ---
    const toolCalls: LanguageToolCallContent[] = [];
    const toolInputBuffers = new Map<string, { name: string; buf: string }>();
    let textBuffer = '';
    let thinkingBuffer = '';
    let finishReason: string | undefined;
    let usage: LanguageTokenUsage | undefined;

    if (resumeFromToolCalls) {
      toolCalls.push(...resumeFromToolCalls);
      resumeFromToolCalls = undefined;
      finishReason = 'tool-calls';
    } else {
      // Apply messages.transform hooks
      let transformedMessages: LanguageMessage[] = [...systemMessages, ...messages];
      for (const p of plugins) {
        if (p['messages.transform']) transformedMessages = await p['messages.transform'](transformedMessages);
      }

      try {
        for await (const part of language.stream({
          model,
          messages: transformedMessages,
          maxOutputTokens,
          temperature,
          tools: sdkTools.length ? sdkTools : undefined,
        })) {
          const p = part as LanguageStreamPart;
          if (p.type === 'tool-input-start' || p.type === 'tool-input-delta' || p.type === 'tool-input-end') {
            logger.debug(`[loop] ${p.type} id=${p.id} ${p.type === 'tool-input-delta' ? 'delta=' + JSON.stringify(p.delta) : ''}`);
          }
          if (p.type === 'text-delta') {
            textBuffer += p.delta;
            const e: AgentEvent = { type: 'text_delta', delta: p.delta };
            for (const pl of plugins) pl['event']?.(e);
            yield e;
          } else if (p.type === 'reasoning-delta') {
            thinkingBuffer += p.delta;
            const e: AgentEvent = { type: 'thinking_delta', delta: p.delta };
            for (const pl of plugins) pl['event']?.(e);
            yield e;
          } else if (p.type === 'tool-input-start') {
            toolInputBuffers.set(p.id, { name: p.toolName, buf: '' });
          } else if (p.type === 'tool-input-delta') {
            const entry = toolInputBuffers.get(p.id);
            if (entry) entry.buf += p.delta;
          } else if (p.type === 'tool-input-end') {
            const entry = toolInputBuffers.get(p.id);
            if (entry) {
              toolCalls.push({ type: 'tool-call', toolCallId: p.id, toolName: entry.name, input: entry.buf });
              toolInputBuffers.delete(p.id);
            }
          } else if (p.type === 'finish') {
            finishReason = p.finishReason ?? undefined;
            usage = p.usage;
          }
        }
      } catch (e) {
        const err: AgentEvent = { type: 'error', error: e instanceof Error ? e : new Error(String(e)) };
        await emit(plugins, err); yield err; return;
      }

      if (thinkingBuffer) {
        const e: AgentEvent = { type: 'thinking', content: thinkingBuffer };
        await emit(plugins, e); yield e;
      }
      if (textBuffer) {
        const e: AgentEvent = { type: 'text', content: textBuffer };
        await emit(plugins, e); yield e;
      }
    }

    const isToolUse = finishReason === 'tool-calls';

    if (!isToolUse || !toolCalls.length) {
      if (controller?.hasFollowUps) {
        for (const msg of controller.consumeFollowUps()) {
          messages.push(msg);
          const e: AgentEvent = { type: 'follow_up', message: typeof msg.content === 'string' ? msg.content : 'follow-up' };
          await emit(plugins, e); yield e;
        }
        const te: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
        await emit(plugins, te); yield te;
        continue mainLoop;
      }
      const te: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
      await emit(plugins, te); yield te;
      const done: AgentEvent = {
        type: 'done',
        usage: usage ? { inputTokens: usage.inputTokens.total ?? 0, outputTokens: usage.outputTokens.total ?? 0 } : undefined,
      };
      await emit(plugins, done); yield done;
      return;
    }

    messages.push({
      role: 'assistant',
      content: [
        ...(textBuffer ? [{ type: 'text' as const, text: textBuffer }] : []),
        ...toolCalls,
      ],
    });

    const toolResults: LanguageToolResultContent[] = [];

    for (const tc of toolCalls) {
      const ctrl = controller;
      if (ctrl?.isSteered) {
        const steerMsgs = ctrl.consumeSteering();
        const label = typeof steerMsgs[0]?.content === 'string' ? steerMsgs[0].content : 'steered';
        const e: AgentEvent = { type: 'steered', message: label };
        await emit(plugins, e); yield e;
        messages.push(...steerMsgs);
        continue mainLoop;
      }
      if (ctrl?.isAborted) {
        const e: AgentEvent = { type: 'error', error: new Error(ctrl.abortReason ?? 'aborted') };
        await emit(plugins, e); yield e; return;
      }

      const tuEvent: AgentEvent = { type: 'tool_use', toolCall: tc };
      await emit(plugins, tuEvent); yield tuEvent;

      const tool = toolMap.get(tc.toolName);
      if (!tool) {
        const err = `Unknown tool: ${tc.toolName}`;
        const e: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: err, isError: true };
        await emit(plugins, e); yield e;
        toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'error-text', value: err }, isError: true });
        continue;
      }

      // tool.execute.before
      const progressMessages: string[] = [];
      const ctx: ToolContext = { sessionId, workingDirectory, logger: logger.scope(tc.toolName), reportProgress: (t) => progressMessages.push(t), askUser };
      let skipped = false;
      for (const p of plugins) {
        const r = await p['tool.execute.before']?.(tc, ctx);
        if (r?.skip) {
          const out = r.result ?? 'skipped';
          const e: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: out, isError: false };
          await emit(plugins, e); yield e;
          toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'text', value: out }, isError: false });
          skipped = true;
          break;
        }
      }
      if (skipped) continue;

      try {
        const input = (typeof tc.input === 'string' ? (tc.input ? JSON.parse(tc.input) : {}) : tc.input ?? {}) as Record<string, unknown>;
        // Validate required parameters before executing the tool
        const requiredParams = tool.inputSchema?.required as string[] | undefined;
        if (requiredParams?.length) {
          const missingParams = requiredParams.filter(param => {
            const value = input[param];
            return value === undefined || value === null || value === '';
          });
          if (missingParams.length > 0) {
            const err = `Missing required parameter(s): ${missingParams.join(', ')}. Please provide valid values.`;
            const re: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: err, isError: true };
            await emit(plugins, re); yield re;
            toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'error-text', value: err }, isError: true });
            continue;
          }
        }
        
        let result = await tool.execute(input, ctx);

        for (const p of plugins) result = (await p['tool.execute.after']?.(tc, result)) ?? result;
        for (const text of progressMessages) {
          const e: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
          await emit(plugins, e); yield e;
        }
        const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
        const e: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: output, isError: !result.success };
        await emit(plugins, e); yield e;
        toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'text', value: output }, isError: !result.success });
      } catch (e) {
        for (const text of progressMessages) {
          const pe: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
          await emit(plugins, pe); yield pe;
        }
        const err = e instanceof Error ? e.message : String(e);
        const re: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: err, isError: true };
        await emit(plugins, re); yield re;
        toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'error-text', value: err }, isError: true });
      }
    }

    if (toolResults.length) messages.push({ role: 'tool', content: toolResults });
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: toolCalls.length };
    await emit(plugins, turnEnd); yield turnEnd;
  }
}
