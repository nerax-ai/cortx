import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '@cortx/sdk';

const execFileAsync = promisify(execFile);

export function createGrepTool(cwd: string): Tool {
  return {
    name: 'grep',
    description: 'Search file contents using regex pattern.',
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
      const target = path ? String(path) : '.';
      const args = ['-r', '-n', '--include', glob ? String(glob) : '*', String(pattern), target];
      try {
        const { stdout } = await execFileAsync('grep', args, { cwd, maxBuffer: 2 * 1024 * 1024 });
        return { success: true, output: stdout.trim() || '(no matches)' };
      } catch (e: any) {
        if (e.code === 1) return { success: true, output: '(no matches)' };
        return { success: false, error: e.message };
      }
    },
  };
}
