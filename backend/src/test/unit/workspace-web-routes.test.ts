import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../../services/workspace-web-auth.js';
import { SecretCipher } from '../../services/secret-cipher.js';
import { generateTotpCode } from '../../utils/totp.js';
import type { WorkspaceVerificationEmail } from '../../services/workspace-verification-email.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';

type JsonRecord = Record<string, unknown>;

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const combined = response.headers.get('set-cookie');
  return combined ? combined.split(/,(?=[^;,]+=)/) : [];
}

function cookieJar(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

function cookieValue(jar: string, name: string): string {
  const item = jar.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

describe('regular Workspace web authentication routes', () => {

  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('creates the account from an address here, signs it in at once, and refuses an outside email', async () => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const users = new InMemoryUserStorage();
    const sent: WorkspaceVerificationEmail[] = [];
    const mailboxes = new MailboxService(new SqliteMailboxStorage(openSqliteDb(':memory:')));
    const auth = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(),
      users,
      new SecretCipher(randomBytes(32).toString('base64')),
      undefined,
      {
        workspaceUrl: `${origin}/workspace`,
        sender: { sendVerification: async (message) => { sent.push(message); } },
      },
      mailboxes,
    );
    const orgStorage = new InMemoryOrgStorage();
    app.use('/workspace', workspaceRoutes({
      userStorage: users,
      orgStorage,
      workspaceWebAuth: auth,
      workspaceWebOrigin: origin,
      mailboxes,
    } as RouteDeps));

    const post = (path: string, body: unknown) => fetch(`${origin}/workspace/${path}`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Creating an account with an address somebody hosts elsewhere is closed.
    const outside = await post('auth/email/register', { email: 'owner@example.com', password: 'correct horse battery staple' });
    expect(outside.status).toBe(410);
    expect(await outside.json()).toMatchObject({ code: 'outside_email_closed' });
    expect(setCookies(outside)).toHaveLength(0);
    expect(await users.getAllUsers()).toHaveLength(0);

    const firstVisit = { from: 't.co', page: '/claude-code-in-the-cloud', at: '2026-10-09T08:00:00.000Z' };
    const register = await post('auth/email/register', { mailbox: 'Samira', firstName: 'Samira', lastName: 'Rahimi', password: 'correct horse battery staple', firstVisit });
    expect(register.status).toBe(201);
    expect(await register.json()).toEqual({ authenticated: true, address: 'samira@agenticcloudcomputer.com' });
    // No confirmation is sent, and the session is open on the answer itself.
    expect(sent).toHaveLength(0);
    const registerCookies = setCookies(register);
    expect(registerCookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^acc_session=.*HttpOnly.*SameSite=Lax/i),
      expect.stringMatching(/^acc_csrf=.*SameSite=Strict/i),
    ]));
    const jar = cookieJar(registerCookies);
    expect(await (await fetch(`${origin}/workspace/auth/session`, { headers: { Cookie: jar } })).json())
      .toMatchObject({ authenticated: true, username: 'samira@agenticcloudcomputer.com' });
    // The workplace is made with the account (note #144): unnamed, owed its
    // naming, its admin the new person — so the subscription has somewhere
    // to land before it is named. Stamped `firstRun` (note #726): its
    // founder's Chief of Staff opens on the greeting, and the plan is asked
    // for inside that chat rather than behind a gate.
    const [member] = await users.getAllUsers();
    const membership = await orgStorage.getMembershipByUser(member!.userId);
    expect(membership?.role).toBe('admin');
    expect(await orgStorage.getOrg(membership!.orgId)).toMatchObject({ name: 'Samira’s workplace', unnamed: true, foundingPending: true, firstRun: true });
    // Where her browser first came from is kept with the account.
    expect(member!.firstVisit).toEqual(firstVisit);

    // A malformed record is dropped, never a reason to refuse the account.
    const odd = await post('auth/email/register', { mailbox: 'omar', firstName: 'Omar', lastName: 'Khan', password: 'correct horse battery staple', firstVisit: { from: '<b>x</b>', page: '/', at: 'now' } });
    expect(odd.status).toBe(201);
    const omar = (await users.getAllUsers()).find((user) => user.email === 'omar@agenticcloudcomputer.com');
    expect(omar).toBeDefined();
    expect(omar!.firstVisit).toBeUndefined();

    // A second person cannot have the same name.
    const taken = await post('auth/email/register', { mailbox: 'samira', firstName: 'Samira', lastName: 'Rahimi', password: 'another long password' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'mailbox_taken' });

    const wrong = await post('auth/email/login', { email: 'samira', password: 'wrong-password' });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'Invalid name or password.' });

    // People will type the name alone, and that is their address.
    const login = await post('auth/email/login', { email: 'Samira', password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    const loginJar = cookieJar(setCookies(login));
    expect(await (await fetch(`${origin}/workspace/auth/session`, { headers: { Cookie: loginJar } })).json())
      .toMatchObject({ authenticated: true, username: 'samira@agenticcloudcomputer.com' });
    expect(await (await fetch(`${origin}/workspace/auth/sessions`, { headers: { Cookie: loginJar } })).json())
      .toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ authMethod: 'password' })]) });

    // Where a TAB stands (note #628): the session read names the workplace
    // the tab remembers and is answered with it while the membership holds;
    // a tab naming none, or one this person has no membership in, starts at
    // the account's active marker. Two tabs on two workplaces each keep theirs.
    const own = membership!.orgId;
    const other = await orgStorage.createOrg({ name: 'Side Hustle', createdByUserId: 'someone-else' });
    await orgStorage.addMember({ orgId: other.orgId, userId: member!.userId, role: 'member' });
    const standingIn = async (query: string) => (
      (await (await fetch(`${origin}/workspace/auth/session${query}`, { headers: { Cookie: loginJar } })).json()) as { activeOrgId?: string }
    ).activeOrgId;
    expect(await standingIn('')).toBe(own);
    expect(await standingIn(`?org=${other.orgId}`)).toBe(other.orgId);
    expect(await standingIn(`?org=${own}`)).toBe(own);
    expect(await standingIn('?org=not-a-workplace-of-hers')).toBe(own);
    // The marker moving under one tab does not move a tab that names its own.
    await orgStorage.setActiveOrg(member!.userId, other.orgId);
    expect(await standingIn('')).toBe(other.orgId);
    expect(await standingIn(`?org=${own}`)).toBe(own);
  });

  it('enrolls, sets protected cookies, enforces CSRF, and revokes logout immediately', async () => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const compatibleOrigin = 'https://agenticcloudcomputer.com';

    const users = new InMemoryUserStorage();
    const auth = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(),
      users,
      new SecretCipher(randomBytes(32).toString('base64')),
    );
    app.use('/workspace', workspaceRoutes({
      userStorage: users,
      workspaceWebAuth: auth,
      workspaceWebOrigin: origin,
      workspaceWebCompatibleOrigins: [compatibleOrigin],
    } as unknown as RouteDeps));

    const start = await fetch(`${origin}/workspace/auth/enroll/start`, {
      method: 'POST', headers: { Origin: compatibleOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'browser_owner' }),
    });
    expect(start.status).toBe(201);
    const enrollment = await start.json() as JsonRecord;
    expect(String(enrollment.qrDataUrl)).toMatch(/^data:image\/png;base64,/);
    expect(enrollment.otp).toEqual({ digits: 6, periodSeconds: 30, kind: 'totp' });

    const finish = await fetch(`${origin}/workspace/auth/enroll/finish`, {
      method: 'POST', headers: { Origin: compatibleOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentToken: enrollment.enrollmentToken,
        code: generateTotpCode(String(enrollment.secret)),
      }),
    });
    expect(finish.status).toBe(201);
    const cookies = setCookies(finish);
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^acc_session=.*HttpOnly.*SameSite=Lax/i),
      expect.stringMatching(/^acc_csrf=.*SameSite=Strict/i),
    ]));
    expect(cookies.find((cookie) => cookie.startsWith('acc_csrf='))).not.toMatch(/HttpOnly/i);
    const jar = cookieJar(cookies);
    const csrf = cookieValue(jar, 'acc_csrf');
    expect(csrf).not.toBe('');

    const session = await fetch(`${origin}/workspace/auth/session`, { headers: { Cookie: jar } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, username: 'browser_owner' });

    const missingCsrf = await fetch(`${origin}/workspace/auth/logout-others`, {
      method: 'POST', headers: { Cookie: jar },
    });
    expect(missingCsrf.status).toBe(403);

    const retiredTelegramOnly = await fetch(`${origin}/workspace/auth/sessions`, {
      headers: { Authorization: 'tma retired-launch-data' },
    });
    expect(retiredTelegramOnly.status).toBe(401);

    const browserSessionIgnoresUnrelatedAuthorization = await fetch(`${origin}/workspace/auth/sessions`, {
      headers: { Cookie: jar, Authorization: 'tma retired-launch-data' },
    });
    expect(browserSessionIgnoresUnrelatedAuthorization.status).toBe(200);

    const secureWrite = await fetch(`${origin}/workspace/auth/logout-others`, {
      method: 'POST', headers: { Cookie: jar, Origin: compatibleOrigin, 'X-CSRF-Token': csrf },
    });
    expect(secureWrite.status).toBe(200);

    const logout = await fetch(`${origin}/workspace/auth/logout`, {
      method: 'POST', headers: { Cookie: jar, Origin: origin, 'X-CSRF-Token': csrf },
    });
    expect(logout.status).toBe(200);
    expect(setCookies(logout).some((cookie) => /^acc_session=/.test(cookie) && /Expires=Thu, 01 Jan 1970/i.test(cookie)))
      .toBe(true);
    // The browser still holds the jar the revoked session came in, and the
    // CSRF half of it is readable by JavaScript — the public front page reads
    // it as "signed in" and sends its owner here. So a session read that finds
    // nothing behind the cookies takes BOTH of them back, and a caller holding
    // no cookies at all is told nothing to forget.
    const stale = await fetch(`${origin}/workspace/auth/session`, { headers: { Cookie: jar } });
    expect(stale.status).toBe(401);
    const cleared = setCookies(stale);
    for (const name of ['acc_session', 'acc_csrf']) {
      expect(cleared.some((cookie) => cookie.startsWith(`${name}=`) && /Expires=Thu, 01 Jan 1970/i.test(cookie)))
        .toBe(true);
    }
    const anonymous = await fetch(`${origin}/workspace/auth/session`);
    expect(anonymous.status).toBe(401);
    expect(setCookies(anonymous)).toEqual([]);
    // The CSRF half on its own is the jar that would bounce forever, since it
    // is the half the front page reads. It is enough on its own to clear.
    const csrfOnly = await fetch(`${origin}/workspace/auth/session`, {
      headers: { Cookie: `acc_csrf=${encodeURIComponent(csrf)}` },
    });
    expect(csrfOnly.status).toBe(401);
    expect(setCookies(csrfOnly).some((cookie) => cookie.startsWith('acc_csrf=') && /Expires=Thu, 01 Jan 1970/i.test(cookie)))
      .toBe(true);
  });

  it('answers the address field over real HTTP, where a same-origin GET carries no Origin header', async () => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const users = new InMemoryUserStorage();
    const auth = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(),
      users,
      new SecretCipher(randomBytes(32).toString('base64')),
    );
    const mailboxes = new MailboxService(new SqliteMailboxStorage(openSqliteDb(':memory:')));
    await mailboxes.claim('user_taken', 'adam', 'active');
    app.use('/workspace', workspaceRoutes({
      userStorage: users,
      workspaceWebAuth: auth,
      workspaceWebOrigin: origin,
      mailboxes,
    } as RouteDeps));

    // No Origin header, exactly as a browser sends it from the signup page.
    const free = await fetch(`${origin}/workspace/auth/email/address?local=Adam.B`);
    expect(free.status).toBe(200);
    expect(await free.json()).toEqual({ local: 'adam.b', address: 'adam.b@agenticcloudcomputer.com', available: true });

    const taken = await fetch(`${origin}/workspace/auth/email/address?local=adam`);
    expect(await taken.json()).toMatchObject({ available: false });

    const reserved = await fetch(`${origin}/workspace/auth/email/address?local=postmaster`);
    expect(await reserved.json()).toMatchObject({ available: false, problem: 'reserved' });
  });
});
