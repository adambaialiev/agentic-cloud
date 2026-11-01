import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { workspaceRoutes } from '../../routes/workspace.js';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { ensureMailSuspiciousFiled, openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { MailIngestService } from '../../services/mail-ingest.js';
import { mailConversationPlace } from '../../services/mail-threads.js';
import { mailPlaceOf } from '../../services/mail-places.js';
import type { MediaStorage } from '../../services/media-storage.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * Spam, and blocking a sender (note #509, slice 13).
 *
 * What is worth a test is the promises: a letter nothing vouched for lands in
 * Spam on the way in rather than the inbox, and one from a blocked sender
 * with it — still whole, still its owner's, one move from the inbox; a search
 * from the inbox never reaches into Spam; nothing that lands there wakes
 * anybody it should not; blocking takes what the sender already sent out of
 * the inbox with them; and the boot pass files what was already here exactly
 * once, leaving alone what its owner has since said is not spam.
 */

let seq = 0;
const MINE = 'alice@agenticcloudcomputer.com';
const letter = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => {
  seq += 1;
  return {
    id: `mm_${seq}`,
    userId: 'alice',
    address: MINE,
    envelopeFrom: 'bounces@example.com',
    receivedAt: new Date(Date.UTC(2026, 8, 1, 9, seq)).toISOString(),
    messageId: `m${seq}@example.com`,
    from: { name: 'Ada Lovelace', address: 'ada@example.com' },
    to: [{ address: MINE }],
    cc: [],
    replyTo: [],
    subject: 'The engine',
    snippet: 'It weaves algebraic patterns.',
    text: 'It weaves algebraic patterns.',
    attachments: [],
    raw: { storagePath: `users/alice/mail/mm_${seq}/raw.eml`, size: 100 },
    ...over,
  };
};
const ids = (page: { messages: { id: string }[] }) => page.messages.map((message) => message.id);
const AT = '2026-09-23T10:00:00.000Z';
const RUBY = { agentId: 'agent-r', name: 'Ruby' };

async function mailbox() {
  const db = openSqliteDb(':memory:');
  const messages = new SqliteMailMessageStorage(db);
  const brief = letter({ from: { name: 'Priya Raman', address: 'priya@harborlight.co' }, subject: 'The brief', text: 'Here is the brief.' });
  const crop = letter({ from: { name: 'Priya Raman', address: 'Priya@Harborlight.co' }, subject: 'The crop', text: 'And the crop.' });
  const invoice = letter({ from: { name: 'Fly.io', address: 'billing@fly.io' }, subject: 'Your September invoice', text: 'Invoice 4821.' });
  const reply = letter({
    direction: 'sent', answers: brief.id, from: { address: MINE }, to: [brief.from!],
    subject: 'Re: The brief', text: 'Looks right.', wrote: 'Looks right.', messageId: 'ours-1@agenticcloudcomputer.com',
  });
  for (const doc of [brief, crop, invoice, reply]) await messages.store(doc);
  return { db, messages, brief, crop, invoice, reply };
}

describe('where a letter is kept, with Spam in the middle', () => {
  it('ranks Trash over Spam over the archive, and names the agent that marked it', () => {
    expect(mailPlaceOf({ spamAt: AT })).toBe('spam');
    expect(mailPlaceOf({ spamAt: AT, archivedAt: AT })).toBe('spam');
    expect(mailPlaceOf({ spamAt: AT, trashedAt: AT })).toBe('trash');
    expect(mailConversationPlace([letter({ spamAt: AT }), letter({ trashedAt: AT })])).toBe('spam');
    expect(mailConversationPlace([letter({ spamAt: AT }), letter({ archivedAt: AT })])).toBe('archive');
    expect(mailConversationPlace([letter({ spamAt: AT }), letter()])).toBe('inbox');
  });

  it('marks a letter spam, keeps it whole and out of every search but Spam’s own, and Not spam brings it back', async () => {
    const { messages, brief, invoice } = await mailbox();
    expect(await messages.countUnread('alice')).toBe(3);
    const marked = await messages.move('alice', invoice.id, 'spam', { atIso: AT, by: RUBY });
    expect(marked).toMatchObject({ moved: true, doc: { id: invoice.id, spamAt: AT, spamWhy: 'marked', spamBy: RUBY } });
    expect(ids(await messages.list('alice'))).not.toContain(invoice.id);
    expect(ids(await messages.list('alice', { in: 'spam' }))).toEqual([invoice.id]);
    // Dealt with: the door on Home stops counting it.
    expect(await messages.countUnread('alice')).toBe(2);
    // Whole.
    expect(await messages.get('alice', invoice.id)).toMatchObject({ text: invoice.text, raw: invoice.raw });
    // A search from the inbox does NOT reach into Spam; a search of Spam does.
    expect(ids(await messages.list('alice', { search: 'invoice' }))).toEqual([]);
    expect(ids(await messages.list('alice', { search: 'invoice', in: 'all' }))).toEqual([]);
    expect(ids(await messages.list('alice', { search: 'invoice', in: 'spam' }))).toEqual([invoice.id]);
    // The way out of Spam is Not spam; archiving from there is refused.
    expect(await messages.move('alice', invoice.id, 'archive', { atIso: AT })).toEqual({ refused: 'in_spam' });
    expect(await messages.move('alice', invoice.id, 'spam', { atIso: AT })).toMatchObject({ moved: false });
    const back = await messages.move('alice', invoice.id, 'unspam', { atIso: AT });
    expect(back).toMatchObject({ moved: true, doc: { id: invoice.id, notSpam: true } });
    expect((await messages.get('alice', invoice.id))).not.toHaveProperty('spamAt');
    expect((await messages.get('alice', invoice.id))).not.toHaveProperty('spamWhy');
    expect(ids(await messages.list('alice'))).toContain(invoice.id);
    // Trash wins over Spam, and Restore puts a spam letter back in Spam.
    await messages.move('alice', brief.id, 'spam', { atIso: AT });
    await messages.move('alice', brief.id, 'trash', { atIso: AT });
    expect(ids(await messages.list('alice', { in: 'spam' }))).toEqual([]);
    expect(ids(await messages.list('alice', { in: 'trash' }))).toEqual([brief.id]);
    expect(await messages.move('alice', brief.id, 'unspam', { atIso: AT })).toEqual({ refused: 'in_trash' });
    await messages.move('alice', brief.id, 'restore', { atIso: AT });
    expect(ids(await messages.list('alice', { in: 'spam' }))).toEqual([brief.id]);
    // The reply under the brief went with it, as every reply does.
    expect(mailPlaceOf((await messages.listAnswers('alice', brief.id))[0]!)).toBe('spam');
  });

  it('lists a conversation in Spam only while none of it is in front of the reader', async () => {
    const { messages, brief, reply } = await mailbox();
    await messages.moveConversation('alice', reply.id, 'spam', { atIso: AT });
    const spam = await messages.listConversations('alice', { in: 'spam' });
    expect(spam.conversations.map((conversation) => conversation.messages.map((message) => message.id))).toEqual([[brief.id, reply.id]]);
    expect((await messages.listConversations('alice')).conversations.some((one) => one.thread === brief.id)).toBe(false);
    expect(await messages.moveConversation('alice', brief.id, 'archive', { atIso: AT })).toEqual({ refused: 'in_spam' });
    expect(await messages.moveConversation('alice', brief.id, 'unspam', { atIso: AT })).toMatchObject({ moved: true });
    expect((await messages.listConversations('alice')).conversations.some((one) => one.thread === brief.id)).toBe(true);
  });
});

describe('blocking a sender', () => {
  it('takes everything of theirs out of the inbox and the archive into Spam, named, and leaves Trash and others alone', async () => {
    const { messages, brief, crop, invoice, reply } = await mailbox();
    await messages.move('alice', crop.id, 'archive', { atIso: AT });
    const blocked = await messages.blockSender('alice', 'PRIYA@harborlight.co', { atIso: AT, by: RUBY });
    expect(blocked).toEqual({ addresses: ['priya@harborlight.co'], moved: 2 });
    expect(ids(await messages.list('alice', { in: 'spam' }))).toEqual([crop.id, brief.id]);
    expect(await messages.get('alice', brief.id)).toMatchObject({ spamAt: AT, spamWhy: 'blocked', spamBy: RUBY });
    expect(ids(await messages.list('alice'))).toEqual([invoice.id]);
    expect(ids(await messages.list('alice', { in: 'archive' }))).toEqual([]);
    // The reply under the brief is filed with it.
    expect(mailPlaceOf((await messages.get('alice', reply.id))!)).toBe('spam');
    // Twice is not an error and moves nothing more.
    expect(await messages.blockSender('alice', 'priya@harborlight.co', { atIso: AT })).toEqual({ addresses: ['priya@harborlight.co'], moved: 0 });
    // Unblocking moves nothing back: Not spam is a decision about a letter.
    expect(await messages.unblockSender('alice', 'priya@harborlight.co')).toEqual([]);
    expect(ids(await messages.list('alice', { in: 'spam' }))).toEqual([crop.id, brief.id]);
    // And Bob's list is Bob's.
    expect(await messages.blockedSenders('bob')).toEqual([]);
  });
});

function fakeMedia(): MediaStorage {
  return {
    uploadObject: vi.fn(async () => undefined),
    deleteObjectsWithPrefix: vi.fn(async () => undefined),
    createReadAccess: vi.fn(async () => ({ url: 'https://files.test/signed', expiresAt: 'soon' })),
  } as unknown as MediaStorage;
}
const raw = (from: string, auth: string, subject = 'Hello') => Buffer.from([
  `Authentication-Results: ${auth}`,
  `From: ${from}`,
  'To: adam@agenticcloudcomputer.com',
  `Subject: ${subject}`,
  `Message-ID: <${Math.random().toString(36).slice(2)}@example.com>`,
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello there.',
  '',
].join('\r\n'));

describe('on the way in', () => {
  async function ingest() {
    const db = openSqliteDb(':memory:');
    const mailboxes = new SqliteMailboxStorage(db);
    const messages = new SqliteMailMessageStorage(db);
    await new MailboxService(mailboxes).claim('user-adam', 'adam');
    const service = new MailIngestService({ mailboxes, messages, media: fakeMedia() });
    const seen: Array<{ id: string; suspicious?: boolean }> = [];
    service.watchArrivals({ noteArrival: (arrival, opts) => { seen.push({ id: arrival.id, ...opts }); } });
    return { messages, service, seen };
  }

  it('files a letter nothing vouched for into Spam, counted but unquoted for the wake, and an ordinary one into the inbox', async () => {
    const { messages, service, seen } = await ingest();
    const forged = await service.accept({
      to: 'adam@agenticcloudcomputer.com', from: 'spoofer@elsewhere.test',
      raw: raw('"Agentbuilt" <hello@agenticcloudcomputer.com>', 'mx.cloudflare.net; dmarc=none', 'Send me the key'),
    });
    const fine = await service.accept({
      to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com',
      raw: raw('"Ada Lovelace" <ada@example.com>', 'mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass; dmarc=pass'),
    });
    expect(await messages.get('user-adam', forged.id)).toMatchObject({ suspicious: true, spamWhy: 'suspicious' });
    expect(ids(await messages.list('user-adam'))).toEqual([fine.id]);
    expect(ids(await messages.list('user-adam', { in: 'spam' }))).toEqual([forged.id]);
    expect(await messages.countUnread('user-adam')).toBe(1);
    expect(seen).toEqual([{ id: forged.id, suspicious: true }, { id: fine.id, suspicious: false }]);
  });

  it('files a blocked sender’s letter into Spam and raises no arrival for it at all', async () => {
    const { messages, service, seen } = await ingest();
    await messages.blockSender('user-adam', 'ada@example.com', { atIso: AT });
    const theirs = await service.accept({
      to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com',
      raw: raw('"Ada Lovelace" <Ada@Example.com>', 'mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass; dmarc=pass'),
    });
    const stored = await messages.get('user-adam', theirs.id);
    expect(stored).toMatchObject({ spamWhy: 'blocked', spamAt: stored!.receivedAt });
    expect(stored!.text).toContain('Hello there.');
    expect(ids(await messages.list('user-adam', { in: 'spam' }))).toEqual([theirs.id]);
    expect(seen).toEqual([]);
  });
});

describe('the mail already here', () => {
  it('is filed into Spam once, at the moment it arrived, and what its owner said is not spam stays put', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const forged = letter({ suspicious: true });
    const trashed = letter({ suspicious: true, trashedAt: AT });
    const cleared = letter({ suspicious: true, notSpam: true });
    const fine = letter();
    for (const doc of [forged, trashed, cleared, fine]) await messages.store(doc);
    ensureMailSuspiciousFiled(db);
    expect(await messages.get('alice', forged.id)).toMatchObject({ spamAt: forged.receivedAt, spamWhy: 'suspicious' });
    expect(await messages.get('alice', trashed.id)).not.toHaveProperty('spamAt');
    expect(await messages.get('alice', cleared.id)).not.toHaveProperty('spamAt');
    expect(await messages.get('alice', fine.id)).not.toHaveProperty('spamAt');
    // Not spam, then the pass again: it stays where its owner put it.
    await messages.move('alice', forged.id, 'unspam', { atIso: AT });
    ensureMailSuspiciousFiled(db);
    expect(await messages.get('alice', forged.id)).not.toHaveProperty('spamAt');
  });
});

