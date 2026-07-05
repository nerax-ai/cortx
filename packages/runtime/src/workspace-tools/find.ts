import type { Tool } from '@cortx/sdk';
import { isWorkspacePathError, resolveWorkspacePath } from './path-safety.js';
import { collectWorkspaceFiles, globToRegExp, workspaceDisplayPath } from './search.js';

export function createFindTool(cwd: string): Tool {
  return {
    name: 'find',
    description: 'Find files by name pattern.',
    sideEffects: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename glob pattern (e.g. "*.ts")' },
        path: { type: 'string', description: 'Directory to search (default: cwd)' },
      },
      required: ['pattern'],
    },
    execute: async ({ pattern, path }) => {
      if (typeof pattern !== 'string' || !pattern) return { success: false, error: 'pattern is required' };
      let target: string;
      let displayRoot: string;
      try {
        target = await resolveWorkspacePath(cwd, path ? String(path) : '.');
        displayRoot = await resolveWorkspacePath(cwd, '.');
      } catch (e: unknown) {
        if (isWorkspacePathError(e)) return { success: false, error: e.message };
        throw e;
      }
      try {
        const matcher = globToRegExp(pattern);
        const files = await collectWorkspaceFiles(cwd, target);
        const matches = files
          .filter((file) => matcher.test(file.split(/[\\/]/).pop() ?? file))
          .map((file) => workspaceDisplayPath(displayRoot, file))
          .sort();
        return { success: true, output: matches.join('\n') || '(no files found)' };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
