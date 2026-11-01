import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceRoutes } from '../../routes/workspace.js';
import { workspaceRootRoutes } from '../../routes/workspace-root.js';
import { WORKSPACE_UI_COOKIE, loadWorkspaceUiShell } from '../../routes/workspace-ui.js';
import type { RouteDeps } from '../../routes/deps.js';

/**
 * How the React Workspace shell is DELIVERED (routes/workspace-ui.ts): every
 * registered address answers with the one index.html, its policy has no
 * inline script hashes because the shell has no inline script, the hashed
 * assets are immutable, a backend without a build says so rather than
 * answering a blank, and the retired `?ui=` switch is cleaned out of an old
 * link. Real sockets: cookies, redirects and static headers are Express
 * behaviour, and a mock would agree with anything.
 */

interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }

function get(port: number, requestPath: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: requestPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const SHELL_HTML = '<!doctype html><html><head><title>Your workspace</title>'
  + '<script type="module" crossorigin src="/workspace/app/assets/index-abc123.js"></script>'
  + '<link rel="stylesheet" crossorigin href="/workspace/app/assets/index-abc123.css"></head>'
  + '<body class="web-mode"><div id="root"></div></body></html>';

function shellFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workspace-ui-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), SHELL_HTML);
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("shell")');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.css'), 'body{}');
  return dir;
}

describe('serving the shell', () => {
  let server: Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    dir = shellFixture();
    const app = express();
    app.use('/workspace', workspaceRoutes({ workspaceUiDir: dir } as RouteDeps));
    app.use(workspaceRootRoutes({ workspaceUiDir: dir }));
    ({ server, port } = await listen(app));
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it('serves the shell at every Workspace address, whatever cookie the browser still holds', async () => {
    for (const address of ['/', '/login', '/signup', '/verify-email', '/invite/tok', '/notes/12?org=o', '/repositories/x/commits/abc']) {
      for (const headers of [{}, { cookie: `${WORKSPACE_UI_COOKIE}=legacy` }, { cookie: `${WORKSPACE_UI_COOKIE}=react` }]) {
        const reply = await get(port, address, headers);
        expect(reply.status, address).toBe(200);
        expect(reply.headers['content-type'], address).toMatch(/text\/html/);
        expect(reply.body.toString('utf8'), address).toBe(SHELL_HTML);
      }
    }
  });

  it('an old ?ui= link is cleaned: the choice cookie expires and the clean address is served', async () => {
    for (const [address, clean] of [
      ['/notes/12?org=o&ui=react&room=r', '/notes/12?org=o&room=r'],
      ['/?ui=legacy', '/'],
      ['/?ui=vue', '/'],
    ]) {
      const reply = await get(port, address!, { cookie: `${WORKSPACE_UI_COOKIE}=legacy` });
      expect(reply.status, address).toBe(302);
      expect(reply.headers.location, address).toBe(clean);
      expect(reply.headers['cache-control'], address).toBe('no-store');
      const cookie = String(reply.headers['set-cookie']);
      expect(cookie, address).toContain(`${WORKSPACE_UI_COOKIE}=;`);
      expect(cookie, address).toContain('Expires=Thu, 01 Jan 1970');
      expect(cookie, address).toContain('Path=/');
    }
  });

  it("the shell's policy is same-origin script with no inline hashes, and it revalidates", async () => {
    const reply = await get(port, '/');
    const csp = String(reply.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain('sha256-');
    expect(csp).not.toContain('cdnjs');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(reply.headers['cache-control']).toBe('no-cache');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    const etag = String(reply.headers.etag);
    expect(etag).toMatch(/^"[\w-]+"$/);
    const again = await get(port, '/', { 'if-none-match': etag });
    expect(again.status).toBe(304);
  });

  it('lets Workspace request microphone permission while keeping other capture features blocked', async () => {
    for (const address of ['/', '/chat/felix', '/notes/12']) {
      const reply = await get(port, address);
      expect(reply.status).toBe(200);
      expect(reply.headers['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()');
    }
  });

  it('serves the hashed assets immutable, and a missing one as a 404 rather than the shell', async () => {
    const asset = await get(port, '/workspace/app/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect(asset.body.toString('utf8')).toBe('console.log("shell")');
    const missing = await get(port, '/workspace/app/assets/index-gone.js');
    expect(missing.status).toBe(404);
  });

  it('still serves the service-worker address, as a worker that retires the one showing pushes', async () => {
    // Browser notifications are gone (note #477). A browser that turned them
    // on still holds the earlier worker, and only a changed file at this
    // address replaces it — so the address answers with a worker that
    // unsubscribes and unregisters, and shows nothing.
    const reply = await get(port, '/workspace/service-worker.js');
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-cache');
    expect(reply.headers['service-worker-allowed']).toBe('/workspace/');
    const worker = reply.body.toString('utf8');
    expect(worker).toContain('self.skipWaiting()');
    expect(worker).toContain('subscription.unsubscribe()');
    expect(worker).toContain('registration.unregister()');
    expect(worker).not.toContain('showNotification');
    expect(worker).not.toContain("addEventListener('push'");
  });

  it('answers every old /workspace address with a permanent redirect to its root form', async () => {
    for (const [address, target] of [
      ['/workspace', '/login'],
      ['/workspace/', '/login'],
      ['/workspace/notes/12?org=o&room=r', '/notes/12?org=o&room=r'],
      ['/workspace/organization/people?org=o', '/workplace/people?org=o'],
      ['/workspace/public/repositories/abc', '/public/repositories/abc'],
    ] as const) {
      const reply = await get(port, address);
      expect(reply.status, address).toBe(301);
      expect(reply.headers.location, address).toBe(target);
    }
    // Signed in, the bare address is Home rather than the login door.
    const home = await get(port, '/workspace', { cookie: 'acc_csrf=t; __Host-acc_csrf=t' });
    expect(home.status).toBe(301);
    expect(home.headers.location).toBe('/');
  });

  it('a Workspace address outside the registry is not served at all', async () => {
    expect((await get(port, '/notifications')).status).toBe(404);
    expect((await get(port, '/decisions/other/1')).status).toBe(404);
    expect((await get(port, '/workspace/notifications')).status).toBe(404);
  });
});

describe('without a build', () => {
  it('says so rather than answering a blank', async () => {
    const app = express();
    app.use('/workspace', workspaceRoutes({ workspaceUiDir: '/nonexistent/workspace-ui' } as RouteDeps));
    app.use(workspaceRootRoutes({ workspaceUiDir: '/nonexistent/workspace-ui' }));
    const { server, port } = await listen(app);
    try {
      const reply = await get(port, '/profile');
      expect(reply.status).toBe(404);
      expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ error: 'Workspace shell not found on this backend build' });
    } finally {
      server.close();
    }
  });
});

describe('loading the shell', () => {
  it('refuses a build that grew an inline script, because the policy promises there is none', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'workspace-ui-inline-'));
    try {
      writeFileSync(path.join(dir, 'index.html'), '<html><body><script>alert(1)</script></body></html>');
      await expect(loadWorkspaceUiShell(dir)).rejects.toThrow(/inline script/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
