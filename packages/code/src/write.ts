import { writeFile } from 'fs/promises';
import type { Tool } from '@cortx/sdk';
import { isWorkspacePathError, resolveWritableWorkspacePath } from './path-safety.js';

export function createWriteTool(cwd: string): Tool {
  return {
    name: 'write',
    description: 'Write content to a file. Creates parent directories if needed.',
    sideEffects: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      if (typeof path !== 'string' || typeof content !== 'string')
        return { success: false, error: 'path and content must be strings' };
      let abs: string;
      try {
        abs = await resolveWritableWorkspacePath(cwd, path);
      } catch (error) {
        if (isWorkspacePathError(error)) return { success: false, error: error.message };
        throw error;
      }
      await writeFile(abs, content, 'utf-8');
      return { success: true, output: `Wrote ${content.length} bytes to ${path}` };
    },
  };
}
