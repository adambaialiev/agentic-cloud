import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretCipher } from '../../services/secret-cipher.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthError,
  WorkspaceWebAuthService,
} from '../../services/workspace-web-auth.js';
import { generateTotpCode, verifyTotpCode } from '../../utils/totp.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteWorkspaceWebAuthStorage } from '../../services/sqlite/sqlite-workspace-web-auth.js';
import {
  parseCookieHeader,
  requestHasValidCsrf,
  requestHasWorkspaceOrigin,
  workspaceCookieNames,
} from '../../services/workspace-web-session.js';
import type { Request } from 'express';
import type {
  WorkspacePasswordResetEmail,
  WorkspaceRecoveryConfirmationEmail,
  WorkspaceVerificationEmail,
} from '../../services/workspace-verification-email.js';
import { hashWorkspacePassword } from '../../utils/workspace-password.js';

const KEY = randomBytes(32).toString('base64');
const START = Date.parse('2026-08-30T12:00:00.000Z');

function verificationDelivery() {
  const sent: WorkspaceVerificationEmail[] = [];
  const resets: WorkspacePasswordResetEmail[] = [];
  const recoveries: WorkspaceRecoveryConfirmationEmail[] = [];
  const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
  return {
    sent,
    resets,
    recoveries,
    config: {
      workspaceUrl: 'https://app.example.com/workspace',
      sender: {
        sendVerification: async (message: WorkspaceVerificationEmail) => { sent.push(message); },
        sendPasswordReset: async (message: WorkspacePasswordResetEmail) => { resets.push(message); },
        sendRecoveryConfirmation: async (message: WorkspaceRecoveryConfirmationEmail) => { recoveries.push(message); },
      },
    },
    token: () => tokenOf(sent.at(-1)!.verificationUrl),
    resetToken: () => tokenOf(resets.at(-1)!.resetUrl),
    recoveryToken: () => tokenOf(recoveries.at(-1)!.confirmUrl),
  };
}

function request(headers: Record<string, string>): Request {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => normalized[name.toLowerCase()] } as Request;
}

describe('TOTP primitives', () => {
  it('matches the six least-significant digits of the RFC 6238 SHA-1 vector', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateTotpCode(secret, 59_000)).toBe('287082');
    expect(generateTotpCode(secret, 1_111_111_109_000)).toBe('081804');
  });

  it('accepts one clock step of drift and refuses an accepted/replayed step', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const previous = generateTotpCode(secret, START - 30_000);
    const accepted = verifyTotpCode(secret, previous, { nowMs: START });
    expect(accepted.ok).toBe(true);
    expect(verifyTotpCode(secret, previous, {
      nowMs: START,
      lastAcceptedStep: accepted.matchedStep,
    }).ok).toBe(false);
  });
});

/** The one way an account is created now (note #509): a name on our own mail
 *  domain. Nothing outside is involved, so nothing is confirmed. */
function mailboxes() {
  return new MailboxService(new SqliteMailboxStorage(openSqliteDb(':memory:')));
}

/** An account from BEFORE email/password: username + authenticator. It is the
 *  only kind that can still attach an outside email, from Settings. */
async function legacyAccount(service: WorkspaceWebAuthService, username: string, nowMs: number) {
  const enrollment = await service.startEnrollment(username);
  const finished = await service.finishEnrollment({
    enrollmentToken: enrollment.enrollmentToken,
    code: generateTotpCode(enrollment.secret, nowMs),
  });
  return { ...finished, secret: enrollment.secret };
}

