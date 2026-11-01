import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  EARLY_READS_KEY, MEDIA_ORIGIN_KEY, earlyReadFor, earlyReadUrl, startEarlyRead, type EarlyRead,
} from './early-read.js';
import {
  EARLY_READS_KEY as CLIENT_EARLY_READS_KEY, EARLY_READ_TTL_MS, createWorkspaceApi, takeEarlyRead,
} from './api/client.js';
import { MEDIA_ORIGIN_KEY as SCREEN_MEDIA_ORIGIN_KEY } from './screens/decisions/proposal-previews.js';
import { parseWorkspaceRoute } from '../../src/shared/workspace-routes.js';

/**
 * A deep link's first read leaves as the page opens (follow-up to note
 * #825): measured at phone size on Fast 4G, a proposal opened from a link
 * used to wait for the session read, and after a deploy for the whole shell
 * script too, before its own read even left. These pin the three seams that
 * make it safe: the early file asks for exactly what the screen will ask for,
 * the client hands that answer to the screen once and only when it succeeded,
 * and anything that does not match is fetched as it always was.
 */

const held = () => ((window as unknown as Record<string, EarlyRead[] | undefined>)[EARLY_READS_KEY] ??= []);

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[EARLY_READS_KEY];
  window.history.replaceState({}, '', '/');
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.head.querySelectorAll('link[rel="preconnect"]').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('which addresses start a read', () => {
  it('reads production’s own addresses, which stand at the root, as well as the old /workspace ones', () => {
    // The first version only knew the prefixed form, and production's links
    // carry none — so it never fired on a real link (caught on the live site).
    expect(earlyReadFor('/decisions/pr/p-1', '?org=o1')).toEqual({ path: 'api/prs/p-1', org: 'o1' });
    expect(earlyReadFor('/decisions/knowledge/k1', '')).toEqual({ path: 'api/knowledge/proposals/k1', org: null });
    expect(parseWorkspaceRoute('/decisions/pr/p-1')).toMatchObject({ kind: 'pr', id: 'p-1' });
    expect(parseWorkspaceRoute('/notes/825', '?room=r1')).toMatchObject({ kind: 'note', id: '825' });
    for (const pathname of ['/notes', '/notes/archive', '/decisions', '/', '/adam', '/adam/infinite-agents', '/login']) {
      expect(earlyReadFor(pathname, '?org=o1')).toBeNull();
    }
  });

  it('starts the screen’s own first read for a proposal and a knowledge proposal — and nothing else, notes included', () => {
    // An old link may still name a room; it is read past (note #843).
    expect(earlyReadFor('/workspace/decisions/pr/p-1', '?org=o1&room=r1')).toEqual({ path: 'api/prs/p-1', org: 'o1' });
    expect(earlyReadFor('/workspace/decisions/knowledge/k1', '?room=r1')).toEqual({ path: 'api/knowledge/proposals/k1', org: null });
    // Not a note: its answer depends on the workplace the session settles
    // on, which this file cannot know yet (a pasted note link drew a refused
    // read beside a screen that loaded — verify-…-home).
    expect(earlyReadFor('/workspace/notes/825', '?org=o1&room=r1')).toBeNull();
    expect(earlyReadFor('/notes/825', '?org=o1&room=r1')).toBeNull();
    for (const [pathname, search] of [
      ['/workspace/notes', '?room=r1'], ['/workspace/notes/archive', ''], ['/workspace/', ''], ['/workspace/decisions', ''],
      ['/workspace/decisions/pr/p1/extra', ''], ['/workspace/drive/files/x', ''], ['/login', ''], ['/', ''], ['/drive/files/x', ''],
    ]) expect(earlyReadFor(pathname!, search!)).toBeNull();
  });

  it('agrees with the route registry on which screen each of those addresses is', () => {
    expect(parseWorkspaceRoute('/workspace/decisions/pr/p-1')).toMatchObject({ kind: 'pr', id: 'p-1' });
    expect(parseWorkspaceRoute('/workspace/decisions/knowledge/k1')).toMatchObject({ kind: 'knowledge', id: 'k1' });
    expect(parseWorkspaceRoute('/workspace/notes/825', '?room=r1')).toMatchObject({ kind: 'note', id: '825' });
    expect(parseWorkspaceRoute('/workspace/notes/archive', '?room=r1')).toMatchObject({ kind: 'noteArchive' });
  });

  it('keeps its two names in step with the client and the proposal screen', () => {
    expect(EARLY_READS_KEY).toBe(CLIENT_EARLY_READS_KEY);
    expect(MEDIA_ORIGIN_KEY).toBe(SCREEN_MEDIA_ORIGIN_KEY);
  });

  it('builds byte for byte the URL the client builds for the same read', async () => {
    const urls: string[] = [];
    const client = createWorkspaceApi({
      fetch: (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response('{}', { status: 200 }); }) as typeof fetch,
      cookies: () => '', standingOrg: () => 'o-standing',
    });
    await client.api('api/notes/825', undefined, { org: 'org a/b' });
    expect(earlyReadUrl({ path: 'api/notes/825', org: 'org a/b' }, null)).toBe(urls[0]);
    // With no workplace in the address, the one this tab stands in.
    await client.api('api/prs/p1', undefined, {});
    expect(earlyReadUrl({ path: 'api/prs/p1', org: null }, 'o-standing')).toBe(urls[1]);
  });
});

