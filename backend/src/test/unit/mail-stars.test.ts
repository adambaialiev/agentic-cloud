import { afterEach, describe, expect, it } from 'vitest';
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
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { mailConversationFacts } from '../../services/mail-threads.js';
import { readMailPlace, readMailView } from '../../services/mail-places.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import type { WorkspaceMailStarAnswer } from '../../shared/workspace-mail.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * Stars (note #666).
 *
 * What is worth a test is the promises: a star moves nothing — a starred
 * letter stays where it is kept, and Starred is every starred letter that is
 * not in Trash or Spam, the reader's own replies included; a star is put on
 * a letter once and keeps the moment it was first put there; a letter in
 * Trash or Spam is not starred until it is brought back, and one starred
 * before it went comes back into Starred with it; a conversation's row stars
 * the newest letter the other side wrote — never the reader's own, when there
 * is one of theirs — and unstars all of it; and an agent's star says whose it
 * was.
 */

let seq = 0;
const MINE = 'alice@agenticcloudcomputer.com';
const letter = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => {
  seq += 1;
  return {
    id: `ms_${seq}`,
    userId: 'alice',
    address: MINE,
    envelopeFrom: 'bounces@example.com',
    receivedAt: new Date(Date.UTC(2026, 8, 1, 9, seq)).toISOString(),
    messageId: `s${seq}@example.com`,
    from: { name: 'Ada Lovelace', address: 'ada@example.com' },
    to: [{ address: MINE }],
    cc: [],
    replyTo: [],
    subject: 'The engine',
    snippet: 'It weaves algebraic patterns.',
    text: 'It weaves algebraic patterns.',
    attachments: [],
    raw: { storagePath: `users/alice/mail/ms_${seq}/raw.eml`, size: 100 },
    ...over,
  };
};
const ids = (page: { messages: { id: string }[] }) => page.messages.map((message) => message.id);
const AT = '2026-09-27T10:00:00.000Z';
const LATER = '2026-09-27T11:00:00.000Z';
const RUBY = { agentId: 'agent-r', name: 'Ruby' };

async function mailbox() {
  const db = openSqliteDb(':memory:');
  const messages = new SqliteMailMessageStorage(db);
  const brief = letter({ from: { name: 'Priya Raman', address: 'priya@harborlight.co' }, subject: 'The brief', text: 'Here is the brief.' });
  const invoice = letter({ from: { name: 'Fly.io', address: 'billing@fly.io' }, subject: 'Your September invoice', text: 'Invoice 4821.' });
  const reply = letter({
    direction: 'sent', answers: brief.id, from: { address: MINE }, to: [brief.from!],
    subject: 'Re: The brief', text: 'Looks right.', wrote: 'Looks right.', messageId: 'ours-1@agenticcloudcomputer.com',
  });
  // Priya answers the reply: the conversation is now three letters long.
  const answer = letter({
    from: brief.from!, subject: 'Re: The brief', text: 'Great, sending the crop.',
    inReplyTo: 'ours-1@agenticcloudcomputer.com', references: [brief.messageId!, 'ours-1@agenticcloudcomputer.com'],
  });
  for (const doc of [brief, invoice, reply, answer]) await messages.store(doc);
  return { db, messages, brief, invoice, reply, answer };
}

describe('a star on one letter', () => {
  it('is a view of letters, never a place a conversation is listed in', () => {
    expect(readMailView('starred')).toEqual({ view: 'starred' });
    expect(readMailPlace('starred')).toEqual({ refused: expect.stringContaining('by place') });
  });

  it('moves nothing, keeps its first moment, and puts the letter in Starred', async () => {
    const { messages, invoice } = await mailbox();
    const starred = await messages.star('alice', invoice.id, { starred: true, atIso: AT });
    expect(starred).toMatchObject({ changed: true, doc: { id: invoice.id, starredAt: AT } });
    // Still in the inbox, as a conversation and as a letter.
    const inbox = await messages.listConversations('alice');
    expect(inbox.conversations.map((row) => row.messages[0]!.id)).toContain(invoice.id);
    expect(ids(await messages.list('alice', { in: 'starred' }))).toEqual([invoice.id]);
    // Starring twice changes nothing: the star is the first time.
    expect(await messages.star('alice', invoice.id, { starred: true, atIso: LATER })).toMatchObject({ changed: false });
    expect((await messages.get('alice', invoice.id))?.starredAt).toBe(AT);
    // Nor is the unread count touched by it.
    expect(await messages.countUnread('alice')).toBe(3);
    const off = await messages.star('alice', invoice.id, { starred: false, atIso: LATER });
    expect(off).toMatchObject({ changed: true });
    expect(await messages.get('alice', invoice.id)).not.toHaveProperty('starredAt');
    expect(ids(await messages.list('alice', { in: 'starred' }))).toEqual([]);
    expect(await messages.star('alice', invoice.id, { starred: false, atIso: LATER })).toMatchObject({ changed: false });
    expect(await messages.star('alice', 'nope', { starred: true, atIso: AT })).toEqual({ refused: 'no_such_message' });
    expect(await messages.star('bob', invoice.id, { starred: true, atIso: AT })).toEqual({ refused: 'no_such_message' });
  });

  it('can stand on a reply this person sent, and Starred is searched on its own', async () => {
    const { messages, invoice, reply } = await mailbox();
    await messages.star('alice', reply.id, { starred: true, atIso: AT });
    await messages.star('alice', invoice.id, { starred: true, atIso: AT });
    // Newest first, one row per letter — the reply among them.
    expect(ids(await messages.list('alice', { in: 'starred' }))).toEqual([reply.id, invoice.id]);
    expect(ids(await messages.list('alice', { in: 'starred', search: 'invoice' }))).toEqual([invoice.id]);
    expect(ids(await messages.list('alice', { in: 'starred', search: 'crop' }))).toEqual([]);
    // Paged like every other list.
    const first = await messages.list('alice', { in: 'starred', limit: 1 });
    expect(ids(first)).toEqual([reply.id]);
    expect(ids(await messages.list('alice', { in: 'starred', limit: 1, before: first.nextBefore! }))).toEqual([invoice.id]);
  });

  it('leaves Starred with a letter put in Trash or Spam, refuses a new star there, and comes back with it', async () => {
    const { messages, invoice, brief } = await mailbox();
    await messages.star('alice', invoice.id, { starred: true, atIso: AT });
    await messages.move('alice', invoice.id, 'trash', { atIso: AT });
    expect(ids(await messages.list('alice', { in: 'starred' }))).toEqual([]);
    expect(await messages.star('alice', invoice.id, { starred: true, atIso: LATER })).toEqual({ refused: 'in_trash' });
    await messages.move('alice', invoice.id, 'restore', { atIso: AT });
    expect(ids(await messages.list('alice', { in: 'starred' }))).toEqual([invoice.id]);
    await messages.move('alice', brief.id, 'spam', { atIso: AT });
    expect(await messages.star('alice', brief.id, { starred: true, atIso: AT })).toEqual({ refused: 'in_spam' });
    // Taking a star off is never refused.
    await messages.move('alice', invoice.id, 'spam', { atIso: AT });
    expect(await messages.star('alice', invoice.id, { starred: false, atIso: AT })).toMatchObject({ changed: true });
  });

  it('names the agent that starred it, and a person starring clears nothing of theirs', async () => {
    const { messages, invoice } = await mailbox();
    expect(await messages.star('alice', invoice.id, { starred: true, atIso: AT, by: RUBY })).toMatchObject({
      changed: true, doc: { starredAt: AT, starredBy: RUBY },
    });
    await messages.star('alice', invoice.id, { starred: false, atIso: AT });
    const own = await messages.star('alice', invoice.id, { starred: true, atIso: LATER });
    expect(own).toMatchObject({ changed: true, doc: { starredAt: LATER } });
    expect((await messages.get('alice', invoice.id))).not.toHaveProperty('starredBy');
  });
});

describe('a star on a conversation’s row', () => {
  it('stars the newest letter that arrived, never the reader’s own when the other side wrote', async () => {
    const { messages, brief, answer } = await mailbox();
    // Priya's answer is the newest letter, and it arrived.
    expect(await messages.star('alice', brief.id, { starred: true, whole: true, atIso: AT })).toMatchObject({ doc: { id: answer.id } });
    await messages.star('alice', brief.id, { starred: false, whole: true, atIso: AT });
    // One the reader sent is newer still: the star still goes on Priya's.
    await messages.store(letter({
      direction: 'sent', answers: answer.id, from: { address: MINE }, to: [answer.from!],
      subject: 'Re: The brief', text: 'Thank you!', wrote: 'Thank you!', messageId: 'ours-2@agenticcloudcomputer.com',
    }));
    expect(await messages.star('alice', brief.id, { starred: true, whole: true, atIso: AT })).toMatchObject({ doc: { id: answer.id } });
  });

  it('stars one the reader sent while nobody has written back', async () => {
    const { messages } = await mailbox();
    const started = letter({ direction: 'sent', from: { address: MINE }, to: [{ address: 'dana@okonjo.studio' }], subject: 'The lease' });
    await messages.store(started);
    expect(await messages.star('alice', started.id, { starred: true, whole: true, atIso: AT })).toMatchObject({ doc: { id: started.id } });
  });

  it('stars its newest letter outside Trash, says the conversation is starred, and unstars all of it', async () => {
    const { messages, brief, reply, answer } = await mailbox();
    // Priya's answer — the newest — is put in Trash alone.
    await messages.move('alice', answer.id, 'trash', { atIso: AT });
    const starred = await messages.star('alice', brief.id, { starred: true, whole: true, atIso: AT });
    // The newest that arrived and is not in Trash is her brief — not the
    // reply between them, which is the reader's own.
    expect(starred).toMatchObject({ changed: true, doc: { id: brief.id } });
    expect(reply.id).not.toBe(brief.id);
    if (!('conversation' in starred)) throw new Error('refused');
    expect(starred.conversation.messages.map((doc) => doc.id)).toEqual([brief.id, reply.id, answer.id]);
    expect(mailConversationFacts(starred.conversation).starred).toBe(true);
    await messages.star('alice', brief.id, { starred: true, atIso: AT });
    const off = await messages.star('alice', answer.id, { starred: false, whole: true, atIso: AT });
    expect(off).toMatchObject({ changed: true });
    if (!('conversation' in off)) throw new Error('refused');
    expect(off.conversation.messages.some((doc) => doc.starredAt)).toBe(false);
    expect(mailConversationFacts(off.conversation).starred).toBe(false);
    expect(ids(await messages.list('alice', { in: 'starred' }))).toEqual([]);
  });

  it('is not starred by a star that stands on a letter in Trash', async () => {
    const { messages, invoice } = await mailbox();
    await messages.star('alice', invoice.id, { starred: true, atIso: AT });
    await messages.move('alice', invoice.id, 'trash', { atIso: AT });
    const conversation = await messages.getConversation('alice', invoice.id);
    expect(mailConversationFacts(conversation!).starred).toBe(false);
    // And a conversation that is all in Trash cannot be starred from its row.
    expect(await messages.star('alice', invoice.id, { starred: true, whole: true, atIso: AT })).toEqual({ refused: 'in_trash' });
  });
});

describe('the owner’s Workspace', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('stars and unstars a letter and a row through the routes, and lists Starred as letters', async () => {
    const { messages, brief, invoice, answer } = await mailbox();
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
    const call = (apiPath: string, method = 'GET') => fetch(`${origin}/workspace/api/${apiPath}`, {
      method, headers: workspaceTestHeaders(42),
    });

    const one = await call(`mail/messages/${invoice.id}/star`, 'POST');
    expect(one.status).toBe(200);
    const oneAnswer = (await one.json()) as WorkspaceMailStarAnswer;
    expect(oneAnswer.conversation).toMatchObject({ id: invoice.id, starred: true });
    expect(oneAnswer.messages).toEqual([expect.objectContaining({ id: invoice.id, starred: true })]);
    expect(oneAnswer.messages[0]).not.toHaveProperty('starredBy');

    const row = await call(`mail/conversations/${brief.id}/star`, 'POST');
    const rowAnswer = (await row.json()) as WorkspaceMailStarAnswer;
    expect(rowAnswer.conversation.starred).toBe(true);
    expect(rowAnswer.messages.filter((message) => message.starred).map((message) => message.id)).toEqual([answer.id]);

    const starred = (await (await call('mail/messages?in=starred')).json()) as { messages: { id: string; starred?: true }[] };
    expect(starred.messages.map((message) => message.id)).toEqual([answer.id, invoice.id]);
    const inbox = (await (await call('mail/conversations')).json()) as { conversations: { id: string; starred?: true }[] };
    expect(inbox.conversations.every((conversation) => conversation.starred)).toBe(true);
    expect((await call('mail/conversations?in=starred')).status).toBe(400);

    const off = (await (await call(`mail/conversations/${answer.id}/unstar`, 'POST')).json()) as WorkspaceMailStarAnswer;
    expect(off.conversation).not.toHaveProperty('starred');
    await call(`mail/messages/${invoice.id}/trash`, 'POST');
    const refused = await call(`mail/messages/${invoice.id}/star`, 'POST');
    // Refused even though its star from before is still on it: from Trash,
    // the answer is always "restore it first".
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('in_trash');
    expect((await call('mail/messages/nope/star', 'POST')).status).toBe(404);
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

describe('an agent and its owner’s stars', () => {
  it('stars under its own name, lists Starred, and takes the star back off', async () => {
    const { messages, invoice, brief } = await mailbox();
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

    const starred = await callCli(deps, token, '/mail/:id/star', 'post', { params: { id: invoice.id } });
    expect(starred.body).toMatchObject({ changed: true, message: { id: invoice.id, starred: true, starredBy: 'Ruby' }, conversation: { starred: true } });
    const listed = await callCli(deps, token, '/mail', 'get', { query: { in: 'starred' } });
    expect((listed.body as { messages: { id: string }[] }).messages.map((message) => message.id)).toEqual([invoice.id]);
    const whole = await callCli(deps, token, '/mail/conversations/:id/star', 'post', { params: { id: brief.id } });
    expect(whole.body).toMatchObject({ changed: true, conversation: { starred: true } });
    expect((await callCli(deps, token, '/mail/:id/unstar', 'post', { params: { id: invoice.id } })).body).toMatchObject({ changed: true });
    expect((await callCli(deps, token, '/mail/conversations', 'get', { query: { in: 'starred' } })).statusCode).toBe(400);
    await messages.move('alice', invoice.id, 'trash', { atIso: AT });
    const refused = await callCli(deps, token, '/mail/:id/star', 'post', { params: { id: invoice.id } });
    expect(refused).toMatchObject({ statusCode: 409, body: { code: 'in_trash' } });
  });
});
