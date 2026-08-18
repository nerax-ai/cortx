import type { CortxContributionConfig } from '@cortx/sdk';
import { RuntimeError } from './errors.js';
import type { ProjectDomain } from './project-domain.js';
import type { WorkspaceToolMode } from './workspace-tool-mode.js';

export const RUNTIME_TOOL_PROFILE = 'runtime.toolProfile';
export const EMPTY_TOOL_PROFILE_ID = 'none';
export const WORKSPACE_TOOLS_PLUGIN_ID = '@cortx-ai/workspace-tools';
export const WORKSPACE_TOOL_IDS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;
export const OFFICIAL_TOOL_PROFILE_ALIASES = {
  none: `${WORKSPACE_TOOLS_PLUGIN_ID}/none`,
  'read-only': `${WORKSPACE_TOOLS_PLUGIN_ID}/read-only`,
  coding: `${WORKSPACE_TOOLS_PLUGIN_ID}/coding`,
  all: `${WORKSPACE_TOOLS_PLUGIN_ID}/all`,
} as const satisfies Record<string, string>;
export type WorkspaceToolId = (typeof WORKSPACE_TOOL_IDS)[number];
export type { WorkspaceToolMode } from './workspace-tool-mode.js';

export interface RuntimeToolProfileToolRef {
  use: string;
  options?: Record<string, unknown>;
}

export interface RuntimeToolProfile {
  id: string;
  use: string;
  name?: string;
  description?: string;
  pluginId: string;
  tools: RuntimeToolProfileToolRef[];
}

export function parseWorkspaceToolMode(value: unknown, fallback: WorkspaceToolMode = EMPTY_TOOL_PROFILE_ID): WorkspaceToolMode {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  throw new RuntimeError('invalid_request', 'toolMode must be a non-empty string', {
    toolMode: value,
  });
}

export function workspaceToolUse(id: WorkspaceToolId): string {
  return `${WORKSPACE_TOOLS_PLUGIN_ID}/${id}`;
}

export async function listRuntimeToolProfiles(projectDomain?: ProjectDomain): Promise<RuntimeToolProfile[]> {
  if (!projectDomain) return [];
  return (await projectDomain.listToolProfiles()).map((profile) => ({
    id: profile.id,
    use: profile.canonicalId,
    name: profile.name,
    description: profile.description,
    pluginId: profile.pluginId,
    tools: profile.tools,
  }));
}

export async function createWorkspaceToolPluginEntries(
  workingDirectory: string,
  mode: WorkspaceToolMode = EMPTY_TOOL_PROFILE_ID,
  projectDomain?: ProjectDomain,
): Promise<CortxContributionConfig[]> {
  const parsedMode = parseWorkspaceToolMode(mode);
  const profile = await resolveRuntimeToolProfile(parsedMode, projectDomain);
  return profile.tools.map((tool) => ({
    use: tool.use,
    options: { ...(tool.options ?? {}), workingDirectory },
  }));
}

export async function resolveRuntimeToolProfile(
  mode: WorkspaceToolMode,
  projectDomain?: ProjectDomain,
): Promise<RuntimeToolProfile> {
  const canonicalMode = OFFICIAL_TOOL_PROFILE_ALIASES[mode as keyof typeof OFFICIAL_TOOL_PROFILE_ALIASES] ?? mode;
  const profiles = await listRuntimeToolProfiles(projectDomain);
  const profile = profiles.find((item) => item.use === canonicalMode);
  if (profile) return profile;
  if (canonicalMode === OFFICIAL_TOOL_PROFILE_ALIASES.none) {
    return {
      id: EMPTY_TOOL_PROFILE_ID,
      use: canonicalMode,
      name: 'None',
      description: 'Do not mount any project tools.',
      pluginId: WORKSPACE_TOOLS_PLUGIN_ID,
      tools: [],
    };
  }
  throw new RuntimeError('invalid_request', `toolMode profile not found: ${mode}`, {
    toolMode: mode,
    availableToolModes: profiles.map((item) => item.use),
  });
}
