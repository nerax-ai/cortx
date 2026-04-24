import { describe, test, expect } from 'bun:test';
import { computeDiff, trimContext } from '../components/diff.js';

describe('computeDiff', () => {
  test('identical text returns all context lines', () => {
    const result = computeDiff('hello\nworld', 'hello\nworld');
    expect(result).toEqual([
      { type: 'context', content: 'hello' },
      { type: 'context', content: 'world' },
    ]);
  });

  test('added lines only', () => {
    const result = computeDiff('', 'new line');
    expect(result).toEqual([
      { type: 'add', content: 'new line' },
    ]);
  });

  test('removed lines only', () => {
    const result = computeDiff('old line', '');
    expect(result).toEqual([
      { type: 'remove', content: 'old line' },
    ]);
  });

  test('mixed additions and removals', () => {
    const result = computeDiff('old 1\nkeep\nold 3', 'new 1\nkeep\nnew 3');
    expect(result).toEqual([
      { type: 'remove', content: 'old 1' },
      { type: 'add', content: 'new 1' },
      { type: 'context', content: 'keep' },
      { type: 'remove', content: 'old 3' },
      { type: 'add', content: 'new 3' },
    ]);
  });

  test('empty both inputs returns empty', () => {
    const result = computeDiff('', '');
    expect(result).toEqual([]);
  });

  test('single line change', () => {
    const result = computeDiff('hello', 'world');
    expect(result).toEqual([
      { type: 'remove', content: 'hello' },
      { type: 'add', content: 'world' },
    ]);
  });
});

describe('trimContext', () => {
  test('trims excess context lines', () => {
    const diff = [
      { type: 'context' as const, content: 'line 1' },
      { type: 'context' as const, content: 'line 2' },
      { type: 'context' as const, content: 'line 3' },
      { type: 'add' as const, content: 'added' },
      { type: 'context' as const, content: 'line 5' },
      { type: 'context' as const, content: 'line 6' },
      { type: 'context' as const, content: 'line 7' },
    ];
    const result = trimContext(diff, 1);
    expect(result.some((l) => l.content === 'added')).toBe(true);
    expect(result.some((l) => l.content === 'line 1')).toBe(false);
    expect(result.some((l) => l.content === 'line 7')).toBe(false);
  });

  test('keeps all change lines', () => {
    const diff = [
      { type: 'context' as const, content: 'ctx' },
      { type: 'add' as const, content: 'a1' },
      { type: 'remove' as const, content: 'r1' },
      { type: 'add' as const, content: 'a2' },
    ];
    const result = trimContext(diff, 1);
    expect(result.filter((l) => l.type === 'add').length).toBe(2);
    expect(result.filter((l) => l.type === 'remove').length).toBe(1);
  });
});
