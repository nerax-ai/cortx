import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadTool } from '../src/read';
import { createWriteTool } from '../src/write';
import { createEditTool } from '../src/edit';
import { createBashTool } from '../src/bash';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-code-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createReadTool', () => {
  test('reads file content', async () => {
    const tool = createReadTool(tmpDir);
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world');
    const result = await tool.execute({ path: 'test.txt' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
  });

  test('throws for missing file', async () => {
    const tool = createReadTool(tmpDir);
    try {
      await tool.execute({ path: 'missing.txt' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect((e as any).code).toBe('ENOENT');
    }
  });

  test('respects offset and limit', async () => {
    const tool = createReadTool(tmpDir);
    writeFileSync(join(tmpDir, 'lines.txt'), 'line1\nline2\nline3\nline4\nline5');
    const result = await tool.execute({ path: 'lines.txt', offset: 2, limit: 2 }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('line2');
    expect(result.output).toContain('line3');
    expect(result.output).not.toContain('line1');
    expect(result.output).not.toContain('line5');
  });

  test('handles absolute path', async () => {
    const tool = createReadTool(tmpDir);
    writeFileSync(join(tmpDir, 'abs.txt'), 'absolute');
    const result = await tool.execute({ path: join(tmpDir, 'abs.txt') }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toBe('absolute');
  });
});

describe('createWriteTool', () => {
  test('writes file content', async () => {
    const tool = createWriteTool(tmpDir);
    const result = await tool.execute({ path: 'new.txt', content: 'written' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpDir, 'new.txt'), 'utf-8')).toBe('written');
  });

  test('creates nested directories', async () => {
    const tool = createWriteTool(tmpDir);
    const result = await tool.execute({ path: 'a/b/c/file.txt', content: 'nested' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(existsSync(join(tmpDir, 'a/b/c/file.txt'))).toBe(true);
  });

  test('overwrites existing file', async () => {
    const tool = createWriteTool(tmpDir);
    await tool.execute({ path: 'overwrite.txt', content: 'original' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    await tool.execute({ path: 'overwrite.txt', content: 'replaced' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(readFileSync(join(tmpDir, 'overwrite.txt'), 'utf-8')).toBe('replaced');
  });
});

describe('createEditTool', () => {
  test('replaces text in file', async () => {
    const tool = createEditTool(tmpDir);
    writeFileSync(join(tmpDir, 'edit.txt'), 'hello world');
    const result = await tool.execute({ path: 'edit.txt', oldText: 'world', newText: 'universe' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpDir, 'edit.txt'), 'utf-8')).toBe('hello universe');
  });

  test('returns error if text not found', async () => {
    const tool = createEditTool(tmpDir);
    writeFileSync(join(tmpDir, 'edit2.txt'), 'hello world');
    const result = await tool.execute({ path: 'edit2.txt', oldText: 'missing', newText: 'replaced' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('throws for missing file', async () => {
    const tool = createEditTool(tmpDir);
    try {
      await tool.execute({ path: 'missing.txt', oldText: 'x', newText: 'y' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect((e as any).code).toBe('ENOENT');
    }
  });

  test('replaces only first occurrence', async () => {
    const tool = createEditTool(tmpDir);
    writeFileSync(join(tmpDir, 'multi.txt'), 'foo foo foo');
    await tool.execute({ path: 'multi.txt', oldText: 'foo', newText: 'bar' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(readFileSync(join(tmpDir, 'multi.txt'), 'utf-8')).toBe('bar foo foo');
  });
});

describe('createBashTool', () => {
  test('executes simple command', async () => {
    const tool = createBashTool(tmpDir);
    const result = await tool.execute({ command: 'echo hello' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  test('returns error for failed command', async () => {
    const tool = createBashTool(tmpDir);
    const result = await tool.execute({ command: 'exit 1' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
  });

  test('respects working directory', async () => {
    const tool = createBashTool(tmpDir);
    writeFileSync(join(tmpDir, 'marker.txt'), 'exists');
    const result = await tool.execute({ command: 'ls marker.txt' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('marker.txt');
  });

  test('validates required command parameter', async () => {
    const tool = createBashTool(tmpDir);
    const result = await tool.execute({ command: '' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  test('handles timeout', async () => {
    const tool = createBashTool(tmpDir);
    const result = await tool.execute({ command: 'sleep 5', timeout: 1 }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
