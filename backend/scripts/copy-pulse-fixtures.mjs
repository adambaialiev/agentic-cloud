#!/usr/bin/env node
/**
 * Put the fixture copies on the Copies screen (note #1058), or take them off.
 * For a live look at the screen before the first real copy sends a pulse:
 * four made-up copies (ids `fixture-…`, domains `….example`), one of each
 * kind the screen draws — live and well, behind with little disk, silent,
 * opted out — with their daily rows, in the exact shape of note #1057.
 *
 *   node /opt/infinite-agents/current/scripts/copy-pulse-fixtures.mjs add [--quiet]
 *   node /opt/infinite-agents/current/scripts/copy-pulse-fixtures.mjs remove
 *
 * `--quiet` also marks every condition they hold as already said, so the
 * alert sweep lands nothing in anybody's Chief of Staff chat for them.
 * `remove` deletes every row whose copy id starts `fixture-`, alerts
 * included, and nothing else. It opens the file directly (as
 * allow-invites.mjs does); the tables exist once a backend carrying them has
 * started. The fixtures come from the built backend, dist/shared.
 */
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const verb = process.argv[2];
if (!sqlitePath || !['add', 'remove'].includes(verb ?? '')) {
  console.error('usage: copy-pulse-fixtures.mjs add [--quiet] | remove   (SQLITE_DB_PATH or the host env names the database)');
  process.exit(1);
}

const db = new Database(sqlitePath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');

if (verb === 'remove') {
  const gone = db.transaction(() => ['copy_pulses', 'copy_pulse_days', 'copy_pulse_alerts']
    .map((table) => `${table} ${db.prepare(`DELETE FROM ${table} WHERE copy_id LIKE 'fixture-%'`).run().changes}`))();
  console.log(`Removed: ${gone.join(', ')}.`);
  process.exit(0);
}

const shared = (name) => import(pathToFileURL(path.join(backendRoot, 'dist', 'shared', name)).href);
const { fixtureCopies, fixtureHistory } = await shared('copy-pulse-fixtures.js');
const { copyConditions, COPY_ALERT_CONDITIONS } = await shared('copy-pulse.js');
const now = new Date();
const quiet = process.argv.includes('--quiet');
const day = (iso) => iso.slice(0, 10);

db.transaction(() => {
  for (const { pulse, receivedAt } of fixtureCopies(now)) {
    const history = fixtureHistory(pulse, receivedAt);
    for (const { pulse: one, receivedAt: at } of history) {
      const doc = JSON.stringify({ ...one, receivedAt: at });
      db.prepare('INSERT INTO copy_pulses (copy_id, first_seen_at, last_seen_at, doc) VALUES (?, ?, ?, ?) ON CONFLICT(copy_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, doc = excluded.doc')
        .run(one.copyId, at, at, doc);
      db.prepare('INSERT INTO copy_pulse_days (copy_id, day, last_seen_at, doc) VALUES (?, ?, ?, ?) ON CONFLICT(copy_id, day) DO UPDATE SET last_seen_at = excluded.last_seen_at, doc = excluded.doc')
        .run(one.copyId, day(at), at, doc);
    }
    if (quiet) {
      const record = { copyId: pulse.copyId, firstSeenAt: receivedAt[0], lastSeenAt: receivedAt.at(-1), pulse: { ...history.at(-1).pulse, receivedAt: receivedAt.at(-1) } };
      // Every release counted as far behind as it could be: all said.
      for (const condition of COPY_ALERT_CONDITIONS) {
        const { holding } = copyConditions(record, ['9999.12.31.0', '9999.12.31.1'], now);
        if (condition === 'behind' || holding.some((alert) => alert.condition === condition)) {
          db.prepare('INSERT OR REPLACE INTO copy_pulse_alerts (copy_id, condition, raised_at) VALUES (?, ?, ?)').run(pulse.copyId, condition, now.toISOString());
        }
      }
    }
    console.log(`${pulse.copyId} ${pulse.domain}: ${history.length} days`);
  }
})();
console.log(quiet ? 'Added, with every alert marked as said.' : 'Added. The alert sweep says what they hold within the hour.');