describe('WorkspaceWebAuthService', () => {
  it('creates one account from an address here, and returns to it with the password', async () => {
    const users = new InMemoryUserStorage();
    const storage = new InMemoryWorkspaceWebAuthStorage();
    const delivery = verificationDelivery();
    const mail = mailboxes();
    const service = new WorkspaceWebAuthService(storage, users, new SecretCipher(KEY), () => new Date(START), delivery.config, mail);
    const created = await service.registerMailbox({ mailbox: ' Samira ', firstName: 'Samira', lastName: 'Rahimi', password: 'correct horse battery staple' });
    expect(created.address).toBe('samira@agenticcloudcomputer.com');
    // The session is open at once: there is no third party to prove anything
    // to, so nothing is emailed and nobody waits.
    expect(created.session.session).toMatchObject({ userId: created.userId, authMethod: 'password' });
    expect(delivery.sent).toHaveLength(0);
    expect((await users.getProfile(created.userId))?.authType).toBe('email');
    expect(await mail.forUser(created.userId)).toEqual({ address: 'samira@agenticcloudcomputer.com' });
    // Their name is asked with the address (note #144): it is the person's
    // display name from the first screen on, and the profile is not left
    // "incomplete" over a name they have already given.
    const profile = await users.getProfile(created.userId);
    expect(profile?.displayName).toBe('Samira Rahimi');
    expect(profile?.person).toMatchObject({ firstName: 'Samira', lastName: 'Rahimi' });
    // ...and an account is not made without one.
    await expect(service.registerMailbox({ mailbox: 'nameless', firstName: '  ', lastName: 'X', password: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_name' });
    expect(await mail.forUser('nobody')).toBeNull();

    // Their own name is what they will type; the full address works too.
    await expect(service.loginEmail({ email: 'Samira', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ session: { userId: created.userId, authMethod: 'password' } });
    await expect(service.loginEmail({ email: 'SAMIRA@agenticcloudcomputer.com', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ session: { userId: created.userId, authMethod: 'password' } });
    await expect(service.loginEmail({ email: 'samira', password: 'wrong-password' }))
      .rejects.toMatchObject({ code: 'invalid_credentials', message: 'Invalid name or password.' });
    await expect(service.changeEmailPassword(created.userId, 'wrong-password', 'a new correct password'))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    await service.changeEmailPassword(created.userId, 'correct horse battery staple', 'a new correct password');
    await expect(service.loginEmail({ email: 'samira', password: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(service.loginEmail({ email: 'samira', password: 'a new correct password' }))
      .resolves.toMatchObject({ session: { userId: created.userId } });
  });

  it('refuses to create an account from an outside email, and takes no name for a refused one', async () => {
    const users = new InMemoryUserStorage();
    const mail = mailboxes();
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(KEY), () => new Date(START),
      verificationDelivery().config, mail,
    );
    await expect(service.registerEmail({ email: 'owner@example.com', password: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'outside_email_closed' });
    expect(await users.getAllUsers()).toHaveLength(0);

    await mail.claim('someone_else', 'samira');
    await expect(service.registerMailbox({ mailbox: 'samira', firstName: 'Samira', lastName: 'Rahimi', password: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'mailbox_taken' });
    // The name that was refused stayed with its owner, and no half-made
    // account was left behind.
    expect(await users.getAllUsers()).toHaveLength(0);
    expect((await mail.forUser('someone_else'))?.address).toBe('samira@agenticcloudcomputer.com');
  });

  it('validates the name and the password without creating a profile', async () => {
    const users = new InMemoryUserStorage();
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(KEY), () => new Date(START),
      verificationDelivery().config, mailboxes(),
    );
    await expect(service.registerMailbox({ mailbox: 'Not A Name', firstName: 'Samira', lastName: 'Rahimi', password: 'long-enough-password' }))
      .rejects.toMatchObject({ code: 'invalid_mailbox' });
    await expect(service.registerMailbox({ mailbox: 'postmaster', firstName: 'Samira', lastName: 'Rahimi', password: 'long-enough-password' }))
      .rejects.toMatchObject({ code: 'invalid_mailbox' });
    await expect(service.registerMailbox({ mailbox: 'samira', firstName: 'Samira', lastName: 'Rahimi', password: 'short' }))
      .rejects.toMatchObject({ code: 'invalid_password' });
    expect(await users.getAllUsers()).toHaveLength(0);
  });

  it('creates nobody on a backend with no mail service, because the address is the account', async () => {
    const users = new InMemoryUserStorage();
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(KEY), () => new Date(START),
    );
    await expect(service.registerMailbox({
      mailbox: 'samira', password: 'correct horse battery staple',
    })).rejects.toMatchObject({ code: 'verification_unavailable' });
    expect(await users.getAllUsers()).toHaveLength(0);
  });

  it('uses TOTP only after a valid password when the owner opted into the second factor', async () => {
    let nowMs = START;
    const delivery = verificationDelivery();
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), new InMemoryUserStorage(), new SecretCipher(KEY),
      () => new Date(nowMs), delivery.config, mailboxes(),
    );
    const created = await service.registerMailbox({ mailbox: 'secure', firstName: 'Samira', lastName: 'Rahimi', password: 'correct horse battery staple' });
    const setup = await service.startTotpSecondFactor(created.userId);
    const enabled = await service.finishTotpSecondFactor({
      userId: created.userId,
      enrollmentToken: setup.enrollmentToken,
      code: generateTotpCode(setup.secret, nowMs),
    });
    expect(enabled.recoveryCodes).toHaveLength(10);

    nowMs += 30_000;
    const pending = await service.loginEmail({ email: 'secure', password: 'correct horse battery staple' });
    expect(pending).toMatchObject({ secondFactorRequired: true });
    if (!('secondFactorRequired' in pending)) throw new Error('second factor should be required');
    await expect(service.finishSecondFactor({ secondFactorToken: pending.secondFactorToken, code: '000000' }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    const signedIn = await service.finishSecondFactor({
      secondFactorToken: pending.secondFactorToken,
      code: generateTotpCode(setup.secret, nowMs),
    });
    expect(signedIn.session.authMethod).toBe('totp');

    nowMs += 30_000;
    await service.disableTotpSecondFactor(created.userId, generateTotpCode(setup.secret, nowMs));
    const emailOnly = await service.loginEmail({ email: 'secure', password: 'correct horse battery staple' });
    expect(emailOnly).not.toHaveProperty('secondFactorRequired');
  });

  it('expires confirmation links, invalidates old links on resend, and refuses replay', async () => {
    let nowMs = START;
    const delivery = verificationDelivery();
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), new InMemoryUserStorage(), new SecretCipher(KEY),
      () => new Date(nowMs), delivery.config, mailboxes(),
    );
    // Confirmation links are now only for an OUTSIDE address, attached from
    // Settings by an account that predates email sign-in.
    const legacy = await legacyAccount(service, 'legacy_owner', nowMs);
    await service.registerEmail({
      email: 'owner@example.com', password: 'correct horse battery staple', authenticatedUserId: legacy.userId,
    });
    const first = delivery.token();
    await service.requestEmailVerification('owner@example.com');
    expect(delivery.sent).toHaveLength(1);

    nowMs += 60_000;
    await service.requestEmailVerification('owner@example.com');
    const second = delivery.token();
    expect(second).not.toBe(first);
    await expect(service.verifyEmail(first)).rejects.toMatchObject({ code: 'verification_invalid' });

    nowMs += 30 * 60_000;
    await expect(service.verifyEmail(second)).rejects.toMatchObject({ code: 'verification_expired' });
    nowMs += 60_000;
    await service.requestEmailVerification('owner@example.com');
    const third = delivery.token();
    await service.verifyEmail(third);
    await expect(service.verifyEmail(third)).rejects.toMatchObject({ code: 'verification_invalid' });
    // The migrated account's authenticator became its second factor, so the
    // confirmed password lands on that check rather than straight on a session.
    await expect(service.loginEmail({ email: 'owner@example.com', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ secondFactorRequired: true });
  });

  it('limits confirmation delivery to one per minute and five per one-hour window', async () => {
    let nowMs = START;
    const delivery = verificationDelivery();
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), new InMemoryUserStorage(), new SecretCipher(KEY),
      () => new Date(nowMs), delivery.config, mailboxes(),
    );
    const legacy = await legacyAccount(service, 'legacy_owner', nowMs);
    await service.registerEmail({
      email: 'limited@example.com', password: 'correct horse battery staple', authenticatedUserId: legacy.userId,
    });
    for (let minute = 1; minute <= 5; minute += 1) {
      nowMs += 60_000;
      await service.requestEmailVerification('limited@example.com');
    }
    expect(delivery.sent).toHaveLength(5);
    nowMs = START + 60 * 60_000;
    await service.requestEmailVerification('limited@example.com');
    expect(delivery.sent).toHaveLength(6);
  });

  it('keeps attaching an outside email and resending it independent of account existence', async () => {
    let nowMs = START;
    const delivery = verificationDelivery();
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), new InMemoryUserStorage(), new SecretCipher(KEY),
      () => new Date(nowMs), delivery.config, mailboxes(),
    );
    const legacy = await legacyAccount(service, 'legacy_owner', nowMs);
    const first = await service.registerEmail({
      email: 'owner@example.com', password: 'correct horse battery staple', authenticatedUserId: legacy.userId,
    });
    expect(first).toEqual({
      email: 'owner@example.com', userId: legacy.userId, newAccount: false, linkedExistingUser: true, verificationRequired: true,
    });
    // A second account asking for an address somebody else already attached
    // is told to check that address, exactly as an unused one is.
    const other = await legacyAccount(service, 'other_owner', nowMs);
    const duplicate = await service.registerEmail({
      email: 'owner@example.com', password: 'wrong but long password', authenticatedUserId: other.userId,
    });
    expect(duplicate).toEqual({
      email: 'owner@example.com', userId: other.userId, newAccount: false, linkedExistingUser: true, verificationRequired: true,
    });
    expect(delivery.sent).toHaveLength(1);
    await expect(service.requestEmailVerification('missing@example.com')).resolves.toBeUndefined();
    await expect(service.requestEmailVerification('not-an-email')).resolves.toBeUndefined();
    await expect(service.verifyEmail(delivery.token())).resolves.toBeNull();
    nowMs += 60_000;
    await expect(service.requestEmailVerification('owner@example.com')).resolves.toBeUndefined();
  });

  it('grandfathers an existing password identity and lets it verify without losing access', async () => {
    const users = new InMemoryUserStorage();
    await users.createProfile('existing', { email: 'existing@example.com', authType: 'email' });
    const storage = new InMemoryWorkspaceWebAuthStorage();
    await storage.createEmailIdentity({
      userId: 'existing', email: 'existing@example.com', emailCanonical: 'existing@example.com',
      passwordHash: (await import('../../utils/workspace-password.js')).hashWorkspacePassword('correct horse battery staple'),
      createdAt: new Date(START - 86_400_000).toISOString(), updatedAt: new Date(START - 86_400_000).toISOString(),
    });
    const delivery = verificationDelivery();
    const service = new WorkspaceWebAuthService(storage, users, new SecretCipher(KEY), () => new Date(START), delivery.config);
    expect((await service.identityForUser('existing'))?.verificationStatus).toBeUndefined();
    await expect(service.loginEmail({ email: 'existing@example.com', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ session: { userId: 'existing' } });
    await service.requestEmailVerification('existing@example.com');
    await expect(service.verifyEmail(delivery.token())).resolves.toMatchObject({
      session: { userId: 'existing', authMethod: 'email_verification' },
    });
    expect((await service.identityForUser('existing'))?.verificationStatus).toBe('verified');
  });

  it('registers a new profile, issues a durable session, and closes TOTP replay', async () => {
    let nowMs = START;
    const users = new InMemoryUserStorage();
    const storage = new InMemoryWorkspaceWebAuthStorage();
    const service = new WorkspaceWebAuthService(storage, users, new SecretCipher(KEY), () => new Date(nowMs));
    const enrollment = await service.startEnrollment('theo_7');
    const finished = await service.finishEnrollment({
      enrollmentToken: enrollment.enrollmentToken,
      code: generateTotpCode(enrollment.secret, nowMs),
      userAgent: 'Test Browser',
    });

    expect(finished.recoveryCodes).toHaveLength(10);
    expect(finished.linkedExistingUser).toBe(false);
    expect((await users.getProfile(finished.userId))?.authType).toBe('anonymous_totp');
    expect((await service.authenticateSession(finished.token))?.userId).toBe(finished.userId);

    await expect(service.login({ username: 'theo_7', code: generateTotpCode(enrollment.secret, nowMs) }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    nowMs += 30_000;
    const login = await service.login({ username: 'THEO_7', code: generateTotpCode(enrollment.secret, nowMs) });
    expect((await service.authenticateSession(login.token))?.authMethod).toBe('totp');
    const sessions = await service.listSessions(finished.userId, login.token);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.current)?.sessionId).toBe(login.session.sessionId);
    expect(await service.revokeSession(finished.userId, login.session.sessionId)).toBe(true);
    expect(await service.authenticateSession(login.token)).toBeNull();
  });

  it('adds browser login to the existing Telegram user instead of creating a second identity', async () => {
    const users = new InMemoryUserStorage();
    const original = await users.createProfile('telegram-user', {
      displayName: 'Existing Person',
      telegram: { telegramUserId: '42', chatId: '42', firstName: 'Existing' },
    });
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(KEY), () => new Date(START),
    );
    const enrollment = await service.startEnrollment('existing_person', original.userId);
    const finished = await service.finishEnrollment({
      enrollmentToken: enrollment.enrollmentToken,
      code: generateTotpCode(enrollment.secret, START),
      authenticatedUserId: original.userId,
    });
    expect(finished.userId).toBe(original.userId);
    expect(finished.linkedExistingUser).toBe(true);
    expect((await users.getProfile(original.userId))?.telegram?.chatId).toBe('42');
  });

  it('moves a legacy authenticator behind email without changing the user or leaving a bypass', async () => {
    let nowMs = START;
    const users = new InMemoryUserStorage();
    const storage = new InMemoryWorkspaceWebAuthStorage();
    const delivery = verificationDelivery();
    const service = new WorkspaceWebAuthService(
      storage, users, new SecretCipher(KEY), () => new Date(nowMs),
      delivery.config,
    );
    const legacy = await service.startEnrollment('legacy_owner');
    const oldAccount = await service.finishEnrollment({
      enrollmentToken: legacy.enrollmentToken,
      code: generateTotpCode(legacy.secret, nowMs),
    });
    const linked = await service.registerEmail({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
      authenticatedUserId: oldAccount.userId,
    });
    expect(linked).toMatchObject({ userId: oldAccount.userId, linkedExistingUser: true });

    nowMs += 30_000;
    await expect(service.login({ username: 'legacy_owner', code: generateTotpCode(legacy.secret, nowMs) }))
      .resolves.toMatchObject({ session: { userId: oldAccount.userId } });
    const pending = await service.loginEmail({ email: 'owner@example.com', password: 'correct horse battery staple' });
    expect(pending).toEqual({ authenticated: false, verificationRequired: true });
    await expect(service.verifyEmail(delivery.token())).resolves.toBeNull();
    nowMs += 30_000;
    await expect(service.login({ username: 'legacy_owner', code: generateTotpCode(legacy.secret, nowMs) }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(service.loginEmail({ email: 'owner@example.com', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ secondFactorRequired: true });
  });

  it('binds a linked enrollment to the authenticated user and consumes recovery codes once', async () => {
    const users = new InMemoryUserStorage();
    await users.createProfile('owner', { displayName: 'Owner' });
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), users, new SecretCipher(KEY), () => new Date(START),
    );
    const enrollment = await service.startEnrollment('owner_name', 'owner');
    await expect(service.finishEnrollment({
      enrollmentToken: enrollment.enrollmentToken,
      code: generateTotpCode(enrollment.secret, START),
      authenticatedUserId: 'attacker',
    })).rejects.toMatchObject({ code: 'authentication_required' });
    const finished = await service.finishEnrollment({
      enrollmentToken: enrollment.enrollmentToken,
      code: generateTotpCode(enrollment.secret, START),
      authenticatedUserId: 'owner',
    });
    const [code] = finished.recoveryCodes;
    expect((await service.recover({ username: 'owner_name', recoveryCode: code! })).session.authMethod).toBe('recovery');
    await expect(service.recover({ username: 'owner_name', recoveryCode: code! }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('signs an outside-email account in by the name it takes here, and keeps the outside email for recovery', async () => {
    // An account that attached an outside email from Settings before
    // addresses existed (the owner's own case, 2026-09-17): its identity
    // says gmail, its mailbox says adam@. The person who HOLDS the address
    // is the account, and the name they type is the door.
    const users = new InMemoryUserStorage();
    await users.createProfile('tg_adam', { email: 'adam.b@example.com', authType: 'email' });
    const storage = new InMemoryWorkspaceWebAuthStorage();
    const day = new Date(START - 86_400_000).toISOString();
    await storage.createEmailIdentity({
      userId: 'tg_adam', email: 'adam.b@example.com', emailCanonical: 'adam.b@example.com',
      passwordHash: hashWorkspacePassword('correct horse battery staple'),
      verificationStatus: 'verified', emailVerifiedAt: day, createdAt: day, updatedAt: day,
    });
    const delivery = verificationDelivery();
    const mail = mailboxes();
    const service = new WorkspaceWebAuthService(storage, users, new SecretCipher(KEY), () => new Date(START), delivery.config, mail);
    // Before the name is taken, only the outside email opens the door.
    await expect(service.loginEmail({ email: 'adam', password: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(service.loginEmail({ email: 'adam.b@example.com', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ session: { userId: 'tg_adam' } });

    const claimed = await mail.claim('tg_adam', 'adam');
    await service.adoptMailboxAddress('tg_adam', claimed.address);
    const identity = await storage.getEmailIdentityByUserId('tg_adam');
    expect(identity).toMatchObject({
      email: 'adam@agenticcloudcomputer.com',
      emailCanonical: 'adam@agenticcloudcomputer.com',
      verificationStatus: 'verified',
      recoveryEmail: 'adam.b@example.com',
      recoveryEmailVerifiedAt: day,
    });
    await expect(service.loginEmail({ email: 'adam', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ session: { userId: 'tg_adam' } });
    await expect(service.loginEmail({ email: 'ADAM@agenticcloudcomputer.com', password: 'correct horse battery staple' }))
      .resolves.toMatchObject({ session: { userId: 'tg_adam' } });
    // The outside email is a recovery address now, not a sign-in name.
    await expect(service.loginEmail({ email: 'adam.b@example.com', password: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    // And it is where a forgotten password goes, straight away.
    await service.requestPasswordReset('adam');
    expect(delivery.resets.at(-1)).toMatchObject({ email: 'adam.b@example.com', signInName: 'adam@agenticcloudcomputer.com' });
  });

  it('resets a forgotten password through the recovery email, once, signing every browser out', async () => {
    const users = new InMemoryUserStorage();
    const storage = new InMemoryWorkspaceWebAuthStorage();
    const delivery = verificationDelivery();
    let nowMs = START;
    const service = new WorkspaceWebAuthService(storage, users, new SecretCipher(KEY), () => new Date(nowMs), delivery.config, mailboxes());
    const created = await service.registerMailbox({ mailbox: 'samira', firstName: 'Samira', lastName: 'Rahimi', password: 'correct horse battery staple' });

    // A brand-new account here has no outside address: asking is answered
    // by silence, exactly as for a name nobody holds.
    await service.requestPasswordReset('samira');
    await service.requestPasswordReset('nobody-here');
    expect(delivery.resets).toHaveLength(0);

    // Settings: a recovery address counts only once its owner opens our link.
    await expect(service.requestRecoveryEmail(created.userId, 'samira@agenticcloudcomputer.com'))
      .rejects.toMatchObject({ code: 'invalid_recovery_email' });
    await expect(service.requestRecoveryEmail(created.userId, 'not an email'))
      .rejects.toMatchObject({ code: 'invalid_recovery_email' });
    await service.requestRecoveryEmail(created.userId, 'Samira@Example.com');
    expect((await storage.getEmailIdentityByUserId(created.userId))).toMatchObject({ recoveryEmail: 'samira@example.com' });
    expect((await storage.getEmailIdentityByUserId(created.userId))?.recoveryEmailVerifiedAt).toBeUndefined();
    await service.requestPasswordReset('samira');
    expect(delivery.resets).toHaveLength(0);
    // A second link within a minute is refused quietly; a minute later it goes.
    await service.requestRecoveryEmail(created.userId, 'samira@example.com');
    expect(delivery.recoveries).toHaveLength(1);
    nowMs += 61_000;
    await service.requestRecoveryEmail(created.userId, 'samira@example.com');
    expect(delivery.recoveries).toHaveLength(2);
    const staleRecovery = new URLSearchParams(new URL(delivery.recoveries[0]!.confirmUrl).hash.slice(1)).get('token')!;
    await expect(service.confirmRecoveryEmail(staleRecovery)).rejects.toMatchObject({ code: 'link_invalid' });
    await expect(service.confirmRecoveryEmail(delivery.recoveryToken())).resolves.toEqual({ email: 'samira@example.com' });
    expect((await storage.getEmailIdentityByUserId(created.userId))?.recoveryEmailVerifiedAt).toBe(new Date(nowMs).toISOString());

    // Forgot: the link goes to the confirmed address and sets a new password.
    const other = await service.loginEmail({ email: 'samira', password: 'correct horse battery staple' });
    await service.requestPasswordReset('samira');
    expect(delivery.resets.at(-1)).toMatchObject({ email: 'samira@example.com', signInName: 'samira@agenticcloudcomputer.com' });
    const resetToken = delivery.resetToken();
    // A recovery token is not a reset token, whatever it is worth elsewhere.
    await expect(service.resetPassword(delivery.recoveryToken(), 'a new correct password'))
      .rejects.toMatchObject({ code: 'link_invalid' });
    await expect(service.resetPassword(resetToken, 'short')).rejects.toMatchObject({ code: 'invalid_password' });
    await expect(service.resetPassword(resetToken, 'a new correct password')).resolves.toMatchObject({ userId: created.userId, revoked: 2 });
    await expect(service.resetPassword(resetToken, 'a new correct password')).rejects.toMatchObject({ code: 'link_invalid' });
    expect(await service.authenticateSession('session' in created ? created.session.token : '')).toBeNull();
    expect(await service.authenticateSession('token' in other ? other.token : '')).toBeNull();
    await expect(service.loginEmail({ email: 'samira', password: 'correct horse battery staple' }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(service.loginEmail({ email: 'samira', password: 'a new correct password' }))
      .resolves.toMatchObject({ session: { userId: created.userId, authMethod: 'password' } });

    // An expired link is not a working one.
    await service.requestPasswordReset('samira');
    const lateToken = delivery.resetToken();
    nowMs += 31 * 60_000;
    await expect(service.resetPassword(lateToken, 'yet another password')).rejects.toMatchObject({ code: 'link_expired' });

    await service.removeRecoveryEmail(created.userId);
    expect((await storage.getEmailIdentityByUserId(created.userId))?.recoveryEmail).toBeUndefined();
  });

  it('uses a uniform error for malformed, unknown, and wrong login credentials', async () => {
    const service = new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(), new InMemoryUserStorage(), new SecretCipher(KEY), () => new Date(START),
    );
    for (const args of [
      { username: '../bad', code: '123456' },
      { username: 'unknown', code: '123456' },
    ]) {
      await expect(service.login(args)).rejects.toEqual(expect.objectContaining({
        code: 'invalid_credentials', message: 'Invalid username or one-time code.',
      } satisfies Partial<WorkspaceWebAuthError>));
    }
  });
});

describe('SQLite WorkspaceWebAuthStorage atomicity', () => {
  let dir: string;
  let db: SqliteDb;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-auth-'));
    db = openSqliteDb(join(dir, 'test.db'));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('accepts one request for a TOTP step and one request for a recovery hash', async () => {
    const storage = new SqliteWorkspaceWebAuthStorage(db);
    await storage.createIdentity({
      userId: 'u1', username: 'u1_name', usernameCanonical: 'u1_name',
      encryptedTotpSecret: 'encrypted', lastAcceptedStep: 10,
      recoveryCodeHashes: ['one'], createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    });
    expect(await Promise.all([storage.acceptTotpStep('u1', 11), storage.acceptTotpStep('u1', 11)]))
      .toEqual([true, false]);
    expect(await Promise.all([storage.consumeRecoveryCode('u1', 'one'), storage.consumeRecoveryCode('u1', 'one')]))
      .toEqual([true, false]);
  });

  it('atomically consumes one email confirmation exactly once', async () => {
    const storage = new SqliteWorkspaceWebAuthStorage(db);
    await storage.createEmailIdentity({
      userId: 'pending', email: 'pending@example.com', emailCanonical: 'pending@example.com',
      passwordHash: 'scrypt:v1:not-used', verificationStatus: 'pending',
      createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    });
    await expect(storage.beginEmailVerification({
      tokenHash: 'hashed-token', userId: 'pending', emailCanonical: 'pending@example.com',
      createdAt: new Date(START).toISOString(), expiresAt: new Date(START + 30 * 60_000).toISOString(),
    }, { cooldownMs: 60_000, windowMs: 60 * 60_000, maxPerWindow: 5 })).resolves.toBe('created');
    expect(await Promise.all([
      storage.consumeEmailVerification('hashed-token', new Date(START).toISOString()),
      storage.consumeEmailVerification('hashed-token', new Date(START).toISOString()),
    ])).toEqual([{ outcome: 'verified', userId: 'pending' }, { outcome: 'invalid' }]);
  });

  it('stores only a salted password hash for an email identity', async () => {
    const password = 'correct horse battery staple';
    const delivery = verificationDelivery();
    const service = new WorkspaceWebAuthService(
      new SqliteWorkspaceWebAuthStorage(db), new InMemoryUserStorage(), new SecretCipher(KEY), () => new Date(START),
      delivery.config, mailboxes(),
    );
    // The account, and then an outside address attached to it: both password
    // hashes and the confirmation bearer have to be unreadable at rest.
    const account = await service.registerMailbox({ mailbox: 'samira', firstName: 'Samira', lastName: 'Rahimi', password });
    const legacy = await service.startEnrollment('legacy_owner');
    const old = await service.finishEnrollment({
      enrollmentToken: legacy.enrollmentToken, code: generateTotpCode(legacy.secret, START),
    });
    expect(account.userId).not.toBe(old.userId);
    await service.registerEmail({ email: 'owner@example.com', password, authenticatedUserId: old.userId });
    const identity = db.prepare('SELECT doc FROM workspace_email_identities').get() as { doc: string };
    expect(identity.doc).toContain('scrypt:v1:');
    expect(identity.doc).not.toContain(password);
    const pending = db.prepare('SELECT token_hash, doc FROM workspace_email_verifications').get() as { token_hash: string; doc: string };
    expect(pending.token_hash).not.toBe(delivery.token());
    expect(pending.doc).not.toContain(delivery.token());
  });

  it('migrates pre-verification email identities to legacy access explicitly', async () => {
    const old = {
      userId: 'legacy-email', email: 'legacy@example.com', emailCanonical: 'legacy@example.com',
      passwordHash: 'scrypt:v1:placeholder', createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    };
    db.prepare('INSERT INTO workspace_email_identities (user_id, email_canonical, doc) VALUES (?, ?, ?)')
      .run(old.userId, old.emailCanonical, JSON.stringify(old));
    db.close();
    db = openSqliteDb(join(dir, 'test.db'));
    const migrated = JSON.parse((db.prepare('SELECT doc FROM workspace_email_identities WHERE user_id = ?')
      .get(old.userId) as { doc: string }).doc) as Record<string, unknown>;
    expect(migrated.verificationStatus).toBe('legacy');
    expect(migrated.verificationGrandfatheredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('makes the address an account holds its sign-in name when the database opens', async () => {
    const day = new Date(START).toISOString();
    const outside = {
      userId: 'tg_adam', email: 'adam.b@example.com', emailCanonical: 'adam.b@example.com',
      passwordHash: 'scrypt:v1:placeholder', verificationStatus: 'verified', emailVerifiedAt: day, createdAt: day, updatedAt: day,
    };
    const own = {
      userId: 'web_1', email: 'juli@agenticcloudcomputer.com', emailCanonical: 'juli@agenticcloudcomputer.com',
      passwordHash: 'scrypt:v1:placeholder', verificationStatus: 'verified', emailVerifiedAt: day, createdAt: day, updatedAt: day,
    };
    const noAddress = {
      userId: 'web_2', email: 'kush@example.com', emailCanonical: 'kush@example.com',
      passwordHash: 'scrypt:v1:placeholder', verificationStatus: 'verified', emailVerifiedAt: day, createdAt: day, updatedAt: day,
    };
    const insert = db.prepare('INSERT INTO workspace_email_identities (user_id, email_canonical, doc) VALUES (?, ?, ?)');
    for (const doc of [outside, own, noAddress]) insert.run(doc.userId, doc.emailCanonical, JSON.stringify(doc));
    const mailbox = db.prepare('INSERT INTO workspace_mailboxes (address, user_id, doc) VALUES (?, ?, ?)');
    mailbox.run('adam@agenticcloudcomputer.com', 'tg_adam', JSON.stringify({ address: 'adam@agenticcloudcomputer.com', localPart: 'adam', userId: 'tg_adam', createdAt: day }));
    mailbox.run('juli@agenticcloudcomputer.com', 'web_1', JSON.stringify({ address: 'juli@agenticcloudcomputer.com', localPart: 'juli', userId: 'web_1', createdAt: day }));
    db.close();
    db = openSqliteDb(join(dir, 'test.db'));
    const read = (userId: string) => db.prepare('SELECT email_canonical AS emailCanonical, doc FROM workspace_email_identities WHERE user_id = ?').get(userId) as { emailCanonical: string; doc: string };
    const adam = read('tg_adam');
    expect(adam.emailCanonical).toBe('adam@agenticcloudcomputer.com');
    expect(JSON.parse(adam.doc)).toMatchObject({
      email: 'adam@agenticcloudcomputer.com',
      emailCanonical: 'adam@agenticcloudcomputer.com',
      verificationStatus: 'verified',
      recoveryEmail: 'adam.b@example.com',
      recoveryEmailVerifiedAt: day,
    });
    // Already its own name: untouched, down to the timestamp.
    expect(JSON.parse(read('web_1').doc)).toEqual(own);
    // No address here yet: nothing to adopt, still signs in with the outside email.
    expect(JSON.parse(read('web_2').doc)).toEqual(noAddress);
    // Opening again is a no-op: the adoption has nothing left to find.
    db.close();
    db = openSqliteDb(join(dir, 'test.db'));
    expect(JSON.parse(read('tg_adam').doc).updatedAt).toBe(JSON.parse(adam.doc).updatedAt);
  });

  it('spends an auth link once, by purpose, and holds one live link per person and purpose', async () => {
    const storage = new SqliteWorkspaceWebAuthStorage(db);
    const at = (ms: number) => new Date(START + ms).toISOString();
    const link = (tokenHash: string, purpose: 'password_reset' | 'recovery_email', createdMs: number) => ({
      tokenHash, userId: 'u1', purpose, email: 'u1@example.com', createdAt: at(createdMs), expiresAt: at(createdMs + 30 * 60_000),
    });
    expect(await storage.saveAuthLink(link('a', 'password_reset', 0), 60_000)).toBe('created');
    expect(await storage.saveAuthLink(link('b', 'password_reset', 1_000), 60_000)).toBe('rate_limited');
    expect(await storage.saveAuthLink(link('c', 'recovery_email', 1_000), 60_000)).toBe('created');
    expect(await storage.saveAuthLink(link('d', 'password_reset', 61_000), 60_000)).toBe('created');
    // The replaced link is gone; the wrong purpose finds nothing.
    expect(await storage.consumeAuthLink('a', 'password_reset', at(62_000))).toEqual({ outcome: 'invalid' });
    expect(await storage.consumeAuthLink('d', 'recovery_email', at(62_000))).toEqual({ outcome: 'invalid' });
    expect(await storage.consumeAuthLink('d', 'password_reset', at(62_000))).toMatchObject({ outcome: 'consumed', link: { tokenHash: 'd' } });
    expect(await storage.consumeAuthLink('d', 'password_reset', at(62_000))).toEqual({ outcome: 'invalid' });
    expect(await storage.consumeAuthLink('c', 'recovery_email', at(40 * 60_000))).toEqual({ outcome: 'expired' });
    expect(await storage.consumeAuthLink('c', 'recovery_email', at(40 * 60_000))).toEqual({ outcome: 'invalid' });
  });

  it('stores neither the authenticator secret nor opaque browser bearer values in plaintext', async () => {
    const users = new InMemoryUserStorage();
    const service = new WorkspaceWebAuthService(
      new SqliteWorkspaceWebAuthStorage(db), users, new SecretCipher(KEY), () => new Date(START),
    );
    const enrollment = await service.startEnrollment('stored_safely');
    const pending = db.prepare('SELECT token_hash, doc FROM workspace_totp_enrollments').get() as {
      token_hash: string; doc: string;
    };
    expect(pending.doc).toContain('enc:v1:');
    expect(pending.doc).not.toContain(enrollment.secret);
    expect(pending.token_hash).not.toBe(enrollment.enrollmentToken);
    expect(pending.doc).not.toContain(enrollment.enrollmentToken);

    const issued = await service.finishEnrollment({
      enrollmentToken: enrollment.enrollmentToken,
      code: generateTotpCode(enrollment.secret, START),
    });
    const identity = db.prepare('SELECT doc FROM workspace_totp_identities').get() as { doc: string };
    const session = db.prepare('SELECT session_hash, doc FROM workspace_web_sessions').get() as {
      session_hash: string; doc: string;
    };
    expect(identity.doc).not.toContain(enrollment.secret);
    expect(identity.doc).not.toContain(issued.recoveryCodes[0]!);
    expect(session.session_hash).not.toBe(issued.token);
    expect(session.doc).not.toContain(issued.token);
    expect(session.doc).not.toContain(issued.csrfToken);
  });
});

describe('Workspace browser cookie protections', () => {
  it('uses __Host cookies on HTTPS and a localhost-compatible name only on explicit HTTP', () => {
    expect(workspaceCookieNames('https://app.example.com')).toMatchObject({ session: '__Host-acc_session', secure: true });
    expect(workspaceCookieNames('http://localhost:3001')).toMatchObject({ session: 'acc_session', secure: false });
  });

  it('requires both exact Origin and a timing-safe matching double-submit token', () => {
    const req = request({ origin: 'https://app.example.com', cookie: '__Host-acc_csrf=abc', 'x-csrf-token': 'abc' });
    expect(requestHasWorkspaceOrigin(req, 'https://app.example.com')).toBe(true);
    expect(requestHasWorkspaceOrigin(
      request({ origin: 'https://old-app.example.com' }),
      'https://app.example.com',
      ['not-an-origin', 'https://old-app.example.com'],
    )).toBe(true);
    expect(requestHasValidCsrf(req, 'https://app.example.com')).toBe(true);
    expect(requestHasWorkspaceOrigin(request({ origin: 'https://evil.example' }), 'https://app.example.com')).toBe(false);
    expect(requestHasWorkspaceOrigin(
      request({ origin: 'https://evil.example' }),
      'https://app.example.com',
      ['https://old-app.example.com'],
    )).toBe(false);
    expect(requestHasValidCsrf(request({ cookie: '__Host-acc_csrf=abc', 'x-csrf-token': 'abd' }), 'https://app.example.com')).toBe(false);
  });

  it('ignores malformed cookie encoding without losing sound siblings', () => {
    expect(parseCookieHeader('broken=%E0%A4%A; good=value')).toEqual({ good: 'value' });
  });
});
