import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkills } from '../src/capabilities/skills/discover.js';
import { createSkillExtensions } from '../src/capabilities/skills/extension.js';
import { parseInvocation, substituteArgs } from '../src/capabilities/skills/substitute.js';
import type { LanguageMessage } from '@cortx/sdk';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `cortx-conformance-assets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeSkill(baseDir: string, name: string, description: string, body = `Instructions for ${name}`): Promise<string> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  return dir;
}

function textOfMessage(message: LanguageMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.find((part) => part.type === 'text')?.text ?? '';
}

describe('conformance: assets', () => {
  test('skill discovery honors priority, warns on override, and skips invalid skills without aborting discovery', async () => {
    const low = join(testDir, 'low');
    const high = join(testDir, 'high');
    const invalid = join(high, 'invalid');
    await writeSkill(low, 'review', 'low priority', 'low body');
    await writeSkill(high, 'review', 'high priority', 'high body');
    await writeSkill(low, 'commit', 'commit skill', 'commit body');
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, 'SKILL.md'), '---\nnot valid yaml\n---\nbody');

    const warnings: string[] = [];
    const skills = await discoverSkills(testDir, { skillPaths: [low, high] }, { warn: (message) => warnings.push(message) });

    expect(skills.find((skill) => skill.name === 'review')?.description).toBe('high priority');
    expect(skills.some((skill) => skill.name === 'commit')).toBe(true);
    expect(warnings.some((warning) => warning.includes('review') && warning.includes('overrides'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('Skill parse error'))).toBe(true);
  });

  test('skill system bridge injects summaries, expands message-start slash invocations, and leaves ordinary slash text alone', async () => {
    const skillDir = await writeSkill(
      testDir,
      'review',
      'Review code changes',
      'Review target: $ARGUMENTS\nFirst arg: $1',
    );
    const skills = await discoverSkills(testDir, { skillPaths: [testDir] });
    const extensions = createSkillExtensions(skills);

    const system = await extensions.systemTransforms[0].transformSystem({ system: 'Base' });
    expect(system.system).toContain('Base');
    expect(system.system).toContain('review: Review code changes');

    const expanded = await extensions.messagesTransforms[0].transformMessages({
      messages: [{ role: 'user', content: [{ type: 'text', text: '/review src/foo.ts' }] }],
    });
    expect(textOfMessage(expanded.messages[0])).toContain('Review target: src/foo.ts');
    expect(textOfMessage(expanded.messages[0])).toContain('First arg: src/foo.ts');

    const unchanged = await extensions.messagesTransforms[0].transformMessages({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'I used /review yesterday' }] }],
    });
    expect(textOfMessage(unchanged.messages[0])).toBe('I used /review yesterday');

    await writeFile(join(skillDir, 'helper.sh'), '#!/bin/sh\necho helper\n');
    const toolResult = await extensions.tools[0].execute({ name: 'review' }, {
      sessionId: 'test',
      toolCallId: 'skill-call',
      workingDirectory: testDir,
      logger: { debug() {}, info() {}, warn() {}, error() {}, scope() { return this; } },
    });
    expect(toolResult.success).toBe(true);
    expect(String(toolResult.output)).toContain('# Skill: review');
    expect(String(toolResult.output)).toContain('helper.sh');
  });

  test('argument substitution protects fenced code blocks', () => {
    const parsed = parseInvocation('/commit fix: typo');
    expect(parsed).toEqual({ skillName: 'commit', argsString: 'fix: typo', positionalArgs: ['fix:', 'typo'] });

    const output = substituteArgs('Outside $ARGUMENTS\n```\nInside $ARGUMENTS\n```\nFirst $1', 'fix: typo', ['fix:', 'typo']);
    expect(output).toContain('Outside fix: typo');
    expect(output).toContain('Inside $ARGUMENTS');
    expect(output).toContain('First fix:');
  });
});
