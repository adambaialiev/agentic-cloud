import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANDING_FIRST_SEGMENTS as EDGE_LANDING_FIRST_SEGMENTS, onRequest, routesToBackend, VISITOR_COUNTRY_HEADER } from '../../functions/[[path]].js';
import { GUEST_COUNTRY_HEADER } from '../../backend/src/shared/guest-agent.js';
import { WORKSPACE_ENTRY_PATTERNS, WORKSPACE_LEGACY_SEGMENTS, WORKSPACE_ROUTE_DEFS } from '../../backend/src/shared/workspace-routes.js';
import { LANDING_FIRST_SEGMENTS } from '../../backend/src/shared/handles.js';
import { ROUTES } from '../entry-server';

const ROOT = path.resolve(__dirname, '..', '..');

describe('same-domain Workspace proxy', () => {
  // Note #1154: /self-hosted-coding-agents went live as a 404, because its
  // word was not on the edge's list and the Workspace answered it as an
  // unknown profile. Every prerendered page stays on the landing site.
  it('keeps every prerendered page on the landing site', () => {
    for (const route of ROUTES) {
      if (route.path === '/') continue;
      expect(routesToBackend(route.path, ''), route.path).toBe(false);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards the exact path, query, method, body and security headers to the fixed backend', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.agenticcloudcomputer.com/workspace/auth/login?return=%2Fworkspace');
      expect(request.method).toBe('POST');
      expect(request.headers.get('origin')).toBe('https://agenticcloudcomputer.com');
      expect(request.headers.get('cookie')).toBe('__Host-acc_csrf=csrf-token');
      expect(request.headers.get('x-csrf-token')).toBe('csrf-token');
      expect(await request.text()).toBe('{"username":"owner"}');
      return new Response('{"ok":true}', {
        status: 201,
        headers: {
          'cache-control': 'no-store',
          'set-cookie': '__Host-acc_session=session-token; Secure; HttpOnly; Path=/',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request(
      'https://agenticcloudcomputer.com/workspace/auth/login?return=%2Fworkspace',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: '__Host-acc_csrf=csrf-token',
          origin: 'https://agenticcloudcomputer.com',
          'x-csrf-token': 'csrf-token',
        },
        body: '{"username":"owner"}',
      },
    );
    const response = await onRequest({ request, next: () => { throw new Error('not the landing site'); } });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('__Host-acc_session=session-token');
  });

  // Note #1139: the forwarded request does not carry Cloudflare's country, so the edge hands it on, and a browser cannot supply it.
  it('hands the visitor\'s Cloudflare country to the backend in its own header, replacing anything the browser sent', async () => {
    expect(VISITOR_COUNTRY_HEADER).toBe(GUEST_COUNTRY_HEADER);
    const seen: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => { seen.push(request.headers.get(VISITOR_COUNTRY_HEADER)); return new Response('{}'); }));
    const next = () => { throw new Error('not the landing site'); };
    const withCf = new Request('https://agenticcloudcomputer.com/workspace/api/public/guest', { method: 'POST', headers: { [VISITOR_COUNTRY_HEADER]: 'XX' }, body: '{}' });
    Object.defineProperty(withCf, 'cf', { value: { country: 'NL' } });
    await onRequest({ request: withCf, next });
    const forged = new Request('https://agenticcloudcomputer.com/workspace/api/public/guest', { method: 'POST', headers: { [VISITOR_COUNTRY_HEADER]: 'US' }, body: '{}' });
    await onRequest({ request: forged, next });
    const odd = new Request('https://agenticcloudcomputer.com/workspace/api/state');
    Object.defineProperty(odd, 'cf', { value: { country: '<script>' } });
    await onRequest({ request: odd, next });
    expect(seen).toEqual(['NL', null, null]);
  });

  it('cannot be steered to another upstream by the incoming hostname or query', async () => {
    const fetchMock = vi.fn(async (request: Request) => new Response(request.url));
    vi.stubGlobal('fetch', fetchMock);

    const response = await onRequest({
      request: new Request('https://preview.example:8443/workspace/api/state?upstream=https://evil.example'),
      next: () => { throw new Error('not the landing site'); },
    });

    expect(await response.text()).toBe(
      'https://api.agenticcloudcomputer.com/workspace/api/state?upstream=https://evil.example',
    );
  });

  it('sends every app address at the root of the domain to the backend, and every public address too; only the landing pages stay', async () => {
    const fetchMock = vi.fn(async (request: Request) => new Response(request.url));
    vi.stubGlobal('fetch', fetchMock);
    const landing = new Response('landing');
    const next = vi.fn(async () => landing);
    const ask = (url: string, cookie?: string) => onRequest({
      request: new Request(url, cookie ? { headers: { cookie } } : undefined), next,
    });

    expect(await (await ask('https://agenticcloudcomputer.com/notes/12?org=o1')).text())
      .toBe('https://api.agenticcloudcomputer.com/notes/12?org=o1');
    expect(await (await ask('https://agenticcloudcomputer.com/public/repositories/abc')).text())
      .toBe('https://api.agenticcloudcomputer.com/public/repositories/abc');
    expect(await (await ask('https://agenticcloudcomputer.com/organization/people?org=o1')).text())
      .toBe('https://api.agenticcloudcomputer.com/organization/people?org=o1');

    // A person's public page (slice 5), and a word nobody holds: the backend
    // answers both, the second with the shell's "nothing at this address".
    expect(await (await ask('https://agenticcloudcomputer.com/adam')).text())
      .toBe('https://api.agenticcloudcomputer.com/adam');
    expect(await (await ask('https://agenticcloudcomputer.com/nobody-here?x=1')).text())
      .toBe('https://api.agenticcloudcomputer.com/nobody-here?x=1');

    expect(await ask('https://agenticcloudcomputer.com/docs/email')).toBe(landing);
    expect(await ask('https://agenticcloudcomputer.com/terms')).toBe(landing);
    expect(await ask('https://agenticcloudcomputer.com/en')).toBe(landing);
    expect(await ask('https://agenticcloudcomputer.com/pricing')).toBe(landing);
    // The open-source page was taken down on 2026-09-29; its address goes
    // home through public/_redirects, never to a public-address lookup.
    expect(await ask('https://agenticcloudcomputer.com/open-source')).toBe(landing);
    // So was the request page (note #791 → #794): its address goes to
    // sign-up through public/_redirects, and nobody may take it as a name.
    expect(await ask('https://agenticcloudcomputer.com/request-access')).toBe(landing);
    // So was the Leaderboard (note #824): its address goes home through
    // public/_redirects, and nobody may take it as a name.
    expect(await ask('https://agenticcloudcomputer.com/leaderboard')).toBe(landing);
    expect(next).toHaveBeenCalledTimes(7);
  });

  it('gives the root to the landing site, except to a signed-in browser', async () => {
    const fetchMock = vi.fn(async (request: Request) => new Response(request.url));
    vi.stubGlobal('fetch', fetchMock);
    const landing = new Response('landing');
    const next = vi.fn(async () => landing);
    expect(await onRequest({ request: new Request('https://agenticcloudcomputer.com/'), next })).toBe(landing);
    expect(await onRequest({ request: new Request('https://agenticcloudcomputer.com/?ref=x', { headers: { cookie: 'other=1' } }), next })).toBe(landing);
    const signedIn = await onRequest({ request: new Request('https://agenticcloudcomputer.com/', { headers: { cookie: '__Host-acc_csrf=t' } }), next });
    expect(await signedIn.text()).toBe('https://api.agenticcloudcomputer.com/');
    expect(routesToBackend('/', 'acc_csrf=t')).toBe(true);
    expect(routesToBackend('/', '__Host-acc_session=t')).toBe(true);
    expect(routesToBackend('/', 'acc_session=')).toBe(false);
    expect(routesToBackend('/', '')).toBe(false);
    // ?stay opens the front page anyway (note #526), signed in or not.
    expect(routesToBackend('/', 'acc_csrf=t', '?stay')).toBe(false);
    expect(routesToBackend('/', 'acc_csrf=t', '?stay=1&x=2')).toBe(false);
    expect(routesToBackend('/', 'acc_csrf=t', '?utm_source=stayfree')).toBe(true);
    expect(await onRequest({ request: new Request('https://agenticcloudcomputer.com/?stay', { headers: { cookie: '__Host-acc_csrf=t' } }), next })).toBe(landing);
  });

  it('keeps exactly the landing site’s first words — the same list a person cannot take as a name', () => {
    expect([...EDGE_LANDING_FIRST_SEGMENTS].sort()).toEqual([...LANDING_FIRST_SEGMENTS].sort());
    // And none of the registry's words is among them: every app address
    // reaches the backend.
    const registry = new Set<string>(['workspace', 'api', 'ops', 'internal']);
    for (const pattern of WORKSPACE_ENTRY_PATTERNS) if (pattern[0] && !pattern[0].startsWith(':')) registry.add(pattern[0]);
    for (const definition of Object.values(WORKSPACE_ROUTE_DEFS)) if (!definition.pattern[0]!.startsWith(':')) registry.add(definition.pattern[0]!);
    for (const old of Object.keys(WORKSPACE_LEGACY_SEGMENTS)) registry.add(old);
    for (const word of registry) {
      expect(EDGE_LANDING_FIRST_SEGMENTS, word).not.toContain(word);
      expect(routesToBackend(`/${word}`, ''), word).toBe(true);
    }
  });

  it('keeps every landing page and static file off the function, so the asset server answers them first', () => {
    const routes = JSON.parse(readFileSync(path.join(ROOT, 'public/_routes.json'), 'utf8')) as { include: string[]; exclude: string[] };
    expect(routes.include).toEqual(['/*']);
    for (const word of ['docs', 'terms', 'privacy', 'teams', 'og-preview', 'claude-code-in-the-cloud', 'codex-in-the-cloud', 'ai-agents-for-your-team', 'four-phases', 'why-fly', 'own-cloud', 'own-cloud.md', 'workplace.md', 'private-copy']) {
      expect(routes.exclude, word).toContain(`/${word}`);
    }
    for (const word of ['workspace', 'api', 'login', 'notes', 'adam']) expect(routes.exclude).not.toContain(`/${word}`);
    expect(routes.include.length + routes.exclude.length).toBeLessThanOrEqual(100);
  });
});
