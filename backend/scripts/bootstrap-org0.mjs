#!/usr/bin/env node
/**
 * Org #0: turn the admin's account into the first organization
 * (org-layer-design). Creates the org, makes the admin its first member, and
 * COPIES every pool credential into the admin's own seats — turns keep
 * running on the pool until the cutover slice, so this is safe to run while
 * agents work.
 *
 * Reads and writes the backend's SQLite file, so run it on the backend host
 * from /opt/infinite-agents/current with backend.env loaded:
 *
 *   node backend/scripts/bootstrap-org0.mjs                  # dry run — prints the plan
 *   node backend/scripts/bootstrap-org0.mjs --apply          # executes it
 *   node backend/scripts/bootstrap-org0.mjs --apply --name "Org #0"
 *   node backend/scripts/bootstrap-org0.mjs --user tg_123…   # if admin discovery needs help
 *
 * Dry run is the default on purpose: the plan prints exactly what apply will
 * write (org, member, every seat with provider/label/status/selection), and no
 * token is ever printed — only a masked tail for Claude and a byte count for
 * Codex auth files.
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

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
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
  const { planOrgBootstrap, applyOrgBootstrap } = await import(
    new URL('../dist/services/org-bootstrap.js', import.meta.url)
  );

  const { secretCipherFromEnv } = await import(
    new URL('../dist/services/secret-cipher.js', import.meta.url)
  );

  const db = openSqliteDb(sqlitePath);
  // Seat tokens are sealed in the row when the backend has SECRETS_MASTER_KEY;
  // the same key here is what lets this script read and write them.
  const orgStorage = new SqliteOrgStorage(db, secretCipherFromEnv());

  // The admin: --user wins; otherwise the single profile carrying roles.admin.
  let adminUserId = typeof arg('user') === 'string' ? arg('user') : undefined;
  if (!adminUserId) {
    const admins = db.prepare('SELECT user_id, doc FROM users').all()
      .map((row) => ({ userId: row.user_id, doc: deserializeDoc(row.doc) }))
      .filter((row) => row.doc?.roles?.admin === true);
    if (admins.length !== 1) {
      throw new Error(
        `expected exactly one admin profile, found ${admins.length}`
        + `${admins.length ? ` (${admins.map((a) => a.userId).join(', ')})` : ''}`
        + ' — pass --user to choose.',
      );
    }
    adminUserId = admins[0].userId;
  }

  const credentials = db.prepare('SELECT doc FROM platform_credentials').all()
    .map((row) => deserializeDoc(row.doc));

  // Cutover companion: re-copy Codex token material from pool rows onto the
  // admin's existing seats (matched by label). The Codex CLI refreshes
  // auth.json in place on whichever row turns run on, so between bootstrap
  // and cutover the POOL copy is the live one — run this right after the
  // cutover deploy, before the first Codex turn leases a seat.
  if (arg('sync-codex-tokens') === true) {
    const membership = await orgStorage.getMembershipByUser(adminUserId);
    if (!membership) throw new Error(`no membership for ${adminUserId} — run the bootstrap first`);
    const seats = await orgStorage.listSeatsByMember(membership.orgId, adminUserId);
    let synced = 0;
    for (const seat of seats) {
      if (seat.provider !== 'codex') continue;
      const source = credentials.find((c) => c.provider === 'codex' && c.label === seat.label);
      if (!source) {
        console.log(`  ${seat.label}: no matching pool credential — left as is`);
        continue;
      }
      if (source.token === seat.token) {
        console.log(`  ${seat.label}: already current`);
        continue;
      }
      await orgStorage.updateSeat(seat.seatId, { token: source.token });
      console.log(`  ${seat.label}: token re-copied from pool (${Buffer.byteLength(source.token)} bytes)`);
      synced += 1;
    }
    console.log(`Synced ${synced} codex seat(s).`);
    return;
  }

  const orgName = typeof arg('name') === 'string' ? arg('name') : 'Org #0';
  const input = { adminUserId, orgName, credentials };
  const plan = await planOrgBootstrap(orgStorage, input);

  if (plan.action === 'already-bootstrapped') {
    console.log(`Already bootstrapped: ${adminUserId} belongs to org ${plan.orgId}. Nothing to do.`);
    return;
  }

  console.log(`Plan: create org "${plan.orgName}" with admin ${plan.adminUserId}`);
  if (plan.seats.length === 0) {
    console.log('  (no pool credentials found — the org starts with zero seats)');
  }
  for (const seat of plan.seats) {
    const source = credentials.find((c) => c.credentialId === seat.sourceCredentialId);
    console.log(
      `  seat: ${seat.provider.padEnd(6)} ${seat.label.padEnd(20)} ${seat.status.padEnd(9)}`
      + `${seat.selected ? ' [selected]' : '          '} ${maskToken(seat.provider, source.token)}`,
    );
  }

  if (arg('apply') !== true) {
    console.log('\nDry run — nothing written. Re-run with --apply to execute exactly this plan.');
    return;
  }

  const result = await applyOrgBootstrap(orgStorage, input);
  console.log(`\nDone: org ${result.orgId} with ${result.seats.length} seat(s).`);
  for (const seat of result.seats) {
    console.log(`  ${seat.provider.padEnd(6)} ${seat.label.padEnd(20)} ${seat.status.padEnd(9)}${seat.selected ? ' [selected]' : ''}`);
  }
  console.log('\nTurns still run on the pool — the cutover slice switches them to these seats.');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
