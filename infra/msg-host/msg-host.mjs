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
// Files (note #1125): a message may carry files. Their bytes live on this
// same volume, beside the database (files/<id>, and files/<id>.thumb for a
// picture's small copy the sender's browser made), and nowhere else. A file
// is uploaded first — PENDING, visible to its uploader alone — and belongs
// to the conversation once a send names it. A pending file nobody sends is
// deleted after PENDING_TTL_MS (longer than a Chief of Staff draft waits).
// The backend sniffs what a file is and decides how it is served; this
// process only keeps bytes and says who may have them.
//
// Zero dependencies on purpose: node:sqlite ships with Node 22.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SECRET = process.env.MSG_HOST_SECRET || '';
const ORG = process.env.MSG_HOST_ORG || '';
const DB_PATH = process.env.MSG_HOST_DB || '/data/messages/messages.db';
const HOST = process.env.HOST || '::';
const PORT = Number(process.env.PORT || 8080);
const IDLE_MS = Number(process.env.MSG_HOST_IDLE_MS ?? 10 * 60_000);
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 8000;
/** One file's ceiling, a picture's small copy's, and how many ride one message (note #1125). */
const MAX_FILE = Number(process.env.MSG_HOST_MAX_FILE_BYTES || 25 * 1024 * 1024);
const MAX_THUMB = 512 * 1024;
const MAX_FILES = 10;
/** Kept free on the volume whatever is uploaded, so the database can always write. */
const RESERVE = Number(process.env.MSG_HOST_RESERVE_BYTES || 64 * 1024 * 1024);
/** An upload nobody sent: 26 hours, past the Chief of Staff draft's 24. */
const PENDING_TTL_MS = 26 * 60 * 60_000;

if (!SECRET) {
  // Fail closed: a host with no secret would answer anyone on the network.
  console.error('[msg-host] MSG_HOST_SECRET is not set — refusing to start');
  process.exit(1);
}

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });
const FILES = process.env.MSG_HOST_FILES
  || (DB_PATH === ':memory:' ? join(tmpdir(), `msg-host-files-${process.pid}`) : join(dirname(DB_PATH), 'files'));
mkdirSync(FILES, { recursive: true, mode: 0o700 });
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
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  low_id TEXT NOT NULL,
  high_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  message_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  thumb_size INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_by_message ON files (message_id, position);
