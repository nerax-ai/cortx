import type {
  AgentEvent,
  AgentRuntimeExtensions,
  LanguageToolResultContent,
  Logger,
} from '@cortx/sdk';
import type { AgentController } from '../types.js';
import { checkControlInterruption, type ControlInterruption } from './control.js';
import {
  executePendingOutput,
  isReadOnlyTool,
  runToolBatch,
  withBeforeProgress,
  type PendingToolExecution,
  type ToolPhaseBaseContext,
} from './tool-phase.js';

export type ToolExecuteOutcome =
  | { action: 'completed'; toolResults: LanguageToolResultContent[] }
  | { action: 'interrupted'; interruption: Exclude<ControlInterruption, { action: 'none' }>; toolResults: LanguageToolResultContent[] };

export interface ToolExecutePhaseInput {
  pendingTools: PendingToolExecution[];
  extensions: AgentRuntimeExtensions;
  baseContext: ToolPhaseBaseContext;
  budget: number;
  maxConcurrentTools: number;
  maxConcurrentAgents: number;
  logger: Logger;
  controller?: AgentController;
}

export async function* executeToolPhase(input: ToolExecutePhaseInput): AsyncGenerator<AgentEvent, ToolExecuteOutcome> {
  const {
    pendingTools,
    extensions,
    baseContext,
    budget,
    maxConcurrentTools,
    maxConcurrentAgents,
    logger,
    controller,
  } = input;
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
        readBatch.length < maxConcurrentTools
      ) {
        readBatch.push(pendingTools[pendingIdx]);
        pendingIdx++;
      }

      const outputs = yield* runToolBatch(readBatch, extensions, baseContext, budget, logger);
      for (let i = 0; i < readBatch.length; i++) {
        yield* executePendingOutput(readBatch[i], withBeforeProgress(readBatch[i], outputs[i]), extensions, toolResults, logger);
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
        const outputs = yield* runToolBatch(agentBatch, extensions, baseContext, budget, logger);
        for (let i = 0; i < agentBatch.length; i++) {
          yield* executePendingOutput(agentBatch[i], withBeforeProgress(agentBatch[i], outputs[i]), extensions, toolResults, logger);
        }
        continue;
      }
    }

    pendingIdx++;
    const [output] = yield* runToolBatch([item], extensions, baseContext, budget, logger);
    yield* executePendingOutput(item, withBeforeProgress(item, output), extensions, toolResults, logger);
  }

  return { action: 'completed', toolResults };
}
