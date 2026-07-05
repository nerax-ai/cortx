import type { LanguageClient } from '@synax-ai/core';
import type { LanguageTokenUsage } from '@synax-ai/sdk';
import {
  createEmptyAgentRuntimeExtensions,
  noopLogger,
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  type AgentRunCheckpoint,
  type AgentRuntimeExtensions,
  type LanguageMessage,
  type LanguageToolCallContent,
  type Tool,
} from '@cortx/sdk';
import type { CortxConfig, AgentController, AgentEvent } from './types.js';
import { AgentLoopController } from './types.js';
import { isToolCallContent } from './message-helpers.js';
import { applyTurnPolicies } from './loop/policy.js';
import { runModelPhase } from './loop/model-phase.js';
import { runCompletionPhase } from './loop/completion-phase.js';
import { prepareToolPhase } from './loop/tool-prepare-phase.js';
import { executeToolPhase } from './loop/tool-execute-phase.js';
import { userAbortEvent, maxIterationsEvent } from './loop/control.js';
import {
  createTurnDeadline,
  emitPhaseEvent,
  runLoopPhaseGenerator,
  type AgentLoopPhaseName,
  type AgentLoopRuntime,
} from './loop/pipeline.js';
import { userAbortError } from './loop/errors.js';

export interface AgentLoopOptions extends Omit<CortxConfig, 'plugins'> {
  language: LanguageClient;
  extensions?: AgentRuntimeExtensions;
  messages?: LanguageMessage[];
  controller?: AgentController;
  skipInitialLlm?: boolean;
  sessionId?: string;
  resumeCheckpoint?: AgentRunCheckpoint;
}

