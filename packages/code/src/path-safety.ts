import { lstat, mkdir, realpath } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

export class WorkspacePathError extends Error {
  readonly code = 'workspace_path_outside_root';

  constructor(label: string, input: string) {
    super(`${label} must stay within the current workspace: ${input}`);
    this.name = 'WorkspacePathError';
  }
}

export function isWorkspacePathError(error: unknown): error is WorkspacePathError {
  return error instanceof WorkspacePathError;
}

function isOutsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function resolveLexical(root: string, input: string, label: string): string {
  const target = resolve(root, input);
  if (isOutsideRoot(root, target)) throw new WorkspacePathError(label, input);
  return target;
}

async function lstatIfExists(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function realpathIfExists(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertExistingPathInside(root: string, realRoot: string, target: string, input: string, label: string) {
  const parts = relative(root, target).split(sep).filter(Boolean);
  let cursor = root;

  for (const part of parts) {
    cursor = join(cursor, part);
    const stat = await lstatIfExists(cursor);
    if (!stat) return;
    const realCursor = await realpath(cursor);
    if (isOutsideRoot(realRoot, realCursor)) throw new WorkspacePathError(label, input);
  }
}

async function ensureParentInside(root: string, realRoot: string, target: string, input: string, label: string) {
  const parentParts = relative(root, dirname(target)).split(sep).filter(Boolean);
  let cursor = root;

  for (const part of parentParts) {
    cursor = join(cursor, part);
    const existing = await lstatIfExists(cursor);
    if (!existing) {
      await mkdir(cursor);
    }
    const realCursor = await realpath(cursor);
    if (isOutsideRoot(realRoot, realCursor)) throw new WorkspacePathError(label, input);
  }
}

export async function resolveWorkspacePath(cwd: string, input: string, label = 'path'): Promise<string> {
  const root = resolve(cwd);
  const target = resolveLexical(root, input, label);
  const realRoot = await realpath(root);
  await assertExistingPathInside(root, realRoot, target, input, label);
  return target;
}

export async function resolveWritableWorkspacePath(cwd: string, input: string, label = 'path'): Promise<string> {
  const root = resolve(cwd);
  const target = resolveLexical(root, input, label);
  const realRoot = await realpath(root);
  await ensureParentInside(root, realRoot, target, input, label);

  const realTarget = await realpathIfExists(target);
  if (realTarget && isOutsideRoot(realRoot, realTarget)) throw new WorkspacePathError(label, input);
  return target;
}
