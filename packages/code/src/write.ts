import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { Tool } from '@cortx/sdk';

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
      const abs = resolve(cwd, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return { success: true, output: `Wrote ${content.length} bytes to ${path}` };
    },
  };
}
