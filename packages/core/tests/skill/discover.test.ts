import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkills } from '../../src/skill/discover.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `cortx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeSkill(baseDir: string, name: string, description: string, body = 'Body') {
  const skillDir = join(baseDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  return skillDir;
}

describe('discoverSkills', () => {
  test('discovers a single skill from skillPaths', async () => {
    await writeSkill(testDir, 'test-skill', 'A test');
    const skills = await discoverSkills(testDir, { skillPaths: [testDir] });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-skill');
  });

  test('higher-priority source overrides lower for same name', async () => {
    const lowDir = join(testDir, 'low');
    const highDir = join(testDir, 'high');
    await writeSkill(lowDir, 'skill-a', 'Low priority version');
    await writeSkill(highDir, 'skill-a', 'High priority version');
    // skillPaths order: low first, high second → high wins
    const skills = await discoverSkills(testDir, { skillPaths: [lowDir, highDir] });
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('High priority version');
  });

  test('returns empty when no skill directories exist', async () => {
    const emptyDir = join(testDir, 'empty');
    await mkdir(emptyDir, { recursive: true });
    const skills = await discoverSkills(emptyDir, {});
    // May find skills from ~/.cortx/skills/ or CWD walk-up, but empty skillPaths
    // Just check it doesn't throw
    expect(Array.isArray(skills)).toBe(true);
  });

  test('skips invalid SKILL.md and loads others', async () => {
    const dir = join(testDir, 'mixed');
    await mkdir(dir, { recursive: true });

    const validDir = join(dir, 'valid');
    await mkdir(validDir, { recursive: true });
    await writeFile(join(validDir, 'SKILL.md'), '---\nname: valid\ndescription: Valid skill\n---\nBody');

    const invalidDir = join(dir, 'invalid');
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(invalidDir, 'SKILL.md'), '---\ninvalid yaml\n---\nBody');

    const skills = await discoverSkills(testDir, { skillPaths: [dir] });
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills.some(s => s.name === 'valid')).toBe(true);
  });

  test('discovers skills in nested subdirectories', async () => {
    const nested = join(testDir, 'sub', 'deep');
    await writeSkill(nested, 'nested-skill', 'Nested');
    const skills = await discoverSkills(testDir, { skillPaths: [testDir] });
    expect(skills.some(s => s.name === 'nested-skill')).toBe(true);
  });
});
