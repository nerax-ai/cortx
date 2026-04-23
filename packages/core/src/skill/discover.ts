import type { SkillInfo } from '@cortx/sdk';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { parseSkillFile, SkillParseError } from './parse.js';

const MAX_DEPTH = 6;
const MAX_SKILLS = 100;
const MAX_FILE_SIZE = 64 * 1024; // 64KB

async function walkDir(dir: string, depth: number, logger?: { warn?: (msg: string) => void }): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') {
      results.push(full);
    } else if (entry.isDirectory()) {
      results.push(...await walkDir(full, depth + 1, logger));
    }
  }
  return results;
}

async function loadSkillsFromDir(dir: string, logger?: { warn?: (msg: string) => void }): Promise<{ skills: SkillInfo[]; errors: SkillParseError[] }> {
  const skills: SkillInfo[] = [];
  const errors: SkillParseError[] = [];
  const files = await walkDir(dir, 0, logger);
  for (const filePath of files) {
    try {
      const s = await stat(filePath);
      if (s.size > MAX_FILE_SIZE) {
        logger?.warn?.(`Skipping ${filePath}: file too large (${s.size} bytes, max ${MAX_FILE_SIZE})`);
        continue;
      }
      const raw = await readFile(filePath, 'utf-8');
      const dirPath = resolve(filePath, '..');
      skills.push(parseSkillFile(raw, filePath, dirPath));
    } catch (e) {
      if (e instanceof SkillParseError) {
        errors.push(e);
        logger?.warn?.(`Skill parse error: ${e.message}`);
      } else {
        logger?.warn?.(`Error loading skill from ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (skills.length >= MAX_SKILLS) break;
  }
  return { skills, errors };
}

function* walkCwdToHome(cwd: string, home: string): Generator<string> {
  // Only walk up if CWD is within the home directory tree
  const normalizedCwd = resolve(cwd);
  const normalizedHome = resolve(home);
  const isUnderHome = normalizedCwd === normalizedHome || normalizedCwd.startsWith(normalizedHome + '/');
  let dir = cwd;
  while (true) {
    yield join(dir, '.cortx', 'skills');
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
    if (isUnderHome && (dir === home || dir === join(home, '..'))) break;
    if (!isUnderHome && dir === normalizedHome) break;
  }
}

export async function discoverSkills(cwd: string, config: { skillPaths?: string[] }, logger?: { warn?: (msg: string) => void }): Promise<SkillInfo[]> {
  const home = homedir();
  const byName = new Map<string, SkillInfo>();

  // Priority: low → high: config skillPaths, ~/.cortx/skills/, .cortx/skills/ (CWD walk-up)
  const sources: string[] = [
    ...(config.skillPaths ?? []),
    join(home, '.cortx', 'skills'),
    ...Array.from(walkCwdToHome(cwd, home)).reverse(), // nearest (highest priority) last
  ];

  for (const dir of sources) {
    const { skills } = await loadSkillsFromDir(dir, logger);
    for (const skill of skills) {
      if (byName.has(skill.name)) {
        logger?.warn?.(`Skill "${skill.name}" from ${relative(cwd, skill.dirPath)} overrides previous definition`);
      }
      byName.set(skill.name, skill); // later (higher priority) overwrites earlier
    }
    if (byName.size >= MAX_SKILLS) break;
  }

  return [...byName.values()];
}
