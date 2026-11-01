#!/usr/bin/env node
/**
 * Set the public CORS rule on an existing public bucket (note #770) — for a
 * bucket made before `storage create --public` set one at creation. Reads
 * the bucket's keys from the room's secret store exactly as the backend
 * does, so nothing is typed or printed.
 *
 * Run ON the backend host from /opt/infinite-agents/current:
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/apply-bucket-cors.mjs <bucket-name>
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
for (const envPath of [path.join(scriptDir, '..', '.env'), path.join(scriptDir, '..', '..', '.env')]) {
  dotenv.config({ path: envPath, override: false, quiet: true });
}
const dist = (rel) => new URL(path.join('..', 'dist', rel), import.meta.url);
const { openSqliteDb } = await import(dist('services/sqlite/sqlite-db.js'));
const { SqliteSecretStorage } = await import(dist('services/sqlite/sqlite-secret-storage.js'));
const { EncryptedSecretStorage } = await import(dist('services/encrypted-secret-storage.js'));
const { secretCipherFromEnv } = await import(dist('services/secret-cipher.js'));
const { UserSecretsService, SHARED_USER_SECRET_SCOPE } = await import(dist('services/user-secrets.js'));
const { SqliteStorageBucketStorage } = await import(dist('services/sqlite/sqlite-storage-bucket-storage.js'));
const { ObjectStorageService } = await import(dist('services/object-storage.js'));

const name = process.argv[2];
const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
if (!name || !sqlitePath) {
  console.error('usage: node scripts/apply-bucket-cors.mjs <bucket-name>  (with backend.env loaded)');
  process.exit(1);
}
const db = openSqliteDb(sqlitePath);
const cipher = secretCipherFromEnv();
const secretStorage = cipher ? new EncryptedSecretStorage(new SqliteSecretStorage(db), cipher) : new SqliteSecretStorage(db);
const secrets = new UserSecretsService(secretStorage);
const buckets = new SqliteStorageBucketStorage(db);
const doc = (await buckets.listAll()).find((b) => b.name === name && b.status === 'live');
if (!doc) { console.error(`no live bucket named ${name}`); process.exit(1); }
const service = new ObjectStorageService({
  storage: buckets,
  resolveHostingContext: async () => { throw new Error('not needed here'); },
  secrets: {
    save: async () => { throw new Error('not needed here'); },
    remove: async () => { throw new Error('not needed here'); },
    read: (ns, n) => secrets.getSecretValue(ns, n, SHARED_USER_SECRET_SCOPE),
  },
  caps: { hostedBucketLimit: 0, hostedBucketGb: 0 },
  log: (m) => console.log(m),
});
await service.ensurePublicCors(doc);
console.log(`done: ${doc.name} (${doc.bucket}, ${doc.public ? 'public' : 'private'})`);