CREATE INDEX IF NOT EXISTS files_pending ON files (created_at) WHERE message_id IS NULL;
`);

const pair = (a, b) => (a < b ? [a, b] : [b, a]);
const fileShape = (f) => ({
  id: f.id, name: f.name, type: f.type, size: Number(f.size),
  ...(f.width ? { width: Number(f.width), height: Number(f.height) } : {}),
  ...(f.thumb_size ? { thumb: true } : {}),
});
const shape = (r, files) => ({
  id: Number(r.id), senderId: r.sender_id, text: r.text, createdAt: r.created_at, clientId: r.client_id,
  ...(files?.length ? { files } : {}),
});
/** Messages with their files, in one query for the lot. */
function shapeAll(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const byMessage = new Map();
  for (const f of db.prepare(`SELECT * FROM files WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY message_id, position`).all(...ids)) {
    const list = byMessage.get(Number(f.message_id)) ?? [];
    list.push(fileShape(f));
    byMessage.set(Number(f.message_id), list);
  }
  return rows.map((r) => shape(r, byMessage.get(Number(r.id))));
}
const fileIdPattern = /^f[0-9a-f]{24}$/;
const bytesPath = (fileId, thumb) => join(FILES, thumb ? `${fileId}.thumb` : fileId);
const removeBytes = (fileId) => {
  for (const thumb of [false, true]) { try { unlinkSync(bytesPath(fileId, thumb)); } catch { /* already gone */ } }
};
function freeBytes() {
  const s = statfsSync(FILES);
  return Number(s.bavail) * Number(s.bsize);
}

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
    const shaped = shapeAll(rows);
    return { threads: rows.map((r, i) => ({ peerId: r.peer_id, lastMessage: shaped[i], unread: Number(r.unread) })) };
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
    return { messages: shapeAll(after ? selected : selected.reverse()), hasMore: rows.length > limit };
  },

  send(body) {
    const userId = id(body.userId, 'userId'), peerId = id(body.peerId, 'peerId');
    if (userId === peerId) throw new Refusal(400, 'a conversation needs two people');
    const text = typeof body.text === 'string' ? body.text : '';
    const fileIds = body.files === undefined ? [] : body.files;
    if (!Array.isArray(fileIds) || fileIds.length > MAX_FILES || fileIds.some((f) => typeof f !== 'string' || !fileIdPattern.test(f))
      || new Set(fileIds).size !== fileIds.length) throw new Refusal(400, `a message carries up to ${MAX_FILES} files`);
    // Words, files, or both (note #1125): a picture may go on its own.
    if ((!text && !fileIds.length) || text.length > MAX_TEXT) throw new Refusal(400, 'text is empty or too long');
    const clientId = body.clientId;
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(clientId)) throw new Refusal(400, 'clientId is not valid');
    const ids = pair(userId, peerId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM messages WHERE low_id=? AND high_id=? AND sender_id=? AND client_id=?').get(...ids, userId, clientId);
      let result;
      if (existing) {
        // A lost-response retry gets the original back; the same identifier
        // with different words or files is a conflict, never a silent second message.
        const [message] = shapeAll([existing]);
        const kept = (message.files ?? []).map((f) => f.id);
        if (existing.text !== text || kept.join() !== fileIds.join()) throw new Refusal(409, 'This send was already used for a different message.');
        result = { message, created: false };
      } else {
        // Every file named must be this sender's own, uploaded for THIS
        // conversation, and not yet sent: nothing else can be attached.
        const files = fileIds.map((fileId) => db.prepare(
          'SELECT * FROM files WHERE id=? AND low_id=? AND high_id=? AND uploader_id=? AND message_id IS NULL').get(fileId, ...ids, userId));
        if (files.some((f) => !f)) throw new Refusal(400, 'a file was not found; upload it again');
        const createdAt = new Date().toISOString();
        const inserted = db.prepare('INSERT INTO messages (low_id,high_id,sender_id,text,created_at,client_id) VALUES (?,?,?,?,?,?)')
          .run(...ids, userId, text, createdAt, clientId);
        const messageId = Number(inserted.lastInsertRowid);
        fileIds.forEach((fileId, position) => db.prepare('UPDATE files SET message_id=?, position=? WHERE id=?').run(messageId, position, fileId));
        db.prepare(`INSERT INTO threads (low_id,high_id,last_id) VALUES (?,?,?)
          ON CONFLICT(low_id,high_id) DO UPDATE SET last_id=excluded.last_id`).run(...ids, messageId);
        result = { message: shape({ id: messageId, sender_id: userId, text, created_at: createdAt, client_id: clientId },
          files.map((f) => fileShape(f))), created: true };
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

  /** The uploader's own unsent files of this conversation, by id (a Chief of Staff draft's check). */
  pending(body) {
    const userId = id(body.userId, 'userId'), ids = pair(userId, id(body.peerId, 'peerId'));
    const wanted = Array.isArray(body.files) ? body.files.filter((f) => typeof f === 'string' && fileIdPattern.test(f)).slice(0, MAX_FILES) : [];
    const files = wanted.map((fileId) => db.prepare(
      'SELECT * FROM files WHERE id=? AND low_id=? AND high_id=? AND uploader_id=? AND message_id IS NULL').get(fileId, ...ids, userId)).filter(Boolean);
    return { files: files.map(fileShape) };
  },

  /** Unsent files their uploader let go of (a draft declined or expired). Sent ones stay. */
  discard(body) {
    const userId = id(body.userId, 'userId'), ids = pair(userId, id(body.peerId, 'peerId'));
    const wanted = Array.isArray(body.files) ? body.files.filter((f) => typeof f === 'string' && fileIdPattern.test(f)).slice(0, MAX_FILES) : [];
    let removed = 0;
    for (const fileId of wanted) {
      const gone = db.prepare('DELETE FROM files WHERE id=? AND low_id=? AND high_id=? AND uploader_id=? AND message_id IS NULL').run(fileId, ...ids, userId);
      if (gone.changes) { removeBytes(fileId); removed += 1; }
    }
    return { removed };
  },

  /** How full the volume is — numbers only, for the platform's own checks. */
  storage() {
    const s = statfsSync(FILES);
    const files = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size + COALESCE(thumb_size, 0)), 0) AS bytes FROM files').get();
    return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: freeBytes(), files: Number(files.n), fileBytes: Number(files.bytes), maxFileBytes: MAX_FILE };
  },
};

/** Who may have a file's bytes: either of its pair once sent; its uploader alone before. */
function fileFor(body) {
  const userId = id(body.userId, 'userId'), ids = pair(userId, id(body.peerId, 'peerId'));
  const fileId = typeof body.fileId === 'string' && fileIdPattern.test(body.fileId) ? body.fileId : '';
  const f = fileId && db.prepare('SELECT * FROM files WHERE id=? AND low_id=? AND high_id=?').get(fileId, ...ids);
  if (!f || (f.message_id === null && f.uploader_id !== userId)) throw new Refusal(404, 'no such file');
  if (body.thumb && !f.thumb_size) throw new Refusal(404, 'no small copy');
  return f;
}

/**
 * One upload: the bytes are the request body, the metadata a header
 * (x-msg-file, URI-encoded JSON: userId, peerId, name, type, width, height,
 * or thumbOf for a picture's small copy). Streamed to disk, never held.
 */
function upload(req, res, answer) {
  let meta;
  try { meta = JSON.parse(decodeURIComponent(String(req.headers['x-msg-file'] ?? ''))); } catch { meta = null; }
  try {
    if (!meta || typeof meta !== 'object') throw new Refusal(400, 'x-msg-file is required');
    const userId = id(meta.userId, 'userId'), peerId = id(meta.peerId, 'peerId');
    if (userId === peerId) throw new Refusal(400, 'a conversation needs two people');
    const ids = pair(userId, peerId);
    const thumbOf = meta.thumbOf === undefined ? null : meta.thumbOf;
    const declared = Number(req.headers['content-length']);
    const limit = thumbOf ? MAX_THUMB : MAX_FILE;
    if (!Number.isSafeInteger(declared) || declared < 1) throw new Refusal(411, 'send the length of the file');
    if (declared > limit) throw new Refusal(413, `a file can be up to ${limit} bytes`);
    if (declared > freeBytes() - RESERVE) throw new Refusal(507, 'storage is full');
    let target, row;
    if (thumbOf) {
      const owner = typeof thumbOf === 'string' && fileIdPattern.test(thumbOf)
        && db.prepare('SELECT * FROM files WHERE id=? AND low_id=? AND high_id=? AND uploader_id=? AND message_id IS NULL').get(thumbOf, ...ids, userId);
      if (!owner) throw new Refusal(404, 'no such unsent file');
      target = thumbOf;
    } else {
      const name = typeof meta.name === 'string' ? meta.name.replace(/[\x00-\x1f\x7f/\\]/g, '').trim().slice(0, 255) : '';
      const type = typeof meta.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(meta.type) && meta.type.length <= 100 ? meta.type : 'application/octet-stream';
      const dim = (v) => (Number.isSafeInteger(v) && v > 0 && v <= 100_000 ? v : null);
      const width = dim(meta.width), height = dim(meta.height);
      target = `f${randomBytes(12).toString('hex')}`;
      row = { name: name || 'file', type, width: width && height ? width : null, height: width && height ? height : null };
    }
    const temp = join(FILES, `tmp-${randomBytes(8).toString('hex')}`);
    const out = createWriteStream(temp, { flags: 'wx', mode: 0o600 });
    let size = 0, failed = false;
    const fail = (status, message) => {
      if (failed || res.headersSent) return; failed = true;
      out.destroy(); try { unlinkSync(temp); } catch { /* never written */ }
      req.resume();
      answer(status, { error: message });
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > declared) fail(400, 'the file is longer than it said');
    });
    req.on('aborted', () => fail(400, 'the upload was cut off'));
    out.on('error', () => fail(500, 'failed'));
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (size !== declared) return fail(400, 'the upload was cut off');
      try {
        renameSync(temp, bytesPath(target, Boolean(thumbOf)));
        if (thumbOf) {
          // The small copy stands the way the picture is meant to (its EXIF
          // turn applied), so its shape is the one the bubble frames.
          const dim = (v) => (Number.isSafeInteger(v) && v > 0 && v <= 100_000 ? v : null);
          const width = dim(meta.width), height = dim(meta.height);
          if (width && height) db.prepare('UPDATE files SET thumb_size=?, width=?, height=? WHERE id=?').run(size, width, height, target);
          else db.prepare('UPDATE files SET thumb_size=? WHERE id=?').run(size, target);
          return answer(200, { file: fileShape(db.prepare('SELECT * FROM files WHERE id=?').get(target)) });
        }
        db.prepare(`INSERT INTO files (id,low_id,high_id,uploader_id,name,type,size,width,height,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(target, ...ids, userId, row.name, row.type, size, row.width, row.height, new Date().toISOString());
        return answer(200, { file: fileShape(db.prepare('SELECT * FROM files WHERE id=?').get(target)) });
      } catch {
        removeBytes(target);
        console.error('[msg-host] upload failed');
        return answer(500, { error: 'failed' });
      }
    });
  } catch (error) {
    req.resume();
    if (error instanceof Refusal) return answer(error.status, { error: error.message });
    console.error('[msg-host] upload failed');
    return answer(500, { error: 'failed' });
  }
}

