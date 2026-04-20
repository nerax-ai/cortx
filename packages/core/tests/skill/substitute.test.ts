import { describe, test, expect } from 'bun:test';
import { parseInvocation, substituteArgs } from '../../src/skill/substitute.js';

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
});
