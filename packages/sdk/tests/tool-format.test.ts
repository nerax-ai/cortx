import { describe, test, expect } from 'bun:test';
import { formatToolSummary } from '../src/tool-format';

describe('formatToolSummary', () => {
  test('bash tool returns command excerpt', () => {
    expect(formatToolSummary('bash', '{"command":"ls -la /some/path"}')).toBe('ls -la /some/path');
  });

  test('bash tool respects maxLength', () => {
    const result = formatToolSummary('bash', '{"command":"' + 'x'.repeat(200) + '"}', { maxLength: 50 });
    expect(result.length).toBeLessThanOrEqual(50);
  });

  test('read tool returns file path', () => {
    expect(formatToolSummary('read', '{"file_path":"/src/index.ts"}')).toBe('/src/index.ts');
  });

  test('write tool returns file path', () => {
    expect(formatToolSummary('write', '{"file_path":"/src/new.ts"}')).toBe('/src/new.ts');
  });

  test('edit tool returns file path', () => {
    expect(formatToolSummary('edit', '{"file_path":"/src/edit.ts"}')).toBe('/src/edit.ts');
  });

  test('grep tool returns pattern excerpt', () => {
    expect(formatToolSummary('grep', '{"pattern":"TODO"}')).toBe('TODO');
  });

  test('agent tool returns description and prompt', () => {
    const result = formatToolSummary('agent', '{"description":"Research","prompt":"find bugs"}');
    expect(result).toBe('Research: find bugs');
  });

  test('agent tool without description returns prompt only', () => {
    const result = formatToolSummary('agent', '{"prompt":"do stuff"}');
    expect(result).toBe('do stuff');
  });

  test('unknown tool returns empty string', () => {
    expect(formatToolSummary('unknown', '{}')).toBe('');
  });

  test('handles string input that is not valid JSON', () => {
    expect(formatToolSummary('bash', 'not json')).toBe('');
  });

  test('handles null input', () => {
    expect(formatToolSummary('bash', null)).toBe('');
  });

  test('handles undefined input', () => {
    expect(formatToolSummary('bash', undefined)).toBe('');
  });

  test('handles object input directly', () => {
    expect(formatToolSummary('bash', { command: 'echo hello' })).toBe('echo hello');
  });

  test('uses path fallback for file tools', () => {
    expect(formatToolSummary('read', '{"path":"/alt/path.ts"}')).toBe('/alt/path.ts');
  });
});
