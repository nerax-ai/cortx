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
      { role: 'user', content: [{ type: 'text', text: '/commit fix: typo' }] },
    ];
    const result = await plugin['messages.transform']!(messages);
    const last = result[result.length - 1];
    const content = Array.isArray(last.content) ? last.content[0] : last.content;
    const text = typeof content === 'object' && 'text' in content ? content.text : String(content);
    expect(text).toContain('Create a git commit with message: fix: typo');
    expect(text).toContain('Skill execution active');
  });

  test('messages.transform returns unchanged for non-skill messages', async () => {
    const messages: LanguageMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
    ];
    const result = await plugin['messages.transform']!(messages);
    expect(result[0]).toEqual(messages[0]);
  });

  test('messages.transform returns error for unknown skill', async () => {
    const messages: LanguageMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '/unknown-skill' }] },
    ];
    const result = await plugin['messages.transform']!(messages);
    const last = result[result.length - 1];
    const content = Array.isArray(last.content) ? last.content[0] : last.content;
    const text = typeof content === 'object' && 'text' in content ? content.text : String(content);
    expect(text).toContain('Skill Error');
    expect(text).toContain('"unknown-skill" not found');
  });

  test('messages.transform does NOT match mid-sentence slash', async () => {
    const messages: LanguageMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'I used /commit yesterday' }] },
    ];
    const result = await plugin['messages.transform']!(messages);
    const content = Array.isArray(result[0].content) ? result[0].content[0] : result[0].content;
    const text = typeof content === 'object' && 'text' in content ? content.text : String(content);
    expect(text).toBe('I used /commit yesterday');
  });

  test('messages.transform returns unchanged for empty messages array', async () => {
    const result = await plugin['messages.transform']!([]);
    expect(result).toEqual([]);
  });

  test('messages.transform returns unchanged when last message is assistant', async () => {
    const messages: LanguageMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: '/commit fix' }] },
    ];
    const result = await plugin['messages.transform']!(messages);
    expect(result).toEqual(messages);
  });

  test('messages.transform does NOT mutate the input array', async () => {
    const originalMessages: LanguageMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '/commit fix: typo' }] },
    ];
    const originalRef = originalMessages[0];
    await plugin['messages.transform']!(originalMessages);
    // Original array and objects should be unchanged
    expect(originalMessages[0]).toBe(originalRef);
  });

  test('messages.transform handles multimodal message with text part containing skill invocation', async () => {
    const messages: LanguageMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '/commit fix: typo' },
          { type: 'file', data: 'fake-image', mimeType: 'image/png' },
        ] as any,
      },
    ];
    const result = await plugin['messages.transform']!(messages);
    const last = result[result.length - 1];
    const firstPart = Array.isArray(last.content) ? last.content[0] : last.content;
    const text = typeof firstPart === 'object' && 'text' in firstPart ? firstPart.text : String(firstPart);
    expect(text).toContain('Create a git commit with message: fix: typo');
    expect(text).toContain('Skill execution active');
  });

  test('messages.transform skips non-text content without skill invocation', async () => {
    const messages: LanguageMessage[] = [
      { role: 'user', content: [{ type: 'file', data: 'data', mimeType: 'image/png' }] as any },
    ];
    const result = await plugin['messages.transform']!(messages);
    expect(result[0]).toEqual(messages[0]);
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

  test('skill tool rejects non-string name', async () => {
    const tool = plugin.tools![0];
    const result = await tool.execute({ name: 123 } as any, {
      sessionId: 'test',
      workingDirectory: process.cwd(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, scope() { return this; } },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('must be a string');
  });

  test('no summary when no skills discovered', () => {
    const emptyPlugin = createSkillPlugin([], process.cwd());
    const result = emptyPlugin['system.transform']!('System prompt');
    expect(result).toBe('System prompt');
  });
});
