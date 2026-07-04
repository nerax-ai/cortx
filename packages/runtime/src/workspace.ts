import { realpath } from 'fs/promises';
import { isAbsolute, relative, resolve, sep } from 'path';
import { RuntimeError } from './errors.js';

export interface WorkspaceResolution {
  workingDirectory: string;
  realWorkingDirectory: string;
  allowedRoot: string;
  realAllowedRoot: string;
}

function isOutsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function realpathForWorkspace(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError('invalid_workspace', `${label} is not accessible: ${path}`, { cause: message });
  }
}

export async function resolveWorkspaceRoot(input: string): Promise<{ root: string; realRoot: string }> {
  const root = resolve(input);
  return { root, realRoot: await realpathForWorkspace(root, 'workspace root') };
}

export async function resolveWorkspace(options: {
  requested?: string;
  defaultWorkingDirectory: string;
  allowedRoots: string[];
}): Promise<WorkspaceResolution> {
  const base = resolve(options.defaultWorkingDirectory);
  const requested = resolve(base, options.requested ?? '.');
  const roots = options.allowedRoots.length ? options.allowedRoots : [base];
  const resolvedRoots = await Promise.all(roots.map(resolveWorkspaceRoot));

  for (const { root, realRoot } of resolvedRoots) {
    if (isOutsideRoot(root, requested)) continue;
    const realRequested = await realpathForWorkspace(requested, 'working directory');
    if (isOutsideRoot(realRoot, realRequested)) continue;
    return {
      workingDirectory: requested,
      realWorkingDirectory: realRequested,
      allowedRoot: root,
      realAllowedRoot: realRoot,
    };
  }

  throw new RuntimeError('invalid_workspace', `working directory is outside allowed workspace roots: ${requested}`, {
    requested,
    allowedRoots: resolvedRoots.map(({ root }) => root),
  });
}
