import { describe, expect, it, vi } from 'vitest';
import { MailApprovalService } from '../../services/mail-approval.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { mailStoragePrefix } from '../../services/mail-ingest.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import {
  MAIL_NEW_PER_HOUR,
  MailOutboxError,
  MailOutboxService,
  forwardBody,
  forwardSubject,
  replyAll,
  replyReachesNew,
} from '../../services/mail-outbox.js';
import { ResendMailSender, type OutboundMail } from '../../services/mail-sender.js';
import { readMailUpload } from '../../services/mail-upload.js';
import type { MediaStorage } from '../../services/media-storage.js';
import { mailConversationFacts } from '../../services/mail-threads.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteMailApprovalStorage } from '../../services/sqlite/sqlite-mail-approval-storage.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { MAIL_UPLOAD_CONTENT_TYPE, mailOutFileRefusal } from '../../shared/workspace-mail.js';

/**
 * Writing grows up (note #509, slice 12): Cc, files out, and forwarding.
 *
 * Slice 5's rule is that the CEILINGS ARE THE WHOLE DESIGN, so most of what
 * is pinned here is about them: a forward is a NEW message; a Cc does not
 * multiply the count, which is exactly why one message reaches four people at
 * most; and a reply's Cc that reaches somebody the letter was not addressed
 * to is a new message too. Then the files — kept under the message's own
 * prefix, thrown away with a message that did not go, frozen in an approval
 * so a retry is byte-identical under its key — and the forward's place in
 * its conversation.
 */

const USER = 'user-adam';
const ME = 'adam@agenticcloudcomputer.com';

const arrived = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => ({
  id: 'mm_in',
  userId: USER,
  address: ME,
  envelopeFrom: 'bounces@example.com',
  receivedAt: '2026-09-23T09:00:00.000Z',
  sentAt: '2026-09-23T08:59:00.000Z',
  messageId: 'abc-123@example.com',
  from: { name: 'Priya Raman', address: 'priya@example.com' },
  to: [{ address: ME }, { name: 'Carol', address: 'carol@example.com' }],
  cc: [{ address: 'dan@example.com' }],
  replyTo: [],
  subject: 'The brief',
  snippet: 'Here is the brief.',
  text: 'Here is the brief.\nPages two and three matter.',
  attachments: [{
    id: 'ma_brief', fileName: 'brief.pdf', contentType: 'application/pdf', size: 5,
    storagePath: 'users/user-adam/mail/mm_in/ma_brief/brief.pdf',
  }, {
    id: 'ma_tool', fileName: 'setup.exe', contentType: 'application/octet-stream', size: 3,
    storagePath: 'users/user-adam/mail/mm_in/ma_tool/setup.exe',
  }],
  raw: { storagePath: 'users/user-adam/mail/mm_in/raw.eml', size: 2048 },
  ...over,
});

function fakeMedia() {
  const objects = new Map<string, Buffer>();
  const media = {
    uploadObject: vi.fn(async (args: { storagePath: string; data: Uint8Array }) => {
      objects.set(args.storagePath, Buffer.from(args.data));
    }),
    downloadObject: vi.fn(async (args: { storagePath: string }) => {
      const found = objects.get(args.storagePath);
      if (!found) throw new Error(`no object at ${args.storagePath}`);
      return found;
    }),
    deleteObjectsWithPrefix: vi.fn(async (args: { prefix: string }) => {
      for (const key of [...objects.keys()]) if (key.startsWith(args.prefix)) objects.delete(key);
    }),
  };
  return { objects, media: media as unknown as MediaStorage };
}

