import { describe, expect, it, vi } from 'vitest';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import {
  MAIL_REPLIES_PER_HOUR,
  MailOutboxService,
  replyBody,
  replyRecipient,
  replySubject,
} from '../../services/mail-outbox.js';
import { MailSendError, ResendMailSender, type OutboundMail } from '../../services/mail-sender.js';

/**
 * Answering a message (note #509, slice 4).
 *
 * The rule under test is not "a reply is sent" — it is WHO it can be sent to.
 * A free address on our domain is worth something to a spammer only if it can
 * reach strangers, so the recipient is read off the message being answered and
 * never taken from the caller. The rest of this file is the three ways that
 * can go wrong: nobody to answer, too many in an hour, and a provider that
 * refused after we had already decided to store a "sent" row.
 */

const arrived = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => ({
  id: 'mm_in',
  userId: 'user-adam',
  address: 'adam@agenticcloudcomputer.com',
  envelopeFrom: 'bounces@example.com',
  receivedAt: '2026-09-14T09:00:00.000Z',
  sentAt: '2026-09-14T08:59:00.000Z',
  messageId: 'abc-123@example.com',
  from: { name: 'Ada Lovelace', address: 'ada@example.com' },
  to: [{ address: 'adam@agenticcloudcomputer.com' }],
  cc: [],
  replyTo: [],
  subject: 'The engine',
  snippet: 'It weaves algebraic patterns.',
  text: 'It weaves algebraic patterns.\nAs the loom weaves flowers.',
  attachments: [],
  raw: { storagePath: 'users/user-adam/mail/mm_in/raw.eml', size: 2048 },
  ...over,
});

async function outbox(opts: { send?: (mail: OutboundMail) => Promise<{ providerId?: string }> } = {}) {
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
  return { db, messages, sent, sender, service: new MailOutboxService({ mailboxes, messages, sender }) };
}

describe('what a reply says and where it goes', () => {
  it('answers the address the sender asked for, then the one they wrote from', () => {
    expect(replyRecipient(arrived())?.address).toBe('ada@example.com');
    expect(replyRecipient(arrived({ replyTo: [{ address: 'desk@example.com' }] }))?.address).toBe('desk@example.com');
    // Never the envelope sender — that is a bounce address, and a person who
    // wrote from a list would get an answer no human reads.
    expect(replyRecipient(arrived({ from: undefined, replyTo: [] }))).toBeNull();
    // And never this mailbox itself: that is a loop, not a reply.
    expect(replyRecipient(arrived({ from: { address: 'adam@agenticcloudcomputer.com' } }))).toBeNull();
  });

  it('says Re: once, however many times it has been round', () => {
    expect(replySubject('The engine')).toBe('Re: The engine');
    expect(replySubject('Re: The engine')).toBe('Re: The engine');
    expect(replySubject('RE: The engine')).toBe('RE: The engine');
    expect(replySubject('  ')).toBe('Re: (no subject)');
  });

  it('quotes what is being answered, so the reply is readable on its own', () => {
    const body = replyBody('It does indeed.', arrived());
    expect(body.startsWith('It does indeed.')).toBe(true);
    expect(body).toContain('Ada Lovelace wrote:');
    expect(body).toContain('> It weaves algebraic patterns.');
    expect(body).toContain('> As the loom weaves flowers.');
  });
});

