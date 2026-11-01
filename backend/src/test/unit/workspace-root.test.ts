import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express, { type Request, type Response } from 'express';
import { BRAND_FILES, DEFAULT_BRAND_FILES_DIR, publicAddress, workspaceRootRoutes } from '../../routes/workspace-root.js';

const SHELL_HTML = '<!doctype html><html><head><script type="module" src="/workspace/app/assets/index.js"></script></head><body><div id="root"></div></body></html>';

function handlerFor(dir: string, routePath: string) {
  const router = workspaceRootRoutes({ workspaceUiDir: dir }) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: Partial<Response>) => Promise<unknown> | void }> } }>;
  };
  const layer = router.stack.find((candidate) => candidate.route?.path === routePath && candidate.route.methods.get);
  if (!layer?.route) throw new Error(`no root route for ${routePath}`);
  return layer.route.stack[0]!.handle;
}

function mockResponse() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    redirectedTo: '',
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    type() { return res; },
    send(body: unknown) { res.body = body; return res; },
    redirect(status: number, url: string) { res.statusCode = status; res.redirectedTo = url; },
    clearCookie() { return res; },
    headers,
  };
  return res;
}

describe('the Workspace at the root of the domain', () => {
  let shellDir: string;
  beforeAll(() => {
    shellDir = mkdtempSync(path.join(tmpdir(), 'workspace-root-'));
    mkdirSync(path.join(shellDir, 'assets'));
    writeFileSync(path.join(shellDir, 'index.html'), SHELL_HTML);
  });
  afterAll(() => { rmSync(shellDir, { recursive: true, force: true }); });

  it('serves the shell at Home, the login door and every registered address, unauthenticated', async () => {
    for (const [routePath, url] of [['/', '/'], ['/login', '/login'], ['/notes/:id', '/notes/12?org=o1'], ['/public/repositories/:id', '/public/repositories/abc']] as const) {
      const res = mockResponse();
      await handlerFor(shellDir, routePath)({ originalUrl: url, path: url.split('?')[0], query: {} } as unknown as Partial<Request>, res as unknown as Partial<Response>);
      expect(res.statusCode, routePath).toBe(200);
      expect(String(res.body)).toContain('<div id="root">');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    }
  });

  it('marks the link-only repository door noindex, and nothing else', async () => {
    const door = mockResponse();
    await handlerFor(shellDir, '/public/repositories/:id')({ originalUrl: '/public/repositories/abc', path: '/public/repositories/abc', query: {} } as unknown as Partial<Request>, door as unknown as Partial<Response>);
    expect(door.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    const home = mockResponse();
    await handlerFor(shellDir, '/')({ originalUrl: '/', path: '/', query: {} } as unknown as Partial<Request>, home as unknown as Partial<Response>);
    expect(home.headers['x-robots-tag']).toBeUndefined();
  });

  it('brings the cloud screen’s oldest address up to date', async () => {
    const res = mockResponse();
    await handlerFor(shellDir, '/organization/spending')({ originalUrl: '/organization/spending?org=o1' } as unknown as Partial<Request>, res as unknown as Partial<Response>);
    expect(res.statusCode).toBe(301);
    expect(res.redirectedTo).toBe('/workplace/cloud?org=o1');
  });

  it('serves nothing that is not a registered address', () => {
    expect(() => handlerFor(shellDir, '/api/state')).toThrow();
    expect(() => handlerFor(shellDir, '/adam/x/y')).toThrow();
  });

  it('serves the shell at a workplace repository’s address, and passes anything else on (slice 6)', async () => {
    const handler = handlerFor(shellDir, '/:handle/:repo') as unknown as (req: Partial<Request>, res: Partial<Response>, next: () => void) => Promise<unknown> | void;
    let passed = 0;
    const page = mockResponse();
    await handler({ originalUrl: '/acme/site?path=src', path: '/acme/site', query: {} } as unknown as Partial<Request>, page as unknown as Partial<Response>, () => { passed += 1; });
    expect(page.statusCode).toBe(200);
    expect(String(page.body)).toContain('<div id="root">');
    for (const bad of ['/api/state', '/ops/x', '/Acme/site', '/docs/email']) {
      const res = mockResponse();
      await handler({ originalUrl: bad, path: bad, query: {} } as unknown as Partial<Request>, res as unknown as Partial<Response>, () => { passed += 1; });
      expect(res.body, bad).toBeUndefined();
    }
    expect(passed).toBe(4);
    expect(publicAddress('/acme/site')).toBe(true);
    expect(publicAddress('/acme/site/commits')).toBe(true);
    expect(publicAddress('/acme/site/commits/0afae37a')).toBe(true);
    expect(publicAddress('/acme/site/proposals')).toBe(true);
    expect(publicAddress('/acme/site/proposals/12')).toBe(true);
    expect(publicAddress('/acme/site/contributors')).toBe(true);
    expect(publicAddress('/api/site/commits')).toBe(false);
    expect(publicAddress('/notes/12')).toBe(false);
  });

  it('sends the link-only token door to the repository’s address when its workplace has one, query intact', async () => {
    const router = workspaceRootRoutes({
      workspaceUiDir: shellDir,
      publicRepoAddress: async (id) => (id === 'known-id' ? '/acme/site' : null),
    }) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: Partial<Response>) => Promise<unknown> | void }> } }> };
    const handler = router.stack.find((layer) => layer.route?.path === '/public/repositories/:id' && layer.route.methods.get)!.route!.stack[0]!.handle;
    const moved = mockResponse();
    await handler({ originalUrl: '/public/repositories/known-id?path=src&file=1', path: '/public/repositories/known-id', query: {} } as unknown as Partial<Request>, moved as unknown as Partial<Response>);
    expect(moved.statusCode).toBe(301);
    expect(moved.redirectedTo).toBe('/acme/site?path=src&file=1');
    // A workplace without a handle keeps the old door: the shell, noindex.
    const kept = mockResponse();
    await handler({ originalUrl: '/public/repositories/other-id', path: '/public/repositories/other-id', query: {} } as unknown as Partial<Request>, kept as unknown as Partial<Response>);
    expect(kept.statusCode).toBe(200);
    expect(kept.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
  });

  it('serves the shell at a person’s public address, and passes a reserved word on (public-addresses, slice 5)', async () => {
    const handler = handlerFor(shellDir, '/:handle') as unknown as (req: Partial<Request>, res: Partial<Response>, next: () => void) => Promise<unknown> | void;
    const page = mockResponse();
    let passed = 0;
    await handler({ originalUrl: '/adam', path: '/adam', query: {} } as unknown as Partial<Request>, page as unknown as Partial<Response>, () => { passed += 1; });
    expect(page.statusCode).toBe(200);
    expect(String(page.body)).toContain('<div id="root">');
    expect(page.headers['x-robots-tag']).toBeUndefined();
    expect(passed).toBe(0);
    // The words the backend answers on outside the registry, and the
    // reserved list, are not this router's: they fall through to whatever
    // is mounted after it, exactly as before.
    for (const word of ['ops', 'internal', 'api', 'notifications', 'admin', 'docs', 'Adam', 'x']) {
      const res = mockResponse();
      await handler({ originalUrl: `/${word}`, path: `/${word}`, query: {} } as unknown as Partial<Request>, res as unknown as Partial<Response>, () => { passed += 1; });
      expect(res.body, word).toBeUndefined();
    }
    expect(passed).toBe(8);
    expect(publicAddress('/adam')).toBe(true);
    expect(publicAddress('/workspace/adam')).toBe(true);
    expect(publicAddress('/login')).toBe(false);
    expect(publicAddress('/support')).toBe(false);
  });

  it('serves the font and icons in a private copy, and leaves them to the public site otherwise (note #815)', async () => {
    const serve = async (options: Parameters<typeof workspaceRootRoutes>[0]) => {
      const app = express();
      app.use(workspaceRootRoutes({ workspaceUiDir: shellDir, ...options }));
      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
    };
    const copy = await serve({ brandFilesDir: DEFAULT_BRAND_FILES_DIR });
    const ours = await serve({});
    const empty = mkdtempSync(path.join(tmpdir(), 'brand-missing-'));
    const missing = await serve({ brandFilesDir: empty });
    try {
      const types: Record<string, RegExp> = { woff2: /^font\/woff2/, ico: /^image\//, png: /^image\/png/ };
      for (const file of BRAND_FILES) {
        const res = await fetch(`${copy.origin}/${file}`);
        expect(res.status, file).toBe(200);
        expect(res.headers.get('content-type'), file).toMatch(types[file.split('.').pop()!]!);
        expect((await res.arrayBuffer()).byteLength, file).toBeGreaterThan(1000);
        // Our platform never mounts them: `/fonts/…` reads as a public
        // address there, exactly as before, because the site answers first.
        expect((await fetch(`${ours.origin}/${file}`)).headers.get('content-type') ?? '', file).not.toMatch(types[file.split('.').pop()!]!);
        // A copy whose image lacks a file says so, rather than sending a page.
        const gone = await fetch(`${missing.origin}/${file}`);
        expect(gone.status, file).toBe(404);
        expect(await gone.text(), file).not.toContain('<div id="root">');
      }
    } finally {
      for (const { server } of [copy, ours, missing]) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
