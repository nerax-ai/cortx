import type { LanguageClient } from '@synax-ai/core';
import type { LanguageTokenUsage } from '@synax-ai/sdk';
import {
  createEmptyAgentRuntimeExtensions,
  noopLogger,
  type AgentRuntimeExtensions,
  type LanguageMessage,
  type LanguageToolCallContent,
  type LanguageToolResultContent,
  type Logger,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ErrorCode,
} from '@cortx/sdk';
import type { CortxConfig, AgentController, AgentEvent } from './types.js';
import { AgentLoopController } from './types.js';
import { isToolCallContent } from './message-helpers.js';

export interface AgentLoopOptions extends Omit<CortxConfig, 'plugins'> {
  language: LanguageClient;
  extensions?: AgentRuntimeExtensions;
  messages?: LanguageMessage[];
  controller?: AgentController;
  skipInitialLlm?: boolean;
}

interface ToolExecOutput {
  progressMessages: string[];
  finalOutput: string;
  isError: boolean;
}

interface PendingToolExecution {
  tc: LanguageToolCallContent;
  tool?: Tool;
  beforeProgress: string[];
  readyOutput?: ToolExecOutput;
}

function isReadOnlyTool(tool: Tool): boolean {
  const sideEffects = tool.sideEffects ?? 'write';
  return sideEffects === 'none' || sideEffects === 'read';
}

