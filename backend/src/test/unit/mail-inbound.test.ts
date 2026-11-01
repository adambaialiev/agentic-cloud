import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { webhookRoutes } from '../../routes/webhooks.js';
import { workspaceRoutes } from '../../routes/workspace.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';
import type { RouteDeps } from '../../routes/deps.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import type { MediaStorage } from '../../services/media-storage.js';
import {
  MAIL_MAX_BYTES,
  MailIngestError,
  MailIngestService,
  looksSuspicious,
  mailSnippet,
  normalizeEnvelopeAddress,
  readAuthentication,
  safeAttachmentName,
  scanHeaders,
} from '../../services/mail-ingest.js';

/**
 * Inbound mail (note #509, slice 2). What is worth asserting here is not that
 * a MIME parser parses — postal-mime's own tests do that — but the four
 * decisions this code makes on top of it:
 *
 *  - an address nobody holds is refused in words, so the Worker can bounce it;
 *  - everything else that goes wrong is OURS, and answers 5xx so the sending
 *    server retries instead of the sender getting a permanent refusal;
 *  - the raw bytes are stored before anything is derived from them, and a
 *    message is never dropped for being unreadable;
 *  - the same message delivered twice lands as one row, not two.
 */

const SENDER_AUTH = 'mx.cloudflare.net; dkim=pass header.d=example.com; '
  + 'spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com';

function message(overrides: { subject?: string; messageId?: string; attachment?: boolean; auth?: string } = {}): Buffer {
  const lines = [
    `Authentication-Results: ${overrides.auth ?? SENDER_AUTH}`,
    'From: "Ada Lovelace" <ada@example.com>',
    'To: adam@agenticcloudcomputer.com',
    `Subject: ${overrides.subject ?? '=?utf-8?B?SGVsbG8g4oCUIGEgdGVzdA==?='}`,
    `Message-ID: <${overrides.messageId ?? 'abc-123'}@example.com>`,
    'Date: Sun, 14 Sep 2026 09:15:00 +0000',
    'MIME-Version: 1.0',
  ];
  if (!overrides.attachment) {
    return Buffer.from([...lines, 'Content-Type: text/plain; charset=utf-8', '', 'Hello there, this is the body.', ''].join('\r\n'));
  }
  return Buffer.from([
    ...lines,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello there, this is the body.',
    '',
    '--b1',
    'Content-Type: text/csv; name="../../escape me.csv"',
    'Content-Disposition: attachment; filename="../../escape me.csv"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('a,b\n1,2\n').toString('base64'),
    '--b1--',
    '',
  ].join('\r\n'));
}

function fakeMedia() {
  const objects = new Map<string, { contentType: string; size: number }>();
  const media = {
    uploadObject: vi.fn(async (args: { storagePath: string; contentType: string; data: Buffer }) => {
      objects.set(args.storagePath, { contentType: args.contentType, size: args.data.length });
    }),
    deleteObjectsWithPrefix: vi.fn(async (args: { prefix: string }) => {
      for (const key of [...objects.keys()]) if (key.startsWith(args.prefix)) objects.delete(key);
    }),
    createReadAccess: vi.fn(async () => ({ url: 'https://files.test/signed', expiresAt: 'soon' })),
  };
  return { objects, media: media as unknown as MediaStorage, spy: media };
}

async function ingest(opts: { media?: ReturnType<typeof fakeMedia> } = {}) {
  const db = openSqliteDb(':memory:');
  const mailboxes = new SqliteMailboxStorage(db);
  const messages = new SqliteMailMessageStorage(db);
  const files = opts.media ?? fakeMedia();
  await new MailboxService(mailboxes).claim('user-adam', 'adam');
  return {
    db,
    files,
    messages,
    service: new MailIngestService({ mailboxes, messages, media: files.media }),
  };
}

