import type {
  AgentEvent,
  AgentRuntimeExtensions,
  LanguageToolCallContent,
  Logger,
  Tool,
  ToolContext,
} from '@cortx/sdk';
import type { AgentController } from '../types.js';
import { AgentEventQueue, drainQueuedEvents, emit } from './events.js';
import { checkControlInterruption, type ControlInterruption } from './control.js';
import { applyToolPolicies } from './policy.js';
import {
  parseToolInput,
  parseToolInputError,
  toolDecisionOutput,
  type PendingToolExecution,
} from './tool-phase.js';

export type ToolPrepareOutcome =
  | { action: 'prepared'; pendingTools: PendingToolExecution[] }
  | { action: 'interrupted'; interruption: Exclude<ControlInterruption, { action: 'none' }>; pendingTools: PendingToolExecution[] };

export interface ToolPreparePhaseInput {
  toolCalls: LanguageToolCallContent[];
  toolMap: Map<string, Tool>;
  sessionId: string;
  workingDirectory: string;
  logger: Logger;
  extensions: AgentRuntimeExtensions;
  controller?: AgentController;
  askUser?: (question: string, toolCallId: string) => Promise<string>;
}

export async function* prepareToolPhase(input: ToolPreparePhaseInput): AsyncGenerator<AgentEvent, ToolPrepareOutcome> {
  const { toolCalls, toolMap, sessionId, workingDirectory, logger, extensions, controller, askUser } = input;
  const pendingTools: PendingToolExecution[] = [];

  for (const toolCall of toolCalls) {
    const interruption = checkControlInterruption(controller);
    if (interruption.action !== 'none') {
      return { action: 'interrupted', interruption, pendingTools };
    }

    const toolUseEvent: AgentEvent = { type: 'tool_use', toolCall };
    await emit(extensions, toolUseEvent, logger);
    yield toolUseEvent;

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
      const policyResult = await applyToolPolicies(extensions, {
        sessionId,
        toolCall: { ...toolCall },
        tool,
        input: parsedInput,
        toolContext,
      });
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
          Promise.resolve().then(() => contribution.beforeToolExecute({
            toolCall: { ...toolCall },
            tool,
            input: parsedInput,
            toolContext: hookContext,
          })),
          queue,
          extensions,
          logger,
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
