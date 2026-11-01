#!/usr/bin/env node
/**
 * Put org #0's attachments back in one place.
 *
 * What went wrong (byo-media-design, shipped 2026-08-25): the design says org
 * #0 rides the env-configured MinIO store, but nothing in the code said so.
 * Org #0 points at our OWN Fly org, so it resolved `source: 'org'` exactly
 * like a client, and its first upload after the deploy minted it a Tigris
 * bucket and wrote the pointer. From that instant every read for org #0 went
 * to the new, empty bucket: a fortnight of note, proposal and knowledge
 * attachments answered 404 while sitting untouched in MinIO.
 *
 * The code fix (org-media.ts) stops it happening again — an org running in
 * our own Fly org is us, and is never given a bucket. This script repairs the
 * split it already made:
 *
 *   1. copy every object from the Tigris bucket into the platform store,
 *   2. clear org #0's media pointer, so reads and writes go to MinIO again,
 *   3. sweep once more, catching anything uploaded during step 1.
 *
 * Copy, never move. MinIO holds the ONLY copy of the older bytes and is not
 * backed up (docs/byo-git.md), so nothing here deletes anything — the Tigris
 * bucket is left standing as a safety net and can be removed by hand later.
 *
 * Run it on the backend host from /opt/infinite-agents/current with
 * backend.env loaded:
 *
 *   node scripts/repair-org0-media.mjs --env-file /etc/infinite-agents/backend.env
 *   …the same with --apply     # executes it; without it, prints the plan
 *   …the same with --org <id>  # if org discovery needs help
 *
 * `--env-file` is how the deployed backend.env is read WITHOUT sourcing it
 * into a shell, which would execute its unquoted values.
 *
 * Idempotent: an object already present in the platform store with the same
 * size is skipped, so a second --apply run copies nothing and simply
 * re-verifies. Safe to re-run after the pointer is already cleared.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(backendRoot, '..');

// `--env-file` reads the deployed backend.env as DATA. Sourcing it into a
// shell first is the obvious alternative and the wrong one: an unquoted
// value in an env file is executed, and these values are secrets.
const envFileIndex = process.argv.indexOf('--env-file');
for (const envPath of [
  ...(envFileIndex >= 0 ? [process.argv[envFileIndex + 1]] : []),
  path.join(backendRoot, '.env.local'),
  path.join(backendRoot, '.env'),
  path.join(repoRoot, '.env.local'),
  path.join(repoRoot, '.env'),
]) {
  dotenv.config({ path: envPath, override: false, quiet: true });
}

const dist = (rel) => new URL(path.join('..', 'dist', rel), import.meta.url);
const { openSqliteDb, deserializeDoc } = await import(dist('services/sqlite/sqlite-db.js'));
const { SqliteOrgStorage } = await import(dist('services/sqlite/sqlite-org-storage.js'));
const { SqliteSecretStorage } = await import(dist('services/sqlite/sqlite-secret-storage.js'));
const { EncryptedSecretStorage } = await import(dist('services/encrypted-secret-storage.js'));
const { secretCipherFromEnv } = await import(dist('services/secret-cipher.js'));
const { OrgSecretsService } = await import(dist('services/org-secrets.js'));
const { ORG_MEDIA_CREDS_SECRET } = await import(dist('services/org-media.js'));
// A plain S3 client for both stores rather than S3MediaStorage: this script
// needs to LIST, which the MediaStorage interface deliberately does not
// expose, and reaching into the class's private client to get it would be
// worse than owning one here.
const {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
} = await import('@aws-sdk/client-s3');

const apply = process.argv.includes('--apply');
const orgFlagIndex = process.argv.indexOf('--org');
const orgFlag = orgFlagIndex >= 0 ? process.argv[orgFlagIndex + 1] : undefined;

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
const flyOrgSlug = (process.env.FLY_ORG || process.env.FLY_ORG_SLUG || '').trim();
if (!sqlitePath || !flyOrgSlug) {
  console.error('Need SQLITE_DB_PATH and FLY_ORG (run with backend.env loaded).');
  process.exit(1);
}
const cipher = secretCipherFromEnv();
if (!cipher) {
  console.error('SECRETS_MASTER_KEY is not set — cannot read the org bucket credentials.');
  process.exit(1);
}
const platformCfg = {
  endpoint: process.env.MEDIA_S3_ENDPOINT?.trim(),
  bucket: process.env.MEDIA_S3_BUCKET?.trim(),
  accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID?.trim(),
  secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY?.trim(),
  region: process.env.MEDIA_S3_REGION?.trim() || 'us-east-1',
};
if (!platformCfg.endpoint || !platformCfg.bucket || !platformCfg.accessKeyId || !platformCfg.secretAccessKey) {
  console.error('MEDIA_S3_* is not fully configured — there is no platform store to repair into.');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);
const orgs = db.prepare('SELECT org_id, doc FROM orgs').all().map((row) => deserializeDoc(row.doc));
// Org #0 is the one running in OUR OWN Fly org — the same test the code now
// makes, rather than a hardcoded id.
const candidates = orgs.filter((o) => o.fly?.orgSlug === flyOrgSlug);
const org = orgFlag ? orgs.find((o) => o.orgId === orgFlag) : (candidates.length === 1 ? candidates[0] : undefined);
if (!org) {
  console.error(orgFlag
    ? `No org with id ${orgFlag}. Existing: ${orgs.map((o) => o.orgId).join(', ') || '(none)'}`
    : `Expected exactly one org in Fly org "${flyOrgSlug}", found ${candidates.length} — name one with --org <id>.`);
  process.exit(1);
}

console.log(`org:        ${org.name} (${org.orgId})`);
console.log(`fly org:    ${org.fly?.orgSlug ?? '(none)'} — the platform's own`);
if (!org.media) {
  console.log('\nNo media pointer on this org: it already rides the platform store. Nothing to repair.');
  process.exit(0);
}
console.log(`pointer:    ${org.media.bucket} @ ${org.media.endpoint}`);

const orgStorage = new SqliteOrgStorage(db);
const orgSecrets = new OrgSecretsService(new EncryptedSecretStorage(new SqliteSecretStorage(db), cipher));
const raw = await orgSecrets.getOrgSecret(org.orgId, org.media.credsSecretName ?? ORG_MEDIA_CREDS_SECRET);
if (!raw) {
  console.error(`Credentials secret for ${org.media.bucket} is missing — cannot read the bucket to copy out of it.`);
  process.exit(1);
}
const creds = JSON.parse(raw);
const orgS3 = new S3Client({
  endpoint: org.media.endpoint,
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
});
const platformS3 = new S3Client({
  endpoint: platformCfg.endpoint,
  region: platformCfg.region,
  forcePathStyle: true,
  credentials: { accessKeyId: platformCfg.accessKeyId, secretAccessKey: platformCfg.secretAccessKey },
});

/** Every key in a bucket, paged to the end — not just the first 1000. */
async function listAll(client, bucket) {
  const out = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket, ContinuationToken: token, MaxKeys: 1000,
    }));
    for (const o of page.Contents ?? []) out.push({ key: o.Key, size: o.Size });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * Copy anything the platform store does not already hold at the same size.
 * Content type is carried across from the source object: it is what the
 * signed read hands the browser, and a note's photo served as
 * application/octet-stream downloads instead of displaying.
 */
