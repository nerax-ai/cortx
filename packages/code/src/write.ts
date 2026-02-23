import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Tool } from '@cortx/sdk';

export function createWriteTool(cwd: string): Tool {
  return {
    name: 'write',
    description: 'Write content to a file. Creates parent directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      const abs = resolve(cwd, path as string);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content as string, 'utf-8');
      return { success: true, output: `Wrote ${(content as string).length} bytes to ${path}` };
    },
  };
}
