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
import { MailOutboxService, replyReferences } from '../../services/mail-outbox.js';
import { MailIngestService } from '../../services/mail-ingest.js';
import type { MediaStorage } from '../../services/media-storage.js';
import type { MailSender } from '../../services/mail-sender.js';
import { MAIL_REFS_KEPT, mailConversationFacts, mailRefs, readReferences } from '../../services/mail-threads.js';
import type { MailConversationPage, MailMessageDocument } from '../../services/mail-message-storage.js';
import type {
  WorkspaceMailConversationAnswer,
  WorkspaceMailConversationMoveAnswer,
  WorkspaceMailConversationsAnswer,
} from '../../shared/workspace-mail.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

/**
 * Conversations (note #509, slice 8).
 *
 * The promises worth a test: an answer lands in the conversation it answers —
 * found by the headers mail writes for that, never by its subject — and a
 * stranger's headers can put THEIR letter somewhere but can never glue two of
 * this person's conversations together; the list is one row per conversation,
 * newest activity first, in the place its liveliest letter is; and a whole
 * conversation moves as one, with nothing removed and every agent named.
 */

const MINE = 'alice@agenticcloudcomputer.com';
let seq = 0;
const letter = (over: Partial<MailMessageDocument> = {}): MailMessageDocument => {
  seq += 1;
  return {
    id: `mm_${seq}`,
    userId: 'alice',
    address: MINE,
    envelopeFrom: 'bounces@example.com',
    receivedAt: new Date(Date.UTC(2026, 8, 1, 9, seq)).toISOString(),
    messageId: `m${seq}@example.com`,
    from: { name: 'Priya Raman', address: 'priya@harborlight.co' },
    to: [{ address: MINE }],
    cc: [],
    replyTo: [],
    subject: 'The brief',
    snippet: 'Here is the brief.',
    text: 'Here is the brief.',
    attachments: [],
    raw: { storagePath: `users/alice/mail/mm_${seq}/raw.eml`, size: 100 },
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
const threadOf = async (messages: SqliteMailMessageStorage, id: string) => (await messages.get('alice', id))?.thread;
const rows = (page: MailConversationPage) => page.conversations.map((conversation) => conversation.messages.map((message) => message.id));

describe('which conversation a letter is in', () => {
  it('follows what it answers: our reply, the answer to our reply, and the answer to a message we started', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId, subject: 'Re: The brief' });
    const back = letter({ inReplyTo: ours.messageId, references: [brief.messageId!, ours.messageId!], subject: 'Re: The brief' });
    const started = sent({ subject: 'The lease' });
    const answer = letter({ from: { address: 'dana@okonjo.studio' }, inReplyTo: started.messageId, subject: 'Re: The lease' });
    await store(messages, brief, ours, back, started, answer);
    expect(await threadOf(messages, brief.id)).toBe(brief.id);
    expect(await threadOf(messages, ours.id)).toBe(brief.id);
    expect(await threadOf(messages, back.id)).toBe(brief.id);
    expect(await threadOf(messages, started.id)).toBe(started.id);
    expect(await threadOf(messages, answer.id)).toBe(started.id);
  });

  it('finds it through References when the letter it answers never reached this mailbox', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    // Priya answered a colleague's message Alice was never sent; its
    // References still name the brief.
    const later = letter({ inReplyTo: 'elsewhere@harborlight.co', references: [brief.messageId!, 'elsewhere@harborlight.co'] });
    await store(messages, brief, later);
    expect(await threadOf(messages, later.id)).toBe(brief.id);
  });

  it('never by subject: the same “Re:” from a stranger is a conversation of its own', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const stranger = letter({ from: { address: 'someone@else.example' }, subject: 'Re: The brief', inReplyTo: undefined });
    await store(messages, brief, stranger);
    expect(await threadOf(messages, stranger.id)).toBe(stranger.id);
  });

  it('takes in the letter an answer was waiting for, when the answer arrived first', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const original = letter({ messageId: 'original@harborlight.co' });
    const early = letter({ from: { address: 'dana@okonjo.studio' }, inReplyTo: 'original@harborlight.co' });
    await store(messages, early, original);
    expect(await threadOf(messages, original.id)).toBe(early.id);
  });

  it('joins ONE conversation — a letter naming two never glues them together', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const lease = letter({ from: { address: 'dana@okonjo.studio' }, subject: 'The lease' });
    // A stranger who has seen both Message-IDs names both.
    const glue = letter({ from: { address: 'mallory@evil.example' }, inReplyTo: lease.messageId, references: [brief.messageId!, lease.messageId!] });
    await store(messages, brief, lease, glue);
    expect(await threadOf(messages, glue.id)).toBe(lease.id);
    expect(await threadOf(messages, brief.id)).toBe(brief.id);
    expect(await threadOf(messages, lease.id)).toBe(lease.id);
    expect((await messages.getConversation('alice', brief.id))!.messages.map((message) => message.id)).toEqual([brief.id]);
  });

  it('is only ever the reader’s own: another person’s Message-IDs thread nothing here', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const bobs = letter({ userId: 'bob', address: 'bob@agenticcloudcomputer.com', messageId: 'shared@example.com' });
    const alices = letter({ inReplyTo: 'shared@example.com' });
    await store(messages, bobs, alices);
    expect(await threadOf(messages, alices.id)).toBe(alices.id);
    expect(await messages.getConversation('bob', alices.id)).toBeNull();
  });

  it('reads References as ids, nearest first, and keeps only so many', () => {
    expect(readReferences('<a@x>  <b@y>\r\n <c@z> junk')).toEqual(['a@x', 'b@y', 'c@z']);
    expect(readReferences('not an id')).toEqual([]);
    expect(mailRefs({ messageId: 'self@x', inReplyTo: 'c@z', references: ['a@x', 'b@y', 'c@z', 'self@x'] })).toEqual(['c@z', 'b@y', 'a@x']);
    const many = Array.from({ length: 60 }, (_, at) => `r${at}@x`);
    expect(readReferences(many.map((id) => `<${id}>`).join(' '))).toHaveLength(MAIL_REFS_KEPT);
    expect(mailRefs({ references: many })).toHaveLength(MAIL_REFS_KEPT);
    expect(mailRefs({ references: many })[0]).toBe('r59@x');
  });

  it('carries the whole chain on what we send, so the answer comes back into it', () => {
    expect(replyReferences({ messageId: 'c@z', references: ['a@x', 'b@y'] })).toEqual(['a@x', 'b@y', 'c@z']);
    expect(replyReferences({ messageId: 'c@z', inReplyTo: 'b@y' })).toEqual(['b@y', 'c@z']);
    expect(replyReferences({ messageId: 'c@z' })).toEqual(['c@z']);
    expect(replyReferences({ messageId: 'c@z', references: ['a@x', 'c@z'] })).toEqual(['a@x', 'c@z']);
  });
});

