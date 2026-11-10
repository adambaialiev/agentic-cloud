import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
    storage = new RemoteDirectMessageStorage({
      call: (id, operation, body) => hosts.get(id)!.call(id, operation, body),
      upload: (id, meta, bytes) => hosts.get(id)!.upload(id, meta, bytes),
      download: (id, body) => hosts.get(id)!.download(id, body),
    }, new SqliteDirectMessageUnreadStore(db));
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
  it('wakes the workplace\'s machine for Home without reading or sending anything (note #1104)', async () => {
    const woken: string[] = [];
    (storage as unknown as { wake: (orgId: string) => Promise<void> }).wake = async (id: string) => { woken.push(id); };
    const answer = await request(1, '/wake', 'POST', {});
    expect(answer.status).toBe(202);
    expect(await answer.json()).toEqual({ ok: true });
    expect(woken).toEqual([orgId]);
    // "wake" is not a person: nothing was sent, and nobody has a conversation.
    expect(await hosts.get(orgId)!.call(orgId, 'count', {})).toEqual({ count: 0 });
    expect((await request(4, '/wake', 'POST', {})).status).toBe(403);
    expect((await fetch(`${origin}/workspace/api/messages/wake?org=${orgId}`, { method: 'POST' })).status).toBe(401);
  });
  // Note #1125: files ride a message; their bytes live on the messaging machine.
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 1, 0x40, 0, 0, 0, 0xf0]), Buffer.alloc(40, 7)]);
  const JPEG_THUMB = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.from('ffc0001108', 'hex'), Buffer.from([0, 0x78, 0, 0xa0]), Buffer.from('03012200021101031101', 'hex'), Buffer.alloc(30, 1), Buffer.from('ffd9', 'hex')]);
  const upload = (who: number, to: string, bytes: Buffer, name: string, extra = '', org?: string) => fetch(`${origin}/workspace/api/messages/${to}/files?org=${org ?? orgId}${extra}`, {
    method: 'POST', headers: { ...workspaceTestHeaders(who), 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body: new Uint8Array(bytes),
  });
  const file = (who: number, peer: string, id: string, query = '') => fetch(`${origin}/workspace/api/messages/${peer}/files/${id}?org=${orgId}${query}`, { headers: workspaceTestHeaders(who) });
  it('carries files: unsent ones are the uploader\'s alone, sent ones the pair\'s alone, and pictures are decided by their bytes', async () => {
    const pic = await upload(1, 'bob', PNG, 'screen shot.png');
    expect(pic.status).toBe(201);
    const { file: picture } = await pic.json();
    expect(picture).toMatchObject({ name: 'screen shot.png', type: 'image/png', size: PNG.length, width: 320, height: 240 });
    expect(picture.id).toMatch(/^f[0-9a-f]{24}$/);
    // A "picture" whose bytes are not one is a download, never drawn.
    const fake = await (await upload(1, 'bob', Buffer.from('<svg onload="alert(1)"/>'), 'evil.png')).json();
    expect(fake.file.type).toBe('application/octet-stream');
    // Unsent: Alice may see her own; Bob, the admin and the other workplace may not.
    expect((await file(1, 'bob', picture.id)).status).toBe(200);
    expect((await file(2, 'alice', picture.id)).status).toBe(404);
    expect((await file(3, 'alice', picture.id)).status).toBe(404);
    // Bob cannot attach Alice's upload, and Alice cannot attach it to another conversation.
    expect((await request(2, '/alice', 'POST', { text: 'mine', clientId: 'bob-steals-00001', files: [picture.id] })).status).toBe(400);
    expect((await request(1, '/admin', 'POST', { text: 'elsewhere', clientId: 'alice-admin-0001', files: [picture.id] })).status).toBe(400);
    // A picture alone is a whole message.
    const sent = await request(1, '/bob', 'POST', { text: '', clientId: 'alice-files-00001', files: [picture.id, fake.file.id] });
    expect(sent.status).toBe(201);
    const { message } = await sent.json();
    expect(message.text).toBe('');
    expect(message.files.map((f: { id: string }) => f.id)).toEqual([picture.id, fake.file.id]);
    // The retry is the same message; other files under the same id are a conflict.
    expect((await request(1, '/bob', 'POST', { text: '', clientId: 'alice-files-00001', files: [picture.id, fake.file.id] })).status).toBe(200);
    expect((await request(1, '/bob', 'POST', { text: '', clientId: 'alice-files-00001', files: [picture.id] })).status).toBe(409);
    // Bob reads it in the conversation and the inbox, and gets the bytes; the admin does not.
    const page = await (await request(2, '/alice')).json();
    expect(page.messages[0].files).toHaveLength(2);
    expect((await (await request(2)).json()).threads[0].lastMessage.files[0].name).toBe('screen shot.png');
    const got = await file(2, 'alice', picture.id);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toBe('inline');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    const download = await file(2, 'alice', fake.file.id);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="evil.png"/);
    expect((await file(2, 'alice', picture.id, '&download=1')).headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await file(3, 'alice', picture.id)).status).toBe(404);
    expect((await file(3, 'bob', picture.id)).status).toBe(404);
    expect((await fetch(`${origin}/workspace/api/messages/alice/files/${picture.id}?org=${otherOrgId}`, { headers: workspaceTestHeaders(2) })).status).toBe(404);
    expect((await fetch(`${origin}/workspace/api/messages/alice/files/${picture.id}?org=${orgId}`)).status).toBe(401);
    // A departed member loses them with the conversation; the one who stays keeps them.
    await orgs.removeMember(orgId, 'bob');
    expect((await file(2, 'alice', picture.id)).status).toBe(403);
    expect((await file(1, 'bob', picture.id)).status).toBe(200);
    expect((await upload(1, 'bob', PNG, 'again.png')).status).toBe(404);
  });
  it('keeps a picture\'s small copy beside it, refuses what is not one, and bounds the files', async () => {
    const { file: picture } = await (await upload(1, 'bob', PNG, 'p.png')).json();
    expect((await upload(1, 'bob', PNG, 'thumb', `&thumbOf=${picture.id}`)).status).toBe(415);
    expect((await upload(2, 'alice', JPEG_THUMB, 'thumb', `&thumbOf=${picture.id}`)).status).toBe(404);
    const small = await upload(1, 'bob', JPEG_THUMB, 'thumb', `&thumbOf=${picture.id}`);
    expect(small.status).toBe(201);
    // The small copy is upright, so its shape is the one the bubble frames.
    expect((await small.json()).file).toMatchObject({ id: picture.id, thumb: true, width: 160, height: 120 });
    const thumb = await file(1, 'bob', picture.id, '&thumb=1');
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await thumb.arrayBuffer()).equals(JPEG_THUMB)).toBe(true);
    expect((await upload(1, 'bob', Buffer.alloc(0), 'empty.txt')).status).toBe(400);
    expect((await upload(1, 'alice', PNG, 'self.png')).status).toBe(404);
    expect((await upload(4, 'bob', PNG, 'stranger.png')).status).toBe(403);
    const eleven = Array.from({ length: 11 }, (_, i) => `f${String(i).padStart(24, '0')}`);
    expect((await request(1, '/bob', 'POST', { text: 'many', clientId: 'too-many-files-01', files: eleven })).status).toBe(400);
    expect((await request(1, '/bob', 'POST', { text: '', clientId: 'nothing-at-all-01', files: [] })).status).toBe(400);
    // No file bytes or names reach a platform table.
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
    for (const table of tables) expect(JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())).not.toContain('p.png');
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

