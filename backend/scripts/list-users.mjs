#!/usr/bin/env node
/**
 * Read-only roster of everyone who has an account: how they signed up, when
 * they joined, when they were last seen, how far through setup they got, and
 * what they have done since. Opens the database READ-ONLY — it never runs the
 * schema migrations `openSqliteDb` runs, so it is safe against production.
 *
 * On the backend host the release root IS the backend directory, so the path
 * there has no `backend/`:
 *
 *   node /opt/infinite-agents/current/scripts/list-users.mjs           # table + funnel
 *   node /opt/infinite-agents/current/scripts/list-users.mjs --csv     # spreadsheet
 *   node /opt/infinite-agents/current/scripts/list-users.mjs --json    # one object per person
 *   node /opt/infinite-agents/current/scripts/list-users.mjs --user someone@example.com
 *   node /opt/infinite-agents/current/scripts/list-users.mjs --stalled # outside accounts short of a team
 *
 * `--user` takes a user id, sign-in email, @telegram handle, display name or
 * CODE and prints that one person in detail (workplaces, devices, per-agent
 * time). The code is the five characters `agentbuilt signups` and Growth's
 * notes show in place of a name, so this is how "who is d2001?" is answered.
 *
 * SQLITE_DB_PATH comes from the environment, a local .env, or — on the host —
 * /etc/infinite-agents/backend.env, of which only that one line is read.
 * Needs `dist/` built, which is true on the hosts.
 *
 * Who counts as what — the stage, the kind, last seen — is derived in
 * `src/services/sqlite/sqlite-user-roster.ts`, which the ops bot's /users
 * shares, so the phone and this script always agree. This file is only the
 * command line and the printing.
 *
 * The stage here is the WORKPLACE funnel (email, workplace, seat, agent, talked).
 * `--stalled` (note #152) is the outreach view of the same facts: everyone
 * from outside who has not reached a team yet, newest first, with the step
 * they stand on and how long they have stood there — the list of people to
 * write to today. A stall can show only the account's date and the seat's:
 * a cloud connect is not stamped with a time in the org record (org-fly.ts
 * writes the slug alone).
 */
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(backendRoot, '..');
const HOST_ENV = '/etc/infinite-agents/backend.env';

for (const envPath of [
  path.join(backendRoot, '.env.local'),
  path.join(backendRoot, '.env'),
  path.join(repoRoot, '.env.local'),
  path.join(repoRoot, '.env'),
]) {
  dotenv.config({ path: envPath, override: false, quiet: true });
}
if (!process.env.SQLITE_DB_PATH?.trim() && existsSync(HOST_ENV)) {
  // Only the one key: the rest of that file is secrets this script has no use for.
  const hostPath = dotenv.parse(readFileSync(HOST_ENV)).SQLITE_DB_PATH;
  if (hostPath) process.env.SQLITE_DB_PATH = hostPath;
}

const args = process.argv.slice(2);
const OUTPUT = args.includes('--json') ? 'json' : args.includes('--csv') ? 'csv' : 'table';
const STALLED = args.includes('--stalled');
const userIndex = args.indexOf('--user');
const USER_QUERY = userIndex >= 0 ? args[userIndex + 1] : undefined;
if (userIndex >= 0 && !USER_QUERY) throw new Error('--user requires an id, code, email, @handle or name');

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
if (!sqlitePath) {
  console.error(`SQLITE_DB_PATH is not set, and ${HOST_ENV} does not name one.`);
  process.exit(1);
}

const { readUserRoster, ROSTER_STAGES: STAGES, ROSTER_STAGE_MEANING: STAGE_MEANING } = await import(
  new URL('../dist/services/sqlite/sqlite-user-roster.js', import.meta.url)
);
const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');

const day = (value) => value?.slice(0, 10) ?? '-';

let people = readUserRoster(db);

if (USER_QUERY) {
  const needle = USER_QUERY.toLowerCase();
  people = people.filter((p) => [p.userId, p.code, p.email, p.telegram, p.name]
    .some((field) => field && field.toLowerCase() === needle));
  if (people.length === 0) {
    console.error(`No user matches ${USER_QUERY}`);
    process.exit(1);
  }
}

const COLUMNS = [
  ['code', 'CODE'], ['name', 'NAME'], ['via', 'VIA'], ['signIn', 'EMAIL / TELEGRAM'], ['kind', 'KIND'],
  ['joined', 'JOINED'], ['from', 'FROM'], ['firstPage', 'FIRST PAGE'], ['lastSeen', 'LAST SEEN'], ['stage', 'STAGE'], ['seatAt', 'SEAT AT'], ['workplaces', 'WORKPLACES'],
  ['agents', 'AGENTS'], ['agentsDeleted', 'DELETED'], ['messagesToAgents', 'MSGS'], ['agentMinutes', 'AGENT MIN'], ['liveSites', 'SITES'],
];
const cell = (p, key) => {
  if (key === 'signIn') return p.email || p.telegram || '-';
  const value = p[key];
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
};