function formatToolResultOutput(result: ToolResult): string {
  const value = !result.success && result.output === undefined && result.error
    ? result.error
    : result.output;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function parseToolInput(input: LanguageToolCallContent['input']): Record<string, unknown> {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
}

function parseToolInputError(input: LanguageToolCallContent['input']): string | undefined {
  try {
    parseToolInput(input);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function withBeforeProgress(item: PendingToolExecution, output: ToolExecOutput): ToolExecOutput {
  return {
    ...output,
    progressMessages: [...item.beforeProgress, ...output.progressMessages],
  };
}

async function runToolCall(
  tc: LanguageToolCallContent,
  tool: Tool,
  extensions: AgentRuntimeExtensions,
  baseCtx: { sessionId: string; workingDirectory: string; logger: Logger; askUser?: (question: string, toolCallId: string) => Promise<string> },
  budget: number,
): Promise<ToolExecOutput> {
  const progressMessages: string[] = [];
  const ctx: ToolContext = {
    sessionId: baseCtx.sessionId,
    toolCallId: tc.toolCallId,
    workingDirectory: baseCtx.workingDirectory,
    logger: baseCtx.logger.scope(tc.toolName),
    reportProgress: (t) => progressMessages.push(t),
    askUser: baseCtx.askUser ? (q: string) => baseCtx.askUser!(q, tc.toolCallId) : undefined,
  };

  try {
    const input = parseToolInput(tc.input);
    let result = await tool.execute(input, ctx);

    let output = formatToolResultOutput(result);
    if (output.length > budget) {
      const marker = `\n\n... (truncated, ${output.length} chars total) ...\n\n`;
      const window = Math.max(0, Math.floor((budget - marker.length) / 2));
      output = window === 0 ? output.slice(0, budget) : `${output.slice(0, window)}${marker}${output.slice(-window)}`;
      result = { ...result, output };
    }
    for (const contribution of extensions.toolAfters) {
      const afterResult = await contribution.afterToolExecute({ toolCall: tc, tool, result });
      result = afterResult.result;
    }

    const finalOutput = formatToolResultOutput(result);
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

async function* emitToolOutput(tc: LanguageToolCallContent, output: ToolExecOutput, extensions: AgentRuntimeExtensions, logger: Logger): AsyncGenerator<AgentEvent> {
  for (const text of output.progressMessages) {
    const e: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
    await emit(extensions, e, logger); yield e;
  }
  const e: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: output.finalOutput, isError: output.isError };
  await emit(extensions, e, logger); yield e;
}

async function* executePendingOutput(
  item: PendingToolExecution,
  output: ToolExecOutput,
  extensions: AgentRuntimeExtensions,
  toolResults: LanguageToolResultContent[],
  logger: Logger,
): AsyncGenerator<AgentEvent> {
  yield* emitToolOutput(item.tc, output, extensions, logger);
  toolResults.push(makeToolResult(item.tc, output));
}

async function emit(extensions: AgentRuntimeExtensions, event: AgentEvent, logger: Logger): Promise<void> {
  const observerLogger = logger.scope('agent.eventObserver');
  for (const observer of extensions.eventObservers) {
    try {
      await observer.onAgentEvent(event);
    } catch (error) {
      observerLogger.warn(`agent.eventObserver failed for ${event.type}`, error);
    }
  }
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
    extensions = createEmptyAgentRuntimeExtensions(),
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

  const allTools = [...tools, ...extensions.tools];
  const toolMap = new Map<string, Tool>(allTools.map((t) => [t.name, t]));
  const sdkTools = allTools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  let resolvedSystem = system ?? '';
  for (const contribution of extensions.systemTransforms) {
    const result = await contribution.transformSystem({ system: resolvedSystem });
    resolvedSystem = result.system;
  }
  const systemMessages: LanguageMessage[] = resolvedSystem ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: resolvedSystem }] }] : [];
  let iteration = 0;
  let resumeFromToolCalls: LanguageToolCallContent[] | undefined;
  let isResuming = false;

  // If skipInitialLlm, extract tool calls from last assistant message
  if (skipInitialLlm) {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && Array.isArray(last.content)) {
      resumeFromToolCalls = Array.from(last.content as Iterable<unknown>).filter(isToolCallContent);
    }
    if (!resumeFromToolCalls?.length) {
      const e: AgentEvent = { type: 'error', error: new Error('continue() requires last message to be an assistant message with tool calls'), code: 'stream_error' };
      await emit(extensions, e, logger); yield e; return;
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
      await emit(extensions, e, logger); yield e; return;
    }
    if (iteration >= maxIterations) {
      const e: AgentEvent = { type: 'error', error: new Error(`Max iterations (${maxIterations}) reached`), code: 'max_iterations' };
      await emit(extensions, e, logger); yield e; return;
    }
    iteration++;
    isResuming = false;
    const turnStart: AgentEvent = { type: 'turn_start', iteration };
    await emit(extensions, turnStart, logger); yield turnStart;

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
      let transformedMessages: LanguageMessage[] = [...systemMessages, ...messages];
      for (const contribution of extensions.messagesTransforms) {
        const result = await contribution.transformMessages({ messages: transformedMessages });
        transformedMessages = result.messages;
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
            await emit(extensions, e, logger);
            yield e;
          } else if (p.type === 'reasoning-delta') {
            thinkingBuffer += p.delta;
            const e: AgentEvent = { type: 'thinking_delta', delta: p.delta };
            await emit(extensions, e, logger);
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

        // Context overflow recovery is separate from ordinary stream retry.
        if (code === 'context_overflow') {
          overflowRecoveryCount++;
          const overflowEvent: AgentEvent = { type: 'context_overflow', messages: [...messages] };
          await emit(extensions, overflowEvent, logger); yield overflowEvent;

          if (extensions.contextOverflows.length && overflowRecoveryCount <= maxOverflowRecoveries) {
            let compressed: LanguageMessage[] | null = null;
            for (const contribution of extensions.contextOverflows) {
              const result = await contribution.handleContextOverflow({ messages: [...messages] });
              if (result.action === 'recover') {
                compressed = result.messages;
                break;
              }
            }
            if (compressed) {
              messages.length = 0;
              for (const m of compressed) messages.push(m);
              continue mainLoop;
            }
          }

          const err: AgentEvent = { type: 'error', error, code: 'context_overflow' };
          await emit(extensions, err, logger); yield err; return;
        }

        // Let configured recovery policies decide before falling back to core defaults.
        let shouldRetry = false;
        let retryDelay = 1000;

        if (extensions.errorRecovers.length) {
          const errorEvent: AgentEvent & { type: 'error' } = { type: 'error', error, code };
          for (const contribution of extensions.errorRecovers) {
            const result = await contribution.recoverError({ event: errorEvent, error, code });
            if (result.action === 'retry' && retryCount < maxRetries) {
              shouldRetry = true;
              retryDelay = result.delayMs ?? 1000;
              break;
            }
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
        await emit(extensions, err, logger); yield err; return;
      }

      if (thinkingBuffer) {
        const e: AgentEvent = { type: 'thinking', content: thinkingBuffer };
        await emit(extensions, e, logger); yield e;
      }
      if (textBuffer) {
        const e: AgentEvent = { type: 'text', content: textBuffer };
        await emit(extensions, e, logger); yield e;
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
        await emit(extensions, e, logger); yield e;
        const te: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
        await emit(extensions, te, logger); yield te;
        continue mainLoop;
      }
      // Non-truncated turn: reset auto-continue budget
      if (!isTruncated) autoContinueCount = 0;

      if (controller?.hasFollowUps) {
        for (const msg of controller.consumeFollowUps()) {
          messages.push(msg);
          const e: AgentEvent = { type: 'follow_up', message: typeof msg.content === 'string' ? msg.content : 'follow-up' };
          await emit(extensions, e, logger); yield e;
        }
        const te: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
        await emit(extensions, te, logger); yield te;
        continue mainLoop;
      }
      const te: AgentEvent = { type: 'turn_end', iteration, toolCallCount: 0 };
      await emit(extensions, te, logger); yield te;
      const done: AgentEvent = {
        type: 'done',
        usage: usage ? { inputTokens: usage.inputTokens.total ?? 0, outputTokens: usage.outputTokens.total ?? 0 } : undefined,
      };
      await emit(extensions, done, logger); yield done;
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
    const resolvedAskUser = askUser
      ? (q: string, tcId: string) => askUser(q)
      : controller instanceof AgentLoopController
        ? (q: string, tcId: string) => {
            const e: AgentEvent = { type: 'user_question', question: q, toolCallId: tcId };
            void emit(extensions, e, logger);
            return controller.registerQuestion(tcId);
          }
        : undefined;
    const baseCtx = { sessionId, workingDirectory, logger, askUser: resolvedAskUser };

    // Phase 1: Emit tool_use events and run before hooks in model order.
    const pendingTools: PendingToolExecution[] = [];
    const agentCallCount = toolCalls.filter(tc => tc.toolName === 'agent').length;
    if (agentCallCount > 0) logger.info(`[loop] agent tool_calls in this turn: ${agentCallCount} (concurrent batching requires >1)`);

    for (const tc of toolCalls) {
      const ctrl = controller;
      if (ctrl?.isSteered) {
        const steerMsgs = ctrl.consumeSteering();
        const label = typeof steerMsgs[0]?.content === 'string' ? steerMsgs[0].content : 'steered';
        const e: AgentEvent = { type: 'steered', message: label };
        await emit(extensions, e, logger); yield e;
        messages.push(...steerMsgs);
        continue mainLoop;
      }
      if (ctrl?.isAborted) {
        const e: AgentEvent = { type: 'error', error: new Error(ctrl.abortReason ?? 'aborted'), code: 'user_abort' };
        await emit(extensions, e, logger); yield e; return;
      }

      const tuEvent: AgentEvent = { type: 'tool_use', toolCall: tc };
      await emit(extensions, tuEvent, logger); yield tuEvent;

      const tool = toolMap.get(tc.toolName);
      if (!tool) {
        const err = `Unknown tool: ${tc.toolName}`;
        pendingTools.push({
          tc,
          beforeProgress: [],
          readyOutput: { progressMessages: [], finalOutput: err, isError: true },
        });
        continue;
      }

      const beforeProgress: string[] = [];
      const ctx: ToolContext = { sessionId, toolCallId: tc.toolCallId, workingDirectory, logger: logger.scope(tc.toolName), reportProgress: (t) => beforeProgress.push(t), askUser: resolvedAskUser ? (q: string) => resolvedAskUser(q, tc.toolCallId) : undefined };
      let skipped = false;
      let inputError = parseToolInputError(tc.input);
      let parsedInput = inputError ? {} : parseToolInput(tc.input);
      for (const contribution of extensions.toolBefores) {
        let r;
        try {
          r = await contribution.beforeToolExecute({ toolCall: { ...tc }, tool, input: parsedInput, toolContext: ctx });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pendingTools.push({
            tc,
            beforeProgress: [],
            readyOutput: { progressMessages: beforeProgress, finalOutput: message, isError: true },
          });
          skipped = true;
          break;
        }
        if (!r || r.action === 'allow') continue;
        if (r.action === 'rewrite' && r.input !== undefined) {
          const rewriteError = parseToolInputError(r.input);
          if (rewriteError) {
            pendingTools.push({
              tc,
              beforeProgress: [],
              readyOutput: { progressMessages: beforeProgress, finalOutput: rewriteError, isError: true },
            });
            skipped = true;
            break;
          }
          tc.input = r.input;
          inputError = undefined;
          parsedInput = parseToolInput(r.input);
          continue;
        }
        if (r.action === 'deny' || r.action === 'shortCircuit') {
          const rawResult = 'result' in r ? r.result : undefined;
          const result = typeof rawResult === 'object' && rawResult !== null
            ? rawResult
            : {
                success: r.action === 'shortCircuit' && r.isError !== true,
                output: rawResult ?? (r.action === 'deny' ? r.reason ?? 'Denied' : 'short-circuited'),
              };
          const out = formatToolResultOutput(result);
          pendingTools.push({
            tc,
            beforeProgress: [],
            readyOutput: {
              progressMessages: beforeProgress,
              finalOutput: out,
              isError: r.action === 'deny' || !result.success,
            },
          });
          skipped = true;
          break;
        }
      }
      if (skipped) continue;
      if (inputError) {
        pendingTools.push({
          tc,
          beforeProgress: [],
          readyOutput: { progressMessages: beforeProgress, finalOutput: inputError, isError: true },
        });
        continue;
      }

      pendingTools.push({ tc, tool, beforeProgress });
    }

    // Phase 2: Execute ordered batches. Contiguous read-only spans may run in
    // parallel, but no read is allowed to jump ahead of an earlier write.
    const maxConcurrentAgents = Math.max(1, opts.maxConcurrentAgents ?? 3);
    let pendingIdx = 0;
    while (pendingIdx < pendingTools.length) {
      const ctrl = controller;
      if (ctrl?.isSteered) {
        const steerMsgs = ctrl.consumeSteering();
        const label = typeof steerMsgs[0]?.content === 'string' ? steerMsgs[0].content : 'steered';
        const e: AgentEvent = { type: 'steered', message: label };
        await emit(extensions, e, logger); yield e;
        messages.push(...steerMsgs);
        continue mainLoop;
      }
      if (ctrl?.isAborted) {
        const e: AgentEvent = { type: 'error', error: new Error(ctrl.abortReason ?? 'aborted'), code: 'user_abort' };
        await emit(extensions, e, logger); yield e; return;
      }

      const item = pendingTools[pendingIdx];
      if (item.readyOutput) {
        pendingIdx++;
        yield* executePendingOutput(item, item.readyOutput, extensions, toolResults, logger);
        continue;
      }

      const { tc, tool } = item;
      if (!tool) {
        pendingIdx++;
        continue;
      }

      if (isReadOnlyTool(tool)) {
        const readBatch: PendingToolExecution[] = [];
        while (
          pendingIdx < pendingTools.length &&
          pendingTools[pendingIdx].tool &&
          isReadOnlyTool(pendingTools[pendingIdx].tool!) &&
          readBatch.length < maxConcurrent
        ) {
          readBatch.push(pendingTools[pendingIdx]);
          pendingIdx++;
        }

        const settled = await Promise.allSettled(
          readBatch.map((readItem) => runToolCall(readItem.tc, readItem.tool!, extensions, baseCtx, budget)),
        );
        for (let i = 0; i < readBatch.length; i++) {
          const readItem = readBatch[i];
          const settledOutput = settled[i];
          const output: ToolExecOutput = settledOutput.status === 'fulfilled'
            ? settledOutput.value
            : { progressMessages: [], finalOutput: settledOutput.reason instanceof Error ? settledOutput.reason.message : String(settledOutput.reason), isError: true };
          yield* executePendingOutput(readItem, withBeforeProgress(readItem, output), extensions, toolResults, logger);
        }
        continue;
      }

      // Check for consecutive agent calls to batch
      if (tc.toolName === 'agent') {
        const agentBatch: PendingToolExecution[] = [];
        let agentIdx = pendingIdx;
        while (
          agentIdx < pendingTools.length &&
          pendingTools[agentIdx].tool &&
          !isReadOnlyTool(pendingTools[agentIdx].tool!) &&
          pendingTools[agentIdx].tc.toolName === 'agent' &&
          agentBatch.length < maxConcurrentAgents
        ) {
          agentBatch.push(pendingTools[agentIdx]);
          agentIdx++;
        }

        if (agentBatch.length > 1) {
          pendingIdx = agentIdx;
          // Execute multiple agents concurrently
          const agentOutputs = await Promise.allSettled(
            agentBatch.map((agentItem) => runToolCall(agentItem.tc, agentItem.tool!, extensions, baseCtx, budget)),
          );
          for (let i = 0; i < agentBatch.length; i++) {
            const agentItem = agentBatch[i];
            const settled = agentOutputs[i];
            const output: ToolExecOutput = settled.status === 'fulfilled'
              ? settled.value
              : { progressMessages: [], finalOutput: settled.reason instanceof Error ? settled.reason.message : String(settled.reason), isError: true };
            yield* executePendingOutput(agentItem, withBeforeProgress(agentItem, output), extensions, toolResults, logger);
          }
          continue;
        }
      }

      pendingIdx++;
      const output = await runToolCall(tc, tool, extensions, baseCtx, budget);
      yield* executePendingOutput(item, withBeforeProgress(item, output), extensions, toolResults, logger);
    }

    if (toolResults.length) messages.push({ role: 'tool', content: toolResults });
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: toolCalls.length };
    await emit(extensions, turnEnd, logger); yield turnEnd;
  }
}
