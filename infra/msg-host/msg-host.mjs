#!/usr/bin/env node
// The messaging host (note #608): the ONE place a workplace's direct messages
// between people are stored. One machine, one volume, one SQLite file; the
// platform's own database holds no message text at all.
//
// Who may talk to it: the backend, and nobody else. Every request but /health
// carries MSG_HOST_SECRET, which the backend keeps as an operator secret no
// agent turn can read; the image's firewall additionally drops every private-
// network connection that does not come from the backend's own peer address,
// because agent machines share that network. There is no public address, no
// SSH, and no agent or CLI door.
//
// The backend authenticates the human and authorizes membership BEFORE it
// calls here, so every operation is keyed by that human and their peer — no
// caller-supplied thread id exists. This process trusts the secret's holder
// and nothing else.
//
// Sleep: nothing sits in front of this port to stop an idle machine, so the
// server stops ITSELF after MSG_HOST_IDLE_MS without a request (the machine's
// restart policy is `no`, so a clean exit is a stopped machine). The backend
// starts it again through the Fly API when somebody opens Messages.
//
// Zero dependencies on purpose: node:sqlite ships with Node 22.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SECRET = process.env.MSG_HOST_SECRET || '';
const ORG = process.env.MSG_HOST_ORG || '';
const DB_PATH = process.env.MSG_HOST_DB || '/data/messages/messages.db';
const HOST = process.env.HOST || '::';
const PORT = Number(process.env.PORT || 8080);
const IDLE_MS = Number(process.env.MSG_HOST_IDLE_MS ?? 10 * 60_000);
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 8000;

if (!SECRET) {
  // Fail closed: a host with no secret would answer anyone on the network.
  console.error('[msg-host] MSG_HOST_SECRET is not set — refusing to start');
  process.exit(1);
}

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  low_id TEXT NOT NULL,
  high_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  client_id TEXT NOT NULL,
  UNIQUE (low_id, high_id, sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_by_pair ON messages (low_id, high_id, id);
CREATE TABLE IF NOT EXISTS threads (
  low_id TEXT NOT NULL,
  high_id TEXT NOT NULL,
  last_id INTEGER NOT NULL,
  low_read INTEGER NOT NULL DEFAULT 0,
  high_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (low_id, high_id)
);
CREATE INDEX IF NOT EXISTS threads_by_high ON threads (high_id);
`);

const pair = (a, b) => (a < b ? [a, b] : [b, a]);
const shape = (r) => ({ id: Number(r.id), senderId: r.sender_id, text: r.text, createdAt: r.created_at, clientId: r.client_id });

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const id = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Refusal(400, `${name} is required`);
  return value;
};
const position = (value) => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Refusal(400, 'not a message position');
  return value;
};

function unreadFor(userId) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM threads t JOIN messages m ON m.low_id=t.low_id AND m.high_id=t.high_id
    WHERE (t.low_id=? OR t.high_id=?) AND m.sender_id != ?
    AND m.id > CASE WHEN t.low_id=? THEN t.low_read ELSE t.high_read END`).get(userId, userId, userId, userId).n);
}

