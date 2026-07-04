import { describe, test, expect } from 'bun:test';
import { parseInvocation, substituteArgs } from '../../src/capabilities/skills/substitute.js';

describe('parseInvocation', () => {
  test('parses /commit fix: typo', () => {
    const result = parseInvocation('/commit fix: typo');
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe('commit');
    expect(result!.argsString).toBe('fix: typo');
    expect(result!.positionalArgs).toEqual(['fix:', 'typo']);
  });

  test('parses /skill-name without args', () => {
    const result = parseInvocation('/skill-name');
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe('skill-name');
    expect(result!.argsString).toBe('');
    expect(result!.positionalArgs).toEqual([]);
  });

  test('returns null for non-slash message', () => {
    expect(parseInvocation('hello world')).toBeNull();
  });

  test('returns null for mid-sentence slash', () => {
    expect(parseInvocation('I used /commit yesterday')).toBeNull();
  });

  test('handles skill name with underscores and hyphens', () => {
    const result = parseInvocation('/my_skill-name arg');
    expect(result!.skillName).toBe('my_skill-name');
  });

  test('handles skill name with colons (e.g. ce:ideate)', () => {
    const result = parseInvocation('/ce:ideate');
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe('ce:ideate');
    expect(result!.argsString).toBe('');
  });

  test('handles colon-prefixed skill with args', () => {
    const result = parseInvocation('/ce:plan some feature');
    expect(result!.skillName).toBe('ce:plan');
    expect(result!.argsString).toBe('some feature');
  });
});

describe('substituteArgs', () => {
  test('replaces $ARGUMENTS with raw args string', () => {
    const result = substituteArgs('Commit: $ARGUMENTS', 'fix: typo', ['fix:', 'typo']);
    expect(result).toBe('Commit: fix: typo');
  });

  test('replaces $1, $2 with positional args', () => {
    const result = substituteArgs('First: $1, Second: $2', 'a b', ['a', 'b']);
    expect(result).toBe('First: a, Second: b');
  });

  test('empty string when no args provided', () => {
    const result = substituteArgs('$ARGUMENTS and $1', '', []);
    expect(result).toBe(' and ');
  });

  test('excess $N references become empty string', () => {
    const result = substituteArgs('$1 $2 $3', 'a b', ['a', 'b']);
    expect(result).toBe('a b ');
  });

  test('does NOT substitute inside fenced code blocks', () => {
    const body = 'Before $ARGUMENTS\n```bash\necho $ARGUMENTS\n```\nAfter $ARGUMENTS';
    const result = substituteArgs(body, 'hello', ['hello']);
    expect(result).toContain('Before hello');
    expect(result).toContain('echo $ARGUMENTS'); // inside code block, not substituted
    expect(result).toContain('After hello');
  });

  test('preserves special characters in args', () => {
    const result = substituteArgs('Msg: $ARGUMENTS', 'fix(core)!: breaking change', ['fix(core)!:']);
    expect(result).toBe('Msg: fix(core)!: breaking change');
  });

  test('$0 resolves to empty string (1-based indexing)', () => {
    const result = substituteArgs('$0 should be empty', 'arg', ['arg']);
    expect(result).toBe(' should be empty');
  });

  test('odd number of fences leaves trailing content in code state', () => {
    // Single opening fence: everything after is treated as code
    const body = 'Before $ARGUMENTS\n```bash\necho $ARGUMENTS';
    const result = substituteArgs(body, 'hello', ['hello']);
    expect(result).toContain('Before hello');
    // After the single fence, content is treated as code so $ARGUMENTS is preserved
    expect(result).toContain('echo $ARGUMENTS');
  });

  test('three fences (open-close-open) correctly protects middle block', () => {
    const body = 'Text $1\n```\ncode $1\n```\nMore text $1\n```\ncode $1';
    const result = substituteArgs(body, 'arg', ['arg']);
    expect(result).toContain('Text arg');
    expect(result).toContain('code $1');
    expect(result).toContain('More text arg');
  });
});
