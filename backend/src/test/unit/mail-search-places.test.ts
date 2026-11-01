import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { MAIL_SEARCH_TABLE } from '../../services/sqlite/sqlite-mail-search.js';
import { mailSearchFields, mailSearchMatch } from '../../services/mail-search.js';
import type { MailMessageDocument } from '../../services/mail-message-storage.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * Search, the archive and Trash (note #509, slice 7).
 *
 * What is worth a test is not that SQLite can match a word — it is the
 * promises made on top of it: a person finds a letter by who it was with,
 * what it was about or something it said, and never finds anybody else's;
 * words typed into a search box are never read as query syntax; a message
 * that is archived or trashed is still whole and comes back exactly where
 * it was; and nothing an agent does to its owner's mail is done unnamed.
 */

let seq = 0;
const letter = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => {
  seq += 1;
  return {
    id: `mm_${seq}`,
    userId: 'alice',
    address: 'alice@agenticcloudcomputer.com',
    envelopeFrom: 'bounces@example.com',
    receivedAt: new Date(Date.UTC(2026, 8, 1, 9, seq)).toISOString(),
    messageId: `m${seq}@example.com`,
    from: { name: 'Ada Lovelace', address: 'ada@example.com' },
    to: [{ address: 'alice@agenticcloudcomputer.com' }],
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

async function mailbox() {
  const db = openSqliteDb(':memory:');
  const messages = new SqliteMailMessageStorage(db);
  const brief = letter({ from: { name: 'Priya Raman', address: 'priya@harborlight.co' }, subject: 'The brief, and one photograph', text: 'Here is the brief we talked through on Tuesday.' });
  const invoice = letter({
    from: { name: 'Fly.io', address: 'billing@fly.io' }, subject: 'Your September invoice', text: undefined,
    html: '<style>.x{color:#ffffff}</style><table><tr><td>Invoice 4821</td></tr></table><p>Paid by the card ending 4242.</p>',
  });
  const cafe = letter({ from: { name: 'Zoë Brontë', address: 'zoe@example.org' }, subject: 'Lunch', text: 'Shall we meet at the café?' });
  const started = letter({
    direction: 'sent', from: { address: 'alice@agenticcloudcomputer.com' }, to: [{ name: 'Dana Okonjo', address: 'dana@okonjo.studio' }],
    subject: 'The lease', text: 'Both copies are signed.', messageId: 'ours-1@agenticcloudcomputer.com',
  });
  const reply = letter({
    direction: 'sent', answers: brief.id, from: { address: 'alice@agenticcloudcomputer.com' }, to: [brief.from!],
    subject: 'Re: The brief', text: 'Looks right.\n\n> Here is the brief', wrote: 'Looks right.', messageId: 'ours-2@agenticcloudcomputer.com',
  });
  const bobs = letter({ userId: 'bob', address: 'bob@agenticcloudcomputer.com', subject: 'The brief for Bob', text: 'Bob’s own brief.' });
  for (const doc of [brief, invoice, cafe, started, reply, bobs]) await messages.store(doc);
  return { db, messages, brief, invoice, cafe, started, reply, bobs };
}

const ids = (page: { messages: { id: string }[] }) => page.messages.map((message) => message.id);

describe('what a message is found by', () => {
  it('is the other side of it, never the reader, and the body the screen draws', () => {
    const arrived = mailSearchFields(letter({ from: { name: 'Priya Raman', address: 'priya@harborlight.co' } }));
    expect(arrived.people).toBe('Priya Raman priya@harborlight.co');
    // Something this person started is found by who it went TO — their own
    // address would make it match every row they ever wrote.
    const sent = mailSearchFields(letter({ direction: 'sent', to: [{ address: 'dana@okonjo.studio' }], text: 'x\n\n> quoted', wrote: 'x' }));
    expect(sent.people).toBe('dana@okonjo.studio');
    expect(sent.body).toBe('x');
    // Markup's words and none of its furniture.
    const html = mailSearchFields(letter({ text: undefined, html: '<style>.a{color:red}</style><div>Invoice <b>4821</b></div>' }));
    expect(html.body).toContain('Invoice');
    expect(html.body).toContain('4821');
    expect(html.body).not.toMatch(/div|color|red/);
  });

  it('reads every typed word as a word, never as query syntax', () => {
    expect(mailSearchMatch('invo')).toBe('"invo"*');
    expect(mailSearchMatch('  brief   photo ')).toBe('"brief"* "photo"*');
    expect(mailSearchMatch('ada OR NEAR "x" -y *')).toBe('"ada"* "OR"* "NEAR"* "x"* "-y"*');
    expect(mailSearchMatch('!!! --- ""')).toBeNull();
    expect(mailSearchMatch('')).toBeNull();
    expect(mailSearchMatch(undefined)).toBeNull();
  });
});

describe('searching one person’s mail', () => {
  it('finds a letter by who, what it was about, or what it said — and only the reader’s own', async () => {
    const { messages, brief, invoice, cafe, started } = await mailbox();
    expect(ids(await messages.list('alice', { search: 'priya' }))).toEqual([brief.id]);
    expect(ids(await messages.list('alice', { search: 'priya@harborlight.co' }))).toEqual([brief.id]);
    expect(ids(await messages.list('alice', { search: 'photograph' }))).toEqual([brief.id]);
    expect(ids(await messages.list('alice', { search: 'tuesday' }))).toEqual([brief.id]);
    // Typed as it is read: the start of a word is already a search for it.
    expect(ids(await messages.list('alice', { search: 'invo' }))).toEqual([invoice.id]);
    // An HTML-only letter is found by its words, not by its tags.
    expect(ids(await messages.list('alice', { search: '4821' }))).toEqual([invoice.id]);
    expect(ids(await messages.list('alice', { search: 'table' }))).toEqual([]);
    // Accents do not stand in the way, in either direction.
    expect(ids(await messages.list('alice', { search: 'cafe' }))).toEqual([cafe.id]);
    expect(ids(await messages.list('alice', { search: 'zoe bronte' }))).toEqual([cafe.id]);
    // Something they started, by who it went to — and never every row by
    // the reader's own address.
    expect(ids(await messages.list('alice', { search: 'dana' }))).toEqual([started.id]);
    expect(ids(await messages.list('alice', { search: 'alice' }))).toEqual([]);
    // Every word narrows.
    expect(ids(await messages.list('alice', { search: 'brief tuesday' }))).toEqual([brief.id]);
    expect(ids(await messages.list('alice', { search: 'brief invoice' }))).toEqual([]);
    // Bob's brief is Bob's. Alice finds hers alone, and Bob his.
    expect(ids(await messages.list('alice', { search: 'brief' }))).toEqual([brief.id]);
    expect((await messages.list('bob', { search: 'brief' })).messages.map((message) => message.subject)).toEqual(['The brief for Bob']);
  });

  it('is a search of the list: a reply is not a row, and words with nothing in them find nothing', async () => {
    const { messages } = await mailbox();
    // "Looks right." is only in the reply, which is read under its message.
    expect(ids(await messages.list('alice', { search: 'looks right' }))).toEqual([]);
    expect(ids(await messages.list('alice', { search: '---' }))).toEqual([]);
    // An operator is a word like any other: `NOT` is looked for, not obeyed
    // (and nothing here has a word starting with it).
    expect(ids(await messages.list('alice', { search: 'NOT' }))).toEqual([]);
    expect(ids(await messages.list('alice', { search: 'priya NOT' }))).toEqual([]);
  });

  it('pages newest first with the same cursor the list uses', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    for (let n = 0; n < 5; n += 1) await messages.store(letter({ subject: `Report ${n}` }));
    await messages.store(letter({ subject: 'Unrelated' }));
    const first = await messages.list('alice', { search: 'report', limit: 2 });
    expect(first.messages.map((message) => message.subject)).toEqual(['Report 4', 'Report 3']);
    expect(first.nextBefore).toBeDefined();
    const second = await messages.list('alice', { search: 'report', limit: 2, before: first.nextBefore });
    expect(second.messages.map((message) => message.subject)).toEqual(['Report 2', 'Report 1']);
    const last = await messages.list('alice', { search: 'report', limit: 2, before: second.nextBefore });
    expect(last.messages.map((message) => message.subject)).toEqual(['Report 0']);
    expect(last.nextBefore).toBeUndefined();
  });
});

describe('the archive and Trash', () => {
  it('moves a letter out of the inbox and keeps it whole, found by a search', async () => {
    const { messages, brief, invoice } = await mailbox();
    expect(await messages.countUnread('alice')).toBe(3);
    const archived = await messages.move('alice', brief.id, 'archive', { atIso: '2026-09-22T10:00:00.000Z' });
    expect(archived).toMatchObject({ moved: true, doc: { id: brief.id, archivedAt: '2026-09-22T10:00:00.000Z' } });
    expect(ids(await messages.list('alice'))).not.toContain(brief.id);
    expect(ids(await messages.list('alice', { in: 'archive' }))).toEqual([brief.id]);
    // Dealt with, so the door on Home stops counting it.
    expect(await messages.countUnread('alice')).toBe(2);
    // Whole: the same words, the same bytes, still opened by its id.
    const kept = await messages.get('alice', brief.id);
    expect(kept).toMatchObject({ text: brief.text, raw: brief.raw, subject: brief.subject });
    // A search looks through the archive too, unless told which place.
    expect(ids(await messages.list('alice', { search: 'brief' }))).toEqual([brief.id]);
    expect(ids(await messages.list('alice', { search: 'brief', in: 'inbox' }))).toEqual([]);
    // Asking twice is not an error, and changes nothing.
    expect(await messages.move('alice', brief.id, 'archive', { atIso: '2026-09-22T11:00:00.000Z' }))
      .toMatchObject({ moved: false, doc: { archivedAt: '2026-09-22T10:00:00.000Z' } });
    // And back.
    expect(await messages.move('alice', brief.id, 'unarchive', { atIso: 'x' })).toMatchObject({ moved: true });
    expect(ids(await messages.list('alice'))).toContain(brief.id);
    expect((await messages.get('alice', brief.id))!.archivedAt).toBeUndefined();
    expect(ids(await messages.list('alice', { in: 'all' }))).toContain(invoice.id);
  });

  it('keeps a trashed letter out of every view but Trash, and Restore takes it back where it was', async () => {
    const { messages, brief, invoice } = await mailbox();
    await messages.move('alice', brief.id, 'archive', { atIso: '2026-09-22T10:00:00.000Z' });
    await messages.move('alice', brief.id, 'trash', { atIso: '2026-09-22T10:05:00.000Z' });
    await messages.move('alice', invoice.id, 'trash', { atIso: '2026-09-22T10:06:00.000Z' });
    expect(ids(await messages.list('alice', { in: 'trash' }))).toEqual([invoice.id, brief.id]);
    expect(ids(await messages.list('alice', { in: 'archive' }))).toEqual([]);
    expect(ids(await messages.list('alice'))).not.toContain(invoice.id);
    // Out of the way: an ordinary search does not dig through Trash…
    expect(ids(await messages.list('alice', { search: 'invoice' }))).toEqual([]);
    // …and a search OF Trash finds what is there.
    expect(ids(await messages.list('alice', { search: 'invoice', in: 'trash' }))).toEqual([invoice.id]);
    // The one undo for Trash is Restore; archiving from there is refused.
    expect(await messages.move('alice', invoice.id, 'archive', { atIso: 'x' })).toEqual({ refused: 'in_trash' });
    expect(await messages.move('alice', brief.id, 'unarchive', { atIso: 'x' })).toEqual({ refused: 'in_trash' });
    // It was archived before it was trashed, so that is where it goes back.
    expect(await messages.move('alice', brief.id, 'restore', { atIso: 'x' })).toMatchObject({ moved: true });
    expect(ids(await messages.list('alice', { in: 'archive' }))).toEqual([brief.id]);
    await messages.move('alice', invoice.id, 'restore', { atIso: 'x' });
    expect(ids(await messages.list('alice'))).toContain(invoice.id);
    expect(ids(await messages.list('alice', { in: 'trash' }))).toEqual([]);
  });

  it('moves only a row of the list, and only the reader’s own', async () => {
    const { messages, reply, bobs, started } = await mailbox();
    expect(await messages.move('alice', reply.id, 'trash', { atIso: 'x' })).toEqual({ refused: 'is_reply' });
    expect(await messages.move('alice', bobs.id, 'trash', { atIso: 'x' })).toEqual({ refused: 'no_such_message' });
    expect(await messages.move('alice', 'mm_nobody', 'archive', { atIso: 'x' })).toEqual({ refused: 'no_such_message' });
    expect((await messages.get('bob', bobs.id))!.trashedAt).toBeUndefined();
    // Something the reader started is a row, and can go.
    expect(await messages.move('alice', started.id, 'archive', { atIso: 'x' })).toMatchObject({ moved: true });
  });

  it('names the agent that moved it, and forgets that name when the move is undone', async () => {
    const { messages, brief } = await mailbox();
    const by = { agentId: 'ag_1', name: 'Ruby' };
    const trashed = await messages.move('alice', brief.id, 'trash', { atIso: 'x', by });
    expect(trashed).toMatchObject({ moved: true, doc: { trashedBy: by } });
    await messages.move('alice', brief.id, 'restore', { atIso: 'x', by });
    const back = await messages.get('alice', brief.id);
    expect(back!.trashedAt).toBeUndefined();
    expect(back!.trashedBy).toBeUndefined();
    // A person archiving their own mail leaves no name behind.
    await messages.move('alice', brief.id, 'archive', { atIso: 'x' });
    expect((await messages.get('alice', brief.id))!.archivedBy).toBeUndefined();
  });
});

describe('the index itself', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('is filled from the mail already stored the first time an installation opens without it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-search-'));
    dirs.push(dir);
    const file = path.join(dir, 'backend.db');
    const before = openSqliteDb(file);
    const messages = new SqliteMailMessageStorage(before);
    const old = letter({ subject: 'Written before search existed', text: 'A lighthouse keeper writes.' });
    await messages.store(old);
    // An installation from before slice 7: the mail is there, the index is not.
    before.exec(`DROP TRIGGER workspace_mail_search_forget; DROP TABLE ${MAIL_SEARCH_TABLE};`);
    before.close();
    const after = openSqliteDb(file);
    expect(ids(await new SqliteMailMessageStorage(after).list('alice', { search: 'lighthouse' }))).toEqual([old.id]);
    after.close();
    // And every boot after that finds it and leaves it alone.
    const again = openSqliteDb(file);
    expect(ids(await new SqliteMailMessageStorage(again).list('alice', { search: 'lighthouse' }))).toEqual([old.id]);
    again.close();
  });

  it('holds no copy of anybody’s words, and forgets a message’s when the message goes', async () => {
    const { db, brief } = await mailbox();
    // Contentless: the index can say WHICH row, never what it said.
    const row = db.prepare(`SELECT people, subject, body FROM ${MAIL_SEARCH_TABLE} WHERE ${MAIL_SEARCH_TABLE} MATCH '"photograph"*'`).get() as Record<string, unknown>;
    expect(row).toEqual({ people: null, subject: null, body: null });
    const found = () => db.prepare(`SELECT rowid FROM ${MAIL_SEARCH_TABLE} WHERE ${MAIL_SEARCH_TABLE} MATCH '"photograph"*'`).all();
    expect(found()).toHaveLength(1);
    db.prepare('DELETE FROM workspace_mail_messages WHERE id = ?').run(brief.id);
    expect(found()).toHaveLength(0);
  });
});

