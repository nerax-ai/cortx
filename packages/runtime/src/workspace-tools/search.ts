import { lstat, readdir, realpath } from 'fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'path';

function isOutsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (const char of glob) {
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}

export async function collectWorkspaceFiles(cwd: string, start: string): Promise<string[]> {
  const root = resolve(cwd);
  const realRoot = await realpath(root);
  const files: string[] = [];

  async function walk(target: string): Promise<void> {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const realTarget = await realpath(target);
      if (isOutsideRoot(realRoot, realTarget)) return;
      return;
    }
    if (stat.isDirectory()) {
      const entries = await readdir(target);
      for (const entry of entries) await walk(join(target, entry));
      return;
    }
    if (stat.isFile()) files.push(target);
  }

  await walk(start);
  return files;
}

export function workspaceDisplayPath(cwd: string, target: string): string {
  const rel = relative(resolve(cwd), target);
  return rel || basename(target);
}
