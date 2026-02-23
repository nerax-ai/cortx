import { readFile, writeFile, access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '@cortx/sdk';

export function createEditTool(cwd: string): Tool {
  return {
    name: 'edit',
    description: 'Replace exact text in a file. oldText must match exactly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        oldText: { type: 'string', description: 'Exact text to find and replace' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    execute: async ({ path, oldText, newText }) => {
      const abs = resolve(cwd, path as string);
      await access(abs, constants.R_OK | constants.W_OK);
      const content = await readFile(abs, 'utf-8');
      const old = oldText as string;
      if (!content.includes(old)) return { success: false, error: `Text not found in ${path}` };
      const updated = content.replace(old, newText as string);
      await writeFile(abs, updated, 'utf-8');
      return { success: true, output: `Edited ${path}` };
    },
  };
}
