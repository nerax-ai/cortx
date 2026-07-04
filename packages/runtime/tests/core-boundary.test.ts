import { describe, expect, test } from 'bun:test';
import { access, readdir, readFile } from 'fs/promises';
import { join } from 'path';

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('architecture boundaries', () => {
  test('legacy code package stays removed', async () => {
    const codePackage = join(import.meta.dir, '..', '..', 'code');
    expect(await pathExists(codePackage)).toBe(false);
  });

  test('core source does not import host/runtime/frontend packages', async () => {
    const coreSrc = join(import.meta.dir, '..', '..', 'core', 'src');
    const forbidden = ['@cortx/runtime', '@cortx/server', '@cortx/tui', '@cortx/web'];

    for (const file of await walk(coreSrc)) {
      const source = await readFile(file, 'utf8');
      for (const specifier of forbidden) {
        expect(source, `${file} must not import ${specifier}`).not.toContain(specifier);
      }
    }
  });

  test('frontends do not depend on workspace tool implementation packages directly', async () => {
    for (const packageDir of ['tui', 'web']) {
      const pkg = JSON.parse(await readFile(join(import.meta.dir, '..', '..', packageDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      expect(
        deps['@cortx/code'],
        `@cortx/${packageDir} should receive workspace tools through runtime`,
      ).toBeUndefined();

      const srcDir = join(import.meta.dir, '..', '..', packageDir, 'src');
      for (const file of await walk(srcDir)) {
        const source = await readFile(file, 'utf8');
        expect(source, `${file} must not import runtime workspace-tools internals`).not.toContain('workspace-tools');
      }
    }
  });

  test('server delegates agent hosting to runtime instead of recreating session management', async () => {
    const serverSrc = join(import.meta.dir, '..', '..', 'server', 'src');
    const files = await walk(serverSrc);

    expect(await pathExists(join(serverSrc, 'session-manager.ts'))).toBe(false);

    let importsRuntime = false;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (source.includes('@cortx/runtime')) importsRuntime = true;

      expect(source, `${file} must not construct Cortx directly`).not.toMatch(/\bnew\s+Cortx\b/);
      expect(source, `${file} must not import workspace tool packs directly`).not.toContain('@cortx/code');
      expect(source, `${file} must not import runtime workspace-tools internals`).not.toContain('workspace-tools');
    }

    expect(importsRuntime).toBe(true);
  });

  test('web source remains a remote-only client', async () => {
    const webSrc = join(import.meta.dir, '..', '..', 'web', 'src');
    const forbidden = ['@cortx/core', '@cortx/runtime', '@cortx/code', 'workspace-tools'];

    for (const file of await walk(webSrc)) {
      const source = await readFile(file, 'utf8');
      for (const specifier of forbidden) {
        expect(source, `${file} must not import ${specifier}`).not.toContain(specifier);
      }
    }
  });
});