describe('reading what a stranger sent', () => {
  it('reduces an envelope recipient to the address it looks up', () => {
    expect(normalizeEnvelopeAddress(' <Adam@AgenticCloudComputer.com> ')).toBe('adam@agenticcloudcomputer.com');
    expect(normalizeEnvelopeAddress('Adam <adam@agenticcloudcomputer.com>')).toBe('adam@agenticcloudcomputer.com');
    expect(normalizeEnvelopeAddress(undefined)).toBe('');
  });

  it('keeps the domain’s own verdicts and flags only what nothing vouched for', () => {
    expect(readAuthentication(SENDER_AUTH)).toMatchObject({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(looksSuspicious(readAuthentication(SENDER_AUTH))).toBe(false);
    expect(looksSuspicious(readAuthentication('mx; spf=fail; dkim=fail; dmarc=fail'))).toBe(true);
    // A forwarded message often fails SPF and still passes DKIM. That is not
    // a forgery, and a wrong "suspicious" mark on ordinary mail is worse than
    // no mark at all.
    expect(looksSuspicious(readAuthentication('mx; spf=fail; dkim=pass; dmarc=pass'))).toBe(false);
    expect(looksSuspicious(undefined)).toBe(false);
  });

  it('takes a file name apart before it becomes a storage key', () => {
    expect(safeAttachmentName('../../etc/passwd', 0)).toBe('....-..-etc-passwd'.replace(/^\.+/, ''));
    expect(safeAttachmentName('', 3)).toBe('attachment-4');
    expect(safeAttachmentName(null, 0)).toBe('attachment-1');
  });

  it('reads the top headers even when nothing else can be read', () => {
    const headers = scanHeaders(Buffer.from(
      'Subject: one\r\n long subject\r\nFrom: ada@example.com\r\n\r\nbody\r\n',
    ));
    expect(headers.get('subject')).toBe('one long subject');
    expect(headers.get('from')).toBe('ada@example.com');
  });

  it('makes one line out of a body, whichever half it has', () => {
    expect(mailSnippet('  Hello\n\nthere  ', undefined)).toBe('Hello there');
    expect(mailSnippet(undefined, '<style>p{}</style><p>Hi <b>you</b></p>')).toBe('Hi you');
    expect(mailSnippet('x'.repeat(400), undefined)).toHaveLength(200);
  });
});

describe('MailIngestService', () => {
  it('stores the raw bytes, the parsed message and its files, and answers the Worker’s question first', async () => {
    const { service, messages, files } = await ingest();
    expect(await service.deliverable('ADAM@agenticcloudcomputer.com'))
      .toEqual({ address: 'adam@agenticcloudcomputer.com', deliverable: true });
    expect(await service.deliverable('nobody@agenticcloudcomputer.com'))
      .toEqual({ address: 'nobody@agenticcloudcomputer.com', deliverable: false });

    const result = await service.accept({
      to: 'adam@agenticcloudcomputer.com',
      from: 'bounces@example.com',
      raw: message({ attachment: true }),
    });
    expect(result.duplicate).toBe(false);

    const stored = await messages.get('user-adam', result.id);
    expect(stored).toMatchObject({
      address: 'adam@agenticcloudcomputer.com',
      envelopeFrom: 'bounces@example.com',
      subject: 'Hello — a test',
      messageId: 'abc-123@example.com',
      from: { address: 'ada@example.com', name: 'Ada Lovelace' },
      snippet: 'Hello there, this is the body.',
      sentAt: '2026-09-14T09:15:00.000Z',
    });
    expect(stored?.suspicious).toBeUndefined();
    expect(stored?.authentication?.dmarc).toBe('pass');
    // The raw copy is the message; everything above is what we made of it.
    expect(files.objects.get(stored!.raw.storagePath)?.contentType).toBe('message/rfc822');
    expect(stored!.raw.size).toBeGreaterThan(0);
    // A file name a sender chose cannot climb out of the message's prefix.
    expect(stored!.attachments).toHaveLength(1);
    const attachment = stored!.attachments[0]!;
    expect(attachment.fileName).not.toContain('/');
    expect(attachment.storagePath.startsWith(`users/user-adam/mail/${result.id}/`)).toBe(true);
    expect(files.objects.get(attachment.storagePath)?.size).toBe(8);
  });

  it('lands a redelivered message as the same row and leaves no second copy of its bytes', async () => {
    const { service, messages, files } = await ingest();
    const first = await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: message({ attachment: true }) });
    const again = await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: message({ attachment: true }) });
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect((await messages.list('user-adam')).messages).toHaveLength(1);
    // The second delivery's uploads are cleaned up; the first message's are not.
    expect([...files.objects.keys()].every((key) => key.includes(first.id))).toBe(true);
  });

  /**
   * The arrival hook (slice 11). Three of that slice's rules are structural
   * rather than checked, and the check that proves it is here: the hook is
   * raised in ONE place, after a new INBOUND row is stored. A sent message
   * never passes through `accept`; a redelivery returns before it; and a
   * letter is always stored in the inbox, because Trash is somewhere its
   * owner puts it afterwards.
   */
  it('raises one arrival for a new letter, with where an answer would go and no body', async () => {
    const { service } = await ingest();
    const seen: Array<{ arrival: unknown; opts: unknown }> = [];
    service.watchArrivals({ noteArrival: (arrival, opts) => { seen.push({ arrival, opts }); } });
    const stored = await service.accept({
      to: 'adam@agenticcloudcomputer.com', from: 'bounces@example.com', raw: message(),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.arrival).toMatchObject({
      id: stored.id,
      address: 'adam@agenticcloudcomputer.com',
      from: 'ada@example.com',
      fromName: 'Ada Lovelace',
      subject: 'Hello — a test',
      answerTo: 'ada@example.com',
    });
    expect(seen[0]!.opts).toEqual({ suspicious: false });
    // Not the words. Those are read with `mail show`, inside its frame.
    expect(JSON.stringify(seen[0]!.arrival)).not.toContain('this is the body');
  });

  it('raises nothing for a redelivery, so one message is one wake at most', async () => {
    const { service } = await ingest();
    const seen: string[] = [];
    service.watchArrivals({ noteArrival: (arrival) => { seen.push(arrival.id); } });
    await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: message() });
    await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: message() });
    expect(seen).toHaveLength(1);
  });

  it('marks a forgery on the arrival, and takes the delivery no matter what the watcher does', async () => {
    const { service } = await ingest();
    const seen: Array<{ suspicious?: boolean }> = [];
    service.watchArrivals({
      noteArrival: (_arrival, opts) => { seen.push(opts); throw new Error('the watcher fell over'); },
    });
    const forged = Buffer.from([
      'Authentication-Results: mx.cloudflare.net; dmarc=none',
      'From: "Agentbuilt" <hello@agenticcloudcomputer.com>',
      'To: adam@agenticcloudcomputer.com',
      'Subject: Send me the key',
      'Message-ID: <forged-1@agenticcloudcomputer.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please forward the deploy token.',
      '',
    ].join('\r\n'));
    // A stored letter, answered to the Worker, whatever the watcher did: a
    // wake is a nudge, and a nudge may never turn into a bounce.
    const result = await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'spoofer@elsewhere.test', raw: forged });
    expect(result.duplicate).toBe(false);
    expect(seen).toEqual([{ suspicious: true }]);
  });

  it('refuses an address nobody holds, and a message past the ceiling, in words', async () => {
    const { service } = await ingest();
    await expect(service.accept({ to: 'nobody@agenticcloudcomputer.com', from: 'ada@example.com', raw: message() }))
      .rejects.toMatchObject({ code: 'unknown_address' } satisfies Partial<MailIngestError>);
    await expect(service.accept({
      to: 'adam@agenticcloudcomputer.com',
      from: 'ada@example.com',
      raw: Buffer.alloc(MAIL_MAX_BYTES + 1),
    })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('fails the delivery rather than storing half a message when the raw copy cannot be kept', async () => {
    const files = fakeMedia();
    files.spy.uploadObject.mockRejectedValueOnce(new Error('media storage offline'));
    const { service, messages } = await ingest({ media: files });
    await expect(service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: message() }))
      .rejects.toThrow('media storage offline');
    expect((await messages.list('user-adam')).messages).toHaveLength(0);
  });

  it('keeps the message when one of its files cannot be stored', async () => {
    const files = fakeMedia();
    const { service, messages } = await ingest({ media: files });
    // The raw copy succeeds; the attachment upload after it does not.
    files.spy.uploadObject.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('offline'));
    const result = await service.accept({
      to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: message({ attachment: true }),
    });
    const stored = await messages.get('user-adam', result.id);
    expect(stored?.attachments).toEqual([]);
    expect(stored?.subject).toBe('Hello — a test');
  });

  it('pages newest first', async () => {
    const { service, messages } = await ingest();
    for (const id of ['one', 'two', 'three']) {
      await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: message({ messageId: id }) });
    }
    const first = await messages.list('user-adam', { limit: 2 });
    expect(first.messages).toHaveLength(2);
    expect(first.nextBefore).toBeDefined();
    const rest = await messages.list('user-adam', { limit: 2, before: first.nextBefore });
    expect(rest.messages).toHaveLength(1);
    expect(rest.nextBefore).toBeUndefined();
    // Nobody else's list, whatever id they ask with.
    expect((await messages.list('user-someone-else')).messages).toEqual([]);
    expect(await messages.get('user-someone-else', first.messages[0]!.id)).toBeNull();
  });
});