export async function* agentLoop(opts: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    language,
    model,
    system,
    tools = [],
    extensions = createEmptyAgentRuntimeExtensions(),
    messages: inputMessages = [],
    maxIterations = 20,
    maxOutputTokens,
    temperature,
    workingDirectory = process.cwd(),
    logger = noopLogger,
    askUser,
    controller,
    skipInitialLlm = false,
  } = opts;

  if (opts.resumeCheckpoint?.state.messages) {
    inputMessages.length = 0;
    for (const message of opts.resumeCheckpoint.state.messages) inputMessages.push({ ...message });
  }
  const messages = inputMessages;
  const pendingToolResults: import('@cortx/sdk').LanguageToolResultContent[] =
    opts.resumeCheckpoint?.state.pendingToolResults?.map((result) => ({ ...result })) ?? [];
  const allTools = [...tools, ...extensions.tools];
  const toolMap = new Map<string, Tool>(allTools.map((t) => [t.name, t]));
  const sessionId =
    opts.sessionId ??
    opts.resumeCheckpoint?.sessionId ??
    `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const abortController = new AbortController();
  const runtime: AgentLoopRuntime = {
    language,
    model,
    maxOutputTokens,
    temperature,
    workingDirectory,
    extensions,
    logger,
    sessionId,
    abortController,
    controller,
    askUser,
    autoContinueLimit: opts.autoContinueLimit,
    toolResultBudget: opts.toolResultBudget,
    maxConcurrentTools: opts.maxConcurrentTools,
    maxConcurrentAgents: opts.maxConcurrentAgents,
    tracer: opts.tracer,
    recorder: opts.recorder,
    durableStore: opts.durableStore,
    limits: opts.limits,
    runId: opts.runId,
  };
  const removeAbortListener = controller?.onAbort?.((reason) => {
    if (!abortController.signal.aborted) abortController.abort(userAbortError(reason));
  });

  async function emitLoopEvent(
    event: AgentEvent,
    phase: AgentLoopPhaseName,
    currentIteration = iteration,
  ): Promise<AgentEvent> {
    return emitPhaseEvent(runtime, phase, currentIteration, event);
  }

  let resolvedSystem = system ?? '';
  for (const contribution of extensions.systemTransforms) {
    const result = await contribution.transformSystem({ system: resolvedSystem });
    resolvedSystem = result.system;
  }
  const systemMessages: LanguageMessage[] = resolvedSystem
    ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: resolvedSystem }] }]
    : [];
  let iteration = 0;
  let resumeFromToolCalls: LanguageToolCallContent[] | undefined;
  let isResuming = false;
  runtime.checkpointState = {
    snapshot: () => ({
      messages: messages.map((message) => ({ ...message })),
      pendingToolResults: pendingToolResults.length ? [...pendingToolResults] : undefined,
    }),
  };

  try {
    if (opts.resumeCheckpoint && opts.resumeCheckpoint.schemaVersion !== AGENT_RUN_CHECKPOINT_SCHEMA_VERSION) {
      const e: AgentEvent = {
        type: 'error',
        error: new Error(`Unsupported checkpoint schema version: ${opts.resumeCheckpoint.schemaVersion}`),
        code: 'client_error',
      };
      yield await emitLoopEvent(e, 'control', iteration);
      return;
    }

    if (pendingToolResults.length) {
      messages.push({ role: 'tool', content: pendingToolResults.splice(0) });
    }

    // If skipInitialLlm, extract tool calls from last assistant message
    if (skipInitialLlm) {
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
        resumeFromToolCalls = Array.from(last.content as Iterable<unknown>).filter(isToolCallContent);
      }
      if (!resumeFromToolCalls?.length) {
        const e: AgentEvent = {
          type: 'error',
          error: new Error('continue() requires last message to be an assistant message with tool calls'),
          code: 'stream_error',
        };
        yield await emitLoopEvent(e, 'control', iteration);
        return;
      }
    }

    const autoContinueLimit = opts.autoContinueLimit ?? 2;
    let autoContinueCount = 0;
    let retryCount = 0;
    const maxRetries = opts.limits?.maxRetries ?? 1;
    let overflowRecoveryCount = 0;
    const maxOverflowRecoveries = opts.limits?.maxOverflowRecoveries ?? 3;
    const maxIterationLimit = opts.limits?.maxIterations ?? maxIterations;

    mainLoop: while (true) {
      const ctrl = controller;
      if (ctrl?.isAborted) {
        const e = userAbortEvent(ctrl.abortReason);
        yield await emitLoopEvent(e, 'control');
        return;
      }
      if (iteration >= maxIterationLimit) {
        const e = maxIterationsEvent(maxIterationLimit);
        yield await emitLoopEvent(e, 'control');
        return;
      }
      iteration++;
      isResuming = false;
      runtime.turnDeadline = createTurnDeadline(iteration, opts.limits?.turnTimeoutMs, abortController);
      const turnStart: AgentEvent = { type: 'turn_start', iteration };
      yield await emitLoopEvent(turnStart, 'turn');

      const turnPolicy = await applyTurnPolicies(extensions, { sessionId, iteration, messages: [...messages] });
      if (turnPolicy.action === 'deny') {
        const e: AgentEvent = {
          type: 'error',
          error: new Error(turnPolicy.reason),
          code: turnPolicy.code ?? 'client_error',
        };
        yield await emitLoopEvent(e, 'policy');
        return;
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
        const modelOutcome = yield* runLoopPhaseGenerator(
          runtime,
          'model',
          { iteration },
          runModelPhase({
            runtime,
            systemMessages,
            messages,
            tools: allTools,
            iteration,
            retryCount,
            maxRetries,
            overflowRecoveryCount,
            maxOverflowRecoveries,
          }),
          (outcome) =>
            outcome.action === 'terminal' && outcome.event.type === 'error' ? outcome.event.error : undefined,
        );
        retryCount = modelOutcome.retryCount;
        overflowRecoveryCount = modelOutcome.overflowRecoveryCount;
        if (modelOutcome.action === 'recoveredContext') continue mainLoop;
        if (modelOutcome.action === 'retry') {
          await new Promise((r) => setTimeout(r, modelOutcome.delayMs ?? 1000));
          continue mainLoop;
        }
        if (modelOutcome.action === 'terminal') {
          yield await emitLoopEvent(modelOutcome.event, 'model');
          return;
        }

        textBuffer = modelOutcome.textBuffer;
        thinkingBuffer = modelOutcome.thinkingBuffer;
        toolCalls.push(...modelOutcome.toolCalls);
        finishReason = modelOutcome.finishReason;
        usage = modelOutcome.usage;
        if (exceedsTokenBudget(usage, opts.limits?.tokenBudget)) {
          const e: AgentEvent = {
            type: 'error',
            error: new Error(`Token budget exceeded (${opts.limits?.tokenBudget})`),
            code: 'budget_exceeded',
          };
          yield await emitLoopEvent(e, 'model');
          return;
        }
      }

      const isToolUse = toolCalls.length > 0;
      logger.info(
        `[loop] iter=${iteration} finishReason=${finishReason} isToolUse=${isToolUse} toolCalls=${toolCalls.length} textLen=${textBuffer.length}`,
      );

      if (!isToolUse || !toolCalls.length) {
        const completionOutcome = yield* runLoopPhaseGenerator(
          runtime,
          'completion',
          { iteration, finishReason },
          runCompletionPhase({
            runtime,
            finishReason,
            thinkingBuffer,
            textBuffer,
            usage,
            autoContinueCount,
            autoContinueLimit,
            messages,
            iteration,
          }),
        );
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
        ? (q: string) => askUser(q)
        : controller instanceof AgentLoopController
          ? (_q: string, tcId: string) => controller.registerQuestion(tcId)
          : undefined;
      runtime.askUserForTool = resolvedAskUser;
      const baseCtx = {
        sessionId,
        runId: opts.runId,
        workingDirectory,
        logger,
        signal: abortController.signal,
        toolTimeoutMs: opts.limits?.toolTimeoutMs,
        askUser: resolvedAskUser,
      };
      const agentCallCount = toolCalls.filter((tc) => tc.toolName === 'agent').length;
      if (agentCallCount > 0)
        logger.info(`[loop] agent tool_calls in this turn: ${agentCallCount} (concurrent batching requires >1)`);

      const prepareOutcome = yield* runLoopPhaseGenerator(
        runtime,
        'tool.prepare',
        { iteration, toolCallCount: toolCalls.length },
        prepareToolPhase({
          runtime,
          toolCalls,
          toolMap,
          iteration,
        }),
        (outcome) => (outcome.action === 'interrupted' ? outcome.interruption.event : undefined),
      );
      if (prepareOutcome.action === 'interrupted') {
        yield await emitLoopEvent(prepareOutcome.interruption.event, 'control');
        if (prepareOutcome.interruption.action === 'steered') {
          messages.push(...prepareOutcome.interruption.messages);
          continue mainLoop;
        }
        return;
      }

      const maxConcurrentAgents = Math.max(1, opts.maxConcurrentAgents ?? 3);
      const executeOutcome = yield* runLoopPhaseGenerator(
        runtime,
        'tool.execute',
        { iteration, pendingToolCount: prepareOutcome.pendingTools.length },
        executeToolPhase({
          runtime,
          pendingTools: prepareOutcome.pendingTools,
          baseContext: baseCtx,
          checkpointToolResults: pendingToolResults,
          budget,
          maxConcurrentTools: maxConcurrent,
          maxConcurrentAgents,
          iteration,
        }),
        (outcome) => (outcome.action === 'interrupted' ? outcome.interruption.event : undefined),
      );
      if (executeOutcome.action === 'interrupted') {
        yield await emitLoopEvent(executeOutcome.interruption.event, 'control');
        if (executeOutcome.interruption.action === 'steered') {
          messages.push(...executeOutcome.interruption.messages);
          continue mainLoop;
        }
        return;
      }

      const toolResults = executeOutcome.toolResults;
      if (toolResults.length) messages.push({ role: 'tool', content: toolResults });
      pendingToolResults.length = 0;
      const turnEnd: AgentEvent = { type: 'turn_end', iteration, toolCallCount: toolCalls.length };
      yield await emitLoopEvent(turnEnd, 'turn');
    }
  } finally {
    removeAbortListener?.();
  }
}

function exceedsTokenBudget(usage: LanguageTokenUsage | undefined, tokenBudget: number | undefined): boolean {
  if (tokenBudget === undefined) return false;
  const used = (usage?.inputTokens.total ?? 0) + (usage?.outputTokens.total ?? 0);
  return used > tokenBudget;
}