describe('the owner’s Workspace', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('searches, moves and restores through the routes — and refuses anybody else', async () => {
    const { messages, brief } = await mailbox();
    const db = openSqliteDb(':memory:');
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    const deps: Partial<RouteDeps> = { userStorage: users, mailMessages: messages, mailboxes: new MailboxService(new SqliteMailboxStorage(db)) };
    await addWorkspaceTestAuth(deps, users, { 42: 'alice', 43: 'bob' });
    const app = express();
    app.use(express.json());
    app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (identity: number, apiPath: string, method = 'GET') => fetch(`${origin}/workspace/api/${apiPath}`, {
      method, headers: workspaceTestHeaders(identity),
    });
    const listed = async (apiPath: string) => ((await (await call(42, apiPath)).json()) as { messages: { id: string; place?: string }[] }).messages;

    expect((await listed('mail/messages?q=photograph')).map((message) => message.id)).toEqual([brief.id]);
    expect((await call(42, 'mail/messages?in=bin')).status).toBe(400);

    const archived = await call(42, `mail/messages/${brief.id}/archive`, 'POST');
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as { message: { place?: string } }).message.place).toBe('archive');
    expect((await listed('mail/messages')).map((message) => message.id)).not.toContain(brief.id);
    expect(await listed('mail/messages?in=archive')).toEqual([expect.objectContaining({ id: brief.id, place: 'archive' })]);
    // Found by a search from the inbox, and marked as archived where it is found.
    expect(await listed('mail/messages?q=photograph')).toEqual([expect.objectContaining({ id: brief.id, place: 'archive' })]);

    expect((await call(42, `mail/messages/${brief.id}/trash`, 'POST')).status).toBe(200);
    const opened = (await (await call(42, `mail/messages/${brief.id}`)).json()) as { message: { place?: string; text?: string } };
    expect(opened.message).toMatchObject({ place: 'trash', text: brief.text });
    const refused = await call(42, `mail/messages/${brief.id}/archive`, 'POST');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('in_trash');

    // Bob knows the id and still cannot touch it: absent, not refused.
    expect((await call(43, `mail/messages/${brief.id}/restore`, 'POST')).status).toBe(404);
    expect((await (await call(43, 'mail/messages?q=photograph')).json() as { messages: unknown[] }).messages).toEqual([]);

    const restored = await call(42, `mail/messages/${brief.id}/restore`, 'POST');
    expect(((await restored.json()) as { message: { place?: string } }).message.place).toBe('archive');
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

async function callCli(deps: Partial<RouteDeps>, token: string, routePath: string, method: 'get' | 'post', args: { params?: Record<string, string>; query?: Record<string, string> } = {}) {
  const res: MockResponse = { statusCode: 200, body: undefined };
  res.status = ((code: number) => { res.statusCode = code; return res as Response; }) as Response['status'];
  res.json = ((payload: unknown) => { res.body = payload; return res as Response; }) as Response['json'];
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  await handlerFor(deps, routePath, method)({
    get: ((name: string) => headers[name.toLowerCase()]) as Request['get'],
    params: args.params ?? {}, query: args.query ?? {}, body: undefined,
  }, res);
  return res;
}

describe('an agent and its owner’s mail', () => {
  it('searches, archives and trashes — named on every move, with no way to delete for good', async () => {
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

    const found = await callCli(deps, token, '/mail', 'get', { query: { q: 'invoice' } });
    expect((found.body as { messages: { id: string }[] }).messages.map((message) => message.id)).toEqual([invoice.id]);
    expect((await callCli(deps, token, '/mail', 'get', { query: { in: 'bin' } })).statusCode).toBe(400);

    const trashed = await callCli(deps, token, '/mail/:id/trash', 'post', { params: { id: brief.id } });
    expect(trashed.body).toMatchObject({ moved: true, message: { id: brief.id, place: 'trash', movedBy: 'Ruby' } });
    const inTrash = await callCli(deps, token, '/mail', 'get', { query: { in: 'trash' } });
    expect((inTrash.body as { messages: { id: string; movedBy?: string }[] }).messages).toEqual([
      expect.objectContaining({ id: brief.id, movedBy: 'Ruby' }),
    ]);
    expect((await callCli(deps, token, '/mail/:id/restore', 'post', { params: { id: brief.id } })).body)
      .toMatchObject({ moved: true, message: { id: brief.id } });
    expect(((await callCli(deps, token, '/mail/:id/restore', 'post', { params: { id: brief.id } })).body as { moved: boolean }).moved).toBe(false);

    // There is no route an agent could delete a letter through.
    const router = agentCliRoutes(deps as RouteDeps) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    const mailRoutes = router.stack.flatMap((layer) => (layer.route?.path.startsWith('/mail') ? [layer.route] : []));
    expect(mailRoutes.some((route) => route.methods.delete)).toBe(false);
    expect(mailRoutes.some((route) => /forever|purge|empty/.test(route.path))).toBe(false);
  });
});