describe('the ingest routes the Email Worker calls', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  async function serve(overrides: Partial<RouteDeps> = {}) {
    const { service, messages, files, db } = await ingest();
    const app = express();
    app.use('/api/webhooks/mail/inbound', express.raw({ type: () => true, limit: '26mb' }));
    app.use(express.json());
    app.use('/api/webhooks', webhookRoutes({
      mailIngest: service,
      mailMessages: messages,
      mailIngestSecret: 'shared-secret',
      ...overrides,
    } as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, messages, files, db };
  }

  const post = (origin: string, raw: Buffer, headers: Record<string, string>) => fetch(
    `${origin}/api/webhooks/mail/inbound`,
    { method: 'POST', headers: { 'content-type': 'message/rfc822', ...headers }, body: new Uint8Array(raw) },
  );

  it('takes a message in, and reads the same one back as already had', async () => {
    const { origin, messages } = await serve();
    const auth = { authorization: 'Bearer shared-secret', 'x-mail-to': 'adam@agenticcloudcomputer.com', 'x-mail-from': 'ada@example.com' };
    const accepted = await post(origin, message(), auth);
    expect(accepted.status).toBe(202);
    const body = await accepted.json() as { id: string; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    const again = await post(origin, message(), auth);
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ id: body.id, duplicate: true });
    expect((await messages.list('user-adam')).messages).toHaveLength(1);
  });

  it('answers the address question, and refuses an address nobody holds with a 404 the Worker bounces on', async () => {
    const { origin } = await serve();
    const headers = { authorization: 'Bearer shared-secret' };
    const known = await fetch(`${origin}/api/webhooks/mail/address?to=adam@agenticcloudcomputer.com`, { headers });
    expect(await known.json()).toMatchObject({ deliverable: true });
    const unknown = await fetch(`${origin}/api/webhooks/mail/address?to=nobody@agenticcloudcomputer.com`, { headers });
    expect(await unknown.json()).toMatchObject({ deliverable: false });

    const refused = await post(origin, message(), {
      ...headers, 'x-mail-to': 'nobody@agenticcloudcomputer.com', 'x-mail-from': 'ada@example.com',
    });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: 'unknown_address' });
  });

  it('refuses a caller without the secret, and says nothing about the address', async () => {
    const { origin } = await serve();
    const noSecret = await fetch(`${origin}/api/webhooks/mail/address?to=adam@agenticcloudcomputer.com`);
    expect(noSecret.status).toBe(401);
    expect(await noSecret.text()).not.toContain('deliverable');
    const wrong = await fetch(`${origin}/api/webhooks/mail/address?to=adam@agenticcloudcomputer.com`, {
      headers: { authorization: 'Bearer shared-secre' },
    });
    expect(wrong.status).toBe(401);
    expect((await post(origin, message(), { authorization: 'Bearer nope', 'x-mail-to': 'adam@agenticcloudcomputer.com' })).status).toBe(401);
  });

  it('says it is not configured — never that the address is unknown — when inbound mail is off', async () => {
    const { origin } = await serve({ mailIngest: undefined, mailIngestSecret: undefined });
    const answer = await fetch(`${origin}/api/webhooks/mail/address?to=adam@agenticcloudcomputer.com`, {
      headers: { authorization: 'Bearer shared-secret' },
    });
    expect(answer.status).toBe(503);
  });
});

