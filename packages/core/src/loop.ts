import type { LanguageClient } from '@synax-ai/core';
import type { LanguageTokenUsage } from '@synax-ai/sdk';
import type { Logger, CortxPlugin, LanguageMessage, LanguageToolCallContent, LanguageToolResultContent, Tool, ToolContext, ErrorCode } from '@cortx/sdk';
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

interface ToolExecOutput {
  progressMessages: string[];
  finalOutput: string;
  isError: boolean;
}

async function runToolCall(
  tc: LanguageToolCallContent,
  tool: Tool,
  plugins: CortxPlugin[],
  baseCtx: { sessionId: string; workingDirectory: string; logger: Logger; askUser?: CortxConfig['askUser'] },
  budget: number,
): Promise<ToolExecOutput> {
  const progressMessages: string[] = [];
  const ctx: ToolContext = {
    sessionId: baseCtx.sessionId,
    workingDirectory: baseCtx.workingDirectory,
    logger: baseCtx.logger.scope(tc.toolName),
    reportProgress: (t) => progressMessages.push(t),
    askUser: baseCtx.askUser,
  };

  try {
    const parsed = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input;
    const input: Record<string, unknown> = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed : {};
    let result = await tool.execute(input, ctx);

    let output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
    if (output.length > budget) {
      const marker = `\n\n... (truncated, ${output.length} chars total) ...\n\n`;
      const window = Math.max(0, Math.floor((budget - marker.length) / 2));
      output = window === 0 ? output.slice(0, budget) : `${output.slice(0, window)}${marker}${output.slice(-window)}`;
      result = { ...result, output };
    }
    for (const p of plugins) result = (await p['tool.execute.after']?.(tc, result)) ?? result;

    const finalOutput = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
    return { progressMessages, finalOutput, isError: !result.success };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { progressMessages, finalOutput: err, isError: true };
  }
}

function makeToolResult(tc: LanguageToolCallContent, output: ToolExecOutput): LanguageToolResultContent {
  return {
    type: 'tool-result',
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    output: output.isError ? { type: 'error-text', value: output.finalOutput } : { type: 'text', value: output.finalOutput },
    isError: output.isError,
  };
}

async function* emitToolOutput(tc: LanguageToolCallContent, output: ToolExecOutput, plugins: CortxPlugin[]): AsyncGenerator<AgentEvent> {
  for (const text of output.progressMessages) {
    const e: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
    await emit(plugins, e); yield e;
  }
  const e: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: output.finalOutput, isError: output.isError };
  await emit(plugins, e); yield e;
}

async function emit(plugins: CortxPlugin[], event: AgentEvent): Promise<void> {
  for (const p of plugins) await p['event']?.(event);
}

