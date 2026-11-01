#!/usr/bin/env node
/**
 * One-shot migration: encrypt (or, for rollback, decrypt) every secret VALUE
 * in the secrets table, in place. See docs/user-secrets.md § Storage.
 *
 * The backend reads legacy plaintext rows fine after SECRETS_MASTER_KEY is
 * set, so the safe order is: deploy the build → add the key to backend.env and
 * restart → run this. Idempotent — already-converted rows are skipped.
 *
 * Run on the backend host from a release dir with backend.env loaded (needs
 * `dist/` built, SQLITE_DB_PATH and SECRETS_MASTER_KEY set):
 *
 *   node backend/scripts/encrypt-secrets.mjs             # dry run: counts only
 *   node backend/scripts/encrypt-secrets.mjs --apply     # encrypt plaintext rows
 *   node backend/scripts/encrypt-secrets.mjs --decrypt --apply   # rollback to plaintext
 *
 * --decrypt exists so rolling back to a pre-encryption build stays possible:
 * that build would return ciphertext as values, so decrypt BEFORE rolling back.
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
  console.error('SECRETS_MASTER_KEY is not set — generate one with `openssl rand -base64 32` and add it to backend.env first.');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);
const rows = db.prepare('SELECT user_id, secret_id, doc FROM secrets').all();
const update = db.prepare('UPDATE secrets SET doc = ? WHERE user_id = ? AND secret_id = ?');

let converted = 0;
let alreadyDone = 0;
let skipped = 0;

const run = db.transaction(() => {
  for (const row of rows) {
    // Raw JSON on purpose: deserializeDoc/serializeDoc would round-trip the
    // whole doc; only `value` should change, byte-for-byte, in this script.
    const doc = JSON.parse(row.doc);
    if (typeof doc.value !== 'string') {
      console.warn(`  skipping ${row.user_id}/${row.secret_id} (${doc.key ?? '?'}): value is not a string`);
      skipped += 1;
      continue;
    }
    const isEncrypted = isEncryptedSecretValue(doc.value);
    if (isEncrypted === !toPlaintext) {
      alreadyDone += 1;
      continue;
    }
    doc.value = toPlaintext ? cipher.decrypt(doc.value) : cipher.encrypt(doc.value);
    converted += 1;
    if (apply) update.run(JSON.stringify(doc), row.user_id, row.secret_id);
  }
});
run();
db.close();

const mode = toPlaintext ? 'decrypted' : 'encrypted';
console.log(`${rows.length} secret rows in ${sqlitePath}:`);
console.log(apply
  ? `  ${converted} ${mode}`
  : `  ${converted} would be ${mode} (dry run — re-run with --apply)`);
console.log(`  ${alreadyDone} already ${toPlaintext ? 'plaintext' : 'encrypted'}`);
if (skipped > 0) console.log(`  ${skipped} skipped (see warnings above)`);
