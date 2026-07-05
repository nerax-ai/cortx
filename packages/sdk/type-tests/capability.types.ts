import type { PluginContext } from '@nerax-ai/plugin';
import {
  AGENT_SESSION_POLICY,
  AGENT_TOOL,
  defineCapabilityContribution,
  defineRuntimeCapability,
  defineSessionPolicy,
  defineSessionPolicyFactory,
  defineTool,
  defineToolFactory,
  registerRuntimeCapability,
  type CortxPluginContext,
} from '../src/index';

const toolFactory = defineToolFactory(() =>
  defineTool({
    name: 'typed_tool',
    inputSchema: {},
    execute: async () => ({ success: true }),
  }),
);
const policyFactory = defineSessionPolicyFactory(() =>
  defineSessionPolicy({
    beforeToolCall() {
      return { action: 'allow' };
    },
  }),
);
const capability = defineRuntimeCapability({
  id: 'typed-capability',
  contributions: [
    defineCapabilityContribution(AGENT_TOOL, 'typed-tool', toolFactory),
    defineCapabilityContribution(AGENT_SESSION_POLICY, 'typed-policy', policyFactory),
  ],
});

declare const ctx: CortxPluginContext;
registerRuntimeCapability(ctx, capability);

// @ts-expect-error policy factories cannot be registered as agent.tool contributions.
defineCapabilityContribution(AGENT_TOOL, 'wrong-policy', policyFactory);

defineRuntimeCapability({
  id: 'bad-capability',
  contributions: [
    // @ts-expect-error direct contribution entries must keep type/factory pairs aligned.
    { type: AGENT_TOOL, id: 'bad-tool', factory: policyFactory },
  ],
});

// @ts-expect-error tools require an execute function.
defineTool({ name: 'missing_execute', inputSchema: {} });

declare const genericPluginContext: PluginContext<string, Record<string, unknown>>;
// @ts-expect-error capability registration requires a Cortx plugin context.
registerRuntimeCapability(genericPluginContext, capability);
