#!/usr/bin/env node
/**
 * Point org #0 at the platform's own Fly org (byo-fly-design: "org #0
 * dogfoods the same path"). Writes the env-configured FLY_ORG + FLY_API_TOKEN
 * into the org's own connection — token as an encrypted org secret, slug on
 * the org document — so our account resolves exactly the way a client's will,
 * and the env globals become nothing more than the seed this script read.
 *
 * Reads and writes the backend's SQLite file, so run it on the backend host
 * from /opt/infinite-agents/current with backend.env loaded:
 *
 *   node backend/scripts/connect-org0-fly.mjs            # dry run — prints the plan
 *   node backend/scripts/connect-org0-fly.mjs --apply    # executes it
 *   node backend/scripts/connect-org0-fly.mjs --org <id> # if org discovery needs help
 *
 * The token is validated against Fly (a read-only app listing) in BOTH modes,
 * so even the dry run proves the pair works. Re-running with --apply is a
 * rotation, not an error. No token is ever printed — only a masked tail.
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

const dist = (rel) => new URL(path.join('..', 'dist', rel), import.meta.url);
const { openSqliteDb, deserializeDoc } = await import(dist('services/sqlite/sqlite-db.js'));
const { SqliteOrgStorage } = await import(dist('services/sqlite/sqlite-org-storage.js'));
const { SqliteSecretStorage } = await import(dist('services/sqlite/sqlite-secret-storage.js'));
const { EncryptedSecretStorage } = await import(dist('services/encrypted-secret-storage.js'));
const { secretCipherFromEnv } = await import(dist('services/secret-cipher.js'));
const { OrgSecretsService } = await import(dist('services/org-secrets.js'));
const { OrgFlyService, ORG_FLY_TOKEN_SECRET_NAME } = await import(dist('services/org-fly.js'));

const apply = process.argv.includes('--apply');
const orgFlagIndex = process.argv.indexOf('--org');
const orgFlag = orgFlagIndex >= 0 ? process.argv[orgFlagIndex + 1] : undefined;

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
const flyOrgSlug = (process.env.FLY_ORG || process.env.FLY_ORG_SLUG || '').trim();
const flyToken = process.env.FLY_API_TOKEN?.trim();
if (!sqlitePath || !flyOrgSlug || !flyToken) {
  console.error('Need SQLITE_DB_PATH, FLY_ORG and FLY_API_TOKEN (run with backend.env loaded).');
  process.exit(1);
}
const cipher = secretCipherFromEnv();
if (!cipher) {
  console.error('SECRETS_MASTER_KEY is not set — refusing to write an org secret unencrypted.');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);
const orgRows = db.prepare('SELECT org_id, doc FROM orgs').all();
const orgs = orgRows.map((row) => deserializeDoc(row.doc));
const org = orgFlag
  ? orgs.find((candidate) => candidate.orgId === orgFlag)
  : (orgs.length === 1 ? orgs[0] : undefined);
if (!org) {
  console.error(orgFlag
    ? `No org with id ${orgFlag}. Existing: ${orgs.map((o) => o.orgId).join(', ') || '(none)'}`
    : `Expected exactly one org, found ${orgs.length} — name one with --org <id>.`);
  process.exit(1);
}

console.log(`org:        ${org.name} (${org.orgId})`);
console.log(`fly org:    ${flyOrgSlug}`);
console.log(`token:      …${flyToken.slice(-6)} → org secret ${ORG_FLY_TOKEN_SECRET_NAME} (encrypted)`);
if (org.fly) {
  console.log(`NOTE: org already points at "${org.fly.orgSlug}" — applying would rotate that connection.`);
}

const orgStorage = new SqliteOrgStorage(db);
const orgSecrets = new OrgSecretsService(new EncryptedSecretStorage(new SqliteSecretStorage(db), cipher));
const orgFly = new OrgFlyService({ orgStorage, orgSecrets });

if (!apply) {
  // Prove the pair works even on the dry run — a read-only listing.
  const { FlyClient } = await import(dist('services/fly-client.js'));
  const apps = await new FlyClient(flyToken).listApps(flyOrgSlug);
  console.log(`validated:  token lists ${apps.length} app(s) in ${flyOrgSlug}`);
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}

const connected = await orgFly.connectOrgFly({ orgId: org.orgId, orgSlug: flyOrgSlug, token: flyToken });
console.log(`connected:  token validated against ${connected.orgSlug} (${connected.appCount} apps), secret + pointer written`);

// Read back through the exact path every later consumer uses.
const context = await orgFly.resolveOrgFlyContext(org.orgId);
console.log(`resolved:   source=${context.source} slug=${context.orgSlug} token=…${context.apiToken.slice(-6)}`);
if (context.source !== 'org') {
  console.error('VERIFY FAILED: resolution still answers from the platform env.');
  process.exit(1);
}
console.log('\nOrg #0 now resolves its own Fly connection — the dogfood moment.');
