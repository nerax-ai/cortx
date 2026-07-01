import { spawn, ChildProcess } from 'child_process';
import { platform } from 'os';
import { accessSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { Tool } from '@cortx/sdk';

type ShellType = 'bash' | 'powershell' | 'cmd';

interface ShellConfiguration {
  executable: string;
  argsPrefix: string[];
  shell: ShellType;
}

const isWindows = (): boolean => platform() === 'win32';

/**
 * Find Git Bash on Windows
 * Checks common locations for Git Bash installation
 */
function findGitBash(): string | null {
  if (!isWindows()) return null;

  // Try to find git and derive bash path
  const gitPaths = [
    process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env['ProgramW6432'] && join(process.env['ProgramW6432'], 'Git', 'bin', 'bash.exe'),
    // User-specific Git installation
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean) as string[];

  for (const gitBash of gitPaths) {
    if (existsSync(gitBash)) {
      return gitBash;
    }
  }

  return null;
}

/**
 * Detect if WSL is available
 */
function findWslBash(): string | null {
  if (!isWindows()) return null;

  // Check if wsl command is available
  try {
    // We'll return 'wsl' as the executable and handle it specially
    return 'wsl';
  } catch {
    return null;
  }
}

/**
 * Get shell configuration based on platform
 * Priority on Windows: Git Bash > WSL > PowerShell > CMD
 */
function getShellConfiguration(): ShellConfiguration {
  if (!isWindows()) {
    // Unix/Linux/macOS - use bash or user's preferred shell
    return {
      executable: process.env['SHELL'] || '/bin/bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    };
  }

  // Windows - try to find a Unix-like shell first
  const gitBash = findGitBash();
  if (gitBash) {
    console.log(`[bash-tool] Using Git Bash: ${gitBash}`);
    return {
      executable: gitBash,
      argsPrefix: ['-c'],
      shell: 'bash',
    };
  }

  // Check ComSpec for PowerShell
  const comSpec = process.env['ComSpec'];
  if (comSpec?.toLowerCase().includes('powershell')) {
    return {
      executable: comSpec,
      argsPrefix: ['-NoProfile', '-Command'],
      shell: 'powershell',
    };
  }

  // Default to PowerShell on Windows
  return {
    executable: 'powershell.exe',
    argsPrefix: ['-NoProfile', '-Command'],
    shell: 'powershell',
  };
}

/**
 * Escape shell argument based on shell type
 */
function escapeShellArg(arg: string, shell: ShellType): string {
  switch (shell) {
    case 'powershell':
      // PowerShell escaping: single quotes with doubled single quotes
      return `'${arg.replace(/'/g, "''")}'`;
    case 'cmd':
      // CMD escaping: double quotes with doubled double quotes
      return `"${arg.replace(/"/g, '""')}"`;
    case 'bash':
    default:
      // Bash escaping: use single quotes, escape single quotes
      return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}

/**
 * Convert a Unix-style command to PowerShell equivalent
 * Only applies basic conversions for common commands
 */
function convertToPowerShell(command: string): string {
  // Basic command conversions
  const conversions: [RegExp, string][] = [
    // ls -> Get-ChildItem (or just use ls alias)
    // rm -> Remove-Item
    // cp -> Copy-Item
    // mv -> Move-Item
    // mkdir -> New-Item -ItemType Directory
    // cat -> Get-Content
    // grep -> Select-String
    // chmod -> icacls (complex, skip for now)
    // env var access: $VAR -> $env:VAR
    [/\$(\w+)/g, '$env:$1'],
    // && -> ; (PowerShell doesn't use && the same way)
    [/&&/g, ';'],
  ];

  let converted = command;
  for (const [pattern, replacement] of conversions) {
    converted = converted.replace(pattern, replacement);
  }

  return converted;
}

/**
 * Kill a process tree on Windows using taskkill
 */
function killProcessTreeWindows(pid: number): void {
  if (!isWindows()) return;

  try {
    spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (e) {
    console.error(`[bash-tool] Failed to kill process tree: ${e}`);
  }
}

const ROOT_FIND_PATTERN = /(^|[;&|]\s*)find\s+(?:-\w+\s+)*\/(?:\s|$)/;

export function validateCommandScope(command: string): string | undefined {
  if (ROOT_FIND_PATTERN.test(command.trim())) {
    return 'Refusing to run an unbounded filesystem scan from /. Limit the command to the current workspace, for example: find . -name "file" or use the find tool.';
  }
  return undefined;
}

export function createBashTool(cwd: string): Tool {
  const shellConfig = getShellConfiguration();

  return {
    name: 'bash',
    description: `Execute a ${shellConfig.shell} command scoped to the current workspace. Returns stdout and stderr combined. Avoid unbounded filesystem scans such as find /. On Windows, uses ${shellConfig.shell} (${shellConfig.executable}).`,
    sideEffects: 'destructive',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional)' },
      },
      required: ['command'],
    },
    execute: async ({ command, timeout }, ctx) => {
      // Validate required parameters
      if (!command || typeof command !== 'string' || command.trim() === '') {
        return {
          success: false,
          error: 'Parameter "command" is required and must be a non-empty string.',
        };
      }

      const scopeError = validateCommandScope(command);
      if (scopeError) {
        return { success: false, error: scopeError };
      }

      const timeoutMs = timeout ? (timeout as number) * 1000 : 120000; // Default 2 minutes


      // Prepare command based on shell type
      let actualCommand = command as string;
      if (shellConfig.shell === 'powershell') {
        actualCommand = convertToPowerShell(command as string);
      }


      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let proc: ChildProcess | null = null;

        const timeoutId = setTimeout(() => {
          timedOut = true;
          if (proc?.pid) {
            if (isWindows()) {
              killProcessTreeWindows(proc.pid);
            } else {
              // On Unix, kill the process group
              try {
                process.kill(-proc.pid, 'SIGKILL');
              } catch {
                proc.kill('SIGKILL');
              }
            }
          }
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          resolve({
            success: false,
            error: `Command timed out after ${timeout ?? 120} seconds. Partial output:\n${output}`,
          });
        }, timeoutMs);

        try {
          proc = spawn(shellConfig.executable, [...shellConfig.argsPrefix, actualCommand], {
            cwd,
            env: {
              ...process.env,
              // Ensure UTF-8 output
              LANG: 'en_US.UTF-8',
              LC_ALL: 'en_US.UTF-8',
            },
            // Don't use shell option since we're directly invoking the shell executable
            shell: false,
            windowsHide: true,
            // Create process group on Unix for proper process tree termination
            detached: !isWindows(),
          });

          proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
          });

          proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
          });

          proc.on('error', (err: Error) => {
            clearTimeout(timeoutId);
            resolve({
              success: false,
              error: `Failed to execute command: ${err.message}`,
            });
          });

          proc.on('close', (code: number | null) => {
            clearTimeout(timeoutId);

            if (timedOut) return; // Already resolved with timeout

            const output = [stdout, stderr].filter(Boolean).join('\n').trim();

            if (code === 0) {
              resolve({ success: true, output: output || '(no output)' });
            } else {
              resolve({
                success: false,
                error: output || `Command exited with code ${code}`,
              });
            }
          });
        } catch (e: unknown) {
          clearTimeout(timeoutId);
          resolve({
            success: false,
            error: `Failed to spawn shell: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
    },
  };
}

/**
 * Utility function to check if a shell is available on the system
 */
export async function checkShellAvailable(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(executable, ['--version'], {
      shell: false,
      windowsHide: true,
      timeout: 5000,
    });

    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
