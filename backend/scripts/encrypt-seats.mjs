#!/usr/bin/env node
/**
 * One-shot migration: encrypt (or, for rollback, decrypt) the AI sign-in
 * material in `org_seats` (`token`, `oauth.refreshToken`) and `seat_signins`
 * (`device.deviceAuthId`), in place. The seat-table sibling of
 * encrypt-secrets.mjs; what is sealed and why is in
 * src/services/seat-credential-cipher.ts.
 *
 * The backend reads legacy plaintext rows fine, so the safe order is: deploy
 * the build (the key is already in backend.env) → run this. Idempotent —
 * already-converted fields are skipped.
 *
 * Encrypting the rows is not enough on its own: SQLite leaves a rewritten
 * row's old bytes in free space, and the nightly `.backup` (infra/db-backup)
 * copies free pages too. So --apply also VACUUMs — which rebuilds the file
 * from live rows only, dropping the plaintext every earlier token refresh
 * left behind as well — and then truncates the WAL, whose old frames hold
 * page images from before. VACUUM holds the write lock for as long as it
 * takes to copy the database; the backend waits on it (busy_timeout).
 *
 * Run on the backend host from a release dir with backend.env loaded (needs
 * `dist/` built, SQLITE_DB_PATH and SECRETS_MASTER_KEY set):
 *
 *   node backend/scripts/encrypt-seats.mjs             # dry run: counts only
 *   node backend/scripts/encrypt-seats.mjs --apply     # encrypt plaintext fields
 *   node backend/scripts/encrypt-seats.mjs --decrypt --apply   # rollback to plaintext
 *
 * --decrypt exists so rolling back to a build without seat encryption stays
 * possible: that build would hand ciphertext to the provider as the token,
 * so decrypt BEFORE rolling back.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(backendRoot, '..');

for (const envPath of [
  path.join(backendRoot, '.env.local'),
  path.join(backendRoot, '.env'),
  path.join(repoRoot, '.env.local'),
  path.join(repoRoot, '.env'),
]) {
  dotenv.config({ path: envPath, override: false, quiet: true });
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const toPlaintext = args.includes('--decrypt');

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
if (!sqlitePath) {
  console.error('SQLITE_DB_PATH is not set. Run on the backend host with backend.env loaded.');
  process.exit(1);
}

const { openSqliteDb } = await import(path.join(backendRoot, 'dist', 'services', 'sqlite', 'sqlite-db.js'));
const { secretCipherFromEnv, isEncryptedSecretValue } = await import(
  path.join(backendRoot, 'dist', 'services', 'secret-cipher.js')
);

const cipher = secretCipherFromEnv();
if (!cipher) {
  console.error('SECRETS_MASTER_KEY is not set — it lives in backend.env; load it first.');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);

/**
 * Convert one field on a parsed doc. Raw JSON on purpose (as in
 * encrypt-secrets.mjs): only the named fields change, the rest of the doc
 * byte-for-byte.
 */
function convert(holder, field) {
  const value = holder?.[field];
  if (typeof value !== 'string') return 'absent';
  if (isEncryptedSecretValue(value) === !toPlaintext) return 'done';
  holder[field] = toPlaintext ? cipher.decrypt(value) : cipher.encrypt(value);
  return 'converted';
}

const tables = [
  {
    table: 'seat_signins',
    key: 'user_id',
    fields: (doc) => [[doc.device, 'deviceAuthId']],
  },
  {
    table: 'org_seats',
    key: 'seat_id',
    fields: (doc) => [[doc, 'token'], [doc.oauth, 'refreshToken']],
  },
];

const counts = [];
// Zero the bytes each rewritten row leaves behind, as it is rewritten.
if (apply) db.pragma('secure_delete = ON');
const run = db.transaction(() => {
  for (const { table, key, fields } of tables) {
    const rows = db.prepare(`SELECT ${key} AS id, doc FROM ${table}`).all();
    const update = db.prepare(`UPDATE ${table} SET doc = ? WHERE ${key} = ?`);
    const tally = { table, rows: rows.length, converted: 0, done: 0 };
    for (const row of rows) {
      const doc = JSON.parse(row.doc);
      const results = fields(doc).map(([holder, field]) => convert(holder, field));
      tally.converted += results.filter((r) => r === 'converted').length;
      tally.done += results.filter((r) => r === 'done').length;
      if (apply && results.includes('converted')) update.run(JSON.stringify(doc), row.id);
    }
    counts.push(tally);
  }
});
run();

let compacted = '';
if (apply) {
  const pageCount = () => db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  const before = pageCount();
  db.exec('VACUUM');
  const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)');
  compacted = `VACUUM: ${before} → ${pageCount()} bytes; WAL truncate ${
    checkpoint.busy ? 'BUSY — another connection was mid-read; re-run to truncate it' : 'done'}`;
}
db.close();

const mode = toPlaintext ? 'decrypted' : 'encrypted';
for (const { table, rows, converted, done } of counts) {
  console.log(`${table}: ${rows} rows in ${sqlitePath}`);
  console.log(apply
    ? `  ${converted} fields ${mode}`
    : `  ${converted} fields would be ${mode} (dry run — re-run with --apply)`);
  console.log(`  ${done} fields already ${toPlaintext ? 'plaintext' : 'encrypted'}`);
}
if (compacted) console.log(compacted);
