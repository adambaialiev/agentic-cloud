/**
 * The front page's one piece of inline script: a signed-in browser opening the
 * root address goes to the Workspace instead (note #526).
 *
 * The test runs THE SHIPPED CODE. It lifts the script out of index.html and
 * calls it through `new Function('location', 'document', source)`, whose
 * parameters shadow the two globals the script reads — so what is exercised
 * here is the exact text the browser will run, not a copy of its logic that
 * can drift away from it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_CSRF_COOKIES } from '../backend/workspace-ui/src/api/client';
import { WORKSPACE_SIGN_IN_URL } from './lib/workspace-link';

const ROOT = path.resolve(__dirname, '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* The module bundle carries `src`; this is the only inline script on the page,
   and a second one appearing is a reason to come back here, not to guess. */
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
if (inline.length !== 1) throw new Error(`expected one inline script in index.html, found ${inline.length}`);
const source = inline[0]!;

interface Visit {
  path?: string;
  search?: string;
  cookie?: string;
}

/** Run the shipped script against one visit; returns the address it left for. */
function visit({ path: pathname = '/', search = '', cookie = '' }: Visit): string | null {
  const replace = vi.fn();
  const location = { pathname, search, replace, assign: vi.fn(), href: `https://agenticcloudcomputer.com${pathname}${search}` };
  new Function('location', 'document', source)(location, { cookie });
  return replace.mock.calls[0]?.[0] ?? null;
}

const signedIn = (name: string) => `${name}=token-value`;

describe('the signed-in redirect on the front page', () => {
  it('sends a signed-in browser from the root address to the Workspace', () => {
    expect(visit({ path: '/', cookie: signedIn('__Host-acc_csrf') })).toBe(WORKSPACE_SIGN_IN_URL);
  });

  it('leaves a signed-out visitor on the page they asked for', () => {
    expect(visit({ path: '/', cookie: '' })).toBeNull();
    expect(visit({ path: '/', cookie: 'landing_seen=1; ab=7' })).toBeNull();
  });

  it('recognises the session by every cookie name the backend may set', () => {
    for (const name of WORKSPACE_CSRF_COOKIES) {
      expect(visit({ path: '/', cookie: signedIn(name) })).toBe(WORKSPACE_SIGN_IN_URL);
      expect(visit({ path: '/', cookie: `other=1; ${signedIn(name)}; last=2` })).toBe(WORKSPACE_SIGN_IN_URL);
    }
  });

  it('is not fooled by the emptied cookie a sign-out leaves behind, or by a longer name', () => {
    expect(visit({ path: '/', cookie: '__Host-acc_csrf=' })).toBeNull();
    expect(visit({ path: '/', cookie: '__Host-acc_csrf=; acc_csrf=' })).toBeNull();
    expect(visit({ path: '/', cookie: 'not__Host-acc_csrf=token-value' })).toBeNull();
    expect(visit({ path: '/', cookie: 'acc_csrf_other=token-value' })).toBeNull();
  });

  /* index.html is the template for every prerendered route, so the script is
     on all of them and only the root address may act on it. */
  it('leaves every other public address alone', () => {
    for (const other of ['/terms', '/privacy', '/teams', '/claude-code-in-the-cloud', '/four-phases', '/why-fly', '/own-cloud', '/private-copy', '/og-preview']) {
      expect(visit({ path: other, cookie: signedIn('__Host-acc_csrf') })).toBeNull();
    }
  });

  it('opens the front page anyway for ?stay, and is not confused by other parameters', () => {
    const cookie = signedIn('__Host-acc_csrf');
    expect(visit({ path: '/', search: '?stay', cookie })).toBeNull();
    expect(visit({ path: '/', search: '?stay=1', cookie })).toBeNull();
    expect(visit({ path: '/', search: '?utm_source=stayfree', cookie })).toBe(WORKSPACE_SIGN_IN_URL);
    expect(visit({ path: '/', search: '?utm_source=x&utm_campaign=y', cookie })).toBe(WORKSPACE_SIGN_IN_URL);
  });

  it('runs before the page can paint, and leaves no history entry behind', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<script>');
    expect(source).toContain('location.replace(');
    expect(source).not.toContain('location.assign(');
    expect(source).not.toContain('location.href =');
  });
});