describe('the owner’s own reads', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('shows one person their inbox and nobody else’s, and hands back the original message too', async () => {
    const db = openSqliteDb(':memory:');
    const mailboxes = new SqliteMailboxStorage(db);
    const messages = new SqliteMailMessageStorage(db);
    const files = fakeMedia();
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    await new MailboxService(mailboxes).claim('alice', 'alice');
    const service = new MailIngestService({ mailboxes, messages, media: files.media });
    const delivered = await service.accept({
      to: 'alice@agenticcloudcomputer.com', from: 'ada@example.com', raw: message({ attachment: true }),
    });

    const deps: Partial<RouteDeps> = { userStorage: users, mailMessages: messages, mediaStorage: files.media,
      mailboxes: new MailboxService(mailboxes) };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const read = (path: string, identity: number) => fetch(`${origin}/workspace/api/${path}`, { headers: workspaceTestHeaders(identity) });

    expect((await fetch(`${origin}/workspace/api/mail/messages`)).status).toBe(401);

    const inbox = async () => (await (await read('mail/messages', 42)).json() as {
      address: string; messages: { id: string; subject: string; files: number; unread?: boolean }[];
    });
    const list = await inbox();
    expect(list.address).toBe('alice@agenticcloudcomputer.com');
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]).toMatchObject({ id: delivered.id, subject: 'Hello — a test', files: 1 });
    // It has arrived and nobody has opened it: the row the list draws heavy.
    expect(list.messages[0]!.unread).toBe(true);
    // And the number the door on Home wears — a count, and nothing else.
    const counted = async (identity: number) => (await (await read('mail/unread', identity)).json() as { unread: number }).unread;
    expect(await counted(42)).toBe(1);
    expect(await counted(43)).toBe(0);

    const detail = await (await read(`mail/messages/${delivered.id}`, 42)).json() as {
      message: { text: string; attachments: { id: string }[]; authentication: { dmarc: string }; rawSize: number; unread?: boolean };
    };
    // Opening it is reading it — on the message handed back, and from now on
    // in the list, on this phone and on every other screen she signs in to.
    expect(detail.message.unread).toBeUndefined();
    expect((await inbox()).messages[0]!.unread).toBeUndefined();
    expect(await counted(42)).toBe(0);
    expect(detail.message.text).toContain('Hello there');
    expect(detail.message.authentication.dmarc).toBe('pass');
    expect(detail.message.rawSize).toBeGreaterThan(0);

    // An answer her AGENT wrote from her address is named as its agent's,
    // where she reads it. The row her list draws for a sent message has said
    // so since slice 6 and `agentbuilt mail show` prints it; her own message
    // screen used to show an agent's reply as if she had typed it (note #545).
    await messages.store({
      id: 'mm_answer', direction: 'sent', answers: delivered.id,
      sentBy: { agentId: 'ag_1', name: 'Ruby' },
      userId: 'alice', address: 'alice@agenticcloudcomputer.com', envelopeFrom: 'alice@agenticcloudcomputer.com',
      receivedAt: new Date().toISOString(),
      from: { address: 'alice@agenticcloudcomputer.com' }, to: [{ address: 'ada@example.com' }], cc: [], replyTo: [],
      subject: 'Re: Hello — a test', snippet: 'On its way.', text: 'On its way.\n\n> Hello there', wrote: 'On its way.',
      attachments: [], raw: { storagePath: '', size: 11 },
    });
    const answered = await (await read(`mail/messages/${delivered.id}`, 42)).json() as {
      message: { replies: { id: string; text: string; sentBy?: string }[] };
    };
    expect(answered.message.replies).toHaveLength(1);
    // What she WROTE, not what went out with the quote under it — and who.
    expect(answered.message.replies[0]).toMatchObject({ id: 'mm_answer', text: 'On its way.', sentBy: 'Ruby' });

    // The original message is a file like any other, so an unreadable one is
    // still something its owner can download and open elsewhere.
    const raw = await (await read(`mail/messages/${delivered.id}/files/raw`, 42)).json() as { url: string; fileName: string };
    expect(raw.url).toBe('https://files.test/signed');
    expect(raw.fileName.endsWith('.eml')).toBe(true);
    const file = await read(`mail/messages/${delivered.id}/files/${detail.message.attachments[0]!.id}`, 42);
    expect(file.status).toBe(200);

    // Bob knows the id and is still told there is no such message.
    expect((await read('mail/messages', 43)).status).toBe(200);
    expect((await (await read('mail/messages', 43)).json() as { messages: unknown[] }).messages).toEqual([]);
    expect((await read(`mail/messages/${delivered.id}`, 43)).status).toBe(404);
    expect((await read(`mail/messages/${delivered.id}/files/raw`, 43)).status).toBe(404);
  });
});

