import type { Tool } from '@cortx/sdk';
import { createBashTool } from './bash.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createGrepTool } from './grep.js';
import { createFindTool } from './find.js';
import { createLsTool } from './ls.js';
import type { WorkspaceToolPackMode } from '../workspace-tool-mode.js';

export { createBashTool } from './bash.js';
export { createReadTool } from './read.js';
export { createWriteTool } from './write.js';
export { createEditTool } from './edit.js';
export { createGrepTool } from './grep.js';
export { createFindTool } from './find.js';
export { createLsTool } from './ls.js';

export function createCodingTools(cwd: string): Tool[] {
  return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)];
}

export function createReadOnlyTools(cwd: string): Tool[] {
  return [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

export function createAllTools(cwd: string): Tool[] {
  return [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

export interface WorkspaceToolPackOptions {
  mode?: WorkspaceToolPackMode;
}

export function createWorkspaceToolPack(cwd: string, options: WorkspaceToolPackOptions = {}): Tool[] {
  const mode = options.mode ?? 'all';
  if (mode === 'read-only') return createReadOnlyTools(cwd);
  if (mode === 'coding') return createCodingTools(cwd);
  return createAllTools(cwd);
}
