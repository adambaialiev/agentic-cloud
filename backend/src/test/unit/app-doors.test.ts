import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import {
  APP_FEED_PAGE, APP_MAIL_ALLOWANCE, APP_PASS_HOURS, APP_PROOF_MINUTES, AppDoors, InMemoryAppDoorStore, SqliteAppDoorStore,
  appCredentialFrom, appReturnTo, appSiteName, type AppDoorStore,
} from '../../services/app-doors.js';
import { forwardGoLink, outreachLinkRoutes } from '../../routes/outreach-links.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * A workplace app's doors (note #1178): the Outreach site moved out of this
 * repository, and what it needs of the platform became doors any workplace
 * app could use, open to the operator only for now. What matters: a pass only
 * for a live site of the person's own, sent only to that site; a proof is an
 * agent and can never send or read a letter's words; Send goes from the
 * person's own mailbox with the app's ceilings; the feed tells a site its own
 * letters' facts and nobody else's; the /go/ forwarder never sends a reader
 * off the landing, and lands them home when the app does not answer.
 */
const SITE = 'https://outreach.agentbuilt.app';

describe('a workplace app\'s doors (note #1178)', () => {
  let server: Server;
  let origin: string;
  let deps: Partial<RouteDeps>;
  let doors: AppDoors;
  let clock = new Date('2026-11-13T15:00:00Z');
  const sent: Array<Record<string, unknown>> = [];
  let mailSeq = 0;

  async function serve(opts: { operator?: boolean; privateCopy?: boolean; siteStatus?: string } = {}) {
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    await users.updateProfile('alice', { person: { firstName: 'Alice', lastName: 'Example' } } as never);
    if (opts.operator !== false) await users.updateProfile('alice', { roles: { admin: true } } as never);
    clock = new Date('2026-11-13T15:00:00Z');
    sent.length = 0;
    doors = new AppDoors(new InMemoryAppDoorStore(), () => clock);
    const deployments = new InMemoryDeploymentStorage();
    await deployments.create({ userId: 'alice', orgId: 'org-a', agentId: 'agent-1', name: 'outreach', status: opts.siteStatus ?? 'live' } as never);
    await deployments.create({ userId: 'carol', orgId: 'org-c', agentId: 'agent-9', name: 'elsewhere', status: 'live' } as never);
    const mails = new Map<string, Record<string, unknown>>();
    const mailOutbox = {
      send: async (args: Record<string, unknown>) => {
        sent.push({ how: 'send', ...args });
        mailSeq += 1;
        const mail = { id: `mail-${mailSeq}`, direction: 'sent', to: [{ address: String(args.to) }], subject: String(args.subject), text: `${String(args.text)}\n`, wrote: String(args.text), receivedAt: clock.toISOString(), providerId: `prov-${mailSeq}` };
        mails.set(mail.id, mail);
        return mail;
      },
      followUp: async (args: Record<string, unknown>) => {
        sent.push({ how: 'followUp', ...args });
        mailSeq += 1;
        const first = mails.get(String(args.messageId))!;
        const mail = { id: `mail-${mailSeq}`, direction: 'sent', to: first.to, subject: `Re: ${String(first.subject)}`, text: String(args.text), wrote: String(args.text), receivedAt: clock.toISOString(), providerId: null };
        mails.set(mail.id, mail);
        return mail;
      },
    };
    deps = {
      userStorage: users,
      orgStorage: new InMemoryOrgStorage(),
      deploymentStorage: deployments,
      appDoors: doors,
      appsDomain: 'agentbuilt.app',
      mailFactsConfigured: true,
      mailOutbox: mailOutbox as never,
      mailMessages: { get: async (_userId: string, id: string) => mails.get(id) ?? null } as never,
      copyPulses: { list: async () => [{ pulse: { copyId: 'copy-1', domain: 'acme.test', contactEmail: 'it@acme.test', sentAt: '2026-11-12T10:00:00Z' } }] } as never,
      ...(opts.privateCopy ? { privateCopy: true } : {}),
    };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

  const door = (who: number | null, site = 'outreach', back = `https://${site}.agentbuilt.app/`) => fetch(
    `${origin}/workspace/api/apps/pass?site=${encodeURIComponent(site)}&return=${encodeURIComponent(back)}`,
    { redirect: 'manual', headers: who === null ? {} : { Cookie: workspaceTestHeaders(who).Cookie! } },
  );
  const passFrom = (location: string | null) => decodeURIComponent(new URL(location!).hash.match(/pass=([^&]+)/)?.[1] ?? '');
  const call = (path: string, token: string, init: RequestInit = {}) => fetch(`${origin}/workspace/api/apps${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> ?? {}) },
  });

  it('sends the signed-in operator back to his own live site with a pass in the fragment; /me says who it is', async () => {
    await serve();
    const answer = await door(42);
    expect(answer.status).toBe(303);
    const location = answer.headers.get('location')!;
    expect(location.startsWith(`${SITE}/#pass=ap_`)).toBe(true);
    expect(answer.headers.get('referrer-policy')).toBe('no-referrer');
    const pass = passFrom(location);
    const me = await call('/me', pass);
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(await me.json()).toMatchObject({ kind: 'person', site: 'outreach', userId: 'alice', name: 'Alice Example', agent: null });
    // A pass opens the app doors and nothing else.
    expect((await fetch(`${origin}/workspace/api/state`, { headers: { authorization: `Bearer ${pass}` } })).status).toBe(401);
    expect((await call('/pass/end', pass, { method: 'POST' })).status).toBe(204);
    expect((await call('/me', pass)).status).toBe(401);
  });

  it('gives nothing signed out, to anybody but the operator, for a site not theirs or not live, or towards another address', async () => {
    await serve();
    const out = await door(null);
    expect(out.status).toBe(401);
    expect(await out.text()).toContain('Sign in to Agentic Cloud first');
    expect((await door(43)).status).toBe(403);
    expect((await door(42, 'elsewhere')).status).toBe(403);
    expect((await door(42, 'nosuchsite')).status).toBe(403);
    for (const back of ['https://evil.test/', 'https://outreach.agentbuilt.app.evil.test/', 'https://user@outreach.agentbuilt.app/', 'https://elsewhere.agentbuilt.app/', 'javascript:alert(1)']) {
      const refused = await door(42, 'outreach', back);
      expect(refused.status).toBe(400);
      expect(refused.headers.get('location')).toBeNull();
    }
    expect((await door(42, '../x')).status).toBe(400);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await serve({ siteStatus: 'stopped' });
    expect((await door(42)).status).toBe(403);
  });

  it('is shut to everybody but the operator: a pass of a person who is not one opens nothing', async () => {
    await serve({ operator: false });
    expect((await door(42)).status).toBe(403);
    const minted = await doors.mintPass('alice', 'outreach', { sessionId: 'workspace-test-42', absoluteExpiresAt: '2026-12-01T00:00:00Z' });
    expect((await call('/me', minted.token)).status).toBe(403);
  });

  it('ends at its hour, and with the sign-in it was given to', async () => {
    await serve();
    const pass = passFrom((await door(42)).headers.get('location'));
    expect((await call('/me', pass)).status).toBe(200);
    clock = new Date(clock.getTime() + APP_PASS_HOURS * 3_600_000 + 1);
    expect((await call('/me', pass)).status).toBe(401);
    clock = new Date('2026-11-13T15:00:00Z');
    const second = passFrom((await door(42)).headers.get('location'));
    await deps.workspaceWebAuth!.revokeSession('alice', 'workspace-test-42');
    expect((await call('/me', second)).status).toBe(401);
  });

  it('sends from the person\'s own mailbox on a pass, with the app\'s ceilings; a follow-up only under a letter this site sent', async () => {
    await serve();
    const pass = passFrom((await door(42)).headers.get('location'));
    const first = await call('/mail/send', pass, { method: 'POST', body: JSON.stringify({ to: 'jo@northwind.test', subject: 'Hello', text: 'Line one\nLine two' }) });
    expect(first.status).toBe(200);
    const { mail } = await first.json() as { mail: { id: string; to: string; subject: string; text: string; providerId: string } };
    expect(mail).toMatchObject({ to: 'jo@northwind.test', subject: 'Hello', text: 'Line one\nLine two', providerId: 'prov-1' });
    expect(sent[0]).toMatchObject({ how: 'send', userId: 'alice', to: 'jo@northwind.test', allowance: APP_MAIL_ALLOWANCE, withHtml: true, senderName: 'Alice Example' });
    expect((await call('/mail/send', pass, { method: 'POST', body: JSON.stringify({ followUpOf: 'mail-not-ours', text: 'Again' }) })).status).toBe(404);
    const again = await call('/mail/send', pass, { method: 'POST', body: JSON.stringify({ followUpOf: mail.id, text: 'Again' }) });
    expect(again.status).toBe(200);
    expect(sent[1]).toMatchObject({ how: 'followUp', messageId: mail.id, allowance: APP_MAIL_ALLOWANCE });
    expect((await call('/mail/send', pass, { method: 'POST', body: JSON.stringify({ to: 'x@y.test', subject: 'S', text: '   ' }) })).status).toBe(400);
    expect(sent).toHaveLength(2);
    // Its words, as they left; a letter it did not send is not its to read.
    const read = await call(`/mail/${mail.id}`, pass);
    expect(read.status).toBe(200);
    expect((await read.json() as { mail: { wrote: string } }).mail.wrote).toBe('Line one\nLine two');
    expect((await call('/mail/mail-404', pass)).status).toBe(404);
  });

  it('a proof is an agent: it reads the feed, and can never send or read a letter\'s words', async () => {
    await serve();
    const proof = await doors.mintProof('alice', 'outreach', { agentId: 'agent-toby', name: 'Toby' });
    expect(proof.token.startsWith('sp_')).toBe(true);
    const me = await call('/me', proof.token);
    expect(await me.json()).toMatchObject({ kind: 'agent', site: 'outreach', userId: 'alice', agent: { id: 'agent-toby', name: 'Toby' } });
    expect((await call('/mail/send', proof.token, { method: 'POST', body: JSON.stringify({ to: 'jo@northwind.test', subject: 'Hi', text: 'Hi' }) })).status).toBe(403);
    expect((await call('/mail/mail-1', proof.token)).status).toBe(403);
    expect(sent).toHaveLength(0);
    expect((await call('/feed', proof.token)).status).toBe(200);
    clock = new Date(clock.getTime() + APP_PROOF_MINUTES * 60_000 + 1);
    expect((await call('/me', proof.token)).status).toBe(401);
  });

  it('the feed: this site\'s letters\' facts once each, arrivals and guests, the copies; another site\'s letters never', async () => {
    await serve();
    const pass = passFrom((await door(42)).headers.get('location'));
    await doors.sent({ userId: 'alice', site: 'outreach', mailId: 'm1', providerId: 'p1', at: '2026-11-13T14:00:00Z' });
    await doors.sent({ userId: 'alice', site: 'other', mailId: 'm2', providerId: 'p2', at: '2026-11-13T14:00:00Z' });
    const event = { eventId: 'evt-1', event: 'delivered', providerId: 'p1', at: '2026-11-13T14:01:00Z', to: ['jo@northwind.test'], subject: 'Hello' };
    expect(await doors.noteMailEvent(event)).toBe(true);
    expect(await doors.noteMailEvent(event)).toBe(true);
    expect(await doors.noteMailEvent({ ...event, eventId: 'evt-2', providerId: 'p2' })).toBe(true);
    expect(await doors.noteMailEvent({ ...event, eventId: 'evt-3', providerId: 'somebody-elses' })).toBe(false);
    await doors.noteArrival('alice', { id: 'in-1', from: 'jo@northwind.test', subject: 'Re: Hello', receivedAt: '2026-11-13T14:30:00Z' }, false);
    await doors.noteGuest('alice', { agentId: 'g-1', name: 'Oscar', country: 'NL', utm: { utm_source: 'outreach', utm_content: 'northwind' } });
    await doors.noteArrival('bob', { id: 'in-2', from: 'x@y.test', subject: 'Not Alice\'s', receivedAt: '2026-11-13T14:31:00Z' }, false);
    const feed = await (await call('/feed', pass)).json() as { events: Array<Record<string, unknown>>; last: number; mailFacts: boolean; copies: unknown[] };
    expect(feed.events.map((one) => one.kind)).toEqual(['mail-event', 'arrival', 'guest']);
    expect(feed.events[0]).toMatchObject({ site: 'outreach', mailId: 'm1', eventId: 'evt-1', event: 'delivered' });
    expect(feed.events[1]).toMatchObject({ mailId: 'in-1', from: 'jo@northwind.test', subject: 'Re: Hello' });
    expect(feed.events[1]).not.toHaveProperty('text');
    expect(feed.mailFacts).toBe(true);
    expect(feed.copies).toEqual([{ copyId: 'copy-1', domain: 'acme.test', contactEmail: 'it@acme.test', at: '2026-11-12T10:00:00Z' }]);
    const after = await (await call(`/feed?after=${feed.last}`, pass)).json() as { events: unknown[]; last: number };
    expect(after.events).toEqual([]);
    expect(after.last).toBe(feed.last);
  });

  it('is not there in a private copy', async () => {
    await serve({ privateCopy: true });
    expect((await door(42)).status).toBe(404);
  });
});

describe('the app doors\' pieces (note #1178)', () => {
  it('reads a credential, a site name and a return address strictly', () => {
    expect(appCredentialFrom('Bearer ap_abc')).toBe('ap_abc');
    expect(appCredentialFrom('Bearer sp_abc')).toBe('sp_abc');
    expect(appCredentialFrom('Bearer op_abc')).toBeNull();
    expect(appCredentialFrom(undefined)).toBeNull();
    expect(appSiteName('Outreach')).toBe('outreach');
    expect(appSiteName('-x')).toBeNull();
    expect(appSiteName('a.b')).toBeNull();
    expect(appReturnTo(undefined, SITE)).toBe(`${SITE}/`);
    expect(appReturnTo(`${SITE}/c/x?y=1#old`, SITE)).toBe(`${SITE}/c/x?y=1`);
    expect(appReturnTo('https://evil.test/', SITE)).toBeNull();
  });

  for (const kind of ['memory', 'sqlite'] as const) {
    it(`keeps credentials as hashes, a letter once, and the feed in order (${kind})`, async () => {
      const store: AppDoorStore = kind === 'sqlite' ? new SqliteAppDoorStore(openSqliteDb(':memory:')) : new InMemoryAppDoorStore();
      let clock = new Date('2026-11-13T15:00:00Z');
      const doors = new AppDoors(store, () => clock);
      const pass = await doors.mintPass('alice', 'outreach', { sessionId: 's1', absoluteExpiresAt: '2026-11-13T16:00:00Z' });
      // Never past the sign-in's own end.
      expect(pass.expiresAt).toBe('2026-11-13T16:00:00.000Z');
      expect(await doors.read(pass.token)).toMatchObject({ kind: 'person', userId: 'alice', site: 'outreach', sessionId: 's1' });
      expect(await store.getCredential(pass.token)).toBeNull();
      clock = new Date('2026-11-13T16:00:01Z');
      expect(await doors.read(pass.token)).toBeNull();
      await doors.sent({ userId: 'alice', site: 'outreach', mailId: 'm1', providerId: 'p1', at: 'x' });
      await doors.sent({ userId: 'alice', site: 'other', mailId: 'm1', providerId: 'p9', at: 'y' });
      expect(await doors.mailOf('alice', 'outreach', 'm1')).toMatchObject({ providerId: 'p1', at: 'x' });
      expect(await doors.mailOf('alice', 'other', 'm1')).toBeNull();
      for (let i = 0; i < APP_FEED_PAGE + 3; i += 1) {
        await doors.noteArrival('alice', { id: `in-${i}`, subject: 's', receivedAt: '2026-11-13T15:30:00Z' }, false);
      }
      const page = await doors.feed('alice', 'outreach', 0);
      expect(page.events).toHaveLength(APP_FEED_PAGE);
      const rest = await doors.feed('alice', 'outreach', page.last);
      expect(rest.events.map((one) => one.mailId)).toEqual([`in-${APP_FEED_PAGE}`, `in-${APP_FEED_PAGE + 1}`, `in-${APP_FEED_PAGE + 2}`]);
      // Kept 180 days.
      clock = new Date('2027-06-01T00:00:00Z');
      expect((await doors.feed('alice', 'outreach', 0)).events).toEqual([]);
    });
  }
});

describe('the /go/ forwarder (note #1178)', () => {
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('takes a path on the landing or a preview card, and nothing else', async () => {
    const reader = { userAgent: 'Mozilla/5.0', method: 'GET' };
    expect(await forwardGoLink(SITE, 'abc234', reader, answering(200, { location: '/?utm_source=outreach' }))).toEqual({ location: '/?utm_source=outreach' });
    expect(await forwardGoLink(SITE, 'abc234', reader, answering(200, { html: '<!doctype html><title>x</title>' }))).toEqual({ html: '<!doctype html><title>x</title>' });
    for (const location of ['//evil.test/', 'https://evil.test/', '/\\evil.test', 'relative', '/a\r\nSet-Cookie: x=1']) {
      expect(await forwardGoLink(SITE, 'abc234', reader, answering(200, { location }))).toBeNull();
    }
    expect(await forwardGoLink(SITE, 'abc234', reader, answering(500, { location: '/' }))).toBeNull();
    const slow = (async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await forwardGoLink(SITE, 'abc234', reader, slow, 50)).toBeNull();
  });

  it('asks the app with the reader\'s word, and lands the reader on the landing, home when the app fails', async () => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    let reply: () => Response = () => new Response(JSON.stringify({ location: '/workplace.md?utm_content=northwind' }), { status: 200 });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      asked.push({ url, headers: init.headers as Record<string, string> });
      return reply();
    }) as unknown as typeof fetch;
    const app = express();
    app.use(outreachLinkRoutes(() => null, { forwardTo: () => SITE, fetchImpl }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const go = await fetch(`${base}/go/ABC234`, { redirect: 'manual', headers: { 'user-agent': 'Claude-User/1.0' } });
      expect(go.status).toBe(302);
      expect(go.headers.get('location')).toBe('https://agenticcloudcomputer.com/workplace.md?utm_content=northwind');
      expect(go.headers.get('cache-control')).toBe('no-store');
      expect(asked[0]).toMatchObject({ url: `${SITE}/api/go/abc234`, headers: { 'x-go-user-agent': 'Claude-User/1.0', 'x-go-method': 'GET' } });
      reply = () => new Response(JSON.stringify({ html: '<!doctype html><title>card</title>' }), { status: 200 });
      const card = await fetch(`${base}/go/abc234`, { redirect: 'manual' });
      expect(card.status).toBe(200);
      expect(await card.text()).toBe('<!doctype html><title>card</title>');
      reply = () => new Response('down', { status: 503 });
      const home = await fetch(`${base}/go/abc234`, { redirect: 'manual' });
      expect(home.status).toBe(302);
      expect(home.headers.get('location')).toBe('https://agenticcloudcomputer.com/');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
