#!/usr/bin/env node
/**
 * Retire the pool rows the org cutover made redundant (org-layer-design:
 * "no pool"). Once turns lease member seats, a pool row whose subscription
 * was copied into a seat serves nothing and only drifts stale — this
 * deletes those rows, after writing a full backup beside the database so a
 * deploy rollback can re-insert them.
 *
 * Reads and writes the backend's SQLite file, so run it on the backend host
 * from /opt/infinite-agents/current with backend.env loaded:
 *
 *   node backend/scripts/retire-pool-rows.mjs           # dry run — prints the plan
 *   node backend/scripts/retire-pool-rows.mjs --apply   # backup, then delete
 *
 * A row is retired only when a live seat carries the same provider+label
 * (the copy linkage the org #0 bootstrap wrote) and the row is idle; the
 * dry run prints a reason for every row it keeps. Tokens are never printed
 * — masked tails only. The backup file DOES hold the full rows (it is the
 * rollback), with owner-only permissions, next to the DB that already
 * holds the same material.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
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

function maskToken(provider, token) {
  if (provider === 'codex') return `auth.json (${Buffer.byteLength(token)} bytes)`;
  return `…${token.slice(-6)}`;
}

async function main() {
  const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
  if (!sqlitePath) {
    throw new Error('SQLITE_DB_PATH is not set. Run on the backend host with backend.env loaded.');
  }
  const { openSqliteDb, deserializeDoc } = await import(
    new URL('../dist/services/sqlite/sqlite-db.js', import.meta.url)
  );
  const { SqliteOrgStorage } = await import(
    new URL('../dist/services/sqlite/sqlite-org-storage.js', import.meta.url)
  );
  const { planPoolRetirement } = await import(
    new URL('../dist/services/pool-retirement.js', import.meta.url)
  );

  const { secretCipherFromEnv } = await import(
    new URL('../dist/services/secret-cipher.js', import.meta.url)
  );

  const db = openSqliteDb(sqlitePath);
  // Seat tokens are sealed in the row when the backend has SECRETS_MASTER_KEY;
  // the same key here is what lets this script read and write them.
  const orgStorage = new SqliteOrgStorage(db, secretCipherFromEnv());

  const credentials = db.prepare('SELECT doc FROM platform_credentials').all()
    .map((row) => deserializeDoc(row.doc));
  const seats = await orgStorage.listAllSeats();
  const plan = planPoolRetirement(credentials, seats);

  for (const kept of plan.keep) {
    const { credential } = kept;
    console.log(`keep:   ${credential.provider.padEnd(6)} ${credential.label.padEnd(20)} — ${kept.reason}`);
  }
  for (const entry of plan.retire) {
    const { credential, seat, tokenMatches } = entry;
    console.log(
      `retire: ${credential.provider.padEnd(6)} ${credential.label.padEnd(20)} ${maskToken(credential.provider, credential.token)}`
      + ` → seat ${seat.seatId} (${seat.status})${tokenMatches ? '' : ' [seat token has drifted — the seat copy is the live one]'}`,
    );
  }
  if (plan.retire.length === 0) {
    console.log('Nothing to retire.');
    return;
  }

  if (process.argv.includes('--apply') === false) {
    console.log(`\nDry run — nothing written. Re-run with --apply to retire ${plan.retire.length} row(s).`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(path.dirname(sqlitePath), `retired-pool-credentials-${stamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify(plan.retire.map((entry) => entry.credential), null, 2),
    { mode: 0o600 },
  );
  console.log(`\nBackup written: ${backupPath} (${plan.retire.length} row(s), owner-only)`);

  const del = db.prepare('DELETE FROM platform_credentials WHERE credential_id = ?');
  const tx = db.transaction(() => {
    for (const entry of plan.retire) del.run(entry.credential.credentialId);
  });
  tx();

  const left = db.prepare('SELECT COUNT(*) AS n FROM platform_credentials').get().n;
  console.log(`Done: ${plan.retire.length} pool row(s) deleted; ${left} remain.`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