describe('the read itself', () => {
  it('leaves at once, with the session cookie and CSRF header, and is held for the client', () => {
    const fetched = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    document.cookie = 'acc_csrf=tok-1; path=/';
    window.sessionStorage.setItem('acc.standingWorkplace', 'o-tab');
    window.history.replaceState({}, '', '/decisions/pr/p1?room=r1');
    startEarlyRead();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]).toEqual(['/workspace/api/prs/p1?org=o-tab', { credentials: 'same-origin', headers: { 'X-CSRF-Token': 'tok-1' } }]);
    expect(held().map((read) => read.url)).toEqual(['/workspace/api/prs/p1?org=o-tab']);
    document.cookie = 'acc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('warms the connection to the picture store a proposal last drew from', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    window.localStorage.setItem(MEDIA_ORIGIN_KEY, 'https://fly.storage.tigris.dev');
    window.history.replaceState({}, '', '/workspace/decisions/pr/p1?org=o1');
    startEarlyRead();
    expect(document.head.querySelector('link[rel="preconnect"]')?.getAttribute('href')).toBe('https://fly.storage.tigris.dev');
  });

  it('starts nothing on an address with no such read', () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    window.history.replaceState({}, '', '/workspace/?org=o1');
    startEarlyRead();
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('the client takes it', () => {
  const hold = (url: string, response: Promise<Response>, at = Date.now()) => { held().push({ url, at, response }); };

  it('answers the screen from the read already in flight, once, without a second request', async () => {
    hold('/workspace/api/prs/p1?org=o1', Promise.resolve(new Response(JSON.stringify({ pr: { id: 'p1' } }), { status: 200 })));
    const fetched = vi.fn(async () => new Response(JSON.stringify({ pr: { id: 'fresh' } }), { status: 200 }));
    const client = createWorkspaceApi({ fetch: fetched as unknown as typeof fetch, cookies: () => '', standingOrg: () => 'o1' });
    await expect(client.api('api/prs/p1')).resolves.toEqual({ pr: { id: 'p1' } });
    expect(fetched).not.toHaveBeenCalled();
    // Taken: the next read of the same proposal (a poll) is a real request.
    await expect(client.api('api/prs/p1')).resolves.toEqual({ pr: { id: 'fresh' } });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('asks for itself when the early read failed, so a failure there is never the screen’s answer', async () => {
    hold('/workspace/api/prs/p1?org=o1', Promise.resolve(new Response('{"error":"Sign in"}', { status: 401 })));
    hold('/workspace/api/knowledge/proposals/k1?org=o1', Promise.reject(new TypeError('offline')));
    const fetched = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const client = createWorkspaceApi({ fetch: fetched as unknown as typeof fetch, cookies: () => '', standingOrg: () => 'o1' });
    await expect(client.api('api/prs/p1')).resolves.toEqual({ ok: true });
    await expect(client.api('api/knowledge/proposals/k1')).resolves.toEqual({ ok: true });
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('matches a read letter for letter — another workplace is another read — and never a write', async () => {
    // Matched by the exact URL since note #843: a room no longer rides
    // either side, so nothing is dropped before comparing.
    hold('/workspace/api/notes/825?org=o1', Promise.resolve(new Response('{"note":"o1"}', { status: 200 })));
    const fetched = vi.fn(async () => new Response('{"note":"asked"}', { status: 200 }));
    const client = createWorkspaceApi({ fetch: fetched as unknown as typeof fetch, cookies: () => '', standingOrg: () => 'o1' });
    // Another workplace holds another note under the same number.
    await expect(client.api('api/notes/825', undefined, { org: 'o2' })).resolves.toEqual({ note: 'asked' });
    // A write to the same address is never answered by a read.
    await client.api('api/notes/825', { method: 'DELETE' });
    expect(fetched).toHaveBeenCalledTimes(2);
    await expect(client.api('api/notes/825')).resolves.toEqual({ note: 'o1' });
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('lets a read nobody claimed in time go', () => {
    const response = Promise.resolve(new Response('{}'));
    hold('/workspace/api/prs/p1', response, 1_000);
    expect(takeEarlyRead('/workspace/api/prs/p1', 1_000 + EARLY_READ_TTL_MS + 1)).toBeNull();
    expect(held()).toEqual([]);
  });
  // Before note #843 the client dropped `room=` from a proposal's read before
  // matching (`earlyReadKey`): the screen sent whichever room the tab last
  // stood in, the early file sent none. Nothing names a room now.
});

describe('the built page', () => {
  it('loads the early file as its own module, ahead of the shell, and nothing inline', () => {
    const page = readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    // The source page names only the shell; the build puts the early file
    // ahead of it (vite.config.ts, earlyReadFirst), which the server's
    // loader and the browser harness check on the built page.
    expect(page).toContain('src="/src/main.tsx"');
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);
    const config = readFileSync(path.resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(config).toContain("early: fileURLToPath(new URL('src/early-read.ts'");
  });
});