/** A file's bytes (or its small copy's), streamed; its metadata rides x-msg-file. */
function download(body, res, answer) {
  const f = fileFor(body);
  const path = bytesPath(f.id, Boolean(body.thumb));
  let size;
  try { size = statSync(path).size; } catch { throw new Refusal(404, 'no such file'); }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(size),
    'cache-control': 'no-store',
    'x-msg-file': encodeURIComponent(JSON.stringify(fileShape(f))),
  });
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
}

/** Unsent uploads past their time, and bytes no row owns (a crash mid-upload). */
function sweep() {
  try {
    const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
    for (const f of db.prepare('SELECT id FROM files WHERE message_id IS NULL AND created_at < ?').all(cutoff)) {
      db.prepare('DELETE FROM files WHERE id=?').run(f.id);
      removeBytes(f.id);
    }
    const hourAgo = Date.now() - 60 * 60_000;
    for (const entry of readdirSync(FILES)) {
      const fileId = entry.replace(/\.thumb$/, '');
      const known = fileIdPattern.test(fileId) && db.prepare('SELECT 1 FROM files WHERE id=?').get(fileId);
      if (known) continue;
      try { if (statSync(join(FILES, entry)).mtimeMs < hourAgo) unlinkSync(join(FILES, entry)); } catch { /* gone */ }
    }
  } catch {
    console.error('[msg-host] sweep failed');
  }
}
sweep();
setInterval(sweep, 10 * 60_000).unref();

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
  if (name === 'upload') {
    inFlight += 1;
    res.on('close', () => { inFlight -= 1; });
    return upload(req, res, answer);
  }
  if (name !== 'file' && !Object.hasOwn(operations, name)) return answer(404, { error: 'not found' });
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
      if (name === 'file') return download(body, res, answer);
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
