import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { workspaceRoutes } from '../../routes/workspace.js';
import { outreachSiteCors } from '../../routes/outreach.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OutreachService } from '../../services/outreach.js';
import { InMemoryOutreachStore } from '../../services/outreach-storage.js';
import { InMemoryOutreachPassStore, OUTREACH_PASS_HOURS, OutreachPasses, outreachReturnTo } from '../../services/outreach-pass.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * The Outreach site's pass (note #1093). Outreach is its own site; the owner
 * signs in on the platform as usual and the pass door sends him back with a
 * pass that opens the Outreach routes and nothing else. What matters: only
 * the operator's live sign-in gets one, only the site's origin receives it,
 * it dies with the sign-in and at its hour, and only the site's origin may
 * call across origins.
 */
const SITE = 'https://outreach.site.test';

describe('the Outreach pass (note #1093)', () => {
  let server: Server;
  let origin: string;
  let deps: Partial<RouteDeps>;
  let passes: OutreachPasses;
  let clock = new Date('2026-11-09T15:00:00Z');

  async function serve(opts: { operator?: boolean; privateCopy?: boolean } = {}) {
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    if (opts.operator !== false) await users.updateProfile('alice', { roles: { admin: true } } as never);
    clock = new Date('2026-11-09T15:00:00Z');
    passes = new OutreachPasses(new InMemoryOutreachPassStore(), () => clock);
    deps = {
      userStorage: users,
      orgStorage: new InMemoryOrgStorage(),
      outreach: new OutreachService({ store: new InMemoryOutreachStore(), outbox: () => undefined }),
      outreachPasses: passes,
      outreachSiteOrigin: SITE,
      ...(opts.privateCopy ? { privateCopy: true } : {}),
    };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
    const app = express();
    app.use('/workspace/api/outreach', outreachSiteCors(SITE));
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const door = (who: number | null, back = `${SITE}/`) => fetch(`${origin}/workspace/api/outreach/pass?return=${encodeURIComponent(back)}`, {
    redirect: 'manual', headers: who === null ? {} : { Cookie: workspaceTestHeaders(who).Cookie! },
  });
  const passFrom = (location: string | null) => new URL(location!).hash.match(/pass=([^&]+)/)?.[1] ?? '';

  it('sends the signed-in operator back to the site with a pass in the fragment, and it opens the routes', async () => {
    await serve();
    const answer = await door(42);
    expect(answer.status).toBe(303);
    const location = answer.headers.get('location')!;
    expect(location.startsWith(`${SITE}/#pass=op_`)).toBe(true);
    expect(answer.headers.get('referrer-policy')).toBe('no-referrer');
    const pass = decodeURIComponent(passFrom(location));
    const list = await fetch(`${origin}/workspace/api/outreach`, { headers: { authorization: `Bearer ${pass}`, origin: SITE } });
    expect(list.status).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(list.headers.get('access-control-allow-credentials')).toBeNull();
    // The pass opens Outreach and nothing else: the Workspace's own reads refuse it.
    expect((await fetch(`${origin}/workspace/api/state`, { headers: { authorization: `Bearer ${pass}` } })).status).toBe(401);
    // Signing out on the site ends it.
    expect((await fetch(`${origin}/workspace/api/outreach/pass/end`, { method: 'POST', headers: { authorization: `Bearer ${pass}` } })).status).toBe(204);
    expect((await fetch(`${origin}/workspace/api/outreach`, { headers: { authorization: `Bearer ${pass}` } })).status).toBe(401);
  });

  it('gives nothing to somebody signed out, to anybody but the operator, or towards any other address', async () => {
    await serve();
    const out = await door(null);
    expect(out.status).toBe(401);
    expect(await out.text()).toContain('Sign in to Agentic Cloud first');
    const member = await door(43);
    expect(member.status).toBe(403);
    expect(member.headers.get('location')).toBeNull();
    for (const elsewhere of ['https://evil.test/', 'https://outreach.site.test.evil.test/', 'https://user@outreach.site.test/', 'javascript:alert(1)']) {
      const refused = await door(42, elsewhere);
      expect(refused.status).toBe(400);
      expect(refused.headers.get('location')).toBeNull();
    }
    expect(outreachReturnTo(undefined, SITE)).toBe(`${SITE}/`);
    expect(outreachReturnTo(`${SITE}/targets/x?y=1#old`, SITE)).toBe(`${SITE}/targets/x?y=1`);
  });

  it('ends at its hour, and with the sign-in it was given to', async () => {
    await serve();
    const pass = decodeURIComponent(passFrom((await door(42)).headers.get('location')));
    const read = () => fetch(`${origin}/workspace/api/outreach`, { headers: { authorization: `Bearer ${pass}` } }).then((r) => r.status);
    expect(await read()).toBe(200);
    clock = new Date(clock.getTime() + OUTREACH_PASS_HOURS * 3_600_000 + 1);
    expect(await read()).toBe(401);
    clock = new Date('2026-11-09T15:00:00Z');
    const second = decodeURIComponent(passFrom((await door(42)).headers.get('location')));
    await deps.workspaceWebAuth!.revokeSession('alice', 'workspace-test-42');
    expect((await fetch(`${origin}/workspace/api/outreach`, { headers: { authorization: `Bearer ${second}` } })).status).toBe(401);
  });

  it('answers the site\'s preflight, and only the site\'s', async () => {
    await serve();
    const ok = await fetch(`${origin}/workspace/api/outreach/targets/x/send`, {
      method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization');
    const other = await fetch(`${origin}/workspace/api/outreach`, { headers: { origin: 'https://evil.test' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('once Outreach moved into its own app (note #1178), the door and the routes say where it went', async () => {
    await serve();
    const pass = decodeURIComponent(passFrom((await door(42)).headers.get('location')));
    deps.outreachMovedTo = 'https://outreach.agentbuilt.app';
    const moved = await door(42);
    expect(moved.status).toBe(410);
    expect(moved.headers.get('location')).toBeNull();
    expect(await moved.text()).toContain('Outreach has its own sign-in now');
    const list = await fetch(`${origin}/workspace/api/outreach`, { headers: { authorization: `Bearer ${pass}` } });
    expect(list.status).toBe(410);
    expect((await list.json() as { code: string }).code).toBe('outreach_moved');
  });

  it('is not there in a private copy', async () => {
    await serve({ privateCopy: true });
    expect((await door(42)).status).toBe(404);
  });
});
