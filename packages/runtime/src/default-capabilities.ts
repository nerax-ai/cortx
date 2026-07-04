import type { CortxConfig } from '@cortx/core';

export interface RuntimeDefaultCapabilities {
  skills?: boolean;
  subAgents?: boolean;
}

export const DEFAULT_RUNTIME_CAPABILITIES: Required<RuntimeDefaultCapabilities> = {
  skills: true,
  subAgents: true,
};

export function toCoreCapabilities(
  capabilities: RuntimeDefaultCapabilities = DEFAULT_RUNTIME_CAPABILITIES,
): CortxConfig['capabilities'] {
  return {
    skills: capabilities.skills === false ? 'disabled' : 'enabled',
    subAgents: capabilities.subAgents === false ? 'disabled' : 'enabled',
  };
}
