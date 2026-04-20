import { describe, test, expect } from 'bun:test';
import { renderSkillSummary } from '../../src/skill/render.js';
import type { SkillInfo } from '@cortx/sdk';

function skill(name: string, description: string): SkillInfo {
  return { name, description, content: '', dirPath: '' };
}

describe('renderSkillSummary', () => {
  test('renders 3 skills with all names and descriptions', () => {
    const result = renderSkillSummary([
      skill('commit', 'Create a commit'),
      skill('review', 'Review code'),
      skill('deploy', 'Deploy to env'),
    ]);
    expect(result).toContain('- commit: Create a commit');
    expect(result).toContain('- review: Review code');
    expect(result).toContain('- deploy: Deploy to env');
    expect(result).toContain('## Available Skills');
  });

  test('returns empty string for 0 skills', () => {
    expect(renderSkillSummary([])).toBe('');
  });

  test('truncates long descriptions to fit budget', () => {
    const longDesc = 'A'.repeat(500);
    const result = renderSkillSummary([skill('a', longDesc), skill('b', longDesc)], 300);
    expect(result.length).toBeLessThanOrEqual(600); // some slack for header/guidance
    expect(result).toContain('...');
  });

  test('includes usage guidance for skill tool', () => {
    const result = renderSkillSummary([skill('test', 'Test skill')]);
    expect(result).toContain('`skill` tool');
  });
});
