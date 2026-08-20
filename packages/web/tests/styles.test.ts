import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');

describe('web style foundation', () => {
  test('uses the UnoCSS reset before utilities without loading Tailwind CDN', () => {
    const entry = readFileSync(resolve(packageRoot, 'src/main.tsx'), 'utf8');
    const html = readFileSync(resolve(packageRoot, 'index.html'), 'utf8');
    const config = readFileSync(resolve(packageRoot, 'uno.config.ts'), 'utf8');
    const resetImport = "import '@unocss/reset/tailwind.css';";
    const utilitiesImport = "import 'virtual:uno.css';";

    expect(html).not.toContain('cdn.tailwindcss.com');
    expect(config).toContain('presetWind3()');
    expect(config).not.toContain('presetUno()');
    expect(entry).toContain(resetImport);
    expect(entry.indexOf(resetImport)).toBeLessThan(entry.indexOf(utilitiesImport));
  });
});
