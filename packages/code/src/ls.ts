import { readdir } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '@cortx/sdk';

export function createLsTool(cwd: string): Tool {
  return {
    name: 'ls',
    description: 'List directory contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: cwd)' },
      },
    },
    execute: async ({ path }) => {
      const abs = resolve(cwd, typeof path === 'string' ? path : '.');
      const entries = await readdir(abs, { withFileTypes: true });
      const output = entries.map((e: import('fs').Dirent) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      return { success: true, output: output || '(empty)' };
    },
  };
}