const operations = {
  inbox(body) {
    const userId = id(body.userId, 'userId');
    const rows = db.prepare(`SELECT m.*, CASE WHEN t.low_id = ? THEN t.high_id ELSE t.low_id END AS peer_id,
      (SELECT COUNT(*) FROM messages u WHERE u.low_id=t.low_id AND u.high_id=t.high_id
       AND u.sender_id != ? AND u.id > CASE WHEN t.low_id=? THEN t.low_read ELSE t.high_read END) AS unread
      FROM threads t JOIN messages m ON m.id=t.last_id
      WHERE t.low_id=? OR t.high_id=? ORDER BY t.last_id DESC`).all(userId, userId, userId, userId, userId);
    return { threads: rows.map((r) => ({ peerId: r.peer_id, lastMessage: shape(r), unread: Number(r.unread) })) };
  },

  page(body) {
    const ids = pair(id(body.userId, 'userId'), id(body.peerId, 'peerId'));
    const before = position(body.before), after = position(body.after);
    if (before && after) throw new Refusal(400, 'choose one message position');
    const limit = Number.isSafeInteger(body.limit) && body.limit >= 1 && body.limit <= 200 ? body.limit : 50;
    const rows = db.prepare(`SELECT * FROM messages WHERE low_id=? AND high_id=?
      ${before ? 'AND id < ?' : after ? 'AND id > ?' : ''} ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(...ids, ...(before ? [before] : after ? [after] : []), limit + 1);
    const selected = rows.slice(0, limit);
    return { messages: (after ? selected : selected.reverse()).map(shape), hasMore: rows.length > limit };
  },

  send(body) {
    const userId = id(body.userId, 'userId'), peerId = id(body.peerId, 'peerId');
    if (userId === peerId) throw new Refusal(400, 'a conversation needs two people');
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text || text.length > MAX_TEXT) throw new Refusal(400, 'text is empty or too long');
    const clientId = body.clientId;
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(clientId)) throw new Refusal(400, 'clientId is not valid');
    const ids = pair(userId, peerId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM messages WHERE low_id=? AND high_id=? AND sender_id=? AND client_id=?').get(...ids, userId, clientId);
      let result;
      if (existing) {
        // A lost-response retry gets the original back; the same identifier
        // with different words is a conflict, never a silent second message.
        if (existing.text !== text) throw new Refusal(409, 'This send was already used for a different message.');
        result = { message: shape(existing), created: false };
      } else {
        const createdAt = new Date().toISOString();
        const inserted = db.prepare('INSERT INTO messages (low_id,high_id,sender_id,text,created_at,client_id) VALUES (?,?,?,?,?,?)')
          .run(...ids, userId, text, createdAt, clientId);
        const messageId = Number(inserted.lastInsertRowid);
        db.prepare(`INSERT INTO threads (low_id,high_id,last_id) VALUES (?,?,?)
          ON CONFLICT(low_id,high_id) DO UPDATE SET last_id=excluded.last_id`).run(...ids, messageId);
        result = { message: { id: messageId, senderId: userId, text, createdAt, clientId }, created: true };
      }
      db.exec('COMMIT');
      // The recipient's new total rides back so the backend can keep the Home
      // badge as a bare number and never wake this machine to ask for it.
      return { ...result, peerUnread: unreadFor(peerId) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },

  read(body) {
    const userId = id(body.userId, 'userId'), peerId = id(body.peerId, 'peerId');
    const messageId = position(body.messageId);
    if (!messageId) throw new Refusal(400, 'messageId is required');
    const ids = pair(userId, peerId);
    // A receipt acknowledges only an actual message from THIS conversation.
    // Neither a future cursor nor a message from another pair can clear arrivals.
    if (db.prepare('SELECT 1 FROM messages WHERE low_id=? AND high_id=? AND id=?').get(...ids, messageId)) {
      const column = ids[0] === userId ? 'low_read' : 'high_read';
      db.prepare(`UPDATE threads SET ${column}=MAX(${column},?) WHERE low_id=? AND high_id=?`).run(messageId, ...ids);
    }
    return { unread: unreadFor(userId) };
  },

  unread(body) {
    return { unread: unreadFor(id(body.userId, 'userId')) };
  },

  count() {
    return { count: Number(db.prepare('SELECT COUNT(*) AS n FROM threads').get().n) };
  },
};

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-msg-host-secret'] ?? ''));
  const expected = Buffer.from(SECRET);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let lastRequestAt = Date.now();
let inFlight = 0;

const server = createServer((req, res) => {
  const answer = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return answer(200, { ok: true });
  if (!authorized(req)) return answer(401, { error: 'unauthorized' });
  lastRequestAt = Date.now();
  // A secret that leaked across workplaces must still not open this one.
  if (ORG && req.headers['x-msg-host-org'] !== ORG) return answer(403, { error: 'wrong workplace' });
  const name = req.method === 'POST' && req.url?.startsWith('/v1/') ? req.url.slice(4) : '';
  if (!Object.hasOwn(operations, name)) return answer(404, { error: 'not found' });
  inFlight += 1;
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('close', () => { inFlight -= 1; });
  req.on('end', () => {
    try {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(400, 'body must be an object');
      answer(200, operations[name](body));
    } catch (error) {
      if (error instanceof Refusal) return answer(error.status, { error: error.message });
      if (error instanceof SyntaxError) return answer(400, { error: 'body is not JSON' });
      // Never log the body or an error that might carry private text.
      console.error(`[msg-host] ${name} failed`);
      answer(500, { error: 'failed' });
    }
  });
});

server.listen(PORT, HOST, () => console.log(`[msg-host] listening on [${HOST}]:${PORT}`));

function shutdown(reason) {
  console.log(`[msg-host] stopping: ${reason}`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5_000).unref();
}
if (IDLE_MS > 0) {
  setInterval(() => {
    if (!inFlight && Date.now() - lastRequestAt >= IDLE_MS) shutdown('idle');
  }, Math.min(30_000, IDLE_MS)).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
