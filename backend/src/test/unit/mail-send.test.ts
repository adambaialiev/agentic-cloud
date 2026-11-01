import { describe, expect, it, vi } from 'vitest';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import {
  MAIL_NEW_PER_DAY,
  MAIL_NEW_PER_HOUR,
  MailOutboxError,
  MailOutboxService,
  readOneRecipient,
} from '../../services/mail-outbox.js';
import { type OutboundMail } from '../../services/mail-sender.js';

/**
 * Writing to somebody who has not written first (note #509, slice 5).
 *
 * Slice 4 refused to have this on purpose, so the tests that matter are not
 * "a message is sent" — they are the brakes that had to be built before the
 * door could open: ONE recipient, ceilings on two clocks that a busy day of
 * replying does not spend, and nothing stored for a message that never went.
 */

const arrived = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => ({
  id: 'mm_in',
  userId: 'user-adam',
  address: 'adam@agenticcloudcomputer.com',
  envelopeFrom: 'bounces@example.com',
  receivedAt: '2026-09-15T09:00:00.000Z',
  messageId: 'abc-123@example.com',
  from: { name: 'Ada Lovelace', address: 'ada@example.com' },
  to: [{ address: 'adam@agenticcloudcomputer.com' }],
  cc: [],
  replyTo: [],
  subject: 'The engine',
  snippet: 'It weaves algebraic patterns.',
  text: 'It weaves algebraic patterns.',
  attachments: [],
  raw: { storagePath: 'users/user-adam/mail/mm_in/raw.eml', size: 2048 },
  ...over,
});

async function outbox(opts: { send?: (mail: OutboundMail) => Promise<{ providerId?: string }>; now?: () => Date } = {}) {
  const db = openSqliteDb(':memory:');
  const mailboxes = new SqliteMailboxStorage(db);
  const messages = new SqliteMailMessageStorage(db);
  await new MailboxService(mailboxes).claim('user-adam', 'adam');
  const sent: OutboundMail[] = [];
  const sender = {
    send: vi.fn(async (mail: OutboundMail) => {
      sent.push(mail);
      return opts.send ? opts.send(mail) : {};
    }),
  };
  const service = new MailOutboxService({ mailboxes, messages, sender }, opts.now);
  return { db, messages, sent, sender, service };
}

const writes = (over: Partial<{ to: unknown; subject: unknown; text: string }> = {}) => ({
  userId: 'user-adam',
  to: 'ada@example.com',
  subject: 'About Tuesday',
  text: 'Are you free at four?',
  ...over,
});

describe('one recipient, read strictly', () => {
  it('takes a plain address and refuses everything that is more than one', () => {
    expect(readOneRecipient('ada@example.com')).toBe('ada@example.com');
    expect(readOneRecipient('  ada@example.com  ')).toBe('ada@example.com');
    // The refusals are the point: a display name or a comma would turn the
    // one-recipient rule into a suggestion.
    expect(readOneRecipient('Ada Lovelace <ada@example.com>')).toBeNull();
    expect(readOneRecipient('ada@example.com, bob@example.com')).toBeNull();
    expect(readOneRecipient('ada@example')).toBeNull();
    expect(readOneRecipient('')).toBeNull();
    expect(readOneRecipient(undefined)).toBeNull();
  });
});

describe('MailOutboxService.send', () => {
  it('sends from the person’s own address and keeps the copy as a row of its own', async () => {
    const { service, sent, messages } = await outbox();
    const message = await service.send({ ...writes(), senderName: 'Adam Baialiev' });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toEqual({ address: 'adam@agenticcloudcomputer.com', name: 'Adam Baialiev' });
    expect(sent[0]!.to).toEqual([{ address: 'ada@example.com' }]);
    expect(sent[0]!.subject).toBe('About Tuesday');
    // Nothing is quoted under a message that starts a conversation.
    expect(sent[0]!.text.trim()).toBe('Are you free at four?');

    expect(message.direction).toBe('sent');
    expect(message.answers).toBeUndefined();
    // A row of its own in the list — the only place it could be read, since
    // it answers nothing to sit under.
    const page = await messages.list('user-adam');
    expect(page.messages.map((row) => row.id)).toEqual([message.id]);
  });

  it('sends "(no subject)" rather than nothing at all when the subject is left empty', async () => {
    const { service, sent } = await outbox();
    await service.send(writes({ subject: '   ' }));
    expect(sent[0]!.subject).toBe('(no subject)');
  });

  it('refuses a recipient that is not one address, and refuses your own', async () => {
    const { service, sent } = await outbox();
    await expect(service.send(writes({ to: 'ada@example.com, bob@example.com' })))
      .rejects.toMatchObject({ code: 'bad_recipient' });
    await expect(service.send(writes({ to: 'adam@agenticcloudcomputer.com' })))
      .rejects.toMatchObject({ code: 'self_recipient' });
    await expect(service.send(writes({ text: '  ' })))
      .rejects.toMatchObject({ code: 'empty_reply' });
    expect(sent).toHaveLength(0);
  });

  it('stops at the hourly ceiling for new messages, and a reply does not spend it', async () => {
    const { service, messages } = await outbox();
    // A busy afternoon of answering mail: stored replies, which carry the id
    // of what they answer and must not count against reaching strangers.
    await messages.store(arrived());
    for (let i = 0; i < MAIL_NEW_PER_HOUR + 2; i += 1) {
      await messages.store({
        ...arrived({ id: `mm_reply_${i}`, messageId: `reply-${i}@agenticcloudcomputer.com` }),
        direction: 'sent',
        answers: 'mm_in',
        receivedAt: new Date().toISOString(),
      });
    }
    // Still allowed, because none of those were cold.
    await expect(service.send(writes())).resolves.toMatchObject({ direction: 'sent' });

    for (let i = 1; i < MAIL_NEW_PER_HOUR; i += 1) await service.send(writes());
    await expect(service.send(writes())).rejects.toMatchObject({ code: 'too_many' });
  });

  it('stops at the day’s ceiling even when every hour stayed under its own', async () => {
    let clock = new Date('2026-09-15T00:00:00.000Z');
    const { service } = await outbox({ now: () => clock });
    for (let i = 0; i < MAIL_NEW_PER_DAY; i += 1) {
      // Spread across the day so no single hour is ever at its limit.
      clock = new Date(clock.getTime() + 40 * 60_000);
      await service.send(writes());
    }
    clock = new Date(clock.getTime() + 40 * 60_000);
    const refused = await service.send(writes()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MailOutboxError);
    expect((refused as MailOutboxError).code).toBe('too_many');
    expect((refused as MailOutboxError).message).toContain('a day');
  });

  it('stores nothing when the provider refuses, so nobody sees a message that never went', async () => {
    const { service, messages } = await outbox({
      send: async () => { throw new Error('mailbox unavailable'); },
    });
    await expect(service.send(writes())).rejects.toThrow(/mailbox unavailable/);
    expect((await messages.list('user-adam')).messages).toHaveLength(0);
  });

  it('reuses a stored approved message without spending the provider or limit twice', async () => {
    const { service, sender, messages } = await outbox();
    const first = await service.send({ ...writes(), outboundId: 'mm_approved' });
    const replay = await service.send({ ...writes(), outboundId: 'mm_approved' });
    expect(replay.id).toBe(first.id);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect((await messages.list('user-adam')).messages).toHaveLength(1);
  });
});
