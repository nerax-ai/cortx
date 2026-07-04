import { readFile } from 'fs/promises';
import type { Tool } from '@cortx/sdk';
import { isWorkspacePathError, resolveWorkspacePath } from './path-safety.js';
import { collectWorkspaceFiles, globToRegExp, workspaceDisplayPath } from './search.js';

export function createGrepTool(cwd: string): Tool {
  return {
    name: 'grep',
    description: 'Search file contents using regex pattern.',
    sideEffects: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search (default: cwd)' },
        glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
      },
      required: ['pattern'],
    },
    execute: async ({ pattern, path, glob }) => {
      if (typeof pattern !== 'string' || !pattern) return { success: false, error: 'pattern is required' };
      let target: string;
      let regex: RegExp;
      try {
        target = await resolveWorkspacePath(cwd, path ? String(path) : '.');
        regex = new RegExp(pattern);
      } catch (e: unknown) {
        if (isWorkspacePathError(e)) return { success: false, error: e.message };
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
      const include = globToRegExp(glob ? String(glob) : '*');
      try {
        const files = await collectWorkspaceFiles(cwd, target);
        const matches: string[] = [];
        for (const file of files) {
          const name = file.split(/[\\/]/).pop() ?? file;
          if (!include.test(name)) continue;
          const text = await readFile(file, 'utf-8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) matches.push(`${workspaceDisplayPath(cwd, file)}:${i + 1}:${lines[i]}`);
            regex.lastIndex = 0;
          }
        }
        return { success: true, output: matches.join('\n') || '(no matches)' };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
