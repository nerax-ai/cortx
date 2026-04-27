import { describe, test, expect } from 'bun:test';
import { parseAgentMessages, turnsToMessages } from '../src/message-io.js';
import type { TurnEntry } from '../src/types/tui-state.js';

describe('parseAgentMessages', () => {
  test('parses valid message array', () => {
    const data = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const result = parseAgentMessages(data);
    expect(result).toHaveLength(2);
  });

  test('returns empty array for null input', () => {
    expect(parseAgentMessages(null)).toHaveLength(0);
  });

  test('returns empty array for undefined input', () => {
    expect(parseAgentMessages(undefined)).toHaveLength(0);
  });

  test('returns empty array for non-array input', () => {
    expect(parseAgentMessages('not an array')).toHaveLength(0);
  });

  test('filters out items without role', () => {
    const data = [
      { role: 'user', content: 'hello' },
      { notRole: true },
      { role: 'assistant', content: 'hi' },
    ];
    const result = parseAgentMessages(data);
    expect(result).toHaveLength(2);
  });
});

describe('turnsToMessages', () => {
  test('maps turns to message objects', () => {
    const turns: TurnEntry[] = [
      { role: 'user', content: 'hello', timestamp: Date.now() },
      { role: 'assistant', content: 'hi', timestamp: Date.now() },
    ];
    const result = turnsToMessages(turns);
    expect(result).toHaveLength(2);
    expect((result[0] as any).role).toBe('user');
    expect((result[0] as any).content).toBe('hello');
  });
});
