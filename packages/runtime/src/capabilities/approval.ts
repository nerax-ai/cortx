import type { AgentRuntimeExtensions, AgentSessionPolicyContribution, Tool } from '@cortx/sdk';
import { createEmptyAgentRuntimeExtensions } from '@cortx/sdk';

const APPROVAL_RESPONSES = new Set(['y', 'yes', 'approve', 'approved', 'allow', 'allowed']);

export interface ToolApprovalPolicyOptions {
  needsApproval?: (tool: Tool | undefined, input: Record<string, unknown>) => boolean;
}

function defaultNeedsApproval(tool: Tool | undefined): boolean {
  const sideEffects = tool?.sideEffects ?? 'write';
  return sideEffects === 'write' || sideEffects === 'destructive';
}

function summarizeToolInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (!json) return '{}';
  return json.length <= 800 ? json : `${json.slice(0, 800)}...`;
}

function isApproved(response: string | undefined): boolean {
  return APPROVAL_RESPONSES.has(String(response ?? '').trim().toLowerCase());
}

export function createDefaultToolApprovalPolicy(options: ToolApprovalPolicyOptions = {}): AgentSessionPolicyContribution {
  return {
    async beforeToolCall({ tool, input, toolContext }) {
      const needsApproval = options.needsApproval ?? ((candidate: Tool | undefined) => defaultNeedsApproval(candidate));
      if (!needsApproval(tool, input)) return { action: 'allow' };
      if (!toolContext.askUser) {
        return { action: 'deny', reason: `Tool ${tool?.name ?? 'unknown'} requires approval, but no approval channel is available.` };
      }

      const response = await toolContext.askUser(
        [
          `Approve ${tool?.sideEffects} tool "${tool?.name ?? 'unknown'}"?`,
          `Input: ${summarizeToolInput(input)}`,
          'Choose Allow to continue or Deny to block this tool call.',
        ].join('\n'),
      );

      if (isApproved(response)) return { action: 'allow' };
      return { action: 'deny', reason: `Tool ${tool?.name ?? 'unknown'} was not approved.` };
    },
  };
}

export function createDefaultSafetyExtensions(options: ToolApprovalPolicyOptions = {}): AgentRuntimeExtensions {
  const extensions = createEmptyAgentRuntimeExtensions();
  extensions.sessionPolicies.push(createDefaultToolApprovalPolicy(options));
  return extensions;
}
