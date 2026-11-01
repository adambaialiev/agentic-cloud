import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const publicCss = readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
const workspaceCss = readFileSync(path.join(ROOT, 'backend/workspace-ui/src/workspace.css'), 'utf8');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const landingPalette = /\.landing-page\s*\{([\s\S]*?)\n\}/.exec(publicCss)?.[1] ?? '';

const literal = (source: string, name: string) => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(source);
  if (!match) throw new Error(`missing literal ${name}`);
  return match[1]!.toLowerCase();
};

describe('the landing palette', () => {
  it('maps its existing colour roles to the Workspace exactly', () => {
    const roles = [
      ['--color-panel', '--bg'],
      ['--color-canvas', '--bg'],
      ['--color-panel-soft', '--card'],
      ['--color-canvas-soft', '--card'],
      ['--color-white', '--text'],
      ['--color-ink', '--text'],
      ['--color-hint', '--hint'],
      ['--color-accent', '--accent'],
      ['--color-accent-bright', '--accent'],
      ['--color-danger', '--danger'],
      ['--color-warn', '--warn'],
      ['--color-ok', '--ok'],
    ] as const;

    for (const [landingRole, workspaceRole] of roles) {
      expect(literal(landingPalette, landingRole), landingRole).toBe(literal(workspaceCss, workspaceRole));
    }
  });

  it('matches the mobile browser chrome to the paper surface', () => {
    expect(landingPalette).toContain('color-scheme: light;');
    expect(html).toContain('<meta name="color-scheme" content="light" />');
    expect(html).toContain('<meta name="theme-color" content="#fcfcfb" />');
  });
});
