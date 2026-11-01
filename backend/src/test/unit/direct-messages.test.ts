import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { workspaceRoutes } from '../../routes/workspace.js';
import type { RouteDeps } from '../../routes/deps.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { RemoteDirectMessageStorage } from '../../services/remote-direct-message-storage.js';
import { SqliteDirectMessageUnreadStore } from '../../services/sqlite/sqlite-direct-message-unread-store.js';
import { startMsgHost, type MsgHostProcess } from './msg-host-process.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { addWorkspaceTestAuth, workspaceTestHeaders } from './workspace-route-auth.js';

// The router, the remote storage and the REAL messaging-host server, one
// process per workplace — exactly production's shape minus the cloud.
describe('private messages through the real Workspace router', () => {
  let server: Server, origin: string, orgId: string, otherOrgId: string;
  let orgs: InMemoryOrgStorage, storage: RemoteDirectMessageStorage, db: SqliteDb;
  let hosts: Map<string, MsgHostProcess>;
  let routeDeps: Partial<RouteDeps>;
  const request = (who: number, path = '', method = 'GET', body?: unknown, org?: string) => fetch(`${origin}/workspace/api/messages${path}?org=${org ?? orgId}`, {
    method, headers: { ...workspaceTestHeaders(who), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const send = (who = 1, to = 'bob', text = 'Hello Bob', clientId = 'test-message-0001', org?: string) => request(who, `/${to}`, 'POST', { text, clientId, senderId: 'forged-user' }, org);
  beforeEach(async () => {
    const users = new InMemoryUserStorage(); orgs = new InMemoryOrgStorage();
    db = openSqliteDb(':memory:');
    for (const name of ['alice', 'bob', 'admin', 'outsider']) await users.createProfile(name, { email: `${name}@example.test`, displayName: name });
    orgId = (await orgs.createOrg({ name: 'Studio', createdByUserId: 'admin' })).orgId;
    otherOrgId = (await orgs.createOrg({ name: 'Elsewhere', createdByUserId: 'outsider' })).orgId;
    for (const name of ['alice', 'bob', 'admin']) await orgs.addMember({ orgId, userId: name, role: name === 'admin' ? 'admin' : 'member' });
    for (const name of ['alice', 'bob', 'outsider']) await orgs.addMember({ orgId: otherOrgId, userId: name, role: 'member' });
    hosts = new Map();
    for (const id of [orgId, otherOrgId]) hosts.set(id, await startMsgHost({ orgId: id }));
    storage = new RemoteDirectMessageStorage({ call: (id, operation, body) => hosts.get(id)!.call(id, operation, body) }, new SqliteDirectMessageUnreadStore(db));
    const deps: Partial<RouteDeps> = { userStorage: users, orgStorage: orgs, directMessageStorage: storage };
    routeDeps = deps;
    await addWorkspaceTestAuth(deps, users, { 1: 'alice', 2: 'bob', 3: 'admin', 4: 'outsider' });
    const app = express(); app.use(express.json()); app.use('/workspace', workspaceRoutes(deps as RouteDeps));
    server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await Promise.all([...hosts.values()].map(host => host.stop())); });

  it('delivers only to the pair, never to another member, admin, org or supplied sender', async () => {
    const sent = await send(); expect(sent.status).toBe(201);
    const { message } = await sent.json(); expect(message.senderId).toBe('alice');
    const inbox = await (await request(2)).json(); expect(inbox.unread).toBe(1); expect(inbox.threads[0].lastMessage.text).toBe('Hello Bob');
    expect((await (await request(1)).json()).unread).toBe(0);
    expect((await (await request(3)).json()).threads).toEqual([]);
    expect((await (await request(3, '/bob')).json()).messages).toEqual([]);
    expect((await (await request(1, '/bob', 'GET', undefined, otherOrgId)).json()).messages).toEqual([]);
    expect((await request(4)).status).toBe(403);
    expect((await fetch(`${origin}/workspace/api/messages`)).status).toBe(401);
    const csrf = await fetch(`${origin}/workspace/api/messages/bob?org=${orgId}`, { method: 'POST', headers: { ...workspaceTestHeaders(1), 'X-CSRF-Token': '', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'bad', clientId: 'test-message-csrf' }) });
    expect(csrf.status).toBe(403);
    expect(sent.headers.get('cache-control')).toBe('no-store');
  });
  it('makes retries idempotent and keeps separate workplaces separate', async () => {
    const first = await (await send()).json();
    const retry = await send(); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(first);
    expect((await send(1, 'bob', 'Changed')).status).toBe(409);
    expect((await send(1, 'bob', 'Other org', 'test-message-0001', otherOrgId)).status).toBe(201);
    expect((await (await request(2)).json()).unread).toBe(1);
    expect((await (await request(2, '', 'GET', undefined, otherOrgId)).json()).threads[0].lastMessage.text).toBe('Other org');
  });
  it('keeps GET read-only and receipts monotonic, bounded to messages actually read', async () => {
    const one = (await (await send()).json()).message;
    await request(2, '/alice'); expect((await (await request(2, '/unread')).json()).unread).toBe(1);
    const two = (await (await send(1, 'bob', 'Second', 'test-message-0002')).json()).message;
    await request(2, '/alice/read', 'POST', { through: one.id });
    expect((await (await request(2)).json()).unread).toBe(1);
    await request(2, '/alice/read', 'POST', { through: 999999 });
    expect((await (await request(2)).json()).unread).toBe(1);
    await request(3, '/alice/read', 'POST', { through: two.id });
    expect((await (await request(2)).json()).unread).toBe(1);
    await request(2, '/alice/read', 'POST', { through: two.id });
    await request(2, '/alice/read', 'POST', { through: one.id });
    expect((await (await request(2)).json()).unread).toBe(0);
  });
  it('revokes a departed viewer immediately, keeps the remaining participant history and refuses sends', async () => {
    await send(); await orgs.removeMember(orgId, 'bob');
    expect((await request(2, '/alice')).status).toBe(403);
    expect((await send()).status).toBe(404);
    const page = await (await request(1, '/bob')).json();
    expect(page.person).toEqual({ userId: 'bob', name: 'Former member', available: false });
    expect(page.messages).toHaveLength(1);
    expect((await request(1, '/outsider')).status).toBe(404);
  });
  it('rejects invalid recipients, text and cursors without creating anything', async () => {
    expect((await send(1, 'alice')).status).toBe(404);
    expect((await send(1, 'outsider')).status).toBe(404);
    expect((await send(1, 'bob', '  ')).status).toBe(400);
    expect((await send(1, 'bob', 'x'.repeat(8001))).status).toBe(400);
    expect((await send(1, 'bob', 'Hi', 'bad')).status).toBe(400);
    const invalid = await fetch(`${origin}/workspace/api/messages/bob?org=${orgId}&before=-1`, { headers: workspaceTestHeaders(1) }); expect(invalid.status).toBe(400);
    expect(await storage.count(orgId)).toBe(0);
    expect(await hosts.get(orgId)!.call(orgId, 'count', {})).toEqual({ count: 0 });
  });
  it('keeps the text off the platform: its database holds one unread number per person and no message table', async () => {
    await send(1, 'bob', 'A private sentence');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'direct_message%'").all() as { name: string }[]).map(row => row.name);
    expect(tables).toEqual(['direct_message_unread']);
    expect(db.prepare('SELECT * FROM direct_message_unread').all()).toEqual([{ org_id: orgId, user_id: 'bob', unread: 1 }]);
    // Home's badge is answered from that number: with the machine gone it still answers.
    await hosts.get(orgId)!.stop();
    expect(await (await request(2, '/unread')).json()).toEqual({ unread: 1 });
    expect((await request(2)).status).toBe(503);
  });
  it('is offered again (29 Oct 2026) wherever there can be someone to write to, and nowhere else', async () => {
    const offered = async (who: number, org: string) => (await (await fetch(`${origin}/workspace/api/state?org=${org}`, { headers: workspaceTestHeaders(who) })).json()).messagesAvailable;
    // Invites open — a private copy, or a workplace we mark: offered.
    expect(await offered(1, orgId)).toBe(true);
    // Invites shut (the hosted service's default): a workplace of three
    // still has people to write to…
    routeDeps.invitesClosed = true;
    expect(await offered(1, orgId)).toBe(true);
    // …and a workplace of one that nobody can join has nobody, so no door.
    const solo = (await orgs.createOrg({ name: 'Solo', createdByUserId: 'outsider' })).orgId;
    await orgs.addMember({ orgId: solo, userId: 'outsider', role: 'admin' });
    expect(await offered(4, solo)).toBe(false);
    // Its mark opens the door, and with it the offer.
    await orgs.updateOrg(solo, { invitesAllowed: { at: new Date().toISOString(), by: 'test' } });
    expect(await offered(4, solo)).toBe(true);
    expect((await send()).status).toBe(201);
    expect((await (await request(2)).json()).threads[0].lastMessage.text).toBe('Hello Bob');
  });
});

it('persists Unicode, pagination, idempotency and read positions across a real restart of the messaging host', async () => {
  const dir = mkdtempSync(`${tmpdir()}/human-messages-`), dbPath = `${dir}/messages/messages.db`;
  let host = await startMsgHost({ orgId: 'o', dbPath });
  const db = openSqliteDb(':memory:');
  try {
    let store = new RemoteDirectMessageStorage(host, new SqliteDirectMessageUnreadStore(db));
    for (let i = 0; i < 120; i++) await store.send('o', 'a', 'b', `Hello 世界 ${i}\n<script>literal text</script>`, `message-${String(i).padStart(10, '0')}`);
    const newest = await store.page('o', 'b', 'a', 50); expect(newest.messages).toHaveLength(50); expect(newest.hasMore).toBe(true);
    const older = await store.page('o', 'b', 'a', 50, newest.messages[0]!.id); expect(older.messages[0]!.id).toBe(21);
    const oldest = await store.page('o', 'b', 'a', 50, older.messages[0]!.id); expect(oldest.messages).toHaveLength(20); expect(oldest.hasMore).toBe(false);
    const catchup = await store.page('o', 'b', 'a', 50, undefined, 20); expect(catchup.messages[0]!.id).toBe(21); expect(catchup.messages.at(-1)!.id).toBe(70); expect(catchup.hasMore).toBe(true);
    await store.readThrough('o', 'b', 'a', 100);
    await host.stop(); host = await startMsgHost({ orgId: 'o', dbPath }); store = new RemoteDirectMessageStorage(host, new SqliteDirectMessageUnreadStore(db));
    expect(await store.unread('o', 'b')).toBe(20);
    expect((await store.send('o', 'a', 'b', 'Hello 世界 0\n<script>literal text</script>', 'message-0000000000')).created).toBe(false);
    expect((await store.page('o', 'a', 'b', 50)).messages.at(-1)!.text).toContain('世界 119');
    expect((await store.inbox('o', 'b'))[0]!.unread).toBe(20);
  } finally { await host.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('the messaging host answers nobody without the secret, refuses another workplace, and stops itself when idle', async () => {
  const host = await startMsgHost({ orgId: 'o', idleMs: 300 });
  const post = (headers: Record<string, string>) => fetch(`${host.origin}/v1/inbox`, { method: 'POST', headers, body: JSON.stringify({ userId: 'a' }) });
  expect((await post({})).status).toBe(401);
  expect((await post({ 'x-msg-host-secret': 'wrong-secret' })).status).toBe(401);
  expect((await post({ 'x-msg-host-secret': host.secret, 'x-msg-host-org': 'another' })).status).toBe(403);
  expect((await post({ 'x-msg-host-secret': host.secret, 'x-msg-host-org': 'o' })).status).toBe(200);
  // A clean exit is how the machine sleeps (restart policy `no`).
  expect(await host.exited).toBe(0);
});

it('retires the old platform tables only while they are empty: a held conversation is never dropped by a schema change', () => {
  const dir = mkdtempSync(`${tmpdir()}/human-messages-retire-`);
  const legacy = (path: string, rows: number) => {
    const db = openSqliteDb(path);
    db.exec(`CREATE TABLE direct_messages (id INTEGER PRIMARY KEY, text TEXT); CREATE TABLE direct_message_threads (last_id INTEGER);`);
    for (let i = 0; i < rows; i++) db.prepare('INSERT INTO direct_messages (text) VALUES (?)').run('kept');
    db.close();
    const reopened = openSqliteDb(path);
    const names = (reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'direct_message%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    reopened.close();
    return names;
  };
  try {
    expect(legacy(`${dir}/empty.db`, 0)).toEqual(['direct_message_unread']);
    expect(legacy(`${dir}/held.db`, 1)).toEqual(['direct_message_threads', 'direct_message_unread', 'direct_messages']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
