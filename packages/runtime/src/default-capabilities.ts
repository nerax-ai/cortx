export interface RuntimeDefaultCapabilities {
  skills?: boolean;
  subAgents?: boolean;
  approval?: boolean;
}

export const DEFAULT_RUNTIME_CAPABILITIES: Required<RuntimeDefaultCapabilities> = {
  skills: true,
  subAgents: true,
  approval: true,
};
