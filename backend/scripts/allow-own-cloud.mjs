#!/usr/bin/env node
/**
 * Let ONE workplace bring a Fly account of its own (note #801), or take that
 * back with `--undo`. Every workplace is hosted on the platform's account
 * (note #664) and the Workspace refuses to connect another; a workplace
 * carrying this mark is offered Workspace → Cloud, where an admin pastes their
 * Fly organization token. Nothing else sets the mark: no route writes it, so
 * the token step never comes back in front of an ordinary sign-up.
 *
 *   node /opt/infinite-agents/current/scripts/allow-own-cloud.mjs <orgId> --by "Alex for Adam"
 *   node /opt/infinite-agents/current/scripts/allow-own-cloud.mjs <orgId> --undo
 *
 * MARK IT BEFORE THE CUSTOMER'S FIRST MESSAGE to the Chief of Staff. A new
 * workplace builds nothing until then (note #726); after it, the Chief of
 * Staff's machine is in our account and connecting is refused until that is
 * moved. The script says what of the workplace already runs on our cloud.
 *
 * It WRITES one key, `ownCloudAllowed` on the workplace record, and opens the
 * file directly rather than through `openSqliteDb`, which would run the schema
 * migrations. The backend reads workplaces from the database on every call,
 * so the Cloud section appears on the next load of the workplace screen.
 * `--undo` only removes the mark: an account already connected stays
 * connected (that is a teardown, deleting-a-client-org).
 */
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_ENV = '/etc/infinite-agents/backend.env';
for (const envPath of [path.join(backendRoot, '.env.local'), path.join(backendRoot, '.env')]) {
  dotenv.config({ path: envPath, override: false, quiet: true });
}
if (!process.env.SQLITE_DB_PATH?.trim() && existsSync(HOST_ENV)) {
  const hostPath = dotenv.parse(readFileSync(HOST_ENV)).SQLITE_DB_PATH;
  if (hostPath) process.env.SQLITE_DB_PATH = hostPath;
}
const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
if (!sqlitePath) {
  console.error(`SQLITE_DB_PATH is not set, and ${HOST_ENV} does not name one.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const undo = args.includes('--undo');
const byIndex = args.indexOf('--by');
const by = byIndex >= 0 ? (args[byIndex + 1] ?? '').trim() : '';
const orgId = args.filter((arg, i) => !arg.startsWith('--') && i !== byIndex + 1)[0]?.trim();
if (!orgId || (!undo && !by)) {
  console.error('usage: allow-own-cloud.mjs <orgId> --by "<who decided>"   |   allow-own-cloud.mjs <orgId> --undo');
  process.exit(1);
}

const db = new Database(sqlitePath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');
const row = db.prepare('SELECT doc FROM orgs WHERE org_id = ?').get(orgId);
if (!row) {
  console.error(`${orgId}: no such workplace. Nothing was written.`);
  process.exit(1);
}
const org = JSON.parse(row.doc);

if (undo) {
  db.prepare(`UPDATE orgs SET doc = json_remove(doc, '$.ownCloudAllowed') WHERE org_id = ?`).run(orgId);
  console.log(`${org.name} (${orgId}): no longer offered a cloud account of its own.`
    + (org.fly ? ` It stays connected to "${org.fly.orgSlug}".` : ''));
  db.close();
  process.exit(0);
}

if (org.fly) {
  console.error(`${org.name} (${orgId}) already runs on its own Fly account "${org.fly.orgSlug}". Nothing was written.`);
  process.exit(1);
}

// What already runs on OUR account — the Workspace refuses to connect while
// any of it does, because it would be stranded (hosted-workplace.ts
// `hostedFootprint`, which is the authority; this is the operator's preview).
const machines = db.prepare(`
  SELECT count(*) AS n FROM users u, json_each(u.doc, '$.telegram.agents') a
  WHERE json_extract(a.value, '$.orgId') = ?
    AND (json_extract(a.value, '$.serverId') IS NOT NULL OR json_extract(a.value, '$.provisioningAppName') IS NOT NULL)
`).get(orgId).n;
const sites = db.prepare(`
  SELECT count(*) AS n FROM deployments
  WHERE json_extract(doc, '$.orgId') = ? AND json_extract(doc, '$.status') NOT IN ('destroyed', 'pending-payment')
`).get(orgId).n;

const mark = JSON.stringify({ at: new Date().toISOString(), by });
db.prepare(`UPDATE orgs SET doc = json_set(doc, '$.ownCloudAllowed', json(?)) WHERE org_id = ?`).run(mark, orgId);
console.log(`${org.name} (${orgId}): may now connect its own Fly account on Workspace → Cloud (marked by ${by}).`);
if (machines || sites) {
  console.log(`  But ${machines} agent machine(s) and ${sites} site(s) of it already run on our cloud,`
    + ' so connecting is refused until they are moved. Mark a workplace before its first message to the Chief of Staff.');
}
db.close();