async function world(opts: { send?: (mail: OutboundMail) => Promise<unknown>; media?: boolean; sender?: 'resend' } = {}) {
  const db = openSqliteDb(':memory:');
  const mailboxes = new SqliteMailboxStorage(db);
  const messages = new SqliteMailMessageStorage(db);
  await new MailboxService(mailboxes).claim(USER, 'adam');
  const files = fakeMedia();
  files.objects.set('users/user-adam/mail/mm_in/ma_brief/brief.pdf', Buffer.from('%PDF-'));
  files.objects.set('users/user-adam/mail/mm_in/ma_tool/setup.exe', Buffer.from('MZ!'));
  const sent: OutboundMail[] = [];
  const bodies: Array<{ key: string; body: string }> = [];
  const sender = opts.sender === 'resend'
    ? new ResendMailSender({
      apiKey: 'test',
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push({ key: String((init.headers as Record<string, string>)['Idempotency-Key']), body: String(init.body) });
        const failed = await opts.send?.(JSON.parse(String(init.body)) as OutboundMail).then(() => false, () => true);
        return failed
          ? new Response('upstream said no', { status: 500 })
          : new Response(JSON.stringify({ id: 'provider-1' }), { status: 200 });
      }) as unknown as typeof fetch,
    })
    : { send: vi.fn(async (mail: OutboundMail) => { sent.push(mail); await opts.send?.(mail); return {}; }) };
  const outbox = new MailOutboxService({
    mailboxes, messages, sender, ...(opts.media === false ? {} : { media: files.media }),
  });
  return { db, messages, outbox, files, sent, bodies };
}

const upload = (name: string, text = 'bytes', type = 'text/plain') => ({
  fileName: name, contentType: type, data: Buffer.from(text),
});

