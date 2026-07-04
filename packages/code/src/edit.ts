import { readFile, writeFile, access, constants } from 'fs/promises';
import type { Tool } from '@cortx/sdk';
import { isWorkspacePathError, resolveWorkspacePath } from './path-safety.js';

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
      let abs: string;
      try {
        abs = await resolveWorkspacePath(cwd, path);
      } catch (error) {
        if (isWorkspacePathError(error)) return { success: false, error: error.message };
        throw error;
      }
      await access(abs, constants.R_OK | constants.W_OK);
      const content = await readFile(abs, 'utf-8');
      if (!content.includes(oldText)) return { success: false, error: `Text not found in ${path}` };
      if (content.indexOf(oldText) !== content.lastIndexOf(oldText)) {
        return { success: false, error: `Text is not unique in ${path}; provide a more specific oldText.` };
      }
      const updated = content.replace(oldText, newText);
      await writeFile(abs, updated, 'utf-8');
      return { success: true, output: `Edited ${path}` };
    },
  };
}