async function sweep(label) {
  const inOrg = await listAll(orgS3, org.media.bucket);
  const inPlatform = new Map((await listAll(platformS3, platformCfg.bucket)).map((o) => [o.key, o.size]));
  const missing = inOrg.filter((o) => inPlatform.get(o.key) !== o.size);
  console.log(`${label}: ${inOrg.length} object(s) in ${org.media.bucket}, ${missing.length} not yet in the platform store`);
  if (!apply) {
    for (const object of missing.slice(0, 10)) console.log(`  would copy ${object.key} (${object.size} bytes)`);
    if (missing.length > 10) console.log(`  …and ${missing.length - 10} more`);
    return missing.length;
  }
  let copied = 0;
  for (const object of missing) {
    const head = await orgS3.send(new HeadObjectCommand({ Bucket: org.media.bucket, Key: object.key }));
    const got = await orgS3.send(new GetObjectCommand({ Bucket: org.media.bucket, Key: object.key }));
    const body = Buffer.from(await got.Body.transformToByteArray());
    if (body.length !== object.size) {
      console.error(`ABORT: ${object.key} read back ${body.length} bytes, listing said ${object.size}`);
      process.exit(1);
    }
    await platformS3.send(new PutObjectCommand({
      Bucket: platformCfg.bucket,
      Key: object.key,
      Body: body,
      ...(head.ContentType ? { ContentType: head.ContentType } : {}),
      ...(head.Metadata ? { Metadata: head.Metadata } : {}),
    }));
    copied += 1;
    if (copied % 25 === 0) console.log(`  …${copied}/${missing.length}`);
  }
  console.log(`${label}: copied ${copied} object(s)`);
  return missing.length;
}

await sweep('pass 1');

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to copy, clear the pointer, and sweep again.');
  process.exit(0);
}

// Pointer down only AFTER the bytes are in the platform store, so there is
// never a moment when a live read has nowhere to find them.
await orgStorage.updateOrg(org.orgId, { media: undefined });
const after = await orgStorage.getOrg(org.orgId);
if (after?.media) {
  console.error('VERIFY FAILED: the media pointer is still on the org document.');
  process.exit(1);
}
console.log('pointer:    cleared — org #0 reads and writes the platform store again');

// Anything uploaded while pass 1 was running went to the bucket; the pointer
// is down now, so this catches it and nothing new can land there.
await sweep('pass 2');

console.log(`\nDone. ${org.media.bucket} is left standing as a safety net — delete it by hand once you are satisfied.`);
console.log('Nothing was removed from either store.');
