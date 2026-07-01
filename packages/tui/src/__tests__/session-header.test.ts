import { describe, expect, test } from 'bun:test';
import {
  compactPath,
  formatTokenUsage,
  headerSegments,
  shortSessionId,
  statusBadge,
} from '../components/session-header.js';

describe('session header helpers', () => {
  test('shortens long session ids', () => {
    expect(shortSessionId('session_123456789')).toBe('session_');
  });

  test('keeps short session ids unchanged', () => {
    expect(shortSessionId('abc123')).toBe('abc123');
  });

  test('compacts cwd to the last two path segments', () => {
    expect(compactPath('/Users/zhxout/gitwork/cortx')).toBe('gitwork/cortx');
  });

  test('formats root path', () => {
    expect(compactPath('/')).toBe('/');
  });

  test('formats token usage with k suffix above 1000', () => {
    expect(formatTokenUsage({ inputTokens: 1530, outputTokens: 42 })).toBe('1.5k in / 42 out');
  });

  test('statusBadge gives registry loading priority', () => {
    expect(statusBadge('idle', false).label).toBe('loading');
  });

  test('statusBadge maps errors to an error label', () => {
    expect(statusBadge('error', true).label).toBe('error');
  });

  test('headerSegments builds compact context segments', () => {
    expect(headerSegments({
      model: 'default',
      cwd: '/Users/zhxout/gitwork/cortx',
      sessionId: 'session_abcdef',
      iteration: 2,
      tokenUsage: { inputTokens: 1000, outputTokens: 25 },
      totalElapsed: 9,
    })).toEqual([
      'default',
      'gitwork/cortx',
      'session session_',
      'turn 2',
      '1.0k in / 25 out',
      '9s',
    ]);
  });
});
