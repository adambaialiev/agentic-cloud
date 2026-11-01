/**
 * A private copy is many people in one company (note #808): no open
 * sign-up, an account through an invite link lands with its request to join
 * and no spare workplace, the first account comes from the installer's code,
 * and a new workplace is made only by someone already in one. Our own
 * platform is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { InMemoryWorkspaceWebAuthStorage, WorkspaceWebAuthService } from '../../services/workspace-web-auth.js';
import { SecretCipher } from '../../services/secret-cipher.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';

const CODE = 'first-account-code-0123456789';

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const combined = response.headers.get('set-cookie');
  return combined ? combined.split(/,(?=[^;,]+=)/) : [];
}

const cookieJar = (cookies: string[]): string => cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');

function cookieValue(jar: string, name: string): string {
  const item = jar.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

describe('a private copy takes people by invite (note #808)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  const start = async (copy: Partial<RouteDeps>) => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = new InMemoryUserStorage();
    const mailboxes = new MailboxService(new SqliteMailboxStorage(openSqliteDb(':memory:')));
    const auth = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(),
      users,
      new SecretCipher(randomBytes(32).toString('base64')),
      undefined,
      { workspaceUrl: `${origin}/workspace`, sender: { sendVerification: async () => undefined } },
      mailboxes,
    );
    const orgStorage = new InMemoryOrgStorage();
    const notified: Array<{ userId: string; title: string }> = [];
    app.use('/workspace', workspaceRoutes({
      userStorage: users,
      orgStorage,
      workspaceWebAuth: auth,
      workspaceWebOrigin: origin,
      mailboxes,
      workspaceNotifications: { notify: async (entry: { userId: string; title: string }) => { notified.push(entry); } },
      ...copy,
    } as unknown as RouteDeps));
    const post = (path: string, body: unknown, jar = '') => fetch(`${origin}/workspace/${path}`, {
      method: 'POST',
      headers: {
        Origin: origin, 'Content-Type': 'application/json',
        ...(jar ? { Cookie: jar, 'X-CSRF-Token': cookieValue(jar, 'acc_csrf') } : {}),
      },
      body: JSON.stringify(body),
    });
    const person = (mailbox: string, extra: Record<string, unknown> = {}) => ({
      mailbox, firstName: mailbox[0]!.toUpperCase() + mailbox.slice(1), lastName: 'Test',
      password: 'correct horse battery staple', ...extra,
    });
    const get = (path: string, jar = '') => fetch(`${origin}/workspace/${path}`, { headers: jar ? { Cookie: jar } : {} });
    const send = (method: string, path: string, body: unknown, jar: string) => fetch(`${origin}/workspace/${path}`, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: jar, 'X-CSRF-Token': cookieValue(jar, 'acc_csrf') },
      body: JSON.stringify(body),
    });
    return { users, orgStorage, notified, post, get, send, person };
  };

  it('refuses a walk-up, makes the first account from the code, and lands an invited one with its request and no spare', async () => {
    const { users, orgStorage, notified, post, person } = await start({ privateCopy: true, firstAccountCode: CODE });

    // Walking up: refused in words, nothing made, no session.
    const walkUp = await post('auth/email/register', person('mallory'));
    expect(walkUp.status).toBe(403);
    expect(await walkUp.json()).toMatchObject({ code: 'registration_closed', error: expect.stringContaining('invite link') });
    expect(setCookies(walkUp)).toHaveLength(0);
    expect(await post('auth/email/register', person('mallory', { firstAccountCode: 'not-the-code-at-all-0000' })).then((r) => r.status)).toBe(403);
    expect(await users.getAllUsers()).toHaveLength(0);

    // The installer's code makes the first account, with the company's workplace.
    const first = await post('auth/email/register', person('ada', { firstAccountCode: CODE }));
    expect(first.status).toBe(201);
    const adminJar = cookieJar(setCookies(first));
    const [ada] = await users.getAllUsers();
    const adaIn = await orgStorage.listMembershipsByUser(ada!.userId);
    expect(adaIn).toHaveLength(1);
    expect(adaIn[0]!.role).toBe('admin');
    const company = adaIn[0]!.orgId;

    // The code is spent once an account exists.
    expect(await post('auth/email/register', person('eve', { firstAccountCode: CODE })).then((r) => r.status)).toBe(403);

    // A link that is nobody's is refused, in its own words.
    const dead = await post('auth/email/register', person('bea', { inviteToken: 'no-such-link' }));
    expect(dead.status).toBe(403);
    expect(await dead.json()).toMatchObject({ error: expect.stringContaining('no longer active') });

    // Through the admin's link: an account, its request filed, no workplace of its own.
    const link = await orgStorage.createInvite({ orgId: company, createdByUserId: ada!.userId });
    const bea = await post('auth/email/register', person('bea', { inviteToken: link.token }));
    expect(bea.status).toBe(201);
    const beaJar = cookieJar(setCookies(bea));
    const beaId = (await users.getAllUsers()).find((user) => user.email?.startsWith('bea@'))!.userId;
    expect(await orgStorage.listMembershipsByUser(beaId)).toHaveLength(0);
    const [request] = await orgStorage.listJoinRequestsByUser(beaId);
    expect(request).toMatchObject({ orgId: company, status: 'pending', inviteToken: link.token });
    // The admin is told, as for a request sent from the link's own page.
    expect(notified).toEqual([expect.objectContaining({ userId: ada!.userId, title: expect.stringContaining('asked to join') })]);
    // The link's page shows her the request she already sent.
    const preview = await fetch(`${new URL(first.url).origin}/workspace/api/org/invites/${link.token}`, { headers: { Cookie: beaJar } });
    expect(await preview.json()).toMatchObject({ status: 'pending', requestId: request!.requestId });

    // With no workplace yet she cannot make one; Ada, who is in one, can.
    const own = await post('api/org', { name: 'Bea’s side project' }, beaJar);
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({ error: expect.stringContaining('someone already in one') });
    expect(await orgStorage.listMembershipsByUser(beaId)).toHaveLength(0);
    expect((await post('api/org', { name: 'Research' }, adminJar)).status).toBe(200);

    // Approved, she is in the company's workplace, and it is her active one.
    expect((await orgStorage.decideJoinRequest(request!.requestId, ada!.userId, 'approve')).ok).toBe(true);
    expect((await orgStorage.getMembershipByUser(beaId))?.orgId).toBe(company);
    expect(await orgStorage.listMembershipsByUser(beaId)).toHaveLength(1);
  });

  it('refuses a link into a workplace being deleted, and takes no code without one configured', async () => {
    const { users, orgStorage, post, person } = await start({ privateCopy: true });
    expect(await post('auth/email/register', person('ada', { firstAccountCode: CODE })).then((r) => r.status)).toBe(403);
    const company = await orgStorage.createOrg({ name: 'Theirco', createdByUserId: 'user-a' });
    await orgStorage.addMember({ orgId: company.orgId, userId: 'user-a', role: 'admin' });
    const link = await orgStorage.createInvite({ orgId: company.orgId, createdByUserId: 'user-a' });
    await orgStorage.updateOrg(company.orgId, {
      deletion: { requestedAt: '2026-10-27T00:00:00.000Z', requestedByUserId: 'user-a', requestedByName: 'A', purgeAt: '2026-11-03T00:00:00.000Z' },
    });
    expect(await post('auth/email/register', person('bea', { inviteToken: link.token })).then((r) => r.status)).toBe(403);
    expect(await users.getAllUsers()).toHaveLength(0);
  });

  it('changes nothing on our own platform: open sign-up, a spare workplace, and an invite token ignored', async () => {
    const { users, orgStorage, post, person } = await start({});
    const company = await orgStorage.createOrg({ name: 'Theirco', createdByUserId: 'user-a' });
    await orgStorage.addMember({ orgId: company.orgId, userId: 'user-a', role: 'admin' });
    const link = await orgStorage.createInvite({ orgId: company.orgId, createdByUserId: 'user-a' });
    expect(await post('auth/email/register', person('samira')).then((r) => r.status)).toBe(201);
    expect(await post('auth/email/register', person('omar', { inviteToken: link.token })).then((r) => r.status)).toBe(201);
    for (const user of await users.getAllUsers()) {
      const [membership] = await orgStorage.listMembershipsByUser(user.userId);
      expect(membership?.role).toBe('admin');
      expect(await orgStorage.getOrg(membership!.orgId)).toMatchObject({ unnamed: true });
      expect(await orgStorage.listJoinRequestsByUser(user.userId)).toHaveLength(0);
    }
  });
  // Note #823 (the owner, 2026-10-28): only the private copy is offered, so
  // our own platform takes no new account but through a live invite link
  // into a workplace whose invites are open (a marked one, note #805). Such
  // an account gets no spare workplace and lands with its request, as in a
  // copy; existing accounts sign in as before; nothing else makes a
  // workplace for an account in none.
  it('closes our own sign-up with SIGNUP_CLOSED: walk-ups and the old authenticator door refused, a marked workplace\'s link still works (note #823)', async () => {
    const { users, orgStorage, notified, post, person } = await start({ invitesClosed: true, signupClosed: true });

    // Walking up: refused in words that point at the private copy and hello@.
    const walkUp = await post('auth/email/register', person('mallory'));
    expect(walkUp.status).toBe(403);
    const said = await walkUp.json() as { code: string; error: string };
    expect(said.code).toBe('registration_closed');
    expect(said.error).toContain('agenticcloudcomputer.com/own-cloud');
    expect(said.error).toContain('adam@agenticcloudcomputer.com');
    expect(said.error).not.toMatch(/unlimited|twenty|\b20\b/i);
    expect(setCookies(walkUp)).toHaveLength(0);
    // The installer's code is a copy's alone.
    expect(await post('auth/email/register', person('mallory', { firstAccountCode: CODE })).then((r) => r.status)).toBe(403);
    // The legacy authenticator door only ever made new accounts: shut too.
    const enroll = await post('auth/enroll/start', { username: 'mallory_totp' });
    expect(enroll.status).toBe(403);
    expect(await enroll.json()).toMatchObject({ code: 'registration_closed' });
    expect(await users.getAllUsers()).toHaveLength(0);

    // A workplace that is not marked keeps its invites shut, so its link makes nothing.
    const plain = await orgStorage.createOrg({ name: 'Plainco', createdByUserId: 'user-p' });
    await orgStorage.addMember({ orgId: plain.orgId, userId: 'user-p', role: 'admin' });
    const plainLink = await orgStorage.createInvite({ orgId: plain.orgId, createdByUserId: 'user-p' });
    expect(await post('auth/email/register', person('omar', { inviteToken: plainLink.token })).then((r) => r.status)).toBe(403);
    expect(await users.getAllUsers()).toHaveLength(0);

    // A marked workplace's link: an account, its request filed, no spare workplace.
    const marked = await orgStorage.createOrg({ name: 'Markedco', createdByUserId: 'user-m' });
    await orgStorage.updateOrg(marked.orgId, { invitesAllowed: true });
    await orgStorage.addMember({ orgId: marked.orgId, userId: 'user-m', role: 'admin' });
    const link = await orgStorage.createInvite({ orgId: marked.orgId, createdByUserId: 'user-m' });
    const bea = await post('auth/email/register', person('bea', { inviteToken: link.token }));
    expect(bea.status).toBe(201);
    const beaJar = cookieJar(setCookies(bea));
    const beaId = (await users.getAllUsers()).find((user) => user.email?.startsWith('bea@'))!.userId;
    expect(await orgStorage.listMembershipsByUser(beaId)).toHaveLength(0);
    const [request] = await orgStorage.listJoinRequestsByUser(beaId);
    expect(request).toMatchObject({ orgId: marked.orgId, status: 'pending', inviteToken: link.token });
    expect(notified).toEqual([expect.objectContaining({ userId: 'user-m', title: expect.stringContaining('asked to join') })]);

    // In no workplace yet, she cannot found one.
    const own = await post('api/org', { name: 'Bea’s side project' }, beaJar);
    expect(own.status).toBe(403);
    expect(await orgStorage.listMembershipsByUser(beaId)).toHaveLength(0);

    // An account that already exists signs in exactly as before.
    const address = (await users.getAllUsers()).find((user) => user.userId === beaId)!.email!;
    const login = await post('auth/email/login', { email: address, password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ authenticated: true });
  });

  it('shows a copy\'s health and diagnostics to its admins only, and has neither on our platform (note #813)', async () => {
    const health = {
      report: async () => ({ release: '2026.10.27.1', commit: 'abc', checkedAt: '2026-10-27T18:00:00.000Z', parts: [{ key: 'workspace', name: 'Workspace', ok: true, line: 'Up 1 h' }] }),
      diagnostics: async () => ({ kind: 'acc-copy-diagnostics', generatedAt: '2026-10-27T18:00:00.000Z' }),
    };
    const { users, orgStorage, post, get, person } = await start({ privateCopy: true, firstAccountCode: CODE, copyHealth: health } as unknown as Partial<RouteDeps>);
    const adminJar = cookieJar(setCookies(await post('auth/email/register', person('ada', { firstAccountCode: CODE }))));
    const answer = await get('api/copy/health', adminJar);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ release: '2026.10.27.1', parts: [{ key: 'workspace' }] });
    const file = await get('api/copy/diagnostics', adminJar);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="copy-diagnostics-2026-10-27.json"');
    expect(await get('api/copy/health').then((r) => r.status)).toBe(401);

    // A member who is not an admin is told, in words.
    const [ada] = await users.getAllUsers();
    const company = (await orgStorage.listMembershipsByUser(ada!.userId))[0]!.orgId;
    const link = await orgStorage.createInvite({ orgId: company, createdByUserId: ada!.userId });
    const beaJar = cookieJar(setCookies(await post('auth/email/register', person('bea', { inviteToken: link.token }))));
    const beaId = (await users.getAllUsers()).find((user) => user.email?.startsWith('bea@'))!.userId;
    const [request] = await orgStorage.listJoinRequestsByUser(beaId);
    await orgStorage.decideJoinRequest(request!.requestId, ada!.userId, 'approve');
    const refused = await get('api/copy/health', beaJar);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('Only an admin') });
    expect(await get('api/copy/diagnostics', beaJar).then((r) => r.status)).toBe(403);

    // Our own platform has no such page.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const ours = await start({});
    expect(await ours.get('api/copy/health').then((r) => r.status)).toBe(404);
  });
  it('signs a removed or declined person out at once, and lets them back only through an invite (note #814)', async () => {
    const { users, orgStorage, post, get, send, person } = await start({ privateCopy: true, firstAccountCode: CODE });
    const adminJar = cookieJar(setCookies(await post('auth/email/register', person('ada', { firstAccountCode: CODE }))));
    const [ada] = await users.getAllUsers();
    const company = (await orgStorage.listMembershipsByUser(ada!.userId))[0]!.orgId;
    const link = await orgStorage.createInvite({ orgId: company, createdByUserId: ada!.userId });
    const beaJar = cookieJar(setCookies(await post('auth/email/register', person('bea', { inviteToken: link.token }))));
    const bea = (await users.getAllUsers()).find((user) => user.email?.startsWith('bea@'))!;
    // Waiting on her request she is in: her page shows it.
    expect((await get('api/state', beaJar)).status).toBe(200);
    const [request] = await orgStorage.listJoinRequestsByUser(bea.userId);
    await orgStorage.decideJoinRequest(request!.requestId, ada!.userId, 'approve');
    expect((await get('api/state', beaJar)).status).toBe(200);

    // Removed: the sign-in she holds ended with the removal itself.
    expect((await send('DELETE', `api/org/members/${bea.userId}`, {}, adminJar)).status).toBe(200);
    const gone = await get('api/state', beaJar);
    expect(gone.status).toBe(401);
    expect(await gone.json()).toEqual({ error: 'Sign in to continue.' });

    // Signing in again is refused in words, unless through an invite link.
    const login = (extra: Record<string, unknown> = {}) => post('auth/email/login', { email: bea.email, password: 'correct horse battery staple', ...extra });
    const refused = await login();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'outside_copy', error: expect.stringContaining('open an invite link') });
    const back = await login({ inviteToken: link.token });
    expect(back.status).toBe(200);
    const backJar = cookieJar(setCookies(back));
    const again = (await orgStorage.listJoinRequestsByUser(bea.userId)).find((one) => one.status === 'pending');
    expect(again).toBeTruthy();
    expect((await get('api/state', backJar)).status).toBe(200);

    // Declined, with nowhere else to be: signed out at once too.
    expect((await send('POST', `api/org/join-requests/${again!.requestId}/decision`, { decision: 'reject' }, adminJar)).status).toBe(200);
    expect((await get('api/state', backJar)).status).toBe(401);
    // The admin is untouched throughout.
    expect((await get('api/state', adminJar)).status).toBe(200);
  });

  it('ends a sign-in still held by someone out of every workplace, whatever removed them (note #814)', async () => {
    const { users, orgStorage, post, get, person } = await start({ privateCopy: true, firstAccountCode: CODE });
    await post('auth/email/register', person('ada', { firstAccountCode: CODE }));
    const [ada] = await users.getAllUsers();
    const company = (await orgStorage.listMembershipsByUser(ada!.userId))[0]!.orgId;
    const link = await orgStorage.createInvite({ orgId: company, createdByUserId: ada!.userId });
    const beaJar = cookieJar(setCookies(await post('auth/email/register', person('bea', { inviteToken: link.token }))));
    const bea = (await users.getAllUsers()).find((user) => user.email?.startsWith('bea@'))!;
    const [request] = await orgStorage.listJoinRequestsByUser(bea.userId);
    await orgStorage.decideJoinRequest(request!.requestId, ada!.userId, 'approve');
    // Out by a path that signs nobody out itself (here, the storage).
    await orgStorage.removeMember(company, bea.userId);
    const gone = await get('api/mail/messages', beaJar);
    expect(gone.status).toBe(401);
    expect(await gone.json()).toMatchObject({ code: 'outside_copy', error: expect.stringContaining('signed out') });
    expect((await get('api/state', beaJar)).status).toBe(401);
  });

  it('turns the next person away at the licence\'s limit, and lets an admin paste a renewal (note #814)', async () => {
    const pasted: string[] = [];
    const licence = {
      personRefusal: async () => 'This copy\'s licence covers 1 people, and all 1 places are taken. An admin can ask for a licence with more.',
      paste: async (text: string) => {
        pasted.push(text);
        return text === 'good' ? { ok: true, status: { state: 'valid', line: 'Licensed until 26 October 2027 · 1 of 5 people' } } : { ok: false, why: 'That is not a licence.' };
      },
      status: async () => ({ state: 'ending', line: 'The licence ends in 10 days.' }),
    };
    const { users, orgStorage, post, get, send, person } = await start({ privateCopy: true, firstAccountCode: CODE, copyLicence: licence } as unknown as Partial<RouteDeps>);
    // The first account is never refused: its admin is who pastes the licence.
    const adminJar = cookieJar(setCookies(await post('auth/email/register', person('ada', { firstAccountCode: CODE }))));
    const [ada] = await users.getAllUsers();
    const company = (await orgStorage.listMembershipsByUser(ada!.userId))[0]!.orgId;
    const link = await orgStorage.createInvite({ orgId: company, createdByUserId: ada!.userId });
    const full = await post('auth/email/register', person('bea', { inviteToken: link.token }));
    expect(full.status).toBe(403);
    expect(await full.json()).toMatchObject({ code: 'licence', error: expect.stringContaining('all 1 places are taken') });
    expect(await users.getAllUsers()).toHaveLength(1);

    // The admin sees the licence on their state, and pastes a renewal.
    expect(await (await get('api/state', adminJar)).json()).toMatchObject({ copyLicence: { state: 'ending', line: 'The licence ends in 10 days.' } });
    const bad = await send('POST', 'api/copy/licence', { licence: 'nonsense' }, adminJar);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'That is not a licence.' });
    const good = await send('POST', 'api/copy/licence', { licence: 'good' }, adminJar);
    expect(await good.json()).toEqual({ state: 'valid', line: 'Licensed until 26 October 2027 · 1 of 5 people' });
    expect(pasted).toEqual(['nonsense', 'good']);
  });
});
