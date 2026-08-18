import {
  AGENT_SESSION_POLICY,
  AGENT_TOOL,
  RUNTIME_TOOL_PROFILE,
  defineContributionBinding,
  defineCortxPlugin,
  defineCortxContributionDescriptor,
  defineSessionPolicy,
  defineSessionPolicyFactory,
  defineTool,
  defineToolFactory,
  parseCortxContributionReference,
  type CortxPluginContext,
  type ProjectContributionMap,
  type ProjectContributionType,
} from '../src/index';

const toolFactory = defineToolFactory((_options, host) => {
  host.defer(() => undefined, 'typed-tool');
  return defineTool({
    name: 'typed_tool',
    inputSchema: {},
    execute: async () => ({ success: true }),
  });
});

const policyFactory = defineSessionPolicyFactory(() =>
  defineSessionPolicy({
    beforeToolCall() {
      return { action: 'allow' };
    },
  }),
);

const toolBinding = defineContributionBinding(AGENT_TOOL, 'typed-tool', toolFactory);
const policyBinding = defineContributionBinding(AGENT_SESSION_POLICY, 'typed-policy', policyFactory);

declare const ctx: CortxPluginContext;
ctx.bind(toolBinding);
ctx.bind(policyBinding);

defineCortxContributionDescriptor({
  id: 'typed-tool',
  displayName: 'Typed tool',
  executable: true,
  schema: { fields: [{ name: 'label', type: 'string' }] },
});

defineCortxContributionDescriptor({
  id: 'read-only',
  displayName: 'Read only',
  executable: false,
  tools: ['@cortx-ai/workspace-tools/read'],
});

parseCortxContributionReference('@cortx-ai/workspace-tools/read');

type ProjectProvider = ProjectContributionMap['provider'];
type ProjectTool = ProjectContributionMap[typeof AGENT_TOOL];
const projectTypes: ProjectContributionType[] = [AGENT_TOOL, RUNTIME_TOOL_PROFILE, 'provider'];
void (null as unknown as ProjectProvider);
void (null as unknown as ProjectTool);
void projectTypes;

// @ts-expect-error policy factories cannot be bound as agent.tool contributions.
defineContributionBinding(AGENT_TOOL, 'wrong-policy', policyFactory);

defineCortxPlugin({
  manifest: {
    manifestVersion: 1,
    id: '@test/typed-context',
    name: 'Typed context',
    version: '1.0.0',
    runtime: { main: 'dist/index.js' },
    contributes: {
      [AGENT_TOOL]: [{ id: 'wrong-policy', executable: true }],
    },
  },
  setup(ctx) {
    const exactContext: CortxPluginContext = ctx;
    void exactContext;
    // @ts-expect-error setup ctx rejects a session-policy factory bound as agent.tool.
    ctx.bind({ type: AGENT_TOOL, id: 'wrong-policy', factory: policyFactory });
  },
});
