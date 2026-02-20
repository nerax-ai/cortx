import type { LanguageClient } from '@synax-ai/core';
import type {
  AgentConfig,
  AgentController,
  AgentEvent,
  AgentLoopController,
  LanguageMessage,
  LanguageToolCallContent,
  LanguageToolResultContent,
  Tool,
  ToolContext,
} from '@cortx/sdk';

export interface AgentLoopOptions extends AgentConfig {
  language: LanguageClient;
  messages?: LanguageMessage[];
  controller?: AgentController;
}

export async function* agentLoop(opts: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const {
    language,
    model,
    system,
    tools = [],
    messages = [],
    maxIterations = 20,
    maxOutputTokens,
    temperature,
    workingDirectory = process.cwd(),
    controller,
  } = opts;

  const toolMap = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const sdkTools = tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const systemMessages: LanguageMessage[] = system ? [{ role: 'system', content: system }] : [];

  let iteration = 0;

  mainLoop: while (true) {
    if ((controller as AgentLoopController | undefined)?.isAborted) {
      yield { type: 'error', error: new Error((controller as AgentLoopController).abortReason ?? 'aborted') };
      return;
    }
    if (iteration >= maxIterations) {
      yield { type: 'error', error: new Error(`Max iterations (${maxIterations}) reached`) };
      return;
    }
    iteration++;

    let response;
    try {
      response = await language.generate({
        model,
        messages: [...systemMessages, ...messages],
        maxOutputTokens,
        temperature,
        tools: sdkTools.length ? sdkTools : undefined,
      });
    } catch (e) {
      yield { type: 'error', error: e instanceof Error ? e : new Error(String(e)) };
      return;
    }

    const choice = response.choices[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finishReason;

    // Emit text
    if (typeof content === 'string' && content) {
      yield { type: 'text', content };
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (p.type === 'text' && p.text) yield { type: 'text', content: p.text };
      }
    }

    const isToolUse = finishReason === 'tool-calls';

    if (!isToolUse) {
      if (controller?.hasFollowUps) {
        for (const msg of controller.consumeFollowUps()) {
          messages.push(msg);
          yield { type: 'follow_up', message: typeof msg.content === 'string' ? msg.content : 'follow-up' };
        }
        continue mainLoop;
      }
      yield {
        type: 'done',
        usage: response.usage
          ? { inputTokens: response.usage.inputTokens.total ?? 0, outputTokens: response.usage.outputTokens.total ?? 0 }
          : undefined,
      };
      return;
    }

    // Extract tool calls
    const toolCalls: LanguageToolCallContent[] = Array.isArray(content)
      ? (content.filter((p) => p.type === 'tool-call') as LanguageToolCallContent[])
      : [];

    if (!toolCalls.length) {
      yield { type: 'done' };
      return;
    }

    // Add assistant message
    messages.push({ role: 'assistant', content: Array.isArray(content) ? content : [{ type: 'text', text: content ?? '' }] });

    const toolResults: LanguageToolResultContent[] = [];

    for (const tc of toolCalls) {
      // Check steer
      if ((controller as AgentLoopController | undefined)?.isSteered) {
        const steerMsg = (controller as AgentLoopController).consumeSteer()!;
        yield { type: 'steered', message: typeof steerMsg.content === 'string' ? steerMsg.content : 'steered' };
        messages.push(steerMsg);
        continue mainLoop;
      }
      if ((controller as AgentLoopController | undefined)?.isAborted) {
        yield { type: 'error', error: new Error((controller as AgentLoopController).abortReason ?? 'aborted') };
        return;
      }

      yield { type: 'tool_use', toolCall: tc };

      const tool = toolMap.get(tc.toolName);
      if (!tool) {
        const err = `Unknown tool: ${tc.toolName}`;
        yield { type: 'tool_result', toolCallId: tc.toolCallId, result: err, isError: true };
        toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'error-text', value: err }, isError: true });
        continue;
      }

      const progressMessages: string[] = [];
      const ctx: ToolContext = {
        sessionId,
        workingDirectory,
        reportProgress: (text) => progressMessages.push(text),
      };

      try {
        const input = (typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input) as Record<string, unknown>;
        const result = await tool.execute(input, ctx);

        for (const text of progressMessages) yield { type: 'tool_progress', toolCallId: tc.toolCallId, text };

        const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
        yield { type: 'tool_result', toolCallId: tc.toolCallId, result: output, isError: !result.success };
        toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'text', value: output }, isError: !result.success });
      } catch (e) {
        for (const text of progressMessages) yield { type: 'tool_progress', toolCallId: tc.toolCallId, text };
        const err = e instanceof Error ? e.message : String(e);
        yield { type: 'tool_result', toolCallId: tc.toolCallId, result: err, isError: true };
        toolResults.push({ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: { type: 'error-text', value: err }, isError: true });
      }
    }

    if (toolResults.length) messages.push({ role: 'tool', content: toolResults });
  }
}
