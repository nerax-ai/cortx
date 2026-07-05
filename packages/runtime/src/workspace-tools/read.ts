import type { Tool } from '@cortx/sdk';
import { isWorkspacePathError, readTextNoFollow, resolveWorkspacePath } from './path-safety.js';

const MAX_LINES = 2000;

export function createReadTool(cwd: string): Tool {
  return {
    name: 'read',
    description: `Read file contents. Text files truncated to ${MAX_LINES} lines; use offset/limit for large files.`,
    sideEffects: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Max lines to read' },
      },
      required: ['path'],
    },
    execute: async ({ path, offset, limit }) => {
      if (!path) return { success: false, output: 'path is required' };
      let abs: string;
      try {
        abs = await resolveWorkspacePath(cwd, path as string);
      } catch (error) {
        if (isWorkspacePathError(error)) return { success: false, error: error.message };
        throw error;
      }
      const text = await readTextNoFollow(abs);
      const lines = text.split('\n');
      const start = offset ? Math.max(0, Number(offset) - 1) : 0;
      const end = limit ? Math.min(start + Number(limit), lines.length) : Math.min(start + MAX_LINES, lines.length);
      const slice = lines.slice(start, end).join('\n');
      const note = end < lines.length ? `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : '';
      return { success: true, output: slice + note };
    },
  };
}
