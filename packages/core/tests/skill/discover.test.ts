import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
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
    expect(skills.some(s => s.name === 'test-skill')).toBe(true);
  });

  test('higher-priority source overrides lower for same name', async () => {
    const lowDir = join(testDir, 'low');
    const highDir = join(testDir, 'high');
    await writeSkill(lowDir, 'skill-a', 'Low priority version');
    await writeSkill(highDir, 'skill-a', 'High priority version');
    const skills = await discoverSkills(testDir, { skillPaths: [lowDir, highDir] });
    const found = skills.find(s => s.name === 'skill-a');
    expect(found).toBeDefined();
    expect(found!.description).toBe('High priority version');
  });

  test('returns empty when no skill directories exist', async () => {
    const emptyDir = join(testDir, 'empty');
    await mkdir(emptyDir, { recursive: true });
    const skills = await discoverSkills(emptyDir, { skillPaths: [emptyDir] });
    // May find global skills from ~/.cortx/skills/, but none from emptyDir
    expect(skills.every(s => !s.dirPath.startsWith(emptyDir))).toBe(true);
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

    const warnings: string[] = [];
    const skills = await discoverSkills(testDir, { skillPaths: [dir] }, { warn: (msg) => warnings.push(msg) });
    expect(skills.some(s => s.name === 'valid')).toBe(true);
    // Should have logged a warning about the invalid skill
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('discovers skills in nested subdirectories', async () => {
    const nested = join(testDir, 'sub', 'deep');
    await writeSkill(nested, 'nested-skill', 'Nested');
    const skills = await discoverSkills(testDir, { skillPaths: [testDir] });
    expect(skills.some(s => s.name === 'nested-skill')).toBe(true);
  });

  test('MAX_DEPTH: skill beyond depth 6 is not discovered', async () => {
    // Create a skill 7 levels deep: .cortx/skills/a/b/c/d/e/f/SKILL.md
    let deepDir = testDir;
    for (let i = 0; i < 7; i++) deepDir = join(deepDir, `level${i}`);
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, 'SKILL.md'), '---\nname: deep-skill\ndescription: Too deep\n---\nBody');
    const skills = await discoverSkills(testDir, { skillPaths: [testDir] });
    expect(skills.every(s => s.name !== 'deep-skill')).toBe(true);
  });

  test('MAX_DEPTH: skill at exactly depth 6 IS discovered', async () => {
    // Create a skill 6 levels deep
    let deepDir = testDir;
    for (let i = 0; i < 5; i++) deepDir = join(deepDir, `level${i}`);
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, 'SKILL.md'), '---\nname: exact-skill\ndescription: Exactly at limit\n---\nBody');
    const skills = await discoverSkills(testDir, { skillPaths: [testDir] });
    expect(skills.some(s => s.name === 'exact-skill')).toBe(true);
  });

  test('symlinks are not followed', async () => {
    // Create skill file outside the walk tree, only reachable via symlink
    const outsideDir = join(testDir, '..', `outside-${Date.now()}`);
    const realDir = join(outsideDir, 'real');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'SKILL.md'), '---\nname: symlinked\ndescription: Should not be found\n---\nBody');

    // Create symlink inside the walk tree pointing to the outside directory
    const skillDir = join(testDir, 'skills', 'link');
    await mkdir(join(skillDir, '..'), { recursive: true });
    await symlink(realDir, skillDir);

    const skills = await discoverSkills(testDir, { skillPaths: [testDir] });
    // symlinked skill should NOT appear because the symlink is skipped
    expect(skills.every(s => s.name !== 'symlinked')).toBe(true);

    // Cleanup
    await rm(outsideDir, { recursive: true, force: true });
  });

  test('logs warning on skill name collision', async () => {
    const dir1 = join(testDir, 'dir1');
    const dir2 = join(testDir, 'dir2');
    await writeSkill(dir1, 'shared-name', 'First');
    await writeSkill(dir2, 'shared-name', 'Second');
    const warnings: string[] = [];
    await discoverSkills(testDir, { skillPaths: [dir1, dir2] }, { warn: (msg) => warnings.push(msg) });
    expect(warnings.some(w => w.includes('shared-name') && w.includes('overrides'))).toBe(true);
  });

  test('skips SKILL.md larger than 64KB', async () => {
    const dir = join(testDir, 'big');
    await mkdir(dir, { recursive: true });
    const bigBody = 'x'.repeat(65 * 1024);
    await writeFile(join(dir, 'SKILL.md'), `---\nname: big-skill\ndescription: Too large\n---\n${bigBody}`);
    const warnings: string[] = [];
    const skills = await discoverSkills(testDir, { skillPaths: [testDir] }, { warn: (msg) => warnings.push(msg) });
    expect(skills.every(s => s.name !== 'big-skill')).toBe(true);
    expect(warnings.some(w => w.includes('too large'))).toBe(true);
  });
});
