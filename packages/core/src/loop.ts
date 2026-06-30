import type { LanguageClient } from '@synax-ai/core';
import type { LanguageTokenUsage } from '@synax-ai/sdk';
import {
  createEmptyAgentRuntimeExtensions,
  noopLogger,
  type AgentRuntimeExtensions,
  type LanguageMessage,
  type LanguageToolCallContent,
  type Tool,
} from '@cortx/sdk';
import type { CortxConfig, AgentController, AgentEvent } from './types.js';
import { AgentLoopController } from './types.js';
import { isToolCallContent } from './message-helpers.js';
import { emit } from './loop/events.js';
import { applyTurnPolicies } from './loop/policy.js';
import { runModelPhase } from './loop/model-phase.js';
import { runCompletionPhase } from './loop/completion-phase.js';
import { prepareToolPhase } from './loop/tool-prepare-phase.js';
import { executeToolPhase } from './loop/tool-execute-phase.js';
import { userAbortEvent, maxIterationsEvent } from './loop/control.js';

export interface AgentLoopOptions extends Omit<CortxConfig, 'plugins'> {
  language: LanguageClient;
  extensions?: AgentRuntimeExtensions;
  messages?: LanguageMessage[];
  controller?: AgentController;
  skipInitialLlm?: boolean;
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
      const e = userAbortEvent(ctrl.abortReason);
      await emit(extensions, e, logger); yield e; return;
    }
    if (iteration >= maxIterations) {
      const e = maxIterationsEvent(maxIterations);
      await emit(extensions, e, logger); yield e; return;
    }
    iteration++;
    isResuming = false;
    const turnStart: AgentEvent = { type: 'turn_start', iteration };
    await emit(extensions, turnStart, logger); yield turnStart;

    const turnPolicy = await applyTurnPolicies(extensions, { sessionId, iteration, messages: [...messages] });
    if (turnPolicy.action === 'deny') {
      const e: AgentEvent = { type: 'error', error: new Error(turnPolicy.reason), code: turnPolicy.code ?? 'client_error' };
      await emit(extensions, e, logger); yield e; return;
    }
    if (turnPolicy.action === 'rewriteMessages') {
      messages.length = 0;
      for (const message of turnPolicy.messages) messages.push(message);
    }

    const toolCalls: LanguageToolCallContent[] = [];
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
      const modelOutcome = yield* runModelPhase({
        language,
        model,
        systemMessages,
        messages,
        tools: allTools,
        maxOutputTokens,
        temperature,
        extensions,
        logger,
        sessionId,
        iteration,
        retryCount,
        maxRetries,
        overflowRecoveryCount,
        maxOverflowRecoveries,
      });
      retryCount = modelOutcome.retryCount;
      overflowRecoveryCount = modelOutcome.overflowRecoveryCount;
      if (modelOutcome.action === 'recoveredContext') continue mainLoop;
      if (modelOutcome.action === 'retry') {
        await new Promise(r => setTimeout(r, modelOutcome.delayMs ?? 1000));
        continue mainLoop;
      }
      if (modelOutcome.action === 'terminal') {
        await emit(extensions, modelOutcome.event, logger); yield modelOutcome.event; return;
      }

      textBuffer = modelOutcome.textBuffer;
      thinkingBuffer = modelOutcome.thinkingBuffer;
      toolCalls.push(...modelOutcome.toolCalls);
      finishReason = modelOutcome.finishReason;
      usage = modelOutcome.usage;
    }

    const isToolUse = finishReason === 'tool-calls';
    logger.info(`[loop] iter=${iteration} finishReason=${finishReason} isToolUse=${isToolUse} toolCalls=${toolCalls.length} textLen=${textBuffer.length}`);

    if (!isToolUse || !toolCalls.length) {
      const completionOutcome = yield* runCompletionPhase({
        finishReason,
        thinkingBuffer,
        textBuffer,
        usage,
        autoContinueCount,
        autoContinueLimit,
        messages,
        controller,
        iteration,
        extensions,
        logger,
      });
      autoContinueCount = completionOutcome.autoContinueCount;
      if (completionOutcome.action === 'continue') continue mainLoop;
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

    const maxConcurrent = opts.maxConcurrentTools ?? 5;
    const budget = opts.toolResultBudget ?? 10240;
    const resolvedAskUser = askUser
      ? (q: string, tcId: string) => askUser(q)
      : controller instanceof AgentLoopController
        ? (_q: string, tcId: string) => controller.registerQuestion(tcId)
        : undefined;
    const baseCtx = { sessionId, workingDirectory, logger, askUser: resolvedAskUser };
    const agentCallCount = toolCalls.filter(tc => tc.toolName === 'agent').length;
    if (agentCallCount > 0) logger.info(`[loop] agent tool_calls in this turn: ${agentCallCount} (concurrent batching requires >1)`);

    const prepareOutcome = yield* prepareToolPhase({
      toolCalls,
      toolMap,
      sessionId,
      workingDirectory,
      logger,
      extensions,
      controller,
      askUser: resolvedAskUser,
    });
    if (prepareOutcome.action === 'interrupted') {
      await emit(extensions, prepareOutcome.interruption.event, logger);
      yield prepareOutcome.interruption.event;
      if (prepareOutcome.interruption.action === 'steered') {
        messages.push(...prepareOutcome.interruption.messages);
        continue mainLoop;
      }
      return;
    }

    const maxConcurrentAgents = Math.max(1, opts.maxConcurrentAgents ?? 3);
    const executeOutcome = yield* executeToolPhase({
      pendingTools: prepareOutcome.pendingTools,
      extensions,
      baseContext: baseCtx,
      budget,
      maxConcurrentTools: maxConcurrent,
      maxConcurrentAgents,
      logger,
      controller,
    });
    if (executeOutcome.action === 'interrupted') {
      await emit(extensions, executeOutcome.interruption.event, logger);
      yield executeOutcome.interruption.event;
      if (executeOutcome.interruption.action === 'steered') {
        messages.push(...executeOutcome.interruption.messages);
        continue mainLoop;
      }
      return;
    }

    const toolResults = executeOutcome.toolResults;
    if (toolResults.length) messages.push({ role: 'tool', content: toolResults });
    const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: toolCalls.length };
    await emit(extensions, turnEnd, logger); yield turnEnd;
  }
}