describe('Cc: up to three boxes, four people a message, one count', () => {
  it('sends a Cc to the provider and keeps it on the row — and spends ONE new message, not three', async () => {
    const { outbox, sent, messages } = await world();
    const row = await outbox.send({
      userId: USER, to: 'ada@example.com', subject: 'Tuesday', text: 'Four?',
      cc: ['bob@example.com', '', ' carol@example.com '],
    });
    expect(sent[0]!.to).toEqual([{ address: 'ada@example.com' }]);
    expect(sent[0]!.cc).toEqual([{ address: 'bob@example.com' }, { address: 'carol@example.com' }]);
    expect(row.cc).toEqual([{ address: 'bob@example.com' }, { address: 'carol@example.com' }]);
    expect(await messages.countNewSince(USER, '2000-01-01T00:00:00.000Z')).toBe(1);
  });

  it('refuses a fourth Cc box rather than quietly dropping one', async () => {
    const { outbox, sent } = await world();
    const error = await outbox.send({
      userId: USER, to: 'ada@example.com', subject: 's', text: 'w',
      cc: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailOutboxError);
    expect((error as MailOutboxError).code).toBe('too_many_recipients');
    expect(sent).toHaveLength(0);
  });

  it('reads each box as strictly as the To box: no comma, no display name, not your own address', async () => {
    const { outbox } = await world();
    const code = (cc: unknown) => outbox.previewSend({ userId: USER, to: 'ada@example.com', subject: '', text: 'w', cc })
      .then(() => 'ok', (e: MailOutboxError) => e.code);
    expect(await code(['bob@example.com, carol@example.com'])).toBe('bad_recipient');
    expect(await code(['Bob <bob@example.com>'])).toBe('bad_recipient');
    expect(await code([ME])).toBe('self_recipient');
    // Somebody already on it is not a second person.
    const preview = await outbox.previewSend({ userId: USER, to: 'ada@example.com', subject: '', text: 'w', cc: ['ADA@example.com', 'bob@example.com', 'bob@example.com'] });
    expect(preview.cc).toEqual([{ address: 'bob@example.com' }]);
  });

  it('refuses a Cc once the hour’s new messages are spent — a Cc is not a way round the ceiling', async () => {
    const { outbox } = await world();
    for (let at = 0; at < MAIL_NEW_PER_HOUR; at += 1) {
      await outbox.send({ userId: USER, to: `p${at}@example.com`, subject: '', text: 'w' });
    }
    const error = await outbox.send({ userId: USER, to: 'z@example.com', subject: '', text: 'w', cc: ['y@example.com'] })
      .catch((e: MailOutboxError) => e);
    expect(error.code).toBe('too_many');
  });
});

describe('reply to all, and a Cc that reaches somebody new', () => {
  it('offers the letter’s other recipients — never this address, never the one answered — at most three', () => {
    const letter = arrived({
      to: [{ address: ME }, { address: 'a@example.com' }, { address: 'b@example.com' }],
      cc: [{ address: 'c@example.com' }, { address: 'priya@example.com' }, { address: 'd@example.com' }],
    });
    const { all, leftOut } = replyAll(letter, { address: 'priya@example.com' });
    expect(all.map((party) => party.address)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(leftOut).toBe(1);
  });

  it('answers everybody on the letter out of the REPLY allowance, and a typed stranger out of the NEW one', async () => {
    const { outbox, messages, sent } = await world();
    await messages.store(arrived());
    expect(replyReachesNew(arrived(), [{ address: 'carol@example.com' }, { address: 'dan@example.com' }])).toBe(false);
    expect(replyReachesNew(arrived(), [{ address: 'stranger@example.com' }])).toBe(true);

    const all = await outbox.reply({ userId: USER, messageId: 'mm_in', text: 'Thanks all', cc: ['carol@example.com', 'dan@example.com'] });
    expect(sent[0]!.to).toEqual([{ name: 'Priya Raman', address: 'priya@example.com' }]);
    expect(sent[0]!.cc).toEqual([{ address: 'carol@example.com' }, { address: 'dan@example.com' }]);
    expect(all.reachesNew).toBeUndefined();
    expect(await messages.countNewSince(USER, '2000-01-01T00:00:00.000Z')).toBe(0);

    const wider = await outbox.reply({ userId: USER, messageId: 'mm_in', text: 'Looping in Eve', cc: ['eve@example.com'] });
    expect(wider.reachesNew).toBe(true);
    expect(await messages.countNewSince(USER, '2000-01-01T00:00:00.000Z')).toBe(1);
  });

  it('still answers everybody on the letter when the new allowance is spent, and refuses the stranger', async () => {
    const { outbox, messages } = await world();
    await messages.store(arrived());
    for (let at = 0; at < MAIL_NEW_PER_HOUR; at += 1) {
      await outbox.send({ userId: USER, to: `p${at}@example.com`, subject: '', text: 'w' });
    }
    await expect(outbox.reply({ userId: USER, messageId: 'mm_in', text: 'All', cc: ['carol@example.com'] })).resolves.toBeTruthy();
    const error = await outbox.reply({ userId: USER, messageId: 'mm_in', text: 'New', cc: ['eve@example.com'] })
      .catch((e: MailOutboxError) => e);
    expect(error.code).toBe('too_many');
  });

  it('never lets the Cc name the To: the answer still goes to who the letter says', async () => {
    const { outbox, messages, sent } = await world();
    await messages.store(arrived());
    await outbox.reply({ userId: USER, messageId: 'mm_in', text: 'Hi', cc: ['priya@example.com'] });
    expect(sent[0]!.cc).toBeUndefined();
  });
});

describe('files out', () => {
  it('keeps each file under the message’s own prefix, hands the provider its bytes, and lists it on the row', async () => {
    const { outbox, sent, files } = await world();
    const row = await outbox.send({
      userId: USER, to: 'ada@example.com', subject: 'Figures', text: 'Attached.',
      files: [upload('figures.csv', 'a,b\n1,2\n', 'text/csv'), upload('photo.jpg', 'JPEG', 'image/jpeg')],
    });
    expect(row.attachments.map((file) => [file.fileName, file.size, file.contentType])).toEqual([
      ['figures.csv', 8, 'text/csv'], ['photo.jpg', 4, 'image/jpeg'],
    ]);
    for (const file of row.attachments) {
      expect(file.storagePath.startsWith(mailStoragePrefix(USER, row.id))).toBe(true);
      expect(files.objects.has(file.storagePath)).toBe(true);
    }
    expect(sent[0]!.attachments!.map((file) => [file.fileName, Buffer.from(file.data).toString()])).toEqual([
      ['figures.csv', 'a,b\n1,2\n'], ['photo.jpg', 'JPEG'],
    ]);
  });

  it('refuses what cannot go before anything is counted, kept or sent', async () => {
    const { outbox, sent, files } = await world();
    const code = (list: ReturnType<typeof upload>[]) => outbox.send({ userId: USER, to: 'ada@example.com', subject: '', text: 'w', files: list })
      .then(() => 'ok', (e: MailOutboxError) => `${e.code}: ${e.message}`);
    expect(await code([upload('.env', 'SECRET=1')])).toMatch(/^bad_file: .*dot/);
    expect(await code([upload('run.exe', 'MZ')])).toMatch(/^bad_file: Mail cannot carry \.exe/);
    expect(await code([upload('big.bin', 'x'.repeat(10 * 1024 * 1024 + 1))])).toMatch(/^bad_file: .*10 MB/);
    expect(await code(Array.from({ length: 6 }, (_, at) => upload(`f${at}.txt`)))).toMatch(/^bad_file: .*at most 5/);
    expect(await code([1, 2].map((at) => upload(`half${at}.bin`, 'x'.repeat(8 * 1024 * 1024))))).toMatch(/^bad_file: .*15 MB/);
    expect(sent).toHaveLength(0);
    expect([...files.objects.keys()].filter((key) => !key.includes('/mm_in/'))).toEqual([]);
  });

  it('throws away the files it kept when the provider refuses, and stores nothing', async () => {
    const { outbox, files, messages } = await world({ send: async () => { throw new Error('refused'); } });
    await expect(outbox.send({ userId: USER, to: 'ada@example.com', subject: '', text: 'w', files: [upload('a.txt')] }))
      .rejects.toThrow('refused');
    expect([...files.objects.keys()].filter((key) => !key.includes('/mm_in/'))).toEqual([]);
    expect(await messages.countNewSince(USER, '2000-01-01T00:00:00.000Z')).toBe(0);
  });

  it('says plainly when this backend has nowhere to keep files, and still sends words', async () => {
    const { outbox } = await world({ media: false });
    const error = await outbox.send({ userId: USER, to: 'ada@example.com', subject: '', text: 'w', files: [upload('a.txt')] })
      .catch((e: MailOutboxError) => e);
    expect(error.code).toBe('files_unavailable');
    await expect(outbox.send({ userId: USER, to: 'ada@example.com', subject: '', text: 'w' })).resolves.toBeTruthy();
  });

  it('shares one refusal with the screens, so the limit is said before Send', () => {
    expect(mailOutFileRefusal({ fileName: 'notes.txt', size: 10 })).toBeNull();
    expect(mailOutFileRefusal({ fileName: 'INSTALL.MSI', size: 10 })).toMatch(/\.msi/);
    expect(mailOutFileRefusal({ fileName: '.bashrc', size: 10 })).toMatch(/dot/);
  });
});

describe('forwarding', () => {
  it('is a NEW message: it answers nothing, spends the new allowance, and is refused once that is spent', async () => {
    const { outbox, messages } = await world();
    await messages.store(arrived());
    const row = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: 'FYI' });
    expect(row.answers).toBeUndefined();
    expect(row.forwards).toBe('mm_in');
    expect(await messages.countNewSince(USER, '2000-01-01T00:00:00.000Z')).toBe(1);
    for (let at = 1; at < MAIL_NEW_PER_HOUR; at += 1) {
      await outbox.send({ userId: USER, to: `p${at}@example.com`, subject: '', text: 'w' });
    }
    const error = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: '' })
      .catch((e: MailOutboxError) => e);
    expect(error.code).toBe('too_many');
  });

  it('goes out as the person’s words over the letter, Fwd: once, with no threading headers', async () => {
    const { outbox, messages, sent } = await world();
    await messages.store(arrived());
    await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: 'See page two.', carry: [] });
    const mail = sent[0]!;
    expect(mail.subject).toBe('Fwd: The brief');
    expect(forwardSubject('Fwd: The brief')).toBe('Fwd: The brief');
    expect(forwardSubject('FW: The brief')).toBe('FW: The brief');
    expect(mail.text).toMatch(/^See page two\.\n\n---------- Forwarded message ---------\nFrom: Priya Raman <priya@example.com>\nDate: .+\nSubject: The brief\nTo: adam@agenticcloudcomputer.com, Carol <carol@example.com>\nCc: dan@example.com\n\nHere is the brief\.\nPages two and three matter\.\n$/);
    expect(mail.inReplyTo).toBeUndefined();
    expect(mail.references).toBeUndefined();
  });

  it('forwards a letter that came only as markup as its words, and says so when it was cut short', () => {
    const body = forwardBody('', arrived({ text: undefined, html: '<p>Hello&nbsp;<b>there</b></p><p>Line &amp; two</p>', bodyTruncated: true }));
    expect(body).toContain('\n\nHello there\n\nLine & two\n\n[This letter was longer');
    expect(body.startsWith('---------- Forwarded message')).toBe(true);
  });

  it('carries the letter’s files by default, only the ticked ones when told, and refuses one it does not have', async () => {
    const { outbox, messages, sent } = await world();
    await messages.store(arrived({ attachments: [arrived().attachments[0]!] }));
    const all = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: '' });
    expect(all.attachments.map((file) => file.storagePath)).toEqual(['users/user-adam/mail/mm_in/ma_brief/brief.pdf']);
    expect(Buffer.from(sent[0]!.attachments![0]!.data).toString()).toBe('%PDF-');
    const none = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: '', carry: [] });
    expect(none.attachments).toEqual([]);
    const error = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: '', carry: ['ma_nope'] })
      .catch((e: MailOutboxError) => e);
    expect(error.code).toBe('bad_file');
  });

  it('leaves a kind of file the provider refuses off by default, as the screen does, and refuses it by name', async () => {
    const { outbox, messages } = await world();
    await messages.store(arrived());
    const row = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: '' });
    expect(row.attachments.map((file) => file.fileName)).toEqual(['brief.pdf']);
    const error = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: '', carry: ['ma_tool'] })
      .catch((e: MailOutboxError) => e);
    expect(error.code).toBe('bad_file');
  });

  it('joins the letter’s conversation, is filed where it is, and never names its recipient as part of it', async () => {
    const { outbox, messages } = await world();
    await messages.store(arrived({ attachments: [] }));
    await messages.move(USER, 'mm_in', 'archive', { atIso: '2026-09-23T09:30:00.000Z' });
    const row = await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: 'FYI' });
    const conversation = (await messages.getConversation(USER, 'mm_in'))!;
    expect(conversation.messages.map((one) => one.id)).toEqual(['mm_in', row.id]);
    const facts = mailConversationFacts(conversation);
    expect(facts.place).toBe('archive');
    expect(facts.with.map((party) => party.address)).toEqual(['priya@example.com']);
    // And Sent has it, where every letter that went out is.
    const sentList = await messages.list(USER, { in: 'sent' });
    expect(sentList.messages.map((one) => one.id)).toContain(row.id);
  });

  it('refuses a letter in Trash, and one that is not this person’s', async () => {
    const { outbox, messages } = await world();
    await messages.store(arrived({ attachments: [] }));
    await messages.move(USER, 'mm_in', 'trash', { atIso: '2026-09-23T09:30:00.000Z' });
    expect((await outbox.forward({ userId: USER, messageId: 'mm_in', to: 'bob@example.com', text: '' })
      .catch((e: MailOutboxError) => e)).code).toBe('not_forwardable');
    expect((await outbox.forward({ userId: 'someone-else', messageId: 'mm_in', to: 'bob@example.com', text: '' })
      .catch((e: MailOutboxError) => e)).code).toBe('no_mailbox');
  });
});

