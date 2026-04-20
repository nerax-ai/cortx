import { describe, test, expect } from 'bun:test';
import { createSkillPlugin } from '../../src/skill/plugin.js';
import type { SkillInfo } from '@cortx/sdk';
import type { LanguageMessage } from '@synax-ai/sdk';

function skill(name: string, description: string, content = 'Do something'): SkillInfo {
  return { name, description, content, dirPath: '' };
}

describe('createSkillPlugin', () => {
  const skills = [skill('commit', 'Create a commit', 'Create a git commit with message: $ARGUMENTS')];
  const plugin = createSkillPlugin(skills, process.cwd());

  test('system.transform appends skill summary', () => {
    const result = plugin['system.transform']!('Base system prompt');
    expect(result).toContain('Base system prompt');
    expect(result).toContain('## Available Skills');
    expect(result).toContain('- commit: Create a commit');
  });

  test('messages.transform replaces /skill-name with expanded content', async () => {
    const messages: LanguageMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'System' }] },
      { role: 'user', content: '/commit fix: typo' },
    ];
    const result = await plugin['messages.transform']!(messages);
    const last = result[result.length - 1];
    const content = typeof last.content === 'string' ? last.content : '';
    expect(content).toBe('Create a git commit with message: fix: typo');
  });

  test('messages.transform returns unchanged for non-skill messages', async () => {
    const messages: LanguageMessage[] = [
      { role: 'user', content: 'Hello world' },
    ];
    const result = await plugin['messages.transform']!(messages);
    expect(result[0]).toEqual(messages[0]);
  });

  test('messages.transform returns error for unknown skill', async () => {
    const messages: LanguageMessage[] = [
      { role: 'user', content: '/unknown-skill' },
    ];
    const result = await plugin['messages.transform']!(messages);
    const content = typeof result[0].content === 'string' ? result[0].content : '';
    expect(content).toContain('Skill Error');
    expect(content).toContain('"unknown-skill" not found');
  });

  test('messages.transform does NOT match mid-sentence slash', async () => {
    const messages: LanguageMessage[] = [
      { role: 'user', content: 'I used /commit yesterday' },
    ];
    const result = await plugin['messages.transform']!(messages);
    const content = typeof result[0].content === 'string' ? result[0].content : '';
    expect(content).toBe('I used /commit yesterday');
  });

  test('provides skill tool in tools array', () => {
    expect(plugin.tools).toBeDefined();
    expect(plugin.tools!.length).toBe(1);
    expect(plugin.tools![0].name).toBe('skill');
  });

  test('skill tool returns content for valid skill', async () => {
    const tool = plugin.tools![0];
    const result = await tool.execute({ name: 'commit' }, {
      sessionId: 'test',
      workingDirectory: process.cwd(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, scope() { return this; } },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Create a git commit');
  });

  test('skill tool returns error for unknown skill', async () => {
    const tool = plugin.tools![0];
    const result = await tool.execute({ name: 'nonexistent' }, {
      sessionId: 'test',
      workingDirectory: process.cwd(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, scope() { return this; } },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('no summary when no skills discovered', () => {
    const emptyPlugin = createSkillPlugin([], process.cwd());
    const result = emptyPlugin['system.transform']!('System prompt');
    expect(result).toBe('System prompt');
  });
});
