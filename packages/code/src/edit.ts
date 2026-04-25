import { readFile, writeFile, access, constants } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '@cortx/sdk';

export function createEditTool(cwd: string): Tool {
  return {
    name: 'edit',
    description: 'Replace exact text in a file. oldText must match exactly.',
    sideEffects: 'write',
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
      if (typeof path !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string')
        return { success: false, error: 'path, oldText, and newText must be strings' };
      const abs = resolve(cwd, path);
      await access(abs, constants.R_OK | constants.W_OK);
      const content = await readFile(abs, 'utf-8');
      if (!content.includes(oldText)) return { success: false, error: `Text not found in ${path}` };
      const updated = content.replace(oldText, newText);
      await writeFile(abs, updated, 'utf-8');
      return { success: true, output: `Edited ${path}` };
    },
  };
}
