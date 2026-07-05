import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadTool } from '../src/workspace-tools/read';
import { createWriteTool } from '../src/workspace-tools/write';
import { createEditTool } from '../src/workspace-tools/edit';
import { createBashTool } from '../src/workspace-tools/bash';
import { createGrepTool } from '../src/workspace-tools/grep';
import { createFindTool } from '../src/workspace-tools/find';
import { createLsTool } from '../src/workspace-tools/ls';
import { resolveWritableWorkspacePath, resolveWorkspacePath } from '../src/workspace-tools/path-safety';

let tmpDir: string;
let outsideDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-code-test-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'cortx-code-outside-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
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

  test('rejects paths outside the workspace', async () => {
    const tool = createReadTool(tmpDir);
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
    const result = await tool.execute({ path: join(outsideDir, 'secret.txt') }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
  });

  test('rejects symlinks that escape the workspace', async () => {
    const tool = createReadTool(tmpDir);
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
    symlinkSync(join(outsideDir, 'secret.txt'), join(tmpDir, 'secret-link.txt'));
    const result = await tool.execute({ path: 'secret-link.txt' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
  });
});

describe('workspace path safety', () => {
  test('canonicalizes existing symlinked paths to their real target', async () => {
    mkdirSync(join(tmpDir, 'real'));
    writeFileSync(join(tmpDir, 'real', 'safe.txt'), 'safe');
    symlinkSync(join(tmpDir, 'real', 'safe.txt'), join(tmpDir, 'safe-link.txt'));

    await expect(resolveWorkspacePath(tmpDir, 'safe-link.txt')).resolves.toBe(
      realpathSync(join(tmpDir, 'real', 'safe.txt')),
    );
  });

  test('canonicalizes writable symlinked parent directories before file operations', async () => {
    mkdirSync(join(tmpDir, 'real-parent'));
    symlinkSync(join(tmpDir, 'real-parent'), join(tmpDir, 'parent-link'));

    await expect(resolveWritableWorkspacePath(tmpDir, 'parent-link/new.txt')).resolves.toBe(
      join(realpathSync(join(tmpDir, 'real-parent')), 'new.txt'),
    );
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

  test('rejects writes outside the workspace', async () => {
    const tool = createWriteTool(tmpDir);
    const target = join(outsideDir, 'owned.txt');
    const result = await tool.execute({ path: target, content: 'owned' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
    expect(existsSync(target)).toBe(false);
  });

  test('rejects writes through symlinked parent directories', async () => {
    const tool = createWriteTool(tmpDir);
    symlinkSync(outsideDir, join(tmpDir, 'outside-link'));
    const result = await tool.execute({ path: 'outside-link/owned.txt', content: 'owned' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
    expect(existsSync(join(outsideDir, 'owned.txt'))).toBe(false);
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

  test('rejects ambiguous text matches', async () => {
    const tool = createEditTool(tmpDir);
    writeFileSync(join(tmpDir, 'multi.txt'), 'foo foo foo');
    const result = await tool.execute({ path: 'multi.txt', oldText: 'foo', newText: 'bar' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not unique');
    expect(readFileSync(join(tmpDir, 'multi.txt'), 'utf-8')).toBe('foo foo foo');
  });

  test('rejects edits outside the workspace', async () => {
    const tool = createEditTool(tmpDir);
    const target = join(outsideDir, 'secret.txt');
    writeFileSync(target, 'secret');
    const result = await tool.execute({ path: target, oldText: 'secret', newText: 'changed' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
    expect(readFileSync(target, 'utf-8')).toBe('secret');
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

  test('rejects unbounded root filesystem scans', async () => {
    const tool = createBashTool(tmpDir);
    const result = await tool.execute({ command: 'find / -name "resolve-base.sh" -path "*references*"' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unbounded filesystem scan');
  });

  test('allows workspace-scoped find commands', async () => {
    const tool = createBashTool(tmpDir);
    writeFileSync(join(tmpDir, 'resolve-base.sh'), 'ok');
    const result = await tool.execute({ command: 'find . -name "resolve-base.sh"' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('resolve-base.sh');
  });

  test('handles timeout', async () => {
    const tool = createBashTool(tmpDir);
    const result = await tool.execute({ command: 'sleep 5', timeout: 1 }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });
});

describe('createGrepTool', () => {
  test('finds matching pattern in file', async () => {
    const tool = createGrepTool(tmpDir);
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world\nfoo bar\nhello again');
    const result = await tool.execute({ pattern: 'hello' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  test('returns no matches for missing pattern', async () => {
    const tool = createGrepTool(tmpDir);
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world');
    const result = await tool.execute({ pattern: 'nonexistent' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('no matches');
  });

  test('respects glob filter', async () => {
    const tool = createGrepTool(tmpDir);
    writeFileSync(join(tmpDir, 'test.txt'), 'pattern');
    writeFileSync(join(tmpDir, 'test.log'), 'pattern');
    const result = await tool.execute({ pattern: 'pattern', glob: '*.txt' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('test.txt');
    expect(result.output).not.toContain('test.log');
  });

  test('searches in subdirectory', async () => {
    const tool = createGrepTool(tmpDir);
    const subDir = join(tmpDir, 'sub');
    require('fs').mkdirSync(subDir);
    writeFileSync(join(subDir, 'nested.txt'), 'found me');
    const result = await tool.execute({ pattern: 'found', path: 'sub' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('found me');
  });

  test('rejects searches outside the workspace', async () => {
    const tool = createGrepTool(tmpDir);
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
    const result = await tool.execute({ pattern: 'secret', path: outsideDir }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
  });
});

describe('createFindTool', () => {
  test('finds files by pattern', async () => {
    const tool = createFindTool(tmpDir);
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    writeFileSync(join(tmpDir, 'file.md'), 'content');
    const result = await tool.execute({ pattern: '*.txt' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('file.txt');
    expect(result.output).not.toContain('file.md');
  });

  test('finds files in subdirectory', async () => {
    const tool = createFindTool(tmpDir);
    const subDir = join(tmpDir, 'sub');
    require('fs').mkdirSync(subDir);
    writeFileSync(join(subDir, 'nested.txt'), 'content');
    const result = await tool.execute({ pattern: '*.txt' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('nested.txt');
  });

  test('returns no files for missing pattern', async () => {
    const tool = createFindTool(tmpDir);
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    const result = await tool.execute({ pattern: '*.nonexistent' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('no files found');
  });

  test('searches in specified path', async () => {
    const tool = createFindTool(tmpDir);
    const subDir = join(tmpDir, 'search');
    require('fs').mkdirSync(subDir);
    writeFileSync(join(subDir, 'target.ts'), 'content');
    const result = await tool.execute({ pattern: '*.ts', path: 'search' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('target.ts');
  });

  test('rejects find paths outside the workspace', async () => {
    const tool = createFindTool(tmpDir);
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
    const result = await tool.execute({ pattern: '*.txt', path: outsideDir }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
  });
});

describe('createLsTool', () => {
  test('lists directory contents', async () => {
    const tool = createLsTool(tmpDir);
    writeFileSync(join(tmpDir, 'file1.txt'), 'a');
    writeFileSync(join(tmpDir, 'file2.txt'), 'b');
    const result = await tool.execute({}, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('file1.txt');
    expect(result.output).toContain('file2.txt');
  });

  test('marks directories with trailing slash', async () => {
    const tool = createLsTool(tmpDir);
    require('fs').mkdirSync(join(tmpDir, 'subdir'));
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    const result = await tool.execute({}, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('subdir/');
    expect(result.output).toContain('file.txt');
    expect(result.output).not.toContain('file.txt/');
  });

  test('lists subdirectory contents', async () => {
    const tool = createLsTool(tmpDir);
    const subDir = join(tmpDir, 'sub');
    require('fs').mkdirSync(subDir);
    writeFileSync(join(subDir, 'nested.txt'), 'content');
    const result = await tool.execute({ path: 'sub' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('nested.txt');
  });

  test('returns empty for empty directory', async () => {
    const tool = createLsTool(tmpDir);
    const result = await tool.execute({}, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(true);
    expect(result.output).toContain('empty');
  });

  test('throws for non-existent directory', async () => {
    const tool = createLsTool(tmpDir);
    try {
      await tool.execute({ path: 'nonexistent' }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
      expect(true).toBe(false);
    } catch (e) {
      expect((e as any).code).toBe('ENOENT');
    }
  });

  test('rejects listing outside the workspace', async () => {
    const tool = createLsTool(tmpDir);
    const result = await tool.execute({ path: outsideDir }, { sessionId: '1', workingDirectory: tmpDir, logger: {} as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace');
  });
});