describe('a letter arriving', () => {
  it('keeps what it follows, and lands in its conversation', async () => {
    const db = openSqliteDb(':memory:');
    const mailboxes = new SqliteMailboxStorage(db);
    const messages = new SqliteMailMessageStorage(db);
    await new MailboxService(mailboxes).claim('user-adam', 'adam');
    const media = { uploadObject: async () => undefined, deleteObjectsWithPrefix: async () => undefined } as unknown as MediaStorage;
    const service = new MailIngestService({ mailboxes, messages, media });
    const mime = (id: string, headers: string[] = []) => Buffer.from([
      'From: "Ada Lovelace" <ada@example.com>',
      'To: adam@agenticcloudcomputer.com',
      'Subject: The engine',
      `Message-ID: <${id}>`,
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello.',
      '',
    ].join('\r\n'));
    const first = await service.accept({ to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com', raw: mime('one@example.com') });
    const second = await service.accept({
      to: 'adam@agenticcloudcomputer.com', from: 'ada@example.com',
      raw: mime('three@example.com', ['In-Reply-To: <two@example.com>', 'References: <one@example.com>\r\n <two@example.com>']),
    });
    const stored = await messages.get('user-adam', second.id);
    expect(stored).toMatchObject({ inReplyTo: 'two@example.com', references: ['one@example.com', 'two@example.com'], thread: first.id });
  });
});

describe('the list, as conversations', () => {
  async function mailbox() {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter({ attachments: [{ id: 'ma_1', fileName: 'brief.pdf', contentType: 'application/pdf', size: 10, storagePath: 'x' }], readAt: 't' });
    const invoice = letter({ from: { name: 'Fly.io', address: 'billing@fly.io' }, subject: 'Your invoice', readAt: 't' });
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId, subject: 'Re: The brief', text: 'Looks right.\n\n> Here is the brief.', wrote: 'Looks right.' });
    const back = letter({ inReplyTo: ours.messageId, subject: 'Re: The brief', snippet: 'Thank you!' });
    await store(messages, brief, invoice, ours, back);
    return { messages, brief, invoice, ours, back };
  }

  it('is one row per conversation, newest activity first — a reply this person sent is activity too', async () => {
    const { messages, brief, invoice, ours, back } = await mailbox();
    expect(rows(await messages.listConversations('alice'))).toEqual([[brief.id, ours.id, back.id], [invoice.id]]);
    const another = sent({ answers: invoice.id, inReplyTo: invoice.messageId, subject: 'Re: Your invoice' });
    await store(messages, another);
    expect(rows(await messages.listConversations('alice')).map((row) => row[0])).toEqual([invoice.id, brief.id]);
  });

  it('says who it is with, what it is called, how many, and where a tap opens it', async () => {
    const { messages, brief, back } = await mailbox();
    const [conversation] = (await messages.listConversations('alice')).conversations;
    const facts = mailConversationFacts(conversation!);
    expect(facts).toMatchObject({
      thread: brief.id, count: 3, subject: 'The brief', place: 'inbox', unread: true, opens: back.id, files: 1, started: false,
    });
    expect(facts.with).toEqual([{ name: 'Priya Raman', address: 'priya@harborlight.co' }]);
    expect(facts.latest.id).toBe(back.id);
    // A list reads no bodies.
    expect(conversation!.messages.every((message) => message.text === undefined && message.html === undefined)).toBe(true);
  });

  it('files a conversation where its liveliest letter is — and an answer brings one back', async () => {
    const { messages, brief, ours, back, invoice } = await mailbox();
    const at = { atIso: '2026-09-22T10:00:00.000Z' };
    expect((await messages.moveConversation('alice', ours.id, 'archive', at))).toMatchObject({ moved: true });
    expect(rows(await messages.listConversations('alice'))).toEqual([[invoice.id]]);
    expect(rows(await messages.listConversations('alice', { in: 'archive' }))).toEqual([[brief.id, ours.id, back.id]]);
    // Priya writes again. The new letter is in the inbox, and so is the
    // conversation — the letters that were archived stay where they were.
    const again = letter({ inReplyTo: back.messageId, subject: 'Re: The brief' });
    await store(messages, again);
    expect(rows(await messages.listConversations('alice'))[0]).toEqual([brief.id, ours.id, back.id, again.id]);
    expect(rows(await messages.listConversations('alice', { in: 'archive' }))).toEqual([]);
    expect((await messages.get('alice', brief.id))!.archivedAt).toBe(at.atIso);
  });

  it('pages by newest activity, with a cursor no two conversations share', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const letters = Array.from({ length: 5 }, (_, at) => letter({ subject: `Letter ${at}` }));
    await store(messages, ...letters);
    const first = await messages.listConversations('alice', { limit: 2 });
    expect(rows(first)).toEqual([[letters[4]!.id], [letters[3]!.id]]);
    const second = await messages.listConversations('alice', { limit: 2, before: first.nextBefore });
    expect(rows(second)).toEqual([[letters[2]!.id], [letters[1]!.id]]);
    const last = await messages.listConversations('alice', { limit: 2, before: second.nextBefore });
    expect(rows(last)).toEqual([[letters[0]!.id]]);
    expect(last.nextBefore).toBeUndefined();
    expect(rows(await messages.listConversations('bob'))).toEqual([]);
  });
});

