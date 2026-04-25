import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Tool } from '@cortx/sdk';

const execFileAsync = promisify(execFile);

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
      const target = path ? String(path) : '.';
      try {
        const { stdout } = await execFileAsync('find', [target, '-name', String(pattern), '-type', 'f'], {
          cwd, maxBuffer: 2 * 1024 * 1024,
        });
        return { success: true, output: stdout.trim() || '(no files found)' };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