describe('an agent’s mail with files and Cc: the card says what leaves, and the retry is the same payload', () => {
  const actor = { userId: USER, agentId: 'agent-ruby', requestedBy: 'Ruby', senderName: 'Adam B' };

  it('stages the files under the message’s future id, lists them by name and size, and sends nothing', async () => {
    const { outbox, db, files, sent } = await world();
    const approvals = new MailApprovalService(new SqliteMailApprovalStorage(db), outbox);
    const doc = await approvals.requestSend({
      ...actor, to: 'ada@example.com', subject: 'Deck', text: 'Here it is.', cc: ['bob@example.com'],
      files: [upload('deck.pdf', 'PDFDATA', 'application/pdf'), upload('notes.txt', 'n')],
    });
    expect(sent).toHaveLength(0);
    const card = (await approvals.get(USER, doc.id))!;
    expect(card.cc).toEqual([{ address: 'bob@example.com' }]);
    expect(card.attachments).toEqual([
      { fileName: 'deck.pdf', size: 7, contentType: 'application/pdf' },
      { fileName: 'notes.txt', size: 1, contentType: 'text/plain' },
    ]);
    expect(JSON.stringify(card)).not.toContain('storagePath');
    expect([...files.objects.keys()].filter((key) => key.startsWith(mailStoragePrefix(USER, doc.outboundId)))).toHaveLength(2);

    const decided = await approvals.decide({ userId: USER, id: doc.id, decision: 'approve' });
    expect(decided?.status).toBe('sent');
    expect(sent[0]!.cc).toEqual([{ address: 'bob@example.com' }]);
    expect(sent[0]!.attachments!.map((file) => file.fileName)).toEqual(['deck.pdf', 'notes.txt']);
  });

  it('hands the provider a byte-identical body under the same key when an approval is retried', async () => {
    let fail = true;
    const { outbox, db, bodies } = await world({
      sender: 'resend',
      send: async () => { if (fail) { fail = false; throw new Error('cut'); } },
    });
    const approvals = new MailApprovalService(new SqliteMailApprovalStorage(db), outbox);
    const doc = await approvals.requestSend({
      ...actor, to: 'ada@example.com', subject: 'Deck', text: 'Here it is.', cc: ['bob@example.com', 'carol@example.com'],
      files: [upload('deck.pdf', 'PDFDATA', 'application/pdf')],
    });
    await expect(approvals.decide({ userId: USER, id: doc.id, decision: 'approve' })).rejects.toThrow();
    const retried = await approvals.decide({ userId: USER, id: doc.id, decision: 'approve' });
    expect(retried?.status).toBe('sent');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    const body = JSON.parse(bodies[0]!.body) as { cc: string[]; attachments: Array<{ filename: string; content: string; content_type?: string }> };
    expect(body.cc).toEqual(['bob@example.com', 'carol@example.com']);
    expect(body.attachments).toEqual([{ filename: 'deck.pdf', content: Buffer.from('PDFDATA').toString('base64'), content_type: 'application/pdf' }]);
  });

  it('throws the staged files away when the owner says Don’t send — and never the forwarded letter’s own', async () => {
    const { outbox, db, files, messages } = await world();
    await messages.store(arrived({ attachments: [arrived().attachments[0]!] }));
    const approvals = new MailApprovalService(new SqliteMailApprovalStorage(db), outbox);
    const doc = await approvals.requestForward({
      ...actor, messageId: 'mm_in', to: 'bob@example.com', text: 'For you', files: [upload('extra.txt')],
    });
    const card = (await approvals.get(USER, doc.id))!;
    expect(card.kind).toBe('forward');
    expect(card.attachments?.map((file) => file.fileName)).toEqual(['brief.pdf', 'extra.txt']);
    expect(card.text).toContain('---------- Forwarded message ---------');
    await approvals.decide({ userId: USER, id: doc.id, decision: 'reject' });
    expect([...files.objects.keys()].filter((key) => key.startsWith(mailStoragePrefix(USER, doc.outboundId)))).toEqual([]);
    expect(files.objects.has('users/user-adam/mail/mm_in/ma_brief/brief.pdf')).toBe(true);
  });

  it('sends an approved forward as the letter it showed, and counts it as new', async () => {
    const { outbox, db, messages, sent } = await world();
    await messages.store(arrived({ attachments: [arrived().attachments[0]!] }));
    const approvals = new MailApprovalService(new SqliteMailApprovalStorage(db), outbox);
    const doc = await approvals.requestForward({ ...actor, messageId: 'mm_in', to: 'bob@example.com', text: 'For you', carry: ['ma_brief'] });
    const decided = await approvals.decide({ userId: USER, id: doc.id, decision: 'approve' });
    expect(decided?.status).toBe('sent');
    expect(sent[0]!.text).toBe(doc.text);
    const row = (await messages.get(USER, doc.outboundId))!;
    expect(row.forwards).toBe('mm_in');
    expect(row.sentBy).toEqual({ agentId: 'agent-ruby', name: 'Ruby' });
    expect(await messages.countNewSince(USER, '2000-01-01T00:00:00.000Z')).toBe(1);
  });

  it('withdraws a request whose card could not be placed, files and all', async () => {
    const { outbox, db, files } = await world();
    const approvals = new MailApprovalService(new SqliteMailApprovalStorage(db), outbox);
    const doc = await approvals.requestSend({ ...actor, to: 'ada@example.com', subject: '', text: 'w', files: [upload('a.txt')] });
    await approvals.withdraw(USER, doc.id);
    expect(await approvals.get(USER, doc.id)).toBeNull();
    expect([...files.objects.keys()].filter((key) => key.startsWith(mailStoragePrefix(USER, doc.outboundId)))).toEqual([]);
  });
});

