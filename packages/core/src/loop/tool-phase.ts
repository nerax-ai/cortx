import type {
  AgentEvent,
  AgentRuntimeExtensions,
  LanguageToolCallContent,
  LanguageToolResultContent,
  Logger,
  Tool,
  ToolContext,
  ToolResult,
} from '@cortx/sdk';
import { AgentEventQueue, drainQueuedEvents, emit } from './events.js';

export interface ToolExecOutput {
  progressMessages: string[];
  finalOutput: string;
  isError: boolean;
}

export interface PendingToolExecution {
  tc: LanguageToolCallContent;
  tool?: Tool;
  beforeProgress: string[];
  readyOutput?: ToolExecOutput;
}

export interface ToolPhaseBaseContext {
  sessionId: string;
  workingDirectory: string;
  logger: Logger;
  askUser?: (question: string, toolCallId: string) => Promise<string>;
}

export function isReadOnlyTool(tool: Tool): boolean {
  const sideEffects = tool.sideEffects ?? 'write';
  return sideEffects === 'none' || sideEffects === 'read';
}

export function formatToolResultOutput(result: ToolResult): string {
  const value = !result.success && result.output === undefined && result.error
    ? result.error
    : result.output;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

export function parseToolInput(input: LanguageToolCallContent['input']): Record<string, unknown> {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
}

export function parseToolInputError(input: LanguageToolCallContent['input']): string | undefined {
  try {
    parseToolInput(input);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function withBeforeProgress(item: PendingToolExecution, output: ToolExecOutput): ToolExecOutput {
  return {
    ...output,
    progressMessages: [...item.beforeProgress, ...output.progressMessages],
  };
}

export function makeToolResult(tc: LanguageToolCallContent, output: ToolExecOutput): LanguageToolResultContent {
  return {
    type: 'tool-result',
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    output: output.isError ? { type: 'error-text', value: output.finalOutput } : { type: 'text', value: output.finalOutput },
    isError: output.isError,
  };
}

export async function* emitToolOutput(tc: LanguageToolCallContent, output: ToolExecOutput, extensions: AgentRuntimeExtensions, logger: Logger): AsyncGenerator<AgentEvent> {
  for (const text of output.progressMessages) {
    const event: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
    await emit(extensions, event, logger);
    yield event;
  }
  const event: AgentEvent = { type: 'tool_result', toolCallId: tc.toolCallId, result: output.finalOutput, isError: output.isError };
  await emit(extensions, event, logger);
  yield event;
}

export async function* executePendingOutput(
  item: PendingToolExecution,
  output: ToolExecOutput,
  extensions: AgentRuntimeExtensions,
  toolResults: LanguageToolResultContent[],
  logger: Logger,
): AsyncGenerator<AgentEvent> {
  yield* emitToolOutput(item.tc, output, extensions, logger);
  toolResults.push(makeToolResult(item.tc, output));
}

export async function runToolCall(
  tc: LanguageToolCallContent,
  tool: Tool,
  extensions: AgentRuntimeExtensions,
  baseCtx: ToolPhaseBaseContext & { emitEvent?: (event: AgentEvent) => void },
  budget: number,
): Promise<ToolExecOutput> {
  const progressMessages: string[] = [];
  const ctx: ToolContext = {
    sessionId: baseCtx.sessionId,
    toolCallId: tc.toolCallId,
    workingDirectory: baseCtx.workingDirectory,
    logger: baseCtx.logger.scope(tc.toolName),
    reportProgress: (text) => progressMessages.push(text),
    askUser: baseCtx.askUser ? (question: string) => {
      baseCtx.emitEvent?.({ type: 'user_question', question, toolCallId: tc.toolCallId });
      return baseCtx.askUser!(question, tc.toolCallId);
    } : undefined,
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
  } catch (error) {
    const finalOutput = error instanceof Error ? error.message : String(error);
    return { progressMessages, finalOutput, isError: true };
  }
}

export async function* runToolBatch(
  items: PendingToolExecution[],
  extensions: AgentRuntimeExtensions,
  baseCtx: ToolPhaseBaseContext,
  budget: number,
  logger: Logger,
): AsyncGenerator<AgentEvent, ToolExecOutput[]> {
  const queue = new AgentEventQueue();
  const settled = yield* drainQueuedEvents(
    Promise.allSettled(items.map((item) => runToolCall(
      item.tc,
      item.tool!,
      extensions,
      { ...baseCtx, emitEvent: (event) => queue.push(event) },
      budget,
    ))),
    queue,
    extensions,
    logger,
  );

  return settled.map((output) => output.status === 'fulfilled'
    ? output.value
    : {
        progressMessages: [],
        finalOutput: output.reason instanceof Error ? output.reason.message : String(output.reason),
        isError: true,
      });
}

export function toolDecisionOutput(
  action: 'deny' | 'shortCircuit',
  rawResult: ToolResult | string | undefined,
  reason: string | undefined,
  isError: boolean | undefined,
): ToolExecOutput {
  const result = typeof rawResult === 'object' && rawResult !== null
    ? rawResult
    : {
        success: action === 'shortCircuit' && isError !== true,
        output: rawResult ?? (action === 'deny' ? reason ?? 'Denied' : 'short-circuited'),
      };
  return {
    progressMessages: [],
    finalOutput: formatToolResultOutput(result),
    isError: action === 'deny' || !result.success,
  };
}
