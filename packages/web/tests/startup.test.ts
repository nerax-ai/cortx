import { describe, expect, test } from 'bun:test';
import { preferredInitialToolMode } from '../src/startup';

describe('web startup profile selection', () => {
  test('prefers the canonical all profile when the server exposes it', () => {
    expect(preferredInitialToolMode([{
      id: 'all',
      use: '@cortx-ai/workspace-tools/all',
      tools: [],
    }])).toBe('@cortx-ai/workspace-tools/all');
  });

  test('lets the server choose a safe default when no all profile is available', () => {
    expect(preferredInitialToolMode([])).toBeUndefined();
    expect(preferredInitialToolMode([{
      id: 'read-only',
      use: '@cortx-ai/workspace-tools/read-only',
      tools: [],
    }])).toBeUndefined();
  });
});