if (STALLED) {
  // The outreach view: who from outside has not reached a team, newest first.
  const today = new Date().toISOString().slice(0, 10);
  const daysSince = (dayText) => (dayText === '-' ? '?' : String(Math.round((Date.parse(today) - Date.parse(dayText)) / 86_400_000)));
  const stalled = people
    .filter((p) => !p.kind && STAGES.indexOf(p.stage) < STAGES.indexOf('agent'))
    .sort((a, b) => b.joined.localeCompare(a.joined));
  const rows = stalled.map((p) => [p.name, p.email || p.telegram || '-', p.joined, daysSince(p.joined), p.lastSeen, p.stage]);
  const heads = ['NAME', 'EMAIL / TELEGRAM', 'JOINED', 'DAYS', 'LAST SEEN', 'STANDS AT'];
  const widths = heads.map((head, i) => Math.min(40, Math.max(head.length, ...rows.map((row) => row[i].length))));
  const line = (cells) => cells.map((value, i) => (value.length > widths[i] ? `${value.slice(0, widths[i] - 1)}…` : value.padEnd(widths[i]))).join('  ').trimEnd();
  console.log(line(heads));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(row));
  console.log(`\n${stalled.length} from outside short of a team · a stage is the LAST step reached, the next one is where they stopped`);
  console.log(STAGES.slice(0, STAGES.indexOf('agent')).map((stage) => `  ${stage.padEnd(10)} ${STAGE_MEANING[stage]}`).join('\n'));
} else if (OUTPUT === 'json') {
  console.log(JSON.stringify(people.map(({ detail, ...rest }) => (USER_QUERY ? { ...rest, detail } : rest)), null, 2));
} else if (OUTPUT === 'csv') {
  const quote = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  console.log(COLUMNS.map(([, head]) => head).join(','));
  for (const p of people) console.log(COLUMNS.map(([key]) => quote(cell(p, key))).join(','));
} else if (USER_QUERY) {
  for (const p of people) {
    console.log(`${p.name}  ·  ${p.code}  ·  ${p.userId}`);
    for (const [key, head] of COLUMNS.slice(2)) console.log(`  ${head.padEnd(17)}${cell(p, key) || '-'}`);
    console.log(`  ${'WEB LOGINS'.padEnd(17)}${p.webLogins}`);
    console.log(`  ${'REPOS / NOTES'.padEnd(17)}${p.repos} / ${p.notes}`);
    for (const place of p.detail.places) {
      console.log(`  workplace  ${place.name}: ${place.role}${place.founder ? ', founder' : ''}, cloud ${place.ownCloud ? 'its own' : 'ours (hosted)'}${place.beingDeleted ? ', being deleted' : ''}, joined ${place.joined}, last seen ${day(place.lastSeen)}`);
    }
    for (const seat of p.detail.seats) console.log(`  seat       ${seat}`);
    for (const device of p.detail.devices) console.log(`  device     ${device}`);
    for (const agent of p.detail.agents) console.log(`  agent      ${agent}`);
    for (const line of p.detail.agentTime) console.log(`  work       ${line}`);
    console.log('');
  }
} else {
  const widths = COLUMNS.map(([key, head]) => Math.min(40, Math.max(head.length, ...people.map((p) => cell(p, key).length))));
  const line = (cells) => cells.map((value, i) => (value.length > widths[i] ? `${value.slice(0, widths[i] - 1)}…` : value.padEnd(widths[i]))).join('  ').trimEnd();
  console.log(line(COLUMNS.map(([, head]) => head)));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const p of people) console.log(line(COLUMNS.map(([key]) => cell(p, key))));

  // The funnel counts people from outside — the admin and internal test
  // accounts would otherwise flatter every stage.
  const outside = people.filter((p) => !p.kind);
  const reached = (stage) => outside.filter((p) => STAGES.indexOf(p.stage) >= STAGES.indexOf(stage)).length;
  console.log(`\n${people.length} accounts · ${outside.length} from outside (${people.length - outside.length} admin/internal)`);
  console.log(`funnel (outside, reached at least): ${STAGES.map((stage) => `${stage}=${reached(stage)}`).join(' · ')}`);
  console.log(STAGES.map((stage) => `  ${stage.padEnd(10)} ${STAGE_MEANING[stage]}`).join('\n'));
}
db.close();
process.exit(0);
