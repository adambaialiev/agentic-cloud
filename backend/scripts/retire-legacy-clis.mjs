#!/usr/bin/env node
/**
 * Operator tool for migrating agents off a RETIRED harness.
 *
 * Written for the Codex/Kimi retirement (2026-08-09) and corrected on
 * 2026-08-25, when Kimi was removed from the codebase: Codex RETURNED on
 * 2026-08-19 and had been left in the retired set ever since, so running this
 * script in between would have migrated healthy Codex agents onto Claude. It
 * now names only what is actually gone.
 *
 * A retired harness leaves behind the agents created while it WAS on offer.
 * This moves the ones that never got off the ground onto Claude so their
 * owners are not stranded on a CLI nothing signs in any more.
 *
 * Only UNCONNECTED agents are touched (no `connectedAt`): they never completed
 * a sign-in, hold no credentials, and — with the platform pool behind Claude —
 * simply work on their next message. An agent that IS connected has real
 * credentials a switch would invalidate, so it is reported and left exactly as
 * it is; the product tells it, in its own chat, that its harness is retired.
 *
 * Runs against the backend's SQLite file (needs `dist/` built — true on the
 * hosts). Dry by default; `--apply` writes.
 *
 *   node backend/scripts/retire-legacy-clis.mjs
 *   node backend/scripts/retire-legacy-clis.mjs --apply
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

const RETIRED_CLIS = new Set(['kimi']);

async function openStore() {
  const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
  if (!sqlitePath) {
    throw new Error('SQLITE_DB_PATH is not set. Run on the backend host with backend.env loaded.');
  }
  const { openSqliteDb, serializeDoc, deserializeDoc } = await import(
    new URL('../dist/services/sqlite/sqlite-db.js', import.meta.url)
  );
  const db = openSqliteDb(sqlitePath);
  return {
    listProfiles: () => db.prepare('SELECT doc FROM users').all().map((row) => deserializeDoc(row.doc)),
    // Read-modify-write of the whole profile doc, so a concurrent write to an
    // unrelated field is not clobbered by a stale copy read minutes ago.
    updateAgents: (userId, mutate) => {
      const row = db.prepare('SELECT doc FROM users WHERE user_id = ?').get(userId);
      if (!row) throw new Error(`No user ${userId}.`);
      const doc = deserializeDoc(row.doc);
      const agents = { ...(doc.telegram?.agents ?? {}) };
      mutate(agents);
      const next = { ...doc, telegram: { ...doc.telegram, agents } };
      db.prepare('UPDATE users SET doc = ? WHERE user_id = ?').run(serializeDoc(next), userId);
    },
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const store = await openStore();

  const migrate = [];
  const keep = [];
  for (const profile of store.listProfiles()) {
    for (const agent of Object.values(profile.telegram?.agents ?? {})) {
      if (!RETIRED_CLIS.has(agent?.cli)) continue;
      const entry = {
        userId: profile.userId,
        agentId: agent.id,
        name: agent.name,
        cli: agent.cli,
        createdAt: agent.createdAt,
      };
      if (agent.connectedAt) keep.push({ ...entry, connectedAt: agent.connectedAt });
      else migrate.push(entry);
    }
  }

  if (migrate.length === 0 && keep.length === 0) {
    console.log('No agents on a retired CLI. Nothing to do.');
    return;
  }

  for (const entry of keep) {
    console.log(
      `KEEP    ${entry.name} (${entry.cli}, ${entry.agentId}, user ${entry.userId})`
      + ` — signed in ${entry.connectedAt}; switching it would break a working agent.`,
    );
  }
  for (const entry of migrate) {
    console.log(
      `${apply ? 'MIGRATE' : 'WOULD  '} ${entry.name} (${entry.cli} → claude, ${entry.agentId},`
      + ` user ${entry.userId}, created ${entry.createdAt}) — never signed in.`,
    );
  }

  if (!apply) {
    console.log(`\n${migrate.length} to migrate, ${keep.length} left alone. Re-run with --apply to write.`);
    return;
  }

  const byUser = new Map();
  for (const entry of migrate) {
    if (!byUser.has(entry.userId)) byUser.set(entry.userId, []);
    byUser.get(entry.userId).push(entry.agentId);
  }
  for (const [userId, agentIds] of byUser) {
    store.updateAgents(userId, (agents) => {
      for (const agentId of agentIds) {
        if (agents[agentId]) agents[agentId] = { ...agents[agentId], cli: 'claude' };
      }
    });
  }
  console.log(`\nMigrated ${migrate.length} agent(s) to claude. ${keep.length} left alone.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
