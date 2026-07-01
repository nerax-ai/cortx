import type {
  AgentEvent,
  LanguageToolResultContent,
} from '@cortx/sdk';
import { checkControlInterruption, type ControlInterruption } from './control.js';
import {
  executePendingOutput,
  isReadOnlyTool,
  runToolBatch,
  withBeforeProgress,
  type PendingToolExecution,
  type ToolPhaseBaseContext,
} from './tool-phase.js';
import type { AgentLoopPhaseInput } from './pipeline.js';

export type ToolExecuteOutcome =
  | { action: 'completed'; toolResults: LanguageToolResultContent[] }
  | { action: 'interrupted'; interruption: Exclude<ControlInterruption, { action: 'none' }>; toolResults: LanguageToolResultContent[] };

export interface ToolExecutePhaseInput extends AgentLoopPhaseInput {
  pendingTools: PendingToolExecution[];
  baseContext: ToolPhaseBaseContext;
  checkpointToolResults?: LanguageToolResultContent[];
  budget: number;
  maxConcurrentTools: number;
  maxConcurrentAgents: number;
  iteration: number;
}

export async function* executeToolPhase(input: ToolExecutePhaseInput): AsyncGenerator<AgentEvent, ToolExecuteOutcome> {
  const {
    pendingTools,
    runtime,
    baseContext,
    checkpointToolResults,
    budget,
    maxConcurrentTools,
    maxConcurrentAgents,
    iteration,
  } = input;
  const { extensions, logger, controller } = runtime;
  const context = { ...baseContext, turnDeadline: runtime.turnDeadline, iteration };
  const toolResults: LanguageToolResultContent[] = [];
  let pendingIdx = 0;

  while (pendingIdx < pendingTools.length) {
    const interruption = checkControlInterruption(controller);
    if (interruption.action !== 'none') {
      return { action: 'interrupted', interruption, toolResults };
    }

    const item = pendingTools[pendingIdx];
    if (item.readyOutput) {
      pendingIdx++;
      yield* executePendingOutput(item, item.readyOutput, runtime, iteration, toolResults, checkpointToolResults);
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
        readBatch.length < maxConcurrentTools
      ) {
        readBatch.push(pendingTools[pendingIdx]);
        pendingIdx++;
      }

      const outputs = yield* runToolBatch(readBatch, extensions, context, budget, logger, runtime);
      for (let i = 0; i < readBatch.length; i++) {
        yield* executePendingOutput(readBatch[i], withBeforeProgress(readBatch[i], outputs[i]), runtime, iteration, toolResults, checkpointToolResults);
      }
      continue;
    }

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
        const outputs = yield* runToolBatch(agentBatch, extensions, context, budget, logger, runtime);
        for (let i = 0; i < agentBatch.length; i++) {
          yield* executePendingOutput(agentBatch[i], withBeforeProgress(agentBatch[i], outputs[i]), runtime, iteration, toolResults, checkpointToolResults);
        }
        continue;
      }
    }

    pendingIdx++;
    const [output] = yield* runToolBatch([item], extensions, context, budget, logger, runtime);
    yield* executePendingOutput(item, withBeforeProgress(item, output), runtime, iteration, toolResults, checkpointToolResults);
  }

  return { action: 'completed', toolResults };
}
