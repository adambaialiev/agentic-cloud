#!/usr/bin/env node
/**
 * Stamp org #0's git namespace (byo-git-design slice 1: org-scoped repos).
 *
 * Writes `git.namespaceId = <admin userId>` onto the org document — the
 * pre-org layout on the central host, made explicit — and backfills `orgId`
 * onto every live and trashed repo record in that namespace. After this, org
 * #0 resolves its repos through the same org pointer a client org will,
 * and nothing about clone URLs, disk paths or behavior changes: the stamp
 * names what is already true.
 *
 * Run on the backend host from /opt/infinite-agents/current with backend.env
 * loaded:
 *
 *   node backend/scripts/stamp-org0-git-namespace.mjs            # dry run
 *   node backend/scripts/stamp-org0-git-namespace.mjs --apply    # executes
 *   node backend/scripts/stamp-org0-git-namespace.mjs --org <id> # if needed
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
const { openSqliteDb, deserializeDoc, serializeDoc } = await import(dist('services/sqlite/sqlite-db.js'));
const { SqliteOrgStorage } = await import(dist('services/sqlite/sqlite-org-storage.js'));
const { OrgGitService } = await import(dist('services/org-git.js'));

const apply = process.argv.includes('--apply');
const orgFlagIndex = process.argv.indexOf('--org');
const orgFlag = orgFlagIndex >= 0 ? process.argv[orgFlagIndex + 1] : undefined;

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
if (!sqlitePath) {
  console.error('Need SQLITE_DB_PATH (run with backend.env loaded).');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);
const orgs = db.prepare('SELECT doc FROM orgs').all().map((row) => deserializeDoc(row.doc));
const org = orgFlag
  ? orgs.find((candidate) => candidate.orgId === orgFlag)
  : (orgs.length === 1 ? orgs[0] : undefined);
if (!org) {
  console.error(orgFlag
    ? `No org with id ${orgFlag}. Existing: ${orgs.map((o) => o.orgId).join(', ') || '(none)'}`
    : `Expected exactly one org, found ${orgs.length} — name one with --org <id>.`);
  process.exit(1);
}

const orgStorage = new SqliteOrgStorage(db);
const admins = (await orgStorage.listMembers(org.orgId)).filter((m) => m.role === 'admin');
if (admins.length !== 1) {
  console.error(`Expected exactly one admin in ${org.name}, found ${admins.length} — this script stamps the pre-org layout, whose namespace is the founding admin's userId.`);
  process.exit(1);
}
const namespaceId = admins[0].userId;

const repoRows = db.prepare('SELECT repo_id, doc FROM git_repos WHERE user_id = ?').all(namespaceId);
const repos = repoRows.map((row) => ({ repoId: row.repo_id, doc: deserializeDoc(row.doc) }));
const unstamped = repos.filter(({ doc }) => doc.orgId !== org.orgId);

console.log(`org:        ${org.name} (${org.orgId})`);
console.log(`namespace:  ${namespaceId} (admin userId — the existing on-disk layout)`);
console.log(`stamp:      org.git = ${org.git ? JSON.stringify(org.git) + ' (already set)' : '{ namespaceId } (new)'}`);
console.log(`repos:      ${repos.length} in namespace, ${unstamped.length} to backfill orgId`);

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}

const orgGit = new OrgGitService({ orgStorage });
await orgGit.stampOrgGitNamespace(org.orgId, namespaceId);

const write = db.prepare('UPDATE git_repos SET doc = ? WHERE repo_id = ?');
for (const { repoId, doc } of unstamped) {
  write.run(serializeDoc({ ...doc, orgId: org.orgId }), repoId);
}

// Read back through the exact path every consumer uses.
const resolved = await orgGit.resolveNamespace(namespaceId);
console.log(`resolved:   namespaceId=${resolved.namespaceId} orgId=${resolved.orgId} role=${resolved.role}`);
if (resolved.namespaceId !== namespaceId || resolved.orgId !== org.orgId) {
  console.error('VERIFY FAILED: resolution does not answer the stamped namespace.');
  process.exit(1);
}
console.log(`\nStamped. ${unstamped.length} repo record(s) backfilled — org #0 now resolves git through its org pointer.`);
