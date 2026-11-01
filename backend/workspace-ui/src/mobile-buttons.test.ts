import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const css = readFileSync(path.join(ROOT, 'src/workspace.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('mobile buttons', () => {
  it('uses the Workspace press state without the browser tap wash', () => {
    const base = /(?:^|})\s*button\s*\{([^}]*)}/m.exec(css)?.[1] ?? '';

    expect(base).toContain('-webkit-tap-highlight-color: transparent;');
    expect(css).toMatch(/button:active\s*\{[^}]*opacity:\s*\.65;/);
  });
});
