#!/usr/bin/env node
/**
 * Let ONE workplace invite people (note #805), or take that back with
 * `--undo`. Inviting is switched off on production (RouteDeps.invitesClosed,
 * 2026-10-11) and a workplace is one person's; a workplace carrying this mark
 * gets the whole door back — the invite page and its link, join requests on
 * Home and Workplace settings, people and roles, and a newcomer's account
 * opening into it once an admin approves. Nothing else sets the mark: no
 * route writes it, so ordinary workplaces never see an invite.
 *
 *   node /opt/infinite-agents/current/scripts/allow-invites.mjs <orgId> --by "Alex for Adam"
 *   node /opt/infinite-agents/current/scripts/allow-invites.mjs <orgId> --undo
 *
 * A mark of its own, beside `ownCloudAllowed` (allow-own-cloud.mjs): a team
 * may want people without its own cloud account, or the reverse.
 *
 * It WRITES one key, `invitesAllowed` on the workplace record, and opens the
 * file directly rather than through `openSqliteDb`, which would run the schema
 * migrations. The backend reads workplaces from the database on every call,
 * so the doors appear on the next load of the Workspace. `--undo` only shuts
 * the door: everyone already in stays in, an unused link opens on "Invites
 * are closed for now", and a request still waiting is shown to nobody.
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
  console.error('usage: allow-invites.mjs <orgId> --by "<who decided>"   |   allow-invites.mjs <orgId> --undo');
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
const members = db.prepare('SELECT count(*) AS n FROM org_members WHERE org_id = ?').get(orgId).n;

if (undo) {
  db.prepare(`UPDATE orgs SET doc = json_remove(doc, '$.invitesAllowed') WHERE org_id = ?`).run(orgId);
  console.log(`${org.name} (${orgId}): no longer invites people.`
    + (members > 1 ? ` Its ${members} people stay in.` : ''));
  db.close();
  process.exit(0);
}

if (org.deletion) {
  console.error(`${org.name} (${orgId}) is being deleted, so it takes nobody new. Nothing was written.`);
  process.exit(1);
}

const mark = JSON.stringify({ at: new Date().toISOString(), by });
db.prepare(`UPDATE orgs SET doc = json_set(doc, '$.invitesAllowed', json(?)) WHERE org_id = ?`).run(mark, orgId);
console.log(`${org.name} (${orgId}): may now invite people (marked by ${by}). An admin finds "Invite to this workplace" in the workplace menu.`);
db.close();