function classifyError(e: unknown): ErrorCode {
  const err = e instanceof Error ? e : new Error(String(e));
  const msg = err.message.toLowerCase();
  const status = (err as { statusCode?: number; status?: number })?.statusCode ?? (err as { statusCode?: number; status?: number })?.status ?? 0;
  if (status === 413 || msg.includes('context length') || msg.includes('context window') || msg.includes('prompt is too long') || msg.includes('too many tokens')) return 'context_overflow';
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limited';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500 || msg.includes('503') || msg.includes('500') || msg.includes('server error')) return 'stream_error';
  return 'stream_error';
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
  const systemMessages: LanguageMessage[] = resolvedSystem ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: resolvedSystem }] }] : [];
  let iteration = 0;
  let resumeFromToolCalls: LanguageToolCallContent[] | undefined;
  let isResuming = false;

  // If skipInitialLlm, extract tool calls from last assistant message
  if (skipInitialLlm) {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && Array.isArray(last.content)) {
      resumeFromToolCalls = (last.content as unknown[]).filter((c): c is LanguageToolCallContent => typeof c === 'object' && c !== null && 'type' in c && c.type === 'tool-call');
    }
    if (!resumeFromToolCalls?.length) {
      const e: AgentEvent = { type: 'error', error: new Error('continue() requires last message to be an assistant message with tool calls'), code: 'stream_error' };
      await emit(plugins, e); yield e; return;
    }
  }

  const autoContinueLimit = opts.autoContinueLimit ?? 2;
  let autoContinueCount = 0;
  let retryCount = 0;
  const maxRetries = 1;
  let overflowRecoveryCount = 0;
  const maxOverflowRecoveries = 3;

  mainLoop: while (true) {
    const ctrl = controller;
    if (ctrl?.isAborted) {
      const e: AgentEvent = { type: 'error', error: new Error(ctrl.abortReason ?? 'aborted'), code: 'user_abort' };
      await emit(plugins, e); yield e; return;
    }
    if (iteration >= maxIterations) {
      const e: AgentEvent = { type: 'error', error: new Error(`Max iterations (${maxIterations}) reached`), code: 'max_iterations' };
      await emit(plugins, e); yield e; return;
    }
    iteration++;
    isResuming = false;
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
      isResuming = true;
      finishReason = 'tool-calls';
    } else {
      // Apply messages.transform hooks
      let transformedMessages: LanguageMessage[] = [...systemMessages, ...messages];
      for (const p of plugins) {
        if (p['messages.transform']) transformedMessages = await p['messages.transform'](transformedMessages);
      }
      // Sync plugin transforms (e.g., skill expansion) back to messages for persistence across turns
      const offset = systemMessages.length;
      for (let i = 0; i < messages.length && offset + i < transformedMessages.length; i++) {
        if (messages[i] !== transformedMessages[offset + i]) {
          messages[i] = transformedMessages[offset + i];
        }
      }

      try {
        for await (const part of language.stream({
          model,
          messages: transformedMessages,
          maxOutputTokens,
          temperature,
          tools: sdkTools.length ? sdkTools : undefined,
        })) {
          const p = part;
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
        const error = e instanceof Error ? e : new Error(String(e));
        const code = classifyError(e);

        // Context overflow: try context.overflow plugin hook
        if (code === 'context_overflow') {
          overflowRecoveryCount++;
          const overflowEvent: AgentEvent = { type: 'context_overflow', messages: [...messages] };
          await emit(plugins, overflowEvent); yield overflowEvent;

          const hasOverflowHook = plugins.some(p => p['context.overflow']);
          if (hasOverflowHook && overflowRecoveryCount <= maxOverflowRecoveries) {
            let compressed: LanguageMessage[] | null = null;
            for (const p of plugins) {
              const result = await p['context.overflow']?.([...messages]);
              if (result) { compressed = result; break; }
            }
            if (compressed) {
              messages.length = 0;
              for (const m of compressed) messages.push(m);
              continue mainLoop;
            }
          }

          const err: AgentEvent = { type: 'error', error, code: 'context_overflow' };
          await emit(plugins, err); yield err; return;
        }

        // Try error.recover plugin hook first
        let shouldRetry = false;
        let retryDelay = 1000;

        const hasRecoverHook = plugins.some(p => p['error.recover']);
        if (hasRecoverHook) {
          const errorEvent: AgentEvent & { type: 'error' } = { type: 'error', error, code };
          for (const p of plugins) {
            const result = await p['error.recover']?.(errorEvent);
            if (result?.retry && retryCount < maxRetries) { shouldRetry = true; retryDelay = result.delay ?? 1000; break; }
          }
        } else {
          // Default: retry once on rate_limited or server errors
          shouldRetry = (code === 'rate_limited' || code === 'stream_error') && retryCount < maxRetries;
        }

        if (shouldRetry) {
          retryCount++;
          await new Promise(r => setTimeout(r, retryDelay));
          continue mainLoop;
        }

        const err: AgentEvent = { type: 'error', error, code };
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
      retryCount = 0;
    }

    const isToolUse = finishReason === 'tool-calls';
    logger.info(`[loop] iter=${iteration} finishReason=${finishReason} isToolUse=${isToolUse} toolCalls=${toolCalls.length} textLen=${textBuffer.length}`);

    if (!isToolUse || !toolCalls.length) {
      // Auto-continue on output truncation
      const isTruncated = finishReason === 'length';
      if (isTruncated && autoContinueCount < autoContinueLimit) {
        autoContinueCount++;
        messages.push({
          role: 'assistant',
          content: [
            ...(thinkingBuffer ? [{ type: 'reasoning' as const, reasoning: thinkingBuffer }] : []),
            ...(textBuffer ? [{ type: 'text' as const, text: textBuffer }] : []),
          ],
        });
        messages.push({ role: 'user', content: [{ type: 'text' as const, text: 'Continue where you left off.' }] });
        const e: AgentEvent = { type: 'follow_up', message: 'auto-continue (output truncated)' };
        await emit(plugins, e); yield e;
        const te: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
        await emit(plugins, te); yield te;
        continue mainLoop;
      }
      // Non-truncated turn: reset auto-continue budget
      if (!isTruncated) autoContinueCount = 0;

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

    if (!isResuming) {
    messages.push({
      role: 'assistant',
      content: [
        ...(thinkingBuffer ? [{ type: 'reasoning' as const, reasoning: thinkingBuffer }] : []),
        ...(textBuffer ? [{ type: 'text' as const, text: textBuffer }] : []),
        ...toolCalls,
      ],
    });
    }

    const toolResults: LanguageToolResultContent[] = [];
    const maxConcurrent = opts.maxConcurrentTools ?? 5;
    const budget = opts.toolResultBudget ?? 10240;
    const baseCtx = { sessionId, workingDirectory, logger, askUser };

    // Phase 1: Emit tool_use events, run before hooks, group by side effect level
    const parallelPending: { tc: LanguageToolCallContent; tool: Tool }[] = [];
    const serialPending: { tc: LanguageToolCallContent; tool: Tool }[] = [];

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
        const e: AgentEvent = { type: 'error', error: new Error(ctrl.abortReason ?? 'aborted'), code: 'user_abort' };
        await emit(plugins, e); yield e; return;
      }

      const tuEvent: AgentEvent = { type: 'tool_use', toolCall: tc };
      await emit(plugins, tuEvent); yield tuEvent;

      const tool = toolMap.get(tc.toolName);
      if (!tool) {
        const err = `Unknown tool: ${tc.toolName}`;
        const e: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: err, isError: true };
        await emit(plugins, e); yield e;
        toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: 'error-text', value: err }, isError: true });
        continue;
      }

      // tool.execute.before
      const beforeProgress: string[] = [];
      const ctx: ToolContext = { sessionId, workingDirectory, logger: logger.scope(tc.toolName), reportProgress: (t) => beforeProgress.push(t), askUser };
      let skipped = false;
      for (const p of plugins) {
        const r = await p['tool.execute.before']?.(tc, ctx);
        if (r?.skip) {
          const out = r.result ?? 'skipped';
          for (const text of beforeProgress) {
            const pe: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
            await emit(plugins, pe); yield pe;
          }
          const e: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: out, isError: false };
          await emit(plugins, e); yield e;
          toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: 'text', value: out }, isError: false });
          skipped = true;
          break;
        }
      }
      if (skipped) continue;

      // Emit any progress from before hooks
      for (const text of beforeProgress) {
        const pe: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
        await emit(plugins, pe); yield pe;
      }

      const se = tool.sideEffects ?? 'write';
      if ((se === 'none' || se === 'read') && parallelPending.length < maxConcurrent) {
        parallelPending.push({ tc, tool });
      } else {
        serialPending.push({ tc, tool });
      }
    }

    // Phase 2: Execute parallel group (read-only tools)
    if (parallelPending.length > 0) {
      const settled = await Promise.allSettled(
        parallelPending.map(({ tc, tool }) => runToolCall(tc, tool, plugins, baseCtx, budget)),
      );
      for (let i = 0; i < parallelPending.length; i++) {
        const { tc } = parallelPending[i];
        const s = settled[i];
        const output: ToolExecOutput = s.status === 'fulfilled'
          ? s.value
          : { progressMessages: [], finalOutput: s.reason instanceof Error ? s.reason.message : String(s.reason), isError: true };
        yield* emitToolOutput(tc, output, plugins);
        toolResults.push(makeToolResult(tc, output));
      }
    }

    // Phase 3: Execute serial group (write/destructive tools)
    // Detect parallelizable agent batches within the serial queue
    const maxConcurrentAgents = Math.max(1, opts.maxConcurrentAgents ?? 3);
    let serialIdx = 0;
    while (serialIdx < serialPending.length) {
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
        const e: AgentEvent = { type: 'error', error: new Error(ctrl.abortReason ?? 'aborted'), code: 'user_abort' };
        await emit(plugins, e); yield e; return;
      }

      const { tc, tool } = serialPending[serialIdx];

      // Check for consecutive agent calls to batch
      if (tc.toolName === 'agent') {
        const agentBatch: { tc: LanguageToolCallContent; tool: Tool }[] = [];
        while (serialIdx < serialPending.length && serialPending[serialIdx].tc.toolName === 'agent' && agentBatch.length < maxConcurrentAgents) {
          agentBatch.push(serialPending[serialIdx]);
          serialIdx++;
        }

        if (agentBatch.length > 1) {
          // Execute multiple agents concurrently
          const agentOutputs = await Promise.allSettled(
            agentBatch.map(({ tc: agentTc, tool: agentTool }) => runToolCall(agentTc, agentTool, plugins, baseCtx, budget)),
          );
          for (let i = 0; i < agentBatch.length; i++) {
            const { tc: agentTc } = agentBatch[i];
            const settled = agentOutputs[i];
            const output: ToolExecOutput = settled.status === 'fulfilled'
              ? settled.value
              : { progressMessages: [], finalOutput: settled.reason instanceof Error ? settled.reason.message : String(settled.reason), isError: true };
            yield* emitToolOutput(agentTc, output, plugins);
            toolResults.push(makeToolResult(agentTc, output));
          }
          continue;
        }
      } else {
        serialIdx++;
      }

      const output = await runToolCall(tc, tool, plugins, baseCtx, budget);
      yield* emitToolOutput(tc, output, plugins);
      toolResults.push(makeToolResult(tc, output));
    }

    if (toolResults.length) messages.push({ role: 'tool', content: toolResults });
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: toolCalls.length };
    await emit(plugins, turnEnd); yield turnEnd;
  }
}
