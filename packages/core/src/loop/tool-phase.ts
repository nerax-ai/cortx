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
import { AgentEventQueue, drainQueuedEvents } from './events.js';
import { emitPhaseEvent, withTurnDeadline, type AgentLoopRuntime } from './pipeline.js';
import { userAbortError } from './errors.js';

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
  signal?: AbortSignal;
  toolTimeoutMs?: number;
  askUser?: (question: string, toolCallId: string) => Promise<string>;
}

export function isReadOnlyTool(tool: Tool): boolean {
  const sideEffects = tool.sideEffects ?? 'write';
  return sideEffects === 'none' || sideEffects === 'read';
}

export function formatToolResultOutput(result: ToolResult): string {
  const value = !result.success && result.output === undefined && result.error ? result.error : result.output;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

export function parseToolInput(input: LanguageToolCallContent['input']): Record<string, unknown> {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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
    output: output.isError
      ? { type: 'error-text', value: output.finalOutput }
      : { type: 'text', value: output.finalOutput },
    isError: output.isError,
  };
}

export async function* emitToolPhaseOutput(
  runtime: AgentLoopRuntime,
  iteration: number,
  tc: LanguageToolCallContent,
  output: ToolExecOutput,
): AsyncGenerator<AgentEvent> {
  for (const text of output.progressMessages) {
    const event: AgentEvent = { type: 'tool_progress', toolCallId: tc.toolCallId, text };
    yield await emitPhaseEvent(runtime, 'tool.execute', iteration, event);
  }
  const event: AgentEvent = {
    type: 'tool_result',
    toolCallId: tc.toolCallId,
    result: output.finalOutput,
    isError: output.isError,
  };
  yield await emitPhaseEvent(runtime, 'tool.execute', iteration, event);
}

export async function* executePendingOutput(
  item: PendingToolExecution,
  output: ToolExecOutput,
  runtime: AgentLoopRuntime,
  iteration: number,
  toolResults: LanguageToolResultContent[],
  checkpointToolResults?: LanguageToolResultContent[],
): AsyncGenerator<AgentEvent> {
  const toolResult = makeToolResult(item.tc, output);
  toolResults.push(toolResult);
  checkpointToolResults?.push(toolResult);
  yield* emitToolPhaseOutput(runtime, iteration, item.tc, output);
}

export async function runToolCall(
  tc: LanguageToolCallContent,
  tool: Tool,
  extensions: AgentRuntimeExtensions,
  baseCtx: ToolPhaseBaseContext & { emitEvent?: (event: AgentEvent) => void },
  budget: number,
): Promise<ToolExecOutput> {
  const progressMessages: string[] = [];
  const toolAbort = createChildAbortController(baseCtx.signal);
  const ctx: ToolContext = {
    sessionId: baseCtx.sessionId,
    toolCallId: tc.toolCallId,
    workingDirectory: baseCtx.workingDirectory,
    logger: baseCtx.logger.scope(tc.toolName),
    signal: toolAbort.signal,
    reportProgress: (text) => progressMessages.push(text),
    askUser: baseCtx.askUser
      ? (question: string) => {
          baseCtx.emitEvent?.({ type: 'user_question', question, toolCallId: tc.toolCallId });
          return withAbortSignal(baseCtx.askUser!(question, tc.toolCallId), toolAbort.signal);
        }
      : undefined,
  };

  try {
    const input = parseToolInput(tc.input);
    throwIfAborted(toolAbort.signal);
    let result = await withTurnDeadline(
      (baseCtx as { turnDeadline?: AgentLoopRuntime['turnDeadline'] }).turnDeadline,
      withToolTimeout(tool.execute(input, ctx), baseCtx.toolTimeoutMs, tc.toolName, toolAbort),
    );

    let output = formatToolResultOutput(result);
    if (output.length > budget) {
      const marker = `\n\n... (truncated, ${output.length} chars total) ...\n\n`;
      const window = Math.max(0, Math.floor((budget - marker.length) / 2));
      output = window === 0 ? output.slice(0, budget) : `${output.slice(0, window)}${marker}${output.slice(-window)}`;
      result = { ...result, output };
    }
    for (const contribution of extensions.toolAfters) {
      throwIfAborted(toolAbort.signal);
      const afterResult = await withTurnDeadline(
        (baseCtx as { turnDeadline?: AgentLoopRuntime['turnDeadline'] }).turnDeadline,
        Promise.resolve(contribution.afterToolExecute({ toolCall: tc, tool, result })),
      );
      result = afterResult.result;
    }

    const finalOutput = formatToolResultOutput(result);
    return { progressMessages, finalOutput, isError: !result.success };
  } catch (error) {
    const finalOutput = error instanceof Error ? error.message : String(error);
    return { progressMessages, finalOutput, isError: true };
  } finally {
    toolAbort.cleanup();
  }
}

async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  toolName: string,
  abortController: { abort(reason?: unknown): void },
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          const error = Object.assign(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`), {
            code: 'timeout' as const,
          });
          abortController.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : userAbortError(String(signal.reason ?? 'aborted')));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : userAbortError(String(signal.reason ?? 'aborted'));
}

function createChildAbortController(parent: AbortSignal | undefined): {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  cleanup(): void;
} {
  const controller = new AbortController();
  if (!parent) {
    return {
      signal: controller.signal,
      abort: (reason?: unknown) => controller.abort(reason),
      cleanup: () => {},
    };
  }

  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) {
    abortFromParent();
    return {
      signal: controller.signal,
      abort: (reason?: unknown) => controller.abort(reason),
      cleanup: () => {},
    };
  }

  parent.addEventListener('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    cleanup: () => parent.removeEventListener('abort', abortFromParent),
  };
}

export async function* runToolBatch(
  items: PendingToolExecution[],
  extensions: AgentRuntimeExtensions,
  baseCtx: ToolPhaseBaseContext,
  budget: number,
  logger: Logger,
  runtime?: AgentLoopRuntime,
): AsyncGenerator<AgentEvent, ToolExecOutput[]> {
  const queue = new AgentEventQueue();
  const settled = yield* drainQueuedEvents(
    Promise.allSettled(
      items.map((item) =>
        runToolCall(item.tc, item.tool!, extensions, { ...baseCtx, emitEvent: (event) => queue.push(event) }, budget),
      ),
    ),
    queue,
    extensions,
    logger,
    runtime,
    'tool.execute',
    (baseCtx as { iteration?: number }).iteration ?? 0,
  );

  return settled.map((output) =>
    output.status === 'fulfilled'
      ? output.value
      : {
          progressMessages: [],
          finalOutput: output.reason instanceof Error ? output.reason.message : String(output.reason),
          isError: true,
        },
  );
}

export function toolDecisionOutput(
  action: 'deny' | 'shortCircuit',
  rawResult: ToolResult | string | undefined,
  reason: string | undefined,
  isError: boolean | undefined,
): ToolExecOutput {
  const result =
    typeof rawResult === 'object' && rawResult !== null
      ? rawResult
      : {
          success: action === 'shortCircuit' && isError !== true,
          output: rawResult ?? (action === 'deny' ? (reason ?? 'Denied') : 'short-circuited'),
        };
  return {
    progressMessages: [],
    finalOutput: formatToolResultOutput(result),
    isError: action === 'deny' || !result.success,
  };
}
