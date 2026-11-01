import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { workspaceRoutes } from '../../routes/workspace.js';
import { agentCliRoutes } from '../../routes/agent-cli.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { mintAgentbuiltToken } from '../../services/agentbuilt-token.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { ensureMailRepliesFiled } from '../../services/sqlite/sqlite-mail-threads.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import type { WorkspaceMailMessagesAnswer } from '../../shared/workspace-mail.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * SENT (note #509, slice 9): what has gone OUT of a person's own address.
 *
 * The promises worth a test: every letter that went out is a row of it — the
 * replies among them, which are a row of no other list — newest first; it is
 * not a place, so an archived letter is still in it and only Trash is left
 * out; a reply is kept where the letter it answers is, which is what makes
 * that true; and a search of Sent looks through Sent alone, finding a letter
 * by who it went TO and by the words of a reply.
 */

const MINE = 'alice@agenticcloudcomputer.com';
let seq = 0;
const letter = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => {
  seq += 1;
  return {
    id: `ms_${seq}`,
    userId: 'alice',
    address: MINE,
    envelopeFrom: 'bounces@example.com',
    receivedAt: new Date(Date.UTC(2026, 8, 1, 9, seq)).toISOString(),
    messageId: `s${seq}@example.com`,
    from: { name: 'Priya Raman', address: 'priya@harborlight.co' },
    to: [{ address: MINE }],
    cc: [],
    replyTo: [],
    subject: 'The brief',
    snippet: 'Here is the brief.',
    text: 'Here is the brief.',
    attachments: [],
    raw: { storagePath: `users/alice/mail/ms_${seq}/raw.eml`, size: 100 },
    ...over,
  };
};
/** Something Alice sent: a reply when it `answers`, a new message when not. */
const sent = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => {
  const doc = letter({ direction: 'sent', from: { address: MINE }, to: [{ name: 'Priya Raman', address: 'priya@harborlight.co' }], ...over });
  return { ...doc, messageId: over.messageId ?? `${doc.id}@agenticcloudcomputer.com`, wrote: over.wrote ?? doc.text };
};

async function store(messages: SqliteMailMessageStorage, ...docs: MailMessageDocument[]) {
  for (const doc of docs) await messages.store(doc);
}
const ids = (page: { messages: MailMessageDocument[] }) => page.messages.map((message) => message.id);

describe('what has gone out', () => {
  it('holds every letter that went out — replies included — newest first, and nothing that arrived', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId, subject: 'Re: The brief' });
    const started = sent({ subject: 'The lease', to: [{ name: 'Dana Okonjo', address: 'dana@okonjo.studio' }] });
    await store(messages, brief, ours, started);
    expect(ids(await messages.list('alice', { in: 'sent' }))).toEqual([started.id, ours.id]);
    // The inbox is unchanged by it: a reply is still no row of the list.
    expect(ids(await messages.list('alice'))).toEqual([started.id, brief.id]);
    // One definition, two doors: the agent's `mail sent` reads this list.
    expect(ids(await messages.listSent('alice'))).toEqual([started.id, ours.id]);
  });

  it('is not a place: an archived letter is still in it, and only Trash is left out', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId });
    const started = sent({ subject: 'The lease' });
    await store(messages, brief, ours, started);
    const at = { atIso: '2026-09-23T09:00:00.000Z' };
    await messages.moveConversation('alice', brief.id, 'archive', at);
    expect(ids(await messages.list('alice', { in: 'sent' }))).toEqual([started.id, ours.id]);
    // In Trash it leaves Sent, reply and all — that is what putting a letter
    // there means — and Restore brings the whole conversation back to it.
    await messages.moveConversation('alice', brief.id, 'trash', at);
    expect(ids(await messages.list('alice', { in: 'sent' }))).toEqual([started.id]);
    await messages.moveConversation('alice', brief.id, 'restore', at);
    expect(ids(await messages.list('alice', { in: 'sent' }))).toEqual([started.id, ours.id]);
    // And the row says where it is kept, so Sent never hides the archive.
    expect((await messages.get('alice', ours.id))!.archivedAt).toBe(at.atIso);
  });

  it('keeps a reply where the letter it answers is — moved alone, it takes its replies with it', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId });
    await store(messages, brief, ours);
    const at = { atIso: '2026-09-23T09:00:00.000Z', by: { agentId: 'agent-r', name: 'Ruby' } };
    expect(await messages.move('alice', brief.id, 'trash', at)).toMatchObject({ moved: true });
    expect(await messages.get('alice', ours.id)).toMatchObject({ trashedAt: at.atIso, trashedBy: { name: 'Ruby' } });
    expect(ids(await messages.list('alice', { in: 'sent' }))).toEqual([]);
    // The reply itself still cannot be asked to move: it is read under the
    // letter it answers, and moving it alone would split the two.
    expect(await messages.move('alice', ours.id, 'restore', at)).toEqual({ refused: 'is_reply' });
    expect(await messages.move('alice', brief.id, 'restore', at)).toMatchObject({ moved: true });
    expect((await messages.get('alice', ours.id))!.trashedAt).toBeUndefined();
    // Asking twice still changes nothing, and says so.
    expect(await messages.move('alice', brief.id, 'restore', at)).toMatchObject({ moved: false });
  });

  it('files the replies already stored, once, the first time an installation opens with this code', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId });
    const lease = letter({ subject: 'The lease', messageId: 'lease@okonjo.studio' });
    const about = sent({ answers: lease.id, inReplyTo: 'lease@okonjo.studio' });
    await store(messages, brief, ours, lease, about);
    await messages.moveConversation('alice', brief.id, 'trash', { atIso: '2026-09-23T09:00:00.000Z' });
    await messages.moveConversation('alice', lease.id, 'archive', { atIso: '2026-09-23T09:00:00.000Z' });
    // Mail stored before this slice: the letters carry their stamps and the
    // replies under them carry none.
    db.prepare("UPDATE workspace_mail_messages SET doc = json_remove(doc, '$.archivedAt', '$.trashedAt') WHERE answers IS NOT NULL").run();
    expect(ids(await messages.list('alice', { in: 'sent' }))).toEqual([about.id, ours.id]);
    ensureMailRepliesFiled(db);
    expect(ids(await messages.list('alice', { in: 'sent' }))).toEqual([about.id]);
    expect((await messages.get('alice', ours.id))!.trashedAt).toBe('2026-09-23T09:00:00.000Z');
    expect((await messages.get('alice', about.id))!.archivedAt).toBe('2026-09-23T09:00:00.000Z');
    // A reply of a letter in neither place is left in neither, rather than
    // given a stamp of its own — and a second run finds nothing to do.
    await messages.moveConversation('alice', lease.id, 'unarchive', { atIso: '2026-09-23T10:00:00.000Z' });
    ensureMailRepliesFiled(db);
    expect(await messages.get('alice', about.id)).not.toHaveProperty('archivedAt');
    expect((await messages.get('alice', about.id))!.text).toBe('Here is the brief.');
  });

  it('searches Sent alone — by who a letter went to, and by the words of a reply', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter({ text: 'Here is the brief, with the lease in it.' });
    const ours = sent({
      answers: brief.id,
      inReplyTo: brief.messageId,
      subject: 'Re: The brief',
      text: 'Thursday suits us.\n\n> Here is the brief, with the lease in it.',
      wrote: 'Thursday suits us.',
    });
    const started = sent({ subject: 'The lease', to: [{ name: 'Dana Okonjo', address: 'dana@okonjo.studio' }], text: 'Both copies are signed.' });
    await store(messages, brief, ours, started);
    // Who it went TO — never the sender's own address, which is on every row.
    expect(ids(await messages.list('alice', { in: 'sent', search: 'dana' }))).toEqual([started.id]);
    expect(ids(await messages.list('alice', { in: 'sent', search: 'alice' }))).toEqual([]);
    // The words of a reply, which no other list can look through.
    expect(ids(await messages.list('alice', { in: 'sent', search: 'thursday' }))).toEqual([ours.id]);
    // Sent alone: the brief says "lease" too, and is not in Sent.
    expect(ids(await messages.list('alice', { in: 'sent', search: 'lease' }))).toEqual([started.id]);
    // And a search from the inbox is unchanged: it finds the letters of the
    // list, and a reply is a row of Sent only.
    expect(ids(await messages.list('alice', { search: 'lease' }))).toEqual([started.id, brief.id]);
    expect(ids(await messages.list('alice', { search: 'thursday' }))).toEqual([]);
  });
});