describe('nobody else may claim to be us', () => {
  /**
   * A mail service on its own domain has one impersonation that matters: a
   * message wearing an address here. Our DMARC policy is `p=none`, so the
   * domain's own checks call a forgery `dmarc=none` rather than `fail` —
   * measured in production on 2026-09-14, where exactly such a message
   * arrived unmarked. The rule below is what marks it instead.
   */
  const ours = 'billing@agenticcloudcomputer.com';

  it('marks a message from an address here that DKIM did not sign', () => {
    expect(looksSuspicious(readAuthentication('mx; spf=none; dmarc=none'), ours)).toBe(true);
    expect(looksSuspicious(undefined, ours)).toBe(true);
    // Our own mail proves itself, and is not marked.
    expect(looksSuspicious(readAuthentication('mx; dkim=pass; dmarc=pass'), ours)).toBe(false);
  });

  it('leaves another domain to its own rules', () => {
    // The same unproven verdicts from somebody else's domain are ordinary.
    expect(looksSuspicious(readAuthentication('mx; spf=none; dmarc=none'), 'ada@example.com')).toBe(false);
    expect(looksSuspicious(readAuthentication('mx; dmarc=fail'), 'ada@example.com')).toBe(true);
  });

  it('stores the mark on a message that wears one of our addresses', async () => {
    const { service, messages } = await ingest();
    const forged = Buffer.from([
      'Authentication-Results: mx.cloudflare.net; spf=none; dmarc=none',
      'From: "Billing" <billing@agenticcloudcomputer.com>',
      'To: adam@agenticcloudcomputer.com',
      'Subject: Your invoice is overdue',
      'Message-ID: <forged-1@agenticcloudcomputer.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Pay here.',
      '',
    ].join('\r\n'));
    const result = await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'someone@elsewhere.test', raw: forged });
    expect((await messages.get('user-adam', result.id))?.suspicious).toBe(true);
  });
});

