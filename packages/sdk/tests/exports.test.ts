import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  AGENT_EXTENSION_BUCKETS,
  AGENT_SESSION_POLICY,
  AGENT_TOOL,
  appendAgentRuntimeExtension,
  createEmptyAgentRuntimeExtensions,
  defineEventObserver,
  defineSessionPolicy,
  defineTool,
  type AgentModelRequestPolicyDecision,
  type AgentToolPolicyDecision,
  type Tool,
} from '../src/index';

function testLogger() {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    scope: () => logger,
    withContext: () => logger,
  };
  return logger;
}

describe('sdk exports', () => {
  test('extension buckets provide a typed runtime append path', () => {
    const extensions = createEmptyAgentRuntimeExtensions();
    const tool: Tool = {
      name: 'echo',
      inputSchema: {},
      execute: async () => ({ success: true, output: 'ok' }),
    };

    appendAgentRuntimeExtension(extensions, AGENT_TOOL, tool);

    expect(AGENT_EXTENSION_BUCKETS[AGENT_TOOL]).toBe('tools');
    expect(extensions.tools).toEqual([tool]);
  });

  test('policy decisions are hook-specific exported types', () => {
    const modelDecision: AgentModelRequestPolicyDecision = { action: 'rewriteTools', tools: [] };
    const toolDecision: AgentToolPolicyDecision = { action: 'shortCircuitTool', result: 'cached' };

    expect(AGENT_EXTENSION_BUCKETS[AGENT_SESSION_POLICY]).toBe('sessionPolicies');
    expect(modelDecision.action).toBe('rewriteTools');
    expect(toolDecision.action).toBe('shortCircuitTool');
  });

  test('helper factories preserve narrow plugin author types', async () => {
    const tool = defineTool({
      name: 'echo',
      inputSchema: {},
      execute: async (_input, ctx) => ({ success: true, output: ctx.signal instanceof AbortSignal }),
    });
    const policy = defineSessionPolicy({
      beforeToolCall({ tool }) {
        return tool?.sideEffects === 'destructive'
          ? { action: 'deny', reason: 'no destructive tools' }
          : { action: 'allow' };
      },
    });
    const observer = defineEventObserver({
      onAgentEvent(event) {
        expect(event.type).toBe('done');
      },
    });

    await expect(
      tool.execute(
        {},
        {
          sessionId: 's',
          toolCallId: 't',
          workingDirectory: '/',
          logger: testLogger(),
        },
      ),
    ).resolves.toEqual({ success: true, output: false });
    expect(
      await policy.beforeToolCall?.({
        sessionId: 's',
        toolCall: { type: 'tool-call', toolCallId: 't', toolName: 'rm', input: '{}' },
        tool: { name: 'rm', inputSchema: {}, sideEffects: 'destructive', execute: async () => ({ success: true }) },
        input: {},
        toolContext: {
          sessionId: 's',
          toolCallId: 't',
          workingDirectory: '/',
          logger: testLogger(),
        },
      }),
    ).toMatchObject({ action: 'deny' });
    await observer.onAgentEvent({ type: 'done' });
    expect(AGENT_RUN_CHECKPOINT_SCHEMA_VERSION).toBe(1);
  });
});
