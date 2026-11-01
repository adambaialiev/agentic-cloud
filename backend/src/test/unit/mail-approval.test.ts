import { describe, expect, it, vi } from 'vitest';
import { MailApprovalService } from '../../services/mail-approval.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { MailOutboxService } from '../../services/mail-outbox.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import type { OutboundMail } from '../../services/mail-sender.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { SqliteMailApprovalStorage } from '../../services/sqlite/sqlite-mail-approval-storage.js';

const arrived = (): MailMessageDocument => ({
  id: 'mm_in', userId: 'u1', address: 'adam@agenticcloudcomputer.com',
  envelopeFrom: 'bounce@example.com', receivedAt: '2026-09-16T10:00:00.000Z',
  messageId: 'incoming@example.com', from: { name: 'Ada', address: 'ada@example.com' },
  to: [{ address: 'adam@agenticcloudcomputer.com' }], cc: [], replyTo: [],
  subject: 'Tuesday', snippet: 'Four?', text: 'Four?', attachments: [],
  raw: { storagePath: 'mail/raw', size: 5 },
});

async function setup(send?: (mail: OutboundMail) => Promise<unknown>) {
  const db = openSqliteDb(':memory:');
  const mailboxes = new SqliteMailboxStorage(db);
  const messages = new SqliteMailMessageStorage(db);
  await new MailboxService(mailboxes).claim('u1', 'adam');
  await messages.store(arrived());
  const sent: OutboundMail[] = [];
  const sender = { send: vi.fn(async (mail: OutboundMail) => {
    sent.push(mail);
    await send?.(mail);
    return {};
  }) };
  const outbox = new MailOutboxService({ mailboxes, messages, sender });
  const storage = new SqliteMailApprovalStorage(db);
  const service = new MailApprovalService(storage, outbox);
  return { service, storage, sent, sender, messages };
}

const actor = { userId: 'u1', agentId: 'a1', requestedBy: 'Felix', senderName: 'Saddam' };

describe('agent mail approval', () => {
  it('stores the exact preview and sends nothing until the owner approves it', async () => {
    const x = await setup();
    const request = await x.service.requestSend({
      ...actor, to: 'ada@example.com', subject: ' Tuesday ', text: '  Four works.  ',
    });
    expect(x.sent).toHaveLength(0);
    expect(await x.service.get('u1', request.id)).toMatchObject({
      kind: 'send', from: { address: 'adam@agenticcloudcomputer.com', name: 'Saddam' }, to: { address: 'ada@example.com' },
      subject: 'Tuesday', text: 'Four works.', requestedBy: 'Felix', status: 'pending',
    });
    expect(await x.service.get('somebody-else', request.id)).toBeNull();

    const answer = await x.service.decide({ userId: 'u1', id: request.id, decision: 'approve' });
    expect(answer).toMatchObject({ status: 'sent', sentMessageId: request.outboundId });
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]).toMatchObject({
      from: { address: 'adam@agenticcloudcomputer.com', name: 'Saddam' },
      to: [{ address: 'ada@example.com' }], subject: 'Tuesday', text: 'Four works.\n',
    });
  });

  it('rejects without sending, and a later replay cannot spend the request', async () => {
    const x = await setup();
    const request = await x.service.requestSend({ ...actor, to: 'ada@example.com', subject: '', text: 'No.' });
    expect(await x.service.decide({ userId: 'u1', id: request.id, decision: 'reject' }))
      .toMatchObject({ status: 'rejected' });
    expect(await x.service.decide({ userId: 'u1', id: request.id, decision: 'approve' }))
      .toMatchObject({ status: 'rejected' });
    expect(x.sent).toHaveLength(0);
  });

  it('resolves a reply target before asking and still cannot be aimed by the agent', async () => {
    const x = await setup();
    const request = await x.service.requestReply({ ...actor, messageId: 'mm_in', text: 'It does.' });
    expect(request).toMatchObject({
      kind: 'reply', to: { name: 'Ada', address: 'ada@example.com' }, subject: 'Re: Tuesday',
      replyToMessageId: 'mm_in',
    });
    await x.service.decide({ userId: 'u1', id: request.id, decision: 'approve' });
    expect(x.sent[0]!.to).toEqual([{ name: 'Ada', address: 'ada@example.com' }]);
  });

  it('claims one double tap, so the provider sees the message once', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const x = await setup(async () => held);
    const request = await x.service.requestSend({ ...actor, to: 'ada@example.com', subject: 'One', text: 'Once.' });
    const first = x.service.decide({ userId: 'u1', id: request.id, decision: 'approve' });
    await vi.waitFor(() => expect(x.sent).toHaveLength(1));
    const second = await x.service.decide({ userId: 'u1', id: request.id, decision: 'approve' });
    expect(second).toMatchObject({ status: 'sending' });
    release();
    await first;
    expect(x.sent).toHaveLength(1);
  });

  it('reopens a failed attempt and keeps the same provider id for a safe retry', async () => {
    let fail = true;
    const x = await setup(async () => { if (fail) throw new Error('provider down'); });
    const request = await x.service.requestSend({ ...actor, to: 'ada@example.com', subject: 'Retry', text: 'Same.' });
    await expect(x.service.decide({ userId: 'u1', id: request.id, decision: 'approve' }))
      .rejects.toThrow('provider down');
    expect(await x.service.get('u1', request.id)).toMatchObject({ status: 'pending', error: expect.stringContaining('Try again') });
    fail = false;
    await x.service.decide({ userId: 'u1', id: request.id, decision: 'approve' });
    expect(x.sent).toHaveLength(2);
    expect(x.sent[0]!.idempotencyKey).toBe(x.sent[1]!.idempotencyKey);
  });
});
