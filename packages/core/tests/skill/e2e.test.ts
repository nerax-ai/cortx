import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkills } from '../../src/skill/discover.js';
import { createSkillPlugin } from '../../src/skill/plugin.js';
import type { LanguageMessage } from '@synax-ai/sdk';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `cortx-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function createSkillDir(name: string, description: string, body: string, extras: Record<string, string> = {}) {
  const skillDir = join(testDir, '.cortx', 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  for (const [path, content] of Object.entries(extras)) {
    const fullPath = join(skillDir, path);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content);
  }
  return skillDir;
}

describe('E2E: Skill system', () => {
  test('full flow: discovery → system prompt → pre-parse → tool', async () => {
    await createSkillDir('commit', 'Create a commit', 'Create a git commit with: $ARGUMENTS\n\nUse $1 for scope.');
    await createSkillDir('review', 'Review code', 'Review the code for issues.');

    const skills = await discoverSkills(testDir, {});
    expect(skills.length).toBeGreaterThanOrEqual(2);

    const plugin = createSkillPlugin(skills, testDir);

    // 1. System prompt injection
    const system = plugin['system.transform']!('You are an assistant.');
    expect(system).toContain('## Available Skills');
    expect(system).toContain('- commit: Create a commit');
    expect(system).toContain('- review: Review code');

    // 2. Pre-parse with argument substitution
    const messages: LanguageMessage[] = [
      { role: 'user', content: '/commit fix: typo' } as any,
    ];
    const transformed = await plugin['messages.transform']!(messages);
    const content = transformed[0].content;
    const lastContent = typeof content === 'string'
      ? content
      : content.find((part) => part.type === 'text')?.text ?? '';
    expect(lastContent).toContain('fix: typo');
    expect(lastContent).toContain('fix: for scope'); // $1 substituted with first arg "fix:"

    // 3. Skill tool returns full content
    const tool = plugin.tools![0];
    const result = await tool.execute({ name: 'review' }, {
      sessionId: 'test',
      workingDirectory: testDir,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, scope() { return this; } },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Review the code for issues');
  });

  test('companion files listed in skill tool output', async () => {
    await createSkillDir('deploy', 'Deploy app', 'Deploy the app.', {
      'scripts/deploy.sh': '#!/bin/bash\necho deploy',
      'references/config.md': '# Config reference',
    });

    const skills = await discoverSkills(testDir, {});
    const plugin = createSkillPlugin(skills, testDir);
    const tool = plugin.tools![0];

    const result = await tool.execute({ name: 'deploy' }, {
      sessionId: 'test',
      workingDirectory: testDir,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, scope() { return this; } },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Companion Files');
    expect(result.output).toContain('scripts/deploy.sh');
    expect(result.output).toContain('references/config.md');
  });

  test('multiple skills in one session', async () => {
    await createSkillDir('skill-a', 'Skill A', 'Content A');
    await createSkillDir('skill-b', 'Skill B', 'Content B');

    const skills = await discoverSkills(testDir, {});
    const plugin = createSkillPlugin(skills, testDir);

    const system = plugin['system.transform']!('System');
    expect(system).toContain('skill-a');
    expect(system).toContain('skill-b');
  });
});
