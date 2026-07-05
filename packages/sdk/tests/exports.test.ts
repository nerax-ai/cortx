import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  AGENT_EXTENSION_BUCKETS,
  AGENT_EVENT_OBSERVER,
  AGENT_SESSION_POLICY,
  AGENT_TOOL,
  CORTX_EXTENSION_SCHEMA_VERSION,
  appendAgentRuntimeExtension,
  createEmptyAgentRuntimeExtensions,
  defineCapabilityContribution,
  defineContributionFactory,
  defineEventObserver,
  defineEventObserverFactory,
  defineRuntimeCapability,
  defineSessionPolicy,
  defineSessionPolicyFactory,
  defineTool,
  defineToolFactory,
  normalizeRuntimeCapabilityDefinition,
  registerRuntimeCapability,
  type AgentModelRequestPolicyDecision,
  type AgentToolPolicyDecision,
  type CortxPluginContext,
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

  test('contribution factory helpers preserve registry factory shapes', async () => {
    const toolFactory = defineToolFactory(() =>
      defineTool({
        name: 'factoryEcho',
        inputSchema: {},
        execute: async () => ({ success: true, output: 'factory' }),
      }),
    );
    const policyFactory = defineSessionPolicyFactory(() =>
      defineSessionPolicy({
        beforeModelRequest() {
          return { action: 'rewriteTools', tools: [] };
        },
      }),
    );
    const observerFactory = defineEventObserverFactory(() =>
      defineEventObserver({
        onAgentEvent() {},
      }),
    );
    const genericFactory = defineContributionFactory(AGENT_TOOL, toolFactory);

    expect((await genericFactory({ instanceId: 'i', options: {}, logger: testLogger(), storage: {} as never })).name).toBe(
      'factoryEcho',
    );
    expect(
      await (
        await policyFactory({ instanceId: 'i', options: {}, logger: testLogger(), storage: {} as never })
      ).beforeModelRequest?.({ sessionId: 's', iteration: 1, messages: [], tools: [] }),
    ).toMatchObject({ action: 'rewriteTools', tools: [] });
    expect(
      typeof (
        await observerFactory({ instanceId: 'i', options: {}, logger: testLogger(), storage: {} as never })
      ).onAgentEvent,
    ).toBe('function');
    expect(AGENT_EVENT_OBSERVER).toBe('agent.eventObserver');
  });

  test('runtime capability helpers register grouped typed contributions', async () => {
    const registered: Array<{ type: string; id: string; factory: unknown; options?: unknown }> = [];
    const ctx: CortxPluginContext = {
      packageName: '@example/capability',
      manifest: {
        manifestVersion: 1,
        id: 'example-capability',
        name: 'Example capability',
        version: '0.1.0',
        runtime: { main: 'dist/index.js' },
      },
      logger: testLogger(),
      storage: {} as never,
      register(type, id, factory, options) {
        registered.push({ type, id, factory, options });
      },
    };
    const toolFactory = defineToolFactory(() =>
      defineTool({
        name: 'capability_echo',
        inputSchema: {},
        execute: async () => ({ success: true, output: 'capability' }),
      }),
    );
    const policyFactory = defineSessionPolicyFactory(() =>
      defineSessionPolicy({
        beforeToolCall() {
          return { action: 'allow' };
        },
      }),
    );
    const observerFactory = defineEventObserverFactory(() =>
      defineEventObserver({
        onAgentEvent() {},
      }),
    );
    const capability = defineRuntimeCapability({
      id: 'workspace-helper',
      displayName: 'Workspace helper',
      contributions: [
        defineCapabilityContribution(AGENT_TOOL, 'echo', toolFactory, { displayName: 'Echo tool' }),
        defineCapabilityContribution(AGENT_SESSION_POLICY, 'policy', policyFactory),
        defineCapabilityContribution(AGENT_EVENT_OBSERVER, 'observer', observerFactory),
      ],
    });

    expect(capability.schemaVersion).toBe(CORTX_EXTENSION_SCHEMA_VERSION);
    expect(capability.contributions.map((entry) => entry.schemaVersion)).toEqual([
      CORTX_EXTENSION_SCHEMA_VERSION,
      CORTX_EXTENSION_SCHEMA_VERSION,
      CORTX_EXTENSION_SCHEMA_VERSION,
    ]);

    registerRuntimeCapability(ctx, capability);

    expect(registered.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'agent.tool:echo',
      'agent.sessionPolicy:policy',
      'agent.eventObserver:observer',
    ]);
    expect(registered[0].options).toEqual({ displayName: 'Echo tool' });
    expect((await toolFactory({ instanceId: 'i', options: {}, logger: testLogger(), storage: {} as never })).name).toBe(
      'capability_echo',
    );
  });

  test('runtime capability schema helpers migrate legacy declarations and reject future schemas', () => {
    const toolFactory = defineToolFactory(() =>
      defineTool({
        name: 'versioned_echo',
        inputSchema: {},
        execute: async () => ({ success: true, output: 'versioned' }),
      }),
    );
    const currentContribution = defineCapabilityContribution({
      schemaVersion: CORTX_EXTENSION_SCHEMA_VERSION,
      type: AGENT_TOOL,
      id: 'versioned-echo',
      factory: toolFactory,
      options: { displayName: 'Versioned echo' },
    });
    const legacyContribution = defineCapabilityContribution({
      schemaVersion: 0,
      type: AGENT_TOOL,
      id: 'legacy-echo',
      factory: toolFactory,
    });
    const normalized = normalizeRuntimeCapabilityDefinition({
      schemaVersion: 0,
      id: 'legacy-capability',
      contributions: [currentContribution, legacyContribution],
    });

    expect(currentContribution).toMatchObject({
      schemaVersion: CORTX_EXTENSION_SCHEMA_VERSION,
      id: 'versioned-echo',
      options: { displayName: 'Versioned echo' },
    });
    expect(legacyContribution.schemaVersion).toBe(CORTX_EXTENSION_SCHEMA_VERSION);
    expect(normalized).toMatchObject({
      schemaVersion: CORTX_EXTENSION_SCHEMA_VERSION,
      id: 'legacy-capability',
    });
    expect(normalized.contributions.map((entry) => entry.schemaVersion)).toEqual([
      CORTX_EXTENSION_SCHEMA_VERSION,
      CORTX_EXTENSION_SCHEMA_VERSION,
    ]);
    expect(() =>
      defineRuntimeCapability({
        schemaVersion: 999 as never,
        id: 'future-capability',
        contributions: [],
      }),
    ).toThrow('RuntimeCapability.schemaVersion');
    expect(() =>
      defineCapabilityContribution({
        schemaVersion: 999 as never,
        type: AGENT_TOOL,
        id: 'future-echo',
        factory: toolFactory,
      }),
    ).toThrow('CortxCapabilityContribution.schemaVersion');
  });
});
