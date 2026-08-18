import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageNames = ['sdk', 'core', 'store', 'runtime', 'server', 'tui'] as const;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'cortx-package-gate-'));

try {
  for (const packageName of packageNames) {
    const packageRoot = resolve(import.meta.dir, '..', 'packages', packageName);
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name: string;
      files?: string[];
      dependencies?: Record<string, string>;
      exports?: Record<string, string | { types?: string; import?: string }>;
    };
    if (JSON.stringify(manifest.files) !== JSON.stringify(['dist'])) {
      throw new Error(`${manifest.name} must publish only dist`);
    }
    const rootExport = manifest.exports?.['.'];
    if (!rootExport || typeof rootExport === 'string' || !rootExport.types || !rootExport.import) {
      throw new Error(`${manifest.name} must expose types and import entrypoints`);
    }
    const typesPath = resolve(packageRoot, rootExport.types);
    const importPath = resolve(packageRoot, rootExport.import);
    for (const path of [typesPath, importPath]) {
      if (!existsSync(path)) throw new Error(`${manifest.name} is missing built entrypoint: ${path}`);
    }
    if (!/export|declare/.test(readFileSync(typesPath, 'utf8'))) {
      throw new Error(`${manifest.name} declaration entrypoint is empty`);
    }
    const module = await import(`${pathToFileURL(importPath).href}?package-gate=${Date.now()}`);
    if (Object.keys(module).length === 0) throw new Error(`${manifest.name} built entrypoint has no exports`);

    const staging = join(temporaryRoot, packageName);
    mkdirSync(staging, { recursive: true });
    cpSync(resolve(packageRoot, 'dist'), join(staging, 'dist'), { recursive: true });
    const stagingManifest = {
      ...manifest,
      dependencies: Object.fromEntries(
        Object.entries(manifest.dependencies ?? {}).map(([name, range]) => [name, range === 'workspace:*' ? '0.0.1' : range]),
      ),
    };
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(stagingManifest, null, 2)}\n`);
    const pack = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--filename', `${packageName}.tgz`, '--ignore-scripts'],
      cwd: staging,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (pack.exitCode !== 0) {
      throw new Error(`${manifest.name} pack failed: ${pack.stderr.toString()}`);
    }
    const tarball = join(staging, `${packageName}.tgz`);
    const listing = Bun.spawnSync({ cmd: ['tar', '-tzf', tarball], stdout: 'pipe', stderr: 'pipe' });
    if (listing.exitCode !== 0) throw new Error(`${manifest.name} tar listing failed: ${listing.stderr.toString()}`);
    const entries = listing.stdout.toString().trim().split('\n');
    if (!entries.some((entry) => entry.endsWith('/package.json')) || !entries.some((entry) => entry.endsWith('/dist/index.js'))) {
      throw new Error(`${manifest.name} packed artifact is missing package.json or dist/index.js`);
    }
    if (entries.some((entry) => entry.includes('/src/'))) {
      throw new Error(`${manifest.name} packed artifact leaked source files`);
    }
    console.log(`package-ok ${manifest.name} exports=${Object.keys(module).length} tarball=${basename(tarball)}`);
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