it('the messaging host keeps file bytes on its volume, refuses past the ceiling and the reserve, and sweeps unsent ones it no longer owns', async () => {
  const dir = mkdtempSync(`${tmpdir()}/human-files-`), filesDir = `${dir}/files`;
  let host = await startMsgHost({ orgId: 'o', dbPath: `${dir}/messages.db`, filesDir, maxFileBytes: 1000 });
  try {
    const { file } = await host.upload<{ file: { id: string } }>('o', { userId: 'a', peerId: 'b', name: 'a.txt', type: 'text/plain' }, Buffer.from('hello'));
    expect(readdirSync(filesDir)).toEqual([file.id]);
    expect(readFileSync(`${filesDir}/${file.id}`, 'utf8')).toBe('hello');
    await expect(host.upload('o', { userId: 'a', peerId: 'b', name: 'big.bin', type: 'x/y' }, Buffer.alloc(1001))).rejects.toMatchObject({ status: 413 });
    // Unsent files can be let go by their uploader only.
    expect(await host.call('o', 'discard', { userId: 'b', peerId: 'a', files: [file.id] })).toEqual({ removed: 0 });
    expect(await host.call('o', 'pending', { userId: 'a', peerId: 'b', files: [file.id] })).toMatchObject({ files: [{ id: file.id, name: 'a.txt', size: 5 }] });
    expect(await host.call('o', 'discard', { userId: 'a', peerId: 'b', files: [file.id] })).toEqual({ removed: 1 });
    expect(readdirSync(filesDir)).toEqual([]);
    const storage = await host.call<{ freeBytes: number; files: number }>('o', 'storage', {});
    expect(storage.files).toBe(0);
    expect(storage.freeBytes).toBeGreaterThan(0);
    // Sent files survive a restart; a full volume (reserve larger than what is free) refuses.
    const kept = await host.upload<{ file: { id: string } }>('o', { userId: 'a', peerId: 'b', name: 'k.txt', type: 'text/plain' }, Buffer.from('kept'));
    await host.call('o', 'send', { userId: 'a', peerId: 'b', text: '', clientId: 'kept-file-message', files: [kept.file.id] });
    await host.stop();
    host = await startMsgHost({ orgId: 'o', dbPath: `${dir}/messages.db`, filesDir, reserveBytes: 1e15 });
    const read = await host.download('o', { userId: 'b', peerId: 'a', fileId: kept.file.id });
    expect(Buffer.from(await new Response(read!.body).arrayBuffer()).toString()).toBe('kept');
    await expect(host.upload('o', { userId: 'a', peerId: 'b', name: 'x.txt', type: 'text/plain' }, Buffer.from('x'))).rejects.toMatchObject({ status: 507 });
  } finally { await host.stop(); rmSync(dir, { recursive: true, force: true }); }
});