describe('the upload envelope', () => {
  const envelope = (manifest: unknown, ...files: Buffer[]) => {
    const described = Buffer.from(JSON.stringify(manifest));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(described.length, 0);
    return Buffer.concat([prefix, described, ...files]);
  };

  it('reads the fields and each file in order, and takes plain JSON as words only', () => {
    const read = readMailUpload(envelope({
      to: 'ada@example.com', cc: ['b@example.com'], text: 'hi',
      files: [{ fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 3 }, { fileName: 'b.bin', sizeBytes: 2 }],
    }, Buffer.from('abc'), Buffer.from('de')));
    if ('error' in read) throw new Error(read.error);
    expect(read.fields).toEqual({ to: 'ada@example.com', cc: ['b@example.com'], text: 'hi' });
    expect(read.files.map((file) => [file.fileName, Buffer.from(file.data).toString()])).toEqual([['a.txt', 'abc'], ['b.bin', 'de']]);
    expect(readMailUpload({ text: 'words' })).toEqual({ fields: { text: 'words' }, files: [] });
    expect(MAIL_UPLOAD_CONTENT_TYPE).toBe('application/vnd.agentbuilt.mail-files');
  });

  it('refuses a short body, trailing bytes, a sixth file and a file over 10 MB', () => {
    const one = { fileName: 'a.txt', sizeBytes: 3 };
    expect(readMailUpload(envelope({ text: '', files: [one] }, Buffer.from('ab')))).toHaveProperty('error');
    expect(readMailUpload(envelope({ text: '', files: [one] }, Buffer.from('abcd')))).toHaveProperty('error');
    expect(readMailUpload(envelope({ text: '', files: Array.from({ length: 6 }, () => ({ fileName: 'x', sizeBytes: 1 })) }, Buffer.alloc(6))))
      .toEqual({ error: 'A message carries at most 5 files.' });
    expect(readMailUpload(envelope({ text: '', files: [{ fileName: 'big', sizeBytes: 10 * 1024 * 1024 + 1 }] }, Buffer.alloc(10 * 1024 * 1024 + 1))))
      .toHaveProperty('error');
  });
});