describe('who a letter wakes (slice 11)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  /**
   * The opt-in in Settings. What matters here is that the default really is
   * NOBODY, that the roster a person chooses from is their OWN agents, and
   * that a choice which has gone away reads as nobody — plus the line
   * Settings needs to say so, which is the only place that can be said.
   */
  async function serve() {
    const db = openSqliteDb(':memory:');
    const mailboxStorage = new SqliteMailboxStorage(db);
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    await new MailboxService(mailboxStorage).claim('alice', 'alice');
    await users.updateProfile('alice', { telegram: { agents: {
      ruby: { id: 'ruby', name: 'Ruby', cli: 'claude', orgId: 'org-1' },
      gus: { id: 'gus', name: 'Gus', cli: 'codex', orgId: 'org-1' },
      // The Workspace Agent is never woken by an event from outside the
      // platform, exactly as it is never woken by its machine's jobs.
      desk: { id: 'desk', name: 'Workspace Agent', cli: 'claude', orgId: 'org-1', purpose: 'workspace' },
    } } as never });
    await users.updateProfile('bob', { telegram: { agents: {
      otto: { id: 'otto', name: 'Otto', cli: 'claude', orgId: 'org-2' },
    } } as never });
    const deps: Partial<RouteDeps> = {
      userStorage: users,
      mailboxes: new MailboxService(mailboxStorage),
      orgStorage: {
        listMembershipsByUser: async () => [],
        getOrg: async () => null,
        getMembership: async () => null,
      } as unknown as RouteDeps['orgStorage'],
    };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    type Answer = {
      agent: { id: string; name: string } | null;
      agents: { id: string; name: string; cli?: string }[];
      lapsed?: true;
    };
    return {
      mailboxStorage,
      read: async (identity = 42) => (await fetch(`${origin}/workspace/api/mail/wake`, {
        headers: workspaceTestHeaders(identity),
      })).json() as Promise<Answer>,
      write: (agentId: string | null, identity = 42) => fetch(`${origin}/workspace/api/mail/wake`, {
        method: 'PUT',
        headers: { ...workspaceTestHeaders(identity), 'content-type': 'application/json' },
        body: JSON.stringify({ agentId }),
      }),
      origin,
    };
  }

  it('starts at nobody, offers this person their own agents, and takes a choice', async () => {
    const { read, write, mailboxStorage } = await serve();
    const before = await read();
    expect(before.agent).toBeNull();
    expect(before.lapsed).toBeUndefined();
    // Their own agents, by name and harness — and not the Workspace Agent.
    // There are no rooms to name them with (note #923).
    expect(before.agents.map((one) => one.id).sort()).toEqual(['gus', 'ruby']);
    expect(before.agents.find((one) => one.id === 'ruby')).toEqual({ id: 'ruby', name: 'Ruby', cli: 'claude' });

    const written = await write('ruby');
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ agent: { id: 'ruby', name: 'Ruby' } });
    expect((await mailboxStorage.getByUser('alice'))?.wakeAgentId).toBe('ruby');
    expect((await read()).agent).toMatchObject({ id: 'ruby' });

    // And back to nobody, which is what the row's first choice writes.
    expect((await write(null)).status).toBe(200);
    expect((await read()).agent).toBeNull();
    expect((await mailboxStorage.getByUser('alice'))?.wakeAgentId).toBeUndefined();
  });

  it('refuses an agent that is not this person’s, and the Workspace Agent with it', async () => {
    const { read, write, mailboxStorage } = await serve();
    expect((await write('otto')).status).toBe(404);
    expect((await write('desk')).status).toBe(404);
    expect((await write('nobody-at-all')).status).toBe(404);
    expect((await mailboxStorage.getByUser('alice'))?.wakeAgentId).toBeUndefined();
    expect((await read()).agent).toBeNull();
  });

  it('reads a choice whose agent is gone as nobody, and says so — the wake itself never can', async () => {
    const { read, write, mailboxStorage } = await serve();
    await write('ruby');
    // The agent is deleted out from under the setting.
    await mailboxStorage.setWakeAgent('alice', 'ruby-who-left');
    const answer = await read();
    expect(answer.agent).toBeNull();
    expect(answer.lapsed).toBe(true);
  });

  it('is one person’s own setting, and nobody else’s to read', async () => {
    const { read, origin } = await serve();
    // Bob holds no address at all, so there is nothing here for him.
    expect((await read(43)).agent).toBeNull();
    expect((await fetch(`${origin}/workspace/api/mail/wake`)).status).toBe(401);
  });
});
