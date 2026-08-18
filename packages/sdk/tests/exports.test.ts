import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUN_CHECKPOINT_SCHEMA_VERSION,
  AGENT_EXTENSION_BUCKETS,
  AGENT_EVENT_OBSERVER,
  AGENT_SESSION_POLICY,
  AGENT_TOOL,
  PROJECT_CONTRIBUTION_TYPES,
  RUNTIME_TOOL_PROFILE,
  appendAgentRuntimeExtension,
  createEmptyAgentRuntimeExtensions,
  defineContributionBinding,
  defineContributionFactory,
  defineCortxContributionDescriptor,
  defineEventObserver,
  defineEventObserverFactory,
  defineSessionPolicy,
  defineSessionPolicyFactory,
  defineTool,
  defineToolFactory,
  parseCortxContributionReference,
  type AgentModelRequestPolicyDecision,
  type AgentToolPolicyDecision,
  type CortxContributionHostContext,
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

function testHostContext<T>(): CortxContributionHostContext<T> {
  const controller = new AbortController();
  return {
    instanceId: 'test-instance',
    scopeKind: 'session',
    sessionId: 's',
    signal: controller.signal,
    logger: testLogger(),
    abort: (reason) => controller.abort(reason),
    dispose: async () => undefined,
    defer: () => undefined,
    acquire: async (acquire) => acquire(controller.signal),
  };
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

  test('policy decisions remain hook-specific exported types', () => {
    const modelDecision: AgentModelRequestPolicyDecision = { action: 'rewriteTools', tools: [] };
    const toolDecision: AgentToolPolicyDecision = { action: 'shortCircuitTool', result: 'cached' };

    expect(AGENT_EXTENSION_BUCKETS[AGENT_SESSION_POLICY]).toBe('sessionPolicies');
    expect(modelDecision.action).toBe('rewriteTools');
    expect(toolDecision.action).toBe('shortCircuitTool');
  });

  test('declarative descriptors and executable bindings do not redeclare metadata', async () => {
    const descriptor = defineCortxContributionDescriptor({
      id: 'factory-echo',
      displayName: 'Factory echo',
      executable: true,
      schema: { fields: [{ name: 'prefix', type: 'string', default: '>' }] },
    });
    const toolFactory = defineToolFactory((_options, host) => {
      host.defer(() => undefined, 'echo');
      return defineTool({
        name: 'factoryEcho',
        inputSchema: {},
        execute: async () => ({ success: true, output: 'factory' }),
      });
    });
    const binding = defineContributionBinding(AGENT_TOOL, descriptor.id, toolFactory);
    const genericFactory = defineContributionFactory(AGENT_TOOL, toolFactory);

    expect(Object.keys(binding).sort()).toEqual(['factory', 'id', 'type']);
    expect((await genericFactory({}, testHostContext())).name).toBe('factoryEcho');
  });

  test('project types include Cortx, metadata-only profile, and Synax contributions', () => {
    expect(PROJECT_CONTRIBUTION_TYPES).toContain(AGENT_TOOL);
    expect(PROJECT_CONTRIBUTION_TYPES).toContain(RUNTIME_TOOL_PROFILE);
    expect(PROJECT_CONTRIBUTION_TYPES).toContain('provider');
    expect(PROJECT_CONTRIBUTION_TYPES).toContain('dispatcher');
    expect(PROJECT_CONTRIBUTION_TYPES).toContain('endpoint');
    expect(PROJECT_CONTRIBUTION_TYPES).toContain('api');
  });

  test('canonical references reject short and malformed names', () => {
    expect(parseCortxContributionReference('@cortx-ai/workspace-tools/read')).toEqual({
      pluginId: '@cortx-ai/workspace-tools',
      contributionId: 'read',
      canonicalId: '@cortx-ai/workspace-tools/read',
    });
    expect(() => parseCortxContributionReference('read')).toThrow('must be canonical');
    expect(() => parseCortxContributionReference('../workspace-tools/read')).toThrow('must be canonical');
  });

  test('factory helpers preserve narrowed host contexts and value types', async () => {
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

    expect(
      await (await policyFactory({}, testHostContext())).beforeModelRequest?.({
        sessionId: 's',
        iteration: 1,
        messages: [],
        tools: [],
      }),
    ).toMatchObject({ action: 'rewriteTools', tools: [] });
    expect(typeof (await observerFactory({}, testHostContext())).onAgentEvent).toBe('function');
    expect(AGENT_EVENT_OBSERVER).toBe('agent.eventObserver');
    expect(AGENT_RUN_CHECKPOINT_SCHEMA_VERSION).toBe(1);
  });
});
