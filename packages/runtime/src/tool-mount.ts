import type { CortxRegistry, PluginConfig } from '@cortx/core';
import { RuntimeError } from './errors.js';
import type { WorkspaceToolMode } from './workspace-tool-mode.js';

interface ToolProfileManifestContribution {
  id: string;
  fullId: string;
  packageName: string;
  pluginId: string;
  contribution: unknown;
  displayName?: string;
  description?: string;
}

export const RUNTIME_TOOL_PROFILE = 'runtime.toolProfile';
export const EMPTY_TOOL_PROFILE_ID = 'none';
export const WORKSPACE_TOOLS_PLUGIN_ID = '@cortx-ai/workspace-tools';
export const WORKSPACE_TOOL_IDS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;
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
  pluginId?: string;
  packageName?: string;
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

export async function listRuntimeToolProfiles(registry?: CortxRegistry): Promise<RuntimeToolProfile[]> {
  const profiles: RuntimeToolProfile[] = [
    {
      id: EMPTY_TOOL_PROFILE_ID,
      use: EMPTY_TOOL_PROFILE_ID,
      name: 'None',
      description: 'Do not mount any tool profile tools.',
      tools: [],
    },
  ];
  if (!registry) return profiles;

  for (const contribution of await registry.listContributions(RUNTIME_TOOL_PROFILE)) {
    const profile = parseToolProfileContribution(contribution);
    const existing = profiles.findIndex((item) => item.id === profile.id);
    if (existing >= 0) profiles[existing] = profile;
    else profiles.push(profile);
  }
  return profiles;
}

export async function createWorkspaceToolPluginEntries(
  workingDirectory: string,
  mode: WorkspaceToolMode = EMPTY_TOOL_PROFILE_ID,
  registry?: CortxRegistry,
): Promise<PluginConfig[]> {
  const parsedMode = parseWorkspaceToolMode(mode);
  const profile = await resolveToolProfile(parsedMode, registry);
  return profile.tools.map((tool) => ({
    use: tool.use,
    options: { ...(tool.options ?? {}), workingDirectory },
  }));
}

async function resolveToolProfile(mode: WorkspaceToolMode, registry?: CortxRegistry): Promise<RuntimeToolProfile> {
  const profiles = await listRuntimeToolProfiles(registry);
  const matches = profiles.filter((profile) =>
    profile.id === mode ||
    profile.use === mode ||
    profile.pluginId === mode ||
    `${profile.pluginId}/${profile.id}` === mode,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new RuntimeError('invalid_request', `toolMode is ambiguous: ${mode}`, {
      toolMode: mode,
      matches: matches.map((profile) => profile.use),
    });
  }
  throw new RuntimeError('invalid_request', `toolMode profile not found: ${mode}`, {
    toolMode: mode,
    availableToolModes: profiles.map((profile) => profile.id),
  });
}

function parseToolProfileContribution(contribution: ToolProfileManifestContribution): RuntimeToolProfile {
  const value = contribution.contribution;
  if (!isRecord(value)) {
    throw new RuntimeError('invalid_request', `Invalid ${RUNTIME_TOOL_PROFILE} contribution: ${contribution.fullId}`);
  }
  const toolsValue = value.tools;
  if (!Array.isArray(toolsValue)) {
    throw new RuntimeError('invalid_request', `${RUNTIME_TOOL_PROFILE} "${contribution.fullId}" must declare a tools array`);
  }
  const tools = toolsValue.map((tool, index) => parseToolRef(tool, `${contribution.fullId}.tools[${index}]`));
  return {
    id: contribution.id,
    use: `${contribution.pluginId}/${contribution.id}`,
    name: stringValue(value.name) ?? contribution.displayName,
    description: stringValue(value.description) ?? contribution.description,
    pluginId: contribution.pluginId,
    packageName: contribution.packageName,
    tools,
  };
}

function parseToolRef(value: unknown, label: string): RuntimeToolProfileToolRef {
  if (typeof value === 'string' && value.trim()) return { use: value.trim() };
  if (!isRecord(value) || typeof value.use !== 'string' || !value.use.trim()) {
    throw new RuntimeError('invalid_request', `${label} must be a tool use string or { use, options } object`);
  }
  if (value.options !== undefined && !isRecord(value.options)) {
    throw new RuntimeError('invalid_request', `${label}.options must be an object`);
  }
  return {
    use: value.use.trim(),
    options: value.options as Record<string, unknown> | undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
