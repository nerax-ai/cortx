import { constants } from 'fs';
import { lstat, mkdir, open, realpath } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

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

async function canonicalPathInside(root: string, realRoot: string, target: string, input: string, label: string): Promise<string> {
  const parts = relative(root, target).split(sep).filter(Boolean);
  let lexicalCursor = root;
  let realCursor = realRoot;

  for (let i = 0; i < parts.length; i++) {
    lexicalCursor = join(lexicalCursor, parts[i]);
    const stat = await lstatIfExists(lexicalCursor);
    if (!stat) return join(realCursor, ...parts.slice(i));
    realCursor = await realpath(lexicalCursor);
    if (isOutsideRoot(realRoot, realCursor)) throw new WorkspacePathError(label, input);
  }
  return realCursor;
}

async function ensureParentInside(root: string, realRoot: string, target: string, input: string, label: string): Promise<string> {
  const parentParts = relative(root, dirname(target)).split(sep).filter(Boolean);
  let lexicalCursor = root;
  let realCursor = realRoot;

  for (const part of parentParts) {
    lexicalCursor = join(lexicalCursor, part);
    const existing = await lstatIfExists(lexicalCursor);
    if (!existing) {
      realCursor = join(realCursor, part);
      await mkdir(realCursor);
      lexicalCursor = realCursor;
      continue;
    }
    realCursor = await realpath(lexicalCursor);
    if (isOutsideRoot(realRoot, realCursor)) throw new WorkspacePathError(label, input);
  }
  return realCursor;
}

export async function resolveWorkspacePath(cwd: string, input: string, label = 'path'): Promise<string> {
  const root = resolve(cwd);
  const target = resolveLexical(root, input, label);
  const realRoot = await realpath(root);
  return canonicalPathInside(root, realRoot, target, input, label);
}

export async function resolveWritableWorkspacePath(cwd: string, input: string, label = 'path'): Promise<string> {
  const root = resolve(cwd);
  const target = resolveLexical(root, input, label);
  const realRoot = await realpath(root);
  const realParent = await ensureParentInside(root, realRoot, target, input, label);

  const realTarget = await realpathIfExists(target);
  if (realTarget && isOutsideRoot(realRoot, realTarget)) throw new WorkspacePathError(label, input);
  return realTarget ?? join(realParent, basename(target));
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

export async function readTextNoFollow(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    return await handle.readFile('utf-8');
  } finally {
    await handle.close();
  }
}

export async function writeTextNoFollow(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag(), 0o666);
  try {
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}

export async function replaceTextNoFollow(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_TRUNC | noFollowFlag());
  try {
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}
