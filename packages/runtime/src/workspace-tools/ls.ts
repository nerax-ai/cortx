import { readdir } from 'fs/promises';
import type { Tool } from '@cortx/sdk';
import { isWorkspacePathError, resolveWorkspacePath } from './path-safety.js';

export function createLsTool(cwd: string): Tool {
  return {
    name: 'ls',
    description: 'List directory contents.',
    sideEffects: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: cwd)' },
      },
    },
    execute: async ({ path }) => {
      let abs: string;
      try {
        abs = await resolveWorkspacePath(cwd, typeof path === 'string' ? path : '.');
      } catch (error) {
        if (isWorkspacePathError(error)) return { success: false, error: error.message };
        throw error;
      }
      const entries = await readdir(abs, { withFileTypes: true });
      const output = entries.map((e: import('fs').Dirent) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      return { success: true, output: output || '(empty)' };
    },
  };
}