describe('moving a whole conversation', () => {
  it('moves every letter of it, the replies among them, and is undone exactly', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId });
    const back = letter({ inReplyTo: ours.messageId });
    await store(messages, brief, ours, back);
    const at = { atIso: '2026-09-22T10:00:00.000Z' };
    const trashed = await messages.moveConversation('alice', back.id, 'trash', { ...at, by: { agentId: 'agent-r', name: 'Ruby' } });
    expect(trashed).toMatchObject({ moved: true });
    // Every letter of it, the reply included (slice 9): a reply goes where its
    // conversation goes, and Sent is the one list that asks where that is.
    for (const id of [brief.id, ours.id, back.id]) expect((await messages.get('alice', id))).toMatchObject({ trashedAt: at.atIso, trashedBy: { name: 'Ruby' } });
    expect(rows(await messages.listConversations('alice', { in: 'trash' }))).toEqual([[brief.id, ours.id, back.id]]);
    // Asking twice moves nothing; archiving a conversation wholly in Trash is refused.
    expect(await messages.moveConversation('alice', brief.id, 'trash', at)).toMatchObject({ moved: false });
    expect(await messages.moveConversation('alice', brief.id, 'archive', at)).toEqual({ refused: 'in_trash' });
    expect(await messages.moveConversation('bob', brief.id, 'restore', at)).toEqual({ refused: 'no_such_message' });
    expect(await messages.moveConversation('alice', brief.id, 'restore', at)).toMatchObject({ moved: true });
    expect(rows(await messages.listConversations('alice'))).toEqual([[brief.id, ours.id, back.id]]);
    expect((await messages.get('alice', brief.id))!.trashedBy).toBeUndefined();
  });

  it('archives the rest of a conversation that is partly in Trash, and says how much of it is there', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const back = letter({ inReplyTo: brief.messageId });
    await store(messages, brief, back);
    const at = { atIso: '2026-09-22T10:00:00.000Z' };
    await messages.move('alice', brief.id, 'trash', at);
    const [inbox] = (await messages.listConversations('alice')).conversations;
    expect(mailConversationFacts(inbox!)).toMatchObject({ place: 'inbox', trashed: 1 });
    const outcome = await messages.moveConversation('alice', back.id, 'archive', at);
    expect(outcome).toMatchObject({ moved: true });
    expect((await messages.get('alice', brief.id))!.archivedAt).toBeUndefined();
    expect((await messages.get('alice', back.id))!.archivedAt).toBe(at.atIso);
    expect(rows(await messages.listConversations('alice', { in: 'archive' }))).toEqual([[brief.id, back.id]]);
  });

  it('opens a conversation as read, every letter in it', async () => {
    const messages = new SqliteMailMessageStorage(openSqliteDb(':memory:'));
    const brief = letter();
    const back = letter({ inReplyTo: brief.messageId });
    const other = letter({ subject: 'Something else' });
    await store(messages, brief, back, other);
    expect(await messages.markConversationRead('alice', brief.id, 't')).toBe(2);
    expect(await messages.markConversationRead('alice', brief.id, 'u')).toBe(0);
    expect(await messages.countUnread('alice')).toBe(1);
  });
});

