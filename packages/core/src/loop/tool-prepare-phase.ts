import type {
  AgentEvent,
  LanguageToolCallContent,
  Logger,
  Tool,
  ToolContext,
} from '@cortx/sdk';
import { AgentEventQueue, drainQueuedEvents } from './events.js';
import { checkControlInterruption, type ControlInterruption } from './control.js';
import { applyToolPolicies } from './policy.js';
import {
  parseToolInput,
  parseToolInputError,
  toolDecisionOutput,
  type PendingToolExecution,
} from './tool-phase.js';
import { emitPhaseEvent, withTurnDeadline, type AgentLoopPhaseInput } from './pipeline.js';

export type ToolPrepareOutcome =
  | { action: 'prepared'; pendingTools: PendingToolExecution[] }
  | { action: 'interrupted'; interruption: Exclude<ControlInterruption, { action: 'none' }>; pendingTools: PendingToolExecution[] };

export interface ToolPreparePhaseInput extends AgentLoopPhaseInput {
  toolCalls: LanguageToolCallContent[];
  toolMap: Map<string, Tool>;
  iteration: number;
}

export async function* prepareToolPhase(input: ToolPreparePhaseInput): AsyncGenerator<AgentEvent, ToolPrepareOutcome> {
  const { toolCalls, toolMap, runtime, iteration } = input;
  const { sessionId, workingDirectory = process.cwd(), logger, extensions, controller } = runtime;
  const askUser = runtime.askUserForTool;
  const pendingTools: PendingToolExecution[] = [];

  for (const toolCall of toolCalls) {
    const interruption = checkControlInterruption(controller);
    if (interruption.action !== 'none') {
      return { action: 'interrupted', interruption, pendingTools };
    }

    const toolUseEvent: AgentEvent = { type: 'tool_use', toolCall };
    yield await emitPhaseEvent(runtime, 'tool.prepare', iteration, toolUseEvent);

    const tool = toolMap.get(toolCall.toolName);
    if (!tool) {
      pendingTools.push({
        tc: toolCall,
        beforeProgress: [],
        readyOutput: { progressMessages: [], finalOutput: `Unknown tool: ${toolCall.toolName}`, isError: true },
      });
      continue;
    }

    const beforeProgress: string[] = [];
    const toolContext = createToolContext({ toolCall, tool, sessionId, workingDirectory, logger, beforeProgress, askUser });
    let skipped = false;
    let inputError = parseToolInputError(toolCall.input);
    let parsedInput = inputError ? {} : parseToolInput(toolCall.input);

    if (!inputError) {
      const queue = new AgentEventQueue();
      const policyToolContext: ToolContext = {
        ...toolContext,
        askUser: askUser ? (question: string) => {
          queue.push({ type: 'user_question', question, toolCallId: toolCall.toolCallId });
          return askUser(question, toolCall.toolCallId);
        } : undefined,
      };
      const policyResult = yield* drainQueuedEvents(
        withTurnDeadline(
          runtime.turnDeadline,
          applyToolPolicies(extensions, {
            sessionId,
            toolCall: { ...toolCall },
            tool,
            input: parsedInput,
            toolContext: policyToolContext,
          }),
        ),
        queue,
        extensions,
        logger,
        runtime,
        'tool.prepare',
        iteration,
      );
      if (policyResult.action === 'readyOutput') {
        pendingTools.push({
          tc: toolCall,
          beforeProgress: [],
          readyOutput: {
            ...policyResult.output,
            progressMessages: beforeProgress.concat(policyResult.output.progressMessages),
          },
        });
        continue;
      }
      if (policyResult.action === 'invalidInput') {
        pendingTools.push({
          tc: toolCall,
          beforeProgress: [],
          readyOutput: { progressMessages: beforeProgress, finalOutput: policyResult.message, isError: true },
        });
        continue;
      }
      if (policyResult.action === 'allow' && policyResult.input !== undefined) {
        toolCall.input = policyResult.input;
        inputError = undefined;
        parsedInput = parseToolInput(policyResult.input);
      }
    }

    for (const contribution of extensions.toolBefores) {
      let result;
      try {
        const queue = new AgentEventQueue();
        const hookContext: ToolContext = {
          ...toolContext,
          askUser: askUser ? (question: string) => {
            queue.push({ type: 'user_question', question, toolCallId: toolCall.toolCallId });
            return askUser(question, toolCall.toolCallId);
          } : undefined,
        };
        result = yield* drainQueuedEvents(
          withTurnDeadline(
            runtime.turnDeadline,
            Promise.resolve().then(() => contribution.beforeToolExecute({
              toolCall: { ...toolCall },
              tool,
              input: parsedInput,
              toolContext: hookContext,
            })),
          ),
          queue,
          extensions,
          logger,
          runtime,
          'tool.prepare',
          iteration,
        );
      } catch (error) {
        pendingTools.push({
          tc: toolCall,
          beforeProgress: [],
          readyOutput: {
            progressMessages: beforeProgress,
            finalOutput: error instanceof Error ? error.message : String(error),
            isError: true,
          },
        });
        skipped = true;
        break;
      }

      if (!result || result.action === 'allow') continue;
      if (result.action === 'rewrite' && result.input !== undefined) {
        const rewriteError = parseToolInputError(result.input);
        if (rewriteError) {
          pendingTools.push({
            tc: toolCall,
            beforeProgress: [],
            readyOutput: { progressMessages: beforeProgress, finalOutput: rewriteError, isError: true },
          });
          skipped = true;
          break;
        }
        toolCall.input = result.input;
        inputError = undefined;
        parsedInput = parseToolInput(result.input);
        continue;
      }
      if (result.action === 'deny' || result.action === 'shortCircuit') {
        const rawResult = 'result' in result ? result.result : undefined;
        pendingTools.push({
          tc: toolCall,
          beforeProgress: [],
          readyOutput: {
            ...toolDecisionOutput(
              result.action,
              rawResult,
              result.action === 'deny' ? result.reason : undefined,
              result.action === 'shortCircuit' ? result.isError : true,
            ),
            progressMessages: beforeProgress,
          },
        });
        skipped = true;
        break;
      }
    }

    if (skipped) continue;
    if (inputError) {
      pendingTools.push({
        tc: toolCall,
        beforeProgress: [],
        readyOutput: { progressMessages: beforeProgress, finalOutput: inputError, isError: true },
      });
      continue;
    }

    pendingTools.push({ tc: toolCall, tool, beforeProgress });
  }

  return { action: 'prepared', pendingTools };
}

function createToolContext(input: {
  toolCall: LanguageToolCallContent;
  tool: Tool;
  sessionId: string;
  workingDirectory: string;
  logger: Logger;
  beforeProgress: string[];
  askUser?: (question: string, toolCallId: string) => Promise<string>;
}): ToolContext {
  const { toolCall, tool, sessionId, workingDirectory, logger, beforeProgress, askUser } = input;
  return {
    sessionId,
    toolCallId: toolCall.toolCallId,
    workingDirectory,
    logger: logger.scope(tool.name),
    reportProgress: (text) => beforeProgress.push(text),
    askUser: askUser ? (question: string) => askUser(question, toolCall.toolCallId) : undefined,
  };
}