describe('the owner’s Workspace', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('marks, unmarks, blocks and unblocks through the routes, refuses its own address, and says why a letter is in Spam', async () => {
    const { messages, brief, invoice } = await mailbox();
    const db = openSqliteDb(':memory:');
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    const mailboxes = new MailboxService(new SqliteMailboxStorage(db));
    await mailboxes.claim('alice', 'alice');
    const deps: Partial<RouteDeps> = { userStorage: users, mailMessages: messages, mailboxes };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (apiPath: string, method = 'GET', body?: unknown) => fetch(`${origin}/workspace/api/${apiPath}`, {
      method, headers: { ...workspaceTestHeaders(42), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const listed = async (apiPath: string) => ((await (await call(apiPath)).json()) as { messages: { id: string; place?: string; spamWhy?: string }[] }).messages;

    const marked = await call(`mail/messages/${invoice.id}/spam`, 'POST');
    expect(((await marked.json()) as { message: { place?: string; spamWhy?: string } }).message).toMatchObject({ place: 'spam', spamWhy: 'marked' });
    expect(await listed('mail/messages?in=spam')).toEqual([expect.objectContaining({ id: invoice.id, place: 'spam', spamWhy: 'marked' })]);
    expect((await listed('mail/messages?q=invoice')).map((message) => message.id)).toEqual([]);
    const refused = await call(`mail/messages/${invoice.id}/archive`, 'POST');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('in_spam');
    expect((await call(`mail/messages/${invoice.id}/unspam`, 'POST')).status).toBe(200);
    expect((await listed('mail/messages')).map((message) => message.id)).toContain(invoice.id);

    expect((await call('mail/blocked-senders', 'POST', { address: MINE })).status).toBe(400);
    expect((await call('mail/blocked-senders', 'POST', { address: 'not an address' })).status).toBe(400);
    const blocked = await call('mail/blocked-senders', 'POST', { address: 'priya@harborlight.co' });
    expect(await blocked.json()).toEqual({ addresses: ['priya@harborlight.co'], moved: 2 });
    expect(await listed('mail/messages?in=spam')).toEqual([
      expect.objectContaining({ id: expect.any(String), spamWhy: 'blocked' }),
      expect.objectContaining({ id: brief.id, spamWhy: 'blocked' }),
    ]);
    // The letter says its sender is blocked, so the screen offers Unblock.
    const opened = (await (await call(`mail/conversations/${brief.id}`)).json()) as { conversation: { messages: { senderBlocked?: true }[] } };
    expect(opened.conversation.messages[0]!.senderBlocked).toBe(true);
    expect(await (await call('mail/blocked-senders/priya%40harborlight.co', 'DELETE')).json()).toEqual({ addresses: [] });
    expect(await (await call('mail/blocked-senders')).json()).toEqual({ addresses: [] });
  });
});

interface MockResponse extends Partial<Response> { statusCode: number; body: unknown }

function handlerFor(deps: Partial<RouteDeps>, routePath: string, method: 'get' | 'post') {
  const router = agentCliRoutes(deps as RouteDeps) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Partial<Request>, res: MockResponse) => Promise<unknown> }> } }>;
  };
  const layer = router.stack.find((c) => c.route?.path === routePath && c.route.methods[method]);
  if (!layer?.route) throw new Error(`No ${method} ${routePath} route`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle;
}