describe('mail stored before conversations existed', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('is threaded the first time an installation opens with this code, by the same rule', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-threads-'));
    dirs.push(dir);
    const file = path.join(dir, 'backend.db');
    const before = openSqliteDb(file);
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId });
    const back = letter({ inReplyTo: ours.messageId });
    const alone = letter({ subject: 'Unrelated' });
    await store(new SqliteMailMessageStorage(before), brief, ours, back, alone);
    // An installation from before slice 8: no columns, no index, no stamps.
    before.exec(`DROP INDEX IF EXISTS workspace_mail_messages_by_thread_place;
      ALTER TABLE workspace_mail_messages DROP COLUMN thread;
      ALTER TABLE workspace_mail_messages DROP COLUMN refs;
      UPDATE workspace_mail_messages SET doc = json_remove(doc, '$.thread');`);
    before.close();
    const after = openSqliteDb(file);
    const messages = new SqliteMailMessageStorage(after);
    expect(rows(await messages.listConversations('alice'))).toEqual([[alone.id], [brief.id, ours.id, back.id]]);
    expect(await threadOf(messages, back.id)).toBe(brief.id);
    after.close();
    const again = openSqliteDb(file);
    expect(rows(await new SqliteMailMessageStorage(again).listConversations('alice'))).toEqual([[alone.id], [brief.id, ours.id, back.id]]);
    again.close();
  });

  it('lists conversations from the index alone, never opening a letter', () => {
    const db = openSqliteDb(':memory:');
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT thread, MAX(seq) AS latest,
        MIN(CASE WHEN (direction = 'in' OR (direction = 'sent' AND answers IS NULL)) THEN
          CASE WHEN json_extract(doc, '$.trashedAt') IS NOT NULL THEN 3 WHEN json_extract(doc, '$.archivedAt') IS NOT NULL THEN 2 ELSE 1 END END) AS rank
      FROM workspace_mail_messages WHERE user_id = 'alice' GROUP BY thread`).all() as { detail: string }[];
    expect(plan.map((step) => step.detail).join('\n')).toMatch(/COVERING INDEX workspace_mail_messages_by_thread/);
  });
});

describe('the owner’s Workspace', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('lists, opens and moves conversations — and refuses anybody else', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId, subject: 'Re: The brief', text: 'Looks right.\n\n> Here is the brief.', wrote: 'Looks right.', sentBy: { agentId: 'agent-r', name: 'Ruby' } });
    const back = letter({ inReplyTo: ours.messageId, subject: 'Re: The brief', text: 'Thank you!\n\n> Looks right.' });
    const invoice = letter({ from: { name: 'Fly.io', address: 'billing@fly.io' }, subject: 'Your invoice', readAt: 't' });
    await store(messages, brief, invoice, ours, back);
    const users = new InMemoryUserStorage();
    await users.createProfile('alice', { email: 'a@example.test' });
    await users.createProfile('bob', { email: 'b@example.test' });
    const sender: MailSender = { send: async () => undefined } as unknown as MailSender;
    const mailboxes = new MailboxService(new SqliteMailboxStorage(db));
    const deps: Partial<RouteDeps> = {
      userStorage: users, mailMessages: messages, mailboxes,
      mailOutbox: new MailOutboxService({ mailboxes: new SqliteMailboxStorage(db), messages, sender }),
    };
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

    const listed = (await (await call(42, 'mail/conversations')).json()) as WorkspaceMailConversationsAnswer;
    expect(listed.conversations.map((row) => row.id)).toEqual([brief.id, invoice.id]);
    expect(listed.conversations[0]).toMatchObject({
      subject: 'The brief', count: 3, unread: true, opens: brief.id,
      with: [{ name: 'Priya Raman', address: 'priya@harborlight.co' }],
      latest: { id: back.id, snippet: 'Here is the brief.' },
    });
    expect(listed.conversations[1]).not.toHaveProperty('unread');
    expect((await call(42, 'mail/conversations?in=all')).status).toBe(400);
    expect((await call(42, 'mail/conversations?in=bin')).status).toBe(400);

    // Opened by ANY message in it — the one a search found, say.
    const opened = (await (await call(42, `mail/conversations/${ours.id}`)).json()) as WorkspaceMailConversationAnswer;
    expect(opened.conversation.messages.map((message) => message.id)).toEqual([brief.id, ours.id, back.id]);
    // Ours reads as what she wrote, marked as the agent's; theirs as it arrived.
    expect(opened.conversation.messages[1]).toMatchObject({ direction: 'sent', text: 'Looks right.', sentBy: 'Ruby' });
    expect(opened.conversation.messages[2]).toMatchObject({ text: 'Thank you!\n\n> Looks right.' });
    // The foot answers the newest letter that arrived, to whoever it names.
    expect(opened.conversation.reply).toEqual({ id: back.id, to: { name: 'Priya Raman', address: 'priya@harborlight.co' } });
    // Opening it read every letter in it.
    expect(opened.conversation.unread).toBeUndefined();
    expect(await messages.countUnread('alice')).toBe(0);

    const archived = (await (await call(42, `mail/conversations/${brief.id}/archive`, 'POST')).json()) as WorkspaceMailConversationMoveAnswer;
    expect(archived.conversation).toMatchObject({ id: brief.id, place: 'archive' });
    expect(archived.messages).toEqual([
      { id: brief.id, place: 'archive' }, { id: ours.id, place: 'archive' }, { id: back.id, place: 'archive' },
    ]);
    expect(((await (await call(42, 'mail/conversations')).json()) as WorkspaceMailConversationsAnswer).conversations.map((row) => row.id)).toEqual([invoice.id]);
    expect(((await (await call(42, 'mail/conversations?in=archive')).json()) as WorkspaceMailConversationsAnswer).conversations.map((row) => row.id)).toEqual([brief.id]);

    await call(42, `mail/conversations/${brief.id}/trash`, 'POST');
    const refused = await call(42, `mail/conversations/${brief.id}/unarchive`, 'POST');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'in_trash', error: 'That conversation is in Trash. Restore it first.' });

    // Bob knows the ids and gets nothing: absent, not refused.
    expect((await call(43, `mail/conversations/${brief.id}`)).status).toBe(404);
    expect((await call(43, `mail/conversations/${brief.id}/restore`, 'POST')).status).toBe(404);
    expect(((await (await call(43, 'mail/conversations?in=trash')).json()) as WorkspaceMailConversationsAnswer).conversations).toEqual([]);

    const restored = (await (await call(42, `mail/conversations/${back.id}/restore`, 'POST')).json()) as WorkspaceMailConversationMoveAnswer;
    expect(restored.conversation.place).toBe('archive');
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

describe('an agent and its owner’s conversations', () => {
  it('lists them, shows where a message sits in one, and moves one whole — named', async () => {
    const db = openSqliteDb(':memory:');
    const messages = new SqliteMailMessageStorage(db);
    const brief = letter();
    const ours = sent({ answers: brief.id, inReplyTo: brief.messageId });
    const back = letter({ inReplyTo: ours.messageId });
    await store(messages, brief, ours, back);
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
    const sender: MailSender = { send: async () => undefined } as unknown as MailSender;
    const deps: Partial<RouteDeps> = {
      userStorage: users, mailMessages: messages, mailboxes,
      mailOutbox: new MailOutboxService({ mailboxes: new SqliteMailboxStorage(db), messages, sender }),
    };

    const listed = await callCli(deps, token, '/mail/conversations', 'get');
    expect((listed.body as { conversations: unknown[] }).conversations).toEqual([
      expect.objectContaining({ id: back.id, conversation: brief.id, count: 3, reply: back.id, subject: 'The brief' }),
    ]);
    // The old list route still answers rows of letters, for a CLI that has not updated.
    expect((await callCli(deps, token, '/mail', 'get')).body).toMatchObject({ messages: [{ id: back.id }, { id: brief.id }] });

    const shown = await callCli(deps, token, '/mail/:id', 'get', { params: { id: brief.id } });
    expect((shown.body as { message: { conversation: unknown } }).message.conversation).toEqual({
      id: brief.id,
      messages: [
        expect.objectContaining({ id: brief.id, direction: 'in' }),
        expect.objectContaining({ id: ours.id, direction: 'sent' }),
        expect.objectContaining({ id: back.id, direction: 'in' }),
      ],
      reply: back.id,
    });
    // A letter alone in its conversation says nothing about one.
    const alone = letter({ subject: 'Alone' });
    await store(messages, alone);
    expect((await callCli(deps, token, '/mail/:id', 'get', { params: { id: alone.id } })).body).not.toHaveProperty('message.conversation');

    const archived = await callCli(deps, token, '/mail/conversations/:id/archive', 'post', { params: { id: ours.id } });
    expect(archived.body).toMatchObject({ moved: true, conversation: { conversation: brief.id, place: 'archive', movedBy: 'Ruby' } });
    expect((await messages.get('alice', back.id))!.archivedBy).toEqual({ agentId: 'agent-r', name: 'Ruby' });
    expect((await callCli(deps, token, '/mail/conversations', 'get', { query: { in: 'all' } })).statusCode).toBe(400);
    expect((await callCli(deps, token, '/mail/conversations/:id/archive', 'post', { params: { id: 'mm_nope' } })).statusCode).toBe(404);

    // Declared before `/mail/:id`, or `conversations` would be read as an id.
    const router = agentCliRoutes(deps as RouteDeps) as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    const order = router.stack.flatMap((layer) => (layer.route?.methods.get ? [layer.route.path] : []));
    expect(order.indexOf('/mail/conversations')).toBeLessThan(order.indexOf('/mail/:id'));
  });
});
