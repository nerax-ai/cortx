import type { Tool } from '@cortx/sdk';
import { createWorkspaceToolPack } from './workspace-tools/index.js';
import { RuntimeError } from './errors.js';
import type { WorkspaceToolMode } from './workspace-tool-mode.js';

const WORKSPACE_TOOL_MODES = new Set<WorkspaceToolMode>(['none', 'read-only', 'coding', 'all']);
export type { WorkspaceToolMode } from './workspace-tool-mode.js';

export function parseWorkspaceToolMode(value: unknown, fallback: WorkspaceToolMode = 'all'): WorkspaceToolMode {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && WORKSPACE_TOOL_MODES.has(value as WorkspaceToolMode)) {
    return value as WorkspaceToolMode;
  }
  throw new RuntimeError('invalid_request', 'toolMode must be one of: none, read-only, coding, all', {
    toolMode: value,
  });
}

export function createWorkspaceTools(cwd: string, mode: WorkspaceToolMode = 'all'): Tool[] {
  const parsedMode = parseWorkspaceToolMode(mode);
  if (parsedMode === 'none') return [];
  return createWorkspaceToolPack(cwd, { mode: parsedMode });
}
