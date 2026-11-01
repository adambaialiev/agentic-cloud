import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretCipher } from '../../services/secret-cipher.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthError,
  WorkspaceWebAuthService,
} from '../../services/workspace-web-auth.js';
import { MailboxError, MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import {
  MAIL_DOMAIN,
  isMailDomainAddress,
  mailLocalProblem,
  mailSignInAddress,
  normalizeMailLocal,
} from '../../shared/workspace-mail.js';
import type { WorkspaceVerificationEmail } from '../../services/workspace-verification-email.js';

const KEY = randomBytes(32).toString('base64');
const START = Date.parse('2026-09-14T09:00:00.000Z');

function mailboxes() {
  return new MailboxService(new SqliteMailboxStorage(openSqliteDb(':memory:')), () => new Date(START));
}

function verificationDelivery() {
  const sent: WorkspaceVerificationEmail[] = [];
  return {
    sent,
    config: {
      workspaceUrl: 'https://app.example.com/workspace',
      sender: { sendVerification: async (message: WorkspaceVerificationEmail) => { sent.push(message); } },
    },
    token: () => new URLSearchParams(new URL(sent.at(-1)!.verificationUrl).hash.slice(1)).get('token')!,
  };
}

describe('the address grammar', () => {
  it('accepts an ordinary name and the whole address pasted into the field', () => {
    expect(normalizeMailLocal('  Adam  ')).toBe('adam');
    expect(normalizeMailLocal(`adam@${MAIL_DOMAIN}`)).toBe('adam');
    expect(normalizeMailLocal('adam.b-1')).toBe('adam.b-1');
    expect(mailLocalProblem('adam.b-1')).toBeNull();
  });

  it('refuses a name from somebody else’s domain rather than taking its local part', () => {
    expect(normalizeMailLocal('adam@gmail.com')).toBe('');
  });

  it('names the one reason a candidate cannot be an address', () => {
    expect(mailLocalProblem('')).toBe('empty');
    expect(mailLocalProblem('ab')).toBe('too-short');
    expect(mailLocalProblem('a'.repeat(33))).toBe('too-long');
    expect(mailLocalProblem('Adam')).toBe('shape');
    expect(mailLocalProblem('adam..b')).toBe('shape');
    expect(mailLocalProblem('-adam')).toBe('shape');
    expect(mailLocalProblem('adam-')).toBe('shape');
    expect(mailLocalProblem('adam b')).toBe('shape');
    // RFC 2142 owes these to the internet; a person holding one would be
    // taken for the platform by whoever wrote to them.
    expect(mailLocalProblem('postmaster')).toBe('reserved');
    expect(mailLocalProblem('abuse')).toBe('reserved');
    expect(mailLocalProblem('support')).toBe('reserved');
  });

  it('reads a bare name in the sign-in field as an address here', () => {
    expect(mailSignInAddress('adam')).toBe(`adam@${MAIL_DOMAIN}`);
    // An account made before this service keeps signing in with its own email.
    expect(mailSignInAddress('adam@gmail.com')).toBe('adam@gmail.com');
    expect(isMailDomainAddress(`adam@${MAIL_DOMAIN}`)).toBe(true);
    expect(isMailDomainAddress('adam@gmail.com')).toBe(false);
  });
});

describe('MailboxService', () => {
  it('hands one name to one person and refuses it to the next', async () => {
    const service = mailboxes();
    expect((await service.availability('adam')).available).toBe(true);
    await service.claim('user_a', 'adam');
    expect((await service.availability('adam')).available).toBe(false);
    await expect(service.claim('user_b', 'adam')).rejects.toMatchObject({ code: 'mailbox_taken' });
    expect(await service.forUser('user_a')).toEqual({ address: `adam@${MAIL_DOMAIN}` });
  });

  it('gives each person one address, not a collection', async () => {
    const service = mailboxes();
    await service.claim('user_a', 'adam');
    await expect(service.claim('user_a', 'adam.second')).rejects.toMatchObject({ code: 'mailbox_exists' });
  });

  it('refuses a name the grammar refuses, before any storage is touched', async () => {
    const service = mailboxes();
    await expect(service.claim('user_a', 'Adam!')).rejects.toBeInstanceOf(MailboxError);
    expect(await service.forUser('user_a')).toBeNull();
    expect(await service.availability('postmaster')).toMatchObject({ available: false, problem: 'reserved' });
  });

  it('never frees an address, however old, and releases only the name it is given', async () => {
    const service = mailboxes();
    await service.claim('user_a', 'adam');
    await service.release('user_a', `someone.else@${MAIL_DOMAIN}`);
    expect(await service.forUser('user_a')).not.toBeNull();
    // The rollback path names both halves, so it can only undo its own claim.
    await service.release('user_a', `adam@${MAIL_DOMAIN}`);
    expect(await service.forUser('user_a')).toBeNull();
  });
});

describe('signing up IS choosing the address', () => {
  function auth(mail?: MailboxService) {
    return new WorkspaceWebAuthService(
      new InMemoryWorkspaceWebAuthStorage(),
      new InMemoryUserStorage(),
      new SecretCipher(KEY),
      () => new Date(START),
      verificationDelivery().config,
      mail,
    );
  }

  it('creates the account, takes the name and opens the session in one step', async () => {
    const mail = mailboxes();
    const created = await auth(mail).registerMailbox({ mailbox: 'adam', firstName: 'Samira', lastName: 'Rahimi', password: 'a-long-password' });
    expect(created.address).toBe(`adam@${MAIL_DOMAIN}`);
    expect(created.session.token).toBeTruthy();
    expect(await mail.forUser(created.userId)).toEqual({ address: `adam@${MAIL_DOMAIN}` });
  });

  it('refuses a taken name and creates no account for it', async () => {
    const mail = mailboxes();
    await mail.claim('someone_else', 'adam');
    const service = auth(mail);
    await expect(service.registerMailbox({ mailbox: 'adam', firstName: 'Samira', lastName: 'Rahimi', password: 'a-long-password' }))
      .rejects.toMatchObject({ code: 'mailbox_taken' });
    await expect(service.loginEmail({ email: 'adam', password: 'a-long-password' }))
      .rejects.toBeInstanceOf(WorkspaceWebAuthError);
  });

  it('refuses a name the grammar refuses, and a whole outside address', async () => {
    const service = auth(mailboxes());
    await expect(service.registerMailbox({ mailbox: 'ADMIN', firstName: 'Samira', lastName: 'Rahimi', password: 'a-long-password' }))
      .rejects.toMatchObject({ code: 'invalid_mailbox' });
    await expect(service.registerMailbox({ mailbox: 'adam@gmail.com', firstName: 'Samira', lastName: 'Rahimi', password: 'a-long-password' }))
      .rejects.toMatchObject({ code: 'invalid_mailbox' });
  });

  it('closes the door on creating an account with an outside email', async () => {
    await expect(auth(mailboxes()).registerEmail({ email: 'adam@gmail.com', password: 'a-long-password' }))
      .rejects.toMatchObject({ code: 'outside_email_closed' });
  });
});
