#!/usr/bin/env node
/**
 * Mark accounts as the team's own (a test, a demo), so the sign-up roster —
 * list-users.mjs, the ops bot, `agentbuilt signups` — stops counting them as
 * people from outside. `--undo` takes the mark off again.
 *
 *   node /opt/infinite-agents/current/scripts/mark-team-account.mjs d2001 test1@agenticcloudcomputer.com
 *   node /opt/infinite-agents/current/scripts/mark-team-account.mjs d2001 --undo
 *
 * Each argument is a roster CODE, a sign-in email or a user id. Every one
 * must match exactly one account, or nothing is written at all.
 *
 * WHY A MARK. Until 2026-10-08 the roster counted any address on
 * @agenticcloudcomputer.com as the team's. Since 2026-09-14 every new
 * account picks its own address there, so that rule filed every real
 * sign-up as ours. Who is ours can only be said, so this says it.
 *
 * It WRITES, and one key only: `roles.internal` on each profile, in one
 * transaction. It opens the file directly rather than through
 * `openSqliteDb`, which would run the schema migrations. The backend reads
 * profiles from the database on every call, so it sees the mark at once.
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
const wanted = args.filter((arg) => !arg.startsWith('--'));
if (!wanted.length) {
  console.error('usage: mark-team-account.mjs <code|email|user id>... [--undo]');
  process.exit(1);
}

const { readUserRoster } = await import(new URL('../dist/services/sqlite/sqlite-user-roster.js', import.meta.url));
const db = new Database(sqlitePath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');

const people = readUserRoster(db);
const matches = wanted.map((needle) => {
  const lower = needle.toLowerCase();
  const found = people.filter((p) => [p.userId, p.code, p.email].some((field) => field && field.toLowerCase() === lower));
  if (found.length !== 1) {
    console.error(`${needle}: ${found.length ? `matches ${found.length} accounts — use the email or user id` : 'matches no account'}. Nothing was written.`);
    process.exit(1);
  }
  return found[0];
});

const write = db.prepare(undo
  ? `UPDATE users SET doc = json_remove(doc, '$.roles.internal') WHERE user_id = ?`
  : `UPDATE users SET doc = json_set(doc, '$.roles', json_patch(coalesce(json_extract(doc, '$.roles'), '{}'), '{"internal":true}')) WHERE user_id = ?`);
db.transaction(() => { for (const person of matches) write.run(person.userId); })();

for (const person of matches) {
  console.log(`${person.code}  ${person.email || person.userId}  ${undo ? 'counts as outside again' : "marked as the team's own"}`);
}
db.close();