describe('MailOutboxService', () => {
  it('sends from the person’s own address, in the thread, and keeps the copy under the message', async () => {
    const { service, messages, sent } = await outbox();
    await messages.store(arrived());
    const reply = await service.reply({ userId: 'user-adam', messageId: 'mm_in', text: 'It does indeed.', senderName: 'Adam B' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { address: 'adam@agenticcloudcomputer.com', name: 'Adam B' },
      to: [{ address: 'ada@example.com', name: 'Ada Lovelace' }],
      subject: 'Re: The engine',
      inReplyTo: 'abc-123@example.com',
      references: ['abc-123@example.com'],
    });

    // The copy is stored as SENT, under the message it answers…
    expect(reply.direction).toBe('sent');
    expect(reply.answers).toBe('mm_in');
    expect((await messages.listAnswers('user-adam', 'mm_in')).map((row) => row.id)).toEqual([reply.id]);
    // …and it is NOT another row in the inbox.
    expect((await messages.list('user-adam')).messages.map((row) => row.id)).toEqual(['mm_in']);
  });

  it('refuses a message that is not this person’s, and one with nobody to answer', async () => {
    const { service, messages } = await outbox();
    await messages.store(arrived());
    await expect(service.reply({ userId: 'user-someone-else', messageId: 'mm_in', text: 'Hello' }))
      .rejects.toMatchObject({ code: 'no_such_message' });
    await messages.store(arrived({ id: 'mm_nobody', from: undefined, messageId: 'no-one@example.com' }));
    await expect(service.reply({ userId: 'user-adam', messageId: 'mm_nobody', text: 'Hello' }))
      .rejects.toMatchObject({ code: 'not_replyable' });
    // Empty words are not a reply.
    await expect(service.reply({ userId: 'user-adam', messageId: 'mm_in', text: '   ' }))
      .rejects.toMatchObject({ code: 'empty_reply' });
  });

  it('will not answer its own outgoing copy, so a reply cannot be replied to into a loop', async () => {
    const { service, messages } = await outbox();
    await messages.store(arrived());
    const reply = await service.reply({ userId: 'user-adam', messageId: 'mm_in', text: 'Yes.' });
    await expect(service.reply({ userId: 'user-adam', messageId: reply.id, text: 'And again' }))
      .rejects.toMatchObject({ code: 'no_such_message' });
  });

  it('stops at the hourly limit, counted off what is stored rather than a counter a deploy resets', async () => {
    const { service, messages } = await outbox();
    for (let at = 0; at < MAIL_REPLIES_PER_HOUR; at += 1) {
      await messages.store(arrived({ id: `mm_${at}`, messageId: `m${at}@example.com` }));
      await service.reply({ userId: 'user-adam', messageId: `mm_${at}`, text: 'Thanks.' });
    }
    await messages.store(arrived({ id: 'mm_last', messageId: 'last@example.com' }));
    await expect(service.reply({ userId: 'user-adam', messageId: 'mm_last', text: 'One more' }))
      .rejects.toMatchObject({ code: 'too_many' });
  });

  it('stores nothing when the provider refuses — a "sent" row nobody received is the worst record', async () => {
    const { service, messages } = await outbox({ send: async () => { throw new MailSendError('domain not verified'); } });
    await messages.store(arrived());
    await expect(service.reply({ userId: 'user-adam', messageId: 'mm_in', text: 'Hello' })).rejects.toThrow(/not verified/);
    expect(await messages.listAnswers('user-adam', 'mm_in')).toEqual([]);
    expect(await messages.countSentSince('user-adam', '2000-01-01T00:00:00.000Z')).toBe(0);
  });
});

describe('ResendMailSender', () => {
  it('sends the threading headers and asks the provider to de-duplicate', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const sender = new ResendMailSender({ apiKey: 'test-key', fetch: fetcher });
    const answer = await sender.send({
      from: { address: 'adam@agenticcloudcomputer.com', name: 'Adam B' },
      to: [{ address: 'ada@example.com' }],
      subject: 'Re: The engine',
      text: 'It does indeed.',
      inReplyTo: 'abc-123@example.com',
      references: ['abc-123@example.com'],
      idempotencyKey: 'mm_out.k3@agenticcloudcomputer.com',
    });
    expect(answer.providerId).toBe('resend-1');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.from).toBe('Adam B <adam@agenticcloudcomputer.com>');
    expect(body.reply_to).toEqual(['adam@agenticcloudcomputer.com']);
    expect(body.headers).toEqual({ 'In-Reply-To': '<abc-123@example.com>', References: '<abc-123@example.com>' });
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('mm_out.k3@agenticcloudcomputer.com');
  });

  it('carries the provider’s reason, because "try again" and "never" are different answers', async () => {
    const fetcher = (async () => new Response('{"message":"The domain is not verified"}', { status: 403 })) as unknown as typeof globalThis.fetch;
    const sender = new ResendMailSender({ apiKey: 'test-key', fetch: fetcher });
    await expect(sender.send({
      from: { address: 'adam@agenticcloudcomputer.com' },
      to: [{ address: 'ada@example.com' }],
      subject: 'Re: hello',
      text: 'hi',
      idempotencyKey: 'k',
    })).rejects.toThrow(/not verified/);
  });
});
