import type { SkillInfo } from '@cortx/sdk';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseSkillFile, SkillParseError } from './parse.js';

const MAX_DEPTH = 6;

async function walkDir(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') {
      results.push(full);
    } else if (entry.isDirectory()) {
      results.push(...await walkDir(full, depth + 1));
    }
  }
  return results;
}

async function loadSkillsFromDir(dir: string): Promise<{ skills: SkillInfo[]; errors: SkillParseError[] }> {
  const skills: SkillInfo[] = [];
  const errors: SkillParseError[] = [];
  const files = await walkDir(dir, 0);
  for (const filePath of files) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const dirPath = resolve(filePath, '..');
      skills.push(parseSkillFile(raw, filePath, dirPath));
    } catch (e) {
      if (e instanceof SkillParseError) errors.push(e);
      // silently skip other errors (permission, etc.)
    }
  }
  return { skills, errors };
}

function* walkCwdToHome(cwd: string, home: string): Generator<string> {
  let dir = cwd;
  while (true) {
    yield join(dir, '.cortx', 'skills');
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
    if (dir === home || dir === join(home, '..')) break;
  }
}

export async function discoverSkills(cwd: string, config: { skillPaths?: string[] }): Promise<SkillInfo[]> {
  const home = homedir();
  const byName = new Map<string, SkillInfo>();

  // Priority: low → high: config skillPaths, ~/.cortx/skills/, .cortx/skills/ (CWD walk-up)
  const sources: string[] = [
    ...(config.skillPaths ?? []),
    join(home, '.cortx', 'skills'),
    ...Array.from(walkCwdToHome(cwd, home)).reverse(), // nearest (highest priority) last
  ];

  for (const dir of sources) {
    const { skills } = await loadSkillsFromDir(dir);
    for (const skill of skills) {
      byName.set(skill.name, skill); // later (higher priority) overwrites earlier
    }
  }

  return [...byName.values()];
}
