import type { Tool } from '@cortx/sdk';
import { createWorkspaceToolPack } from '@cortx/code';

export type WorkspaceToolMode = 'none' | 'read-only' | 'coding' | 'all';

export function createWorkspaceTools(cwd: string, mode: WorkspaceToolMode = 'all'): Tool[] {
  if (mode === 'none') return [];
  return createWorkspaceToolPack(cwd, { mode });
}