describe('the doors onto Sent', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('answers the owner and nobody else, and is no place for a conversation', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId, subject: 'Re: The brief', wrote: 'Thursday suits us.', sentBy: { agentId: 'agent-r', name: 'Ruby' } });
    await store(messages, brief, ours);
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    const mailboxes = new MailboxService(new SqliteMailboxStorage(db));
    const deps: Partial<RouteDeps> = { userStorage: users, mailMessages: messages, mailboxes };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (identity: number, apiPath: string) => fetch(`${origin}/workspace/api/${apiPath}`, { headers: workspaceTestHeaders(identity) });

    const listed = (await (await call(42, 'mail/messages?in=sent')).json()) as WorkspaceMailMessagesAnswer;
    expect(listed.messages.map((message) => message.id)).toEqual([ours.id]);
    // Named by who it went to, marked with the agent that wrote it, and new
    // to nobody: the reader wrote it.
    expect(listed.messages[0]).toMatchObject({ direction: 'sent', to: [{ name: 'Priya Raman' }], sentBy: 'Ruby' });
    expect(listed.messages[0]).not.toHaveProperty('unread');

    // Bob knows the address and gets his own empty list, not hers.
    expect(((await (await call(43, 'mail/messages?in=sent')).json()) as WorkspaceMailMessagesAnswer).messages).toEqual([]);
    // A conversation is kept in one place, and Sent is not one of them.
    const refused = await call(42, 'mail/conversations?in=sent');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'Conversations are listed by place: inbox, archive, spam or trash.' });
    expect((await call(42, 'mail/messages?in=nowhere')).status).toBe(400);
  });

  it('is the same list the agent CLI reads — `mail sent`, with the archive in it and Trash out', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId, subject: 'Re: The brief', wrote: 'Thursday suits us.' });
    const lease = letter({ subject: 'The lease', messageId: 'lease@okonjo.studio' });
    const about = sent({ answers: lease.id, inReplyTo: 'lease@okonjo.studio' });
    await store(messages, brief, ours, lease, about);
    const at = { atIso: '2026-09-23T09:00:00.000Z' };
    await messages.moveConversation('alice', brief.id, 'archive', at);
    await messages.moveConversation('alice', lease.id, 'trash', at);
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
    const listed = await callCli(deps, token, '/mail/sent', 'get');
    expect(listed.statusCode).toBe(200);
    expect((listed.body as { messages: { id: string }[] }).messages.map((message) => message.id)).toEqual([ours.id]);
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

async function callCli(deps: Partial<RouteDeps>, token: string, routePath: string, method: 'get' | 'post') {
  const res: MockResponse = { statusCode: 200, body: undefined };
  res.status = ((code: number) => { res.statusCode = code; return res as Response; }) as Response['status'];
  res.json = ((payload: unknown) => { res.body = payload; return res as Response; }) as Response['json'];
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  await handlerFor(deps, routePath, method)({
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: {}, query: {}, body: undefined,
  }, res);
  return res;
}
