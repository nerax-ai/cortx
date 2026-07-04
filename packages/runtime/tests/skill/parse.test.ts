import { describe, test, expect } from 'bun:test';
import { parseFrontmatter, parseSkillFile, SkillParseError } from '../../src/capabilities/skills/parse.js';

describe('parseFrontmatter', () => {
  test('parses valid YAML frontmatter with body', () => {
    const raw = '---\nname: test-skill\ndescription: A test skill\n---\nSkill body content';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter.name).toBe('test-skill');
    expect(result.frontmatter.description).toBe('A test skill');
    expect(result.body).toBe('Skill body content');
  });

  test('parses frontmatter with optional arguments', () => {
    const raw = '---\nname: commit\ndescription: Commit helper\narguments:\n  - message\n  - scope\n---\nBody';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter.arguments).toEqual(['message', 'scope']);
  });

  test('returns empty string for body when no content after frontmatter', () => {
    const raw = '---\nname: empty\ndescription: Empty body\n---\n';
    const result = parseFrontmatter(raw);
    expect(result.body).toBe('');
  });

  test('ignores extra unknown fields in YAML', () => {
    const raw = '---\nname: test\ndescription: Test\nunknown: field\n---\nBody';
    const result = parseFrontmatter(raw);
    expect(result.frontmatter.name).toBe('test');
    expect(result.frontmatter.unknown).toBe('field');
  });

  test('throws when no frontmatter delimiters', () => {
    expect(() => parseFrontmatter('no frontmatter here')).toThrow(SkillParseError);
    expect(() => parseFrontmatter('no frontmatter here')).toThrow(/no frontmatter delimiters found/);
  });

  test('throws when YAML is not a mapping (scalar)', () => {
    expect(() => parseFrontmatter('---\njust a string\n---\nBody')).toThrow(/frontmatter must be a YAML mapping/);
  });

  test('throws when YAML is an array', () => {
    expect(() => parseFrontmatter('---\n- item1\n- item2\n---\nBody')).toThrow(/frontmatter must be a YAML mapping/);
  });
});

describe('parseSkillFile', () => {
  const validRaw = '---\nname: commit\ndescription: Create a commit\n---\nCreate a commit with the message $ARGUMENTS';

  test('parses valid SKILL.md into SkillInfo', () => {
    const info = parseSkillFile(validRaw, 'SKILL.md', '/skills/commit');
    expect(info.name).toBe('commit');
    expect(info.description).toBe('Create a commit');
    expect(info.content).toBe('Create a commit with the message $ARGUMENTS');
    expect(info.dirPath).toBe('/skills/commit');
    expect(info.arguments).toBeUndefined();
  });

  test('parses SKILL.md with arguments array', () => {
    const raw = '---\nname: deploy\ndescription: Deploy\narguments:\n  - env\n  - version\n---\nBody';
    const info = parseSkillFile(raw, 'SKILL.md', '/skills/deploy');
    expect(info.arguments).toEqual(['env', 'version']);
  });

  test('throws when name is missing', () => {
    const raw = '---\ndescription: No name\n---\nBody';
    expect(() => parseSkillFile(raw, 'SKILL.md', '/dir')).toThrow(/missing or invalid "name"/);
  });

  test('throws when description is missing', () => {
    const raw = '---\nname: test\n---\nBody';
    expect(() => parseSkillFile(raw, 'SKILL.md', '/dir')).toThrow(/missing or invalid "description"/);
  });

  test('throws when name is not a string', () => {
    const raw = '---\nname: 123\ndescription: Test\n---\nBody';
    expect(() => parseSkillFile(raw, 'SKILL.md', '/dir')).toThrow(/missing or invalid "name"/);
  });

  test('throws when description is not a string', () => {
    const raw = '---\nname: test\ndescription: 456\n---\nBody';
    expect(() => parseSkillFile(raw, 'SKILL.md', '/dir')).toThrow(/missing or invalid "description"/);
  });

  test('throws when arguments contains non-string values', () => {
    const raw = '---\nname: test\ndescription: Test\narguments:\n  - valid\n  - 123\n---\nBody';
    expect(() => parseSkillFile(raw, 'SKILL.md', '/dir')).toThrow(/must be an array of strings/);
  });
});