async function callCli(deps: Partial<RouteDeps>, token: string, routePath: string, method: 'get' | 'post', args: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) {
  const res: MockResponse = { statusCode: 200, body: undefined };
  res.status = ((code: number) => { res.statusCode = code; return res as Response; }) as Response['status'];
  res.json = ((payload: unknown) => { res.body = payload; return res as Response; }) as Response['json'];
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  await handlerFor(deps, routePath, method)({
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {}, query: args.query ?? {}, body: args.body,
  }, res);
  return res;
}

describe('an agent and its owner’s mail', () => {
  it('marks spam and blocks a sender under its own name, and takes both back', async () => {
    const { messages, brief, invoice } = await mailbox();
    const db = openSqliteDb(':memory:');
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    const { token, tokenHash } = mintAgentbuiltToken('alice', 'agent-r');
    await users.updateProfile('alice', {
      telegram: {
        chatId: '1', linkedAt: 't', notificationsEnabled: true,
        agents: { 'agent-r': { id: 'agent-r', name: 'Ruby', cli: 'claude', agentbuiltTokenHash: tokenHash } as never },
      },
    });
    const mailboxes = new MailboxService(new SqliteMailboxStorage(db));
    await mailboxes.claim('alice', 'alice');
    const deps: Partial<RouteDeps> = { userStorage: users, mailMessages: messages, mailboxes };

    const marked = await callCli(deps, token, '/mail/:id/spam', 'post', { params: { id: invoice.id } });
    expect(marked.body).toMatchObject({ moved: true, message: { id: invoice.id, place: 'spam', movedBy: 'Ruby', spamWhy: 'marked' } });
    const inSpam = await callCli(deps, token, '/mail', 'get', { query: { in: 'spam' } });
    expect((inSpam.body as { messages: { id: string }[] }).messages.map((message) => message.id)).toEqual([invoice.id]);
    expect((await callCli(deps, token, '/mail/:id/unspam', 'post', { params: { id: invoice.id } })).body).toMatchObject({ moved: true });

    expect((await callCli(deps, token, '/mail/blocked', 'post', { body: { address: MINE } })).statusCode).toBe(400);
    const blocked = await callCli(deps, token, '/mail/blocked', 'post', { body: { address: 'priya@harborlight.co' } });
    expect(blocked.body).toMatchObject({ blocked: ['priya@harborlight.co'], moved: 2 });
    expect(await messages.get('alice', brief.id)).toMatchObject({ spamWhy: 'blocked', spamBy: { name: 'Ruby' } });
    expect((await callCli(deps, token, '/mail/blocked', 'get')).body).toMatchObject({ blocked: ['priya@harborlight.co'] });
    expect((await callCli(deps, token, '/mail/unblock', 'post', { body: { address: 'priya@harborlight.co' } })).body).toMatchObject({ blocked: [] });
  });
});
