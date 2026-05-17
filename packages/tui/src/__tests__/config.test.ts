import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getConfigDir, loadConfig, saveConfig } from '../config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `cortx-config-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.XDG_CONFIG_HOME = join(tmpDir, 'config');
  await mkdir(process.env.XDG_CONFIG_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.XDG_CONFIG_HOME;
});

describe('config storage', () => {
  test('returns defaults when cortx.json is missing', async () => {
    const config = await loadConfig();

    expect(config.model).toBe('default');
    expect(config.maxIterations).toBe(200);
  });

  test('saves and merges user config from the existing config location', async () => {
    await saveConfig({ model: 'custom-model', maxIterations: 12 });

    expect(getConfigDir()).toBe(join(tmpDir, 'config', 'cortx'));
    await expect(loadConfig()).resolves.toMatchObject({
      model: 'custom-model',
      maxIterations: 12,
    });
  });

  test('surfaces corrupt cortx.json distinctly from missing config', async () => {
    const configDir = getConfigDir();
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'cortx.json'), '{{corrupt', 'utf8');

    await expect(loadConfig()).rejects.toMatchObject({
      code: 'corrupt_json',
    });
  });
});
