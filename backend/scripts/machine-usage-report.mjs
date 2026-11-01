#!/usr/bin/env node
// Per-agent machine cost report: observed runtime × compute rate + provisioned
// volume × storage rate. The runtime side reads `machineRuntimeMs` (monthly
// buckets stamped by the idle reaper's sweep, see machine-runtime-meter.ts);
// the volume side asks the Fly API for live provisioned sizes.
//
//   npm --prefix backend run usage:report                 # current UTC month
//   npm --prefix backend run usage:report -- --month 2026-06
//   npm --prefix backend run usage:report -- --no-volumes # skip Fly API calls
//
// This is the ground truth for pricing decisions ("what does an engaged user
// actually cost?"), not a billing engine: runtime is sampled at sweep
// granularity (±5 min per session), and volume cost is quoted as the full
// month's rate on today's provisioned size.
//
// Requires SQLITE_DB_PATH, plus FLY_API_TOKEN for volumes.
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(backendRoot, '..');

const FLY_API_BASE_URL = 'https://api.machines.dev/v1';
// Mirrors fly-sandbox-id.ts: persisted records are `fly_<app>.<machineId>`.
const FLY_RECORD_ID_PATTERN = /^fly_([a-z][a-z0-9-]*)\.([0-9a-f]+)$/;

// List prices for `performance-4x` / 8GB (fly.io/docs/about/pricing, checked
// 2026-08-17), and volume provisioned capacity.
//
// Agent machines moved from shared to DEDICATED cores on 2026-08-17 (Owner's
// call, after 91-94% steal was measured on a shared-2x under a test suite), so
// the old $0.0297/hr shared-2x figure understated an active hour six-fold.
// $128.77/month at 730 hours; machines are stopped while idle and Fly bills
// CPU/RAM only while they run, so this multiplies AWAKE hours, not calendar.
//
// ONE RATE FOR A FLEET THAT IS NO LONGER ONE SHAPE. Since 2026-09-06 a new
// agent is built at `performance-2x` (half of this rate), and owners have
// been able to move any machine along the ladder since note #268 shipped the
// day before. So read a row here as "what this runtime would cost on a 4x
// box": right for the machines built before that date, twice the truth for a
// 2x one. `agentbuilt org spend` is the view that prices each machine by the
// shape Fly actually reports (services/org-spend.ts, using the shared table
// in config/fly-cost-estimates.ts) — go there for a per-machine answer, and
// use this script for the runtime hours it alone knows.
const COMPUTE_USD_PER_HOUR = 0.1764;
const VOLUME_USD_PER_GB_MONTH = 0.15;

function loadEnvFiles() {
  for (const envPath of [
    path.join(backendRoot, '.env.local'),
    path.join(backendRoot, '.env'),
    path.join(repoRoot, '.env.local'),
    path.join(repoRoot, '.env'),
  ]) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

function parseArgs(argv) {
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const options = { month: currentMonth, volumes: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--month':
        index += 1;
        if (!/^\d{4}-\d{2}$/.test(argv[index] ?? '')) throw new Error('--month requires YYYY-MM');
        options.month = argv[index];
        break;
      case '--no-volumes': options.volumes = false; break;
      case '--help': case '-h':
        console.log('Usage: npm --prefix backend run usage:report -- [--month YYYY-MM] [--no-volumes]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

/**
 * Every user profile from the backend's SQLite file. Loaded through the
 * compiled sqlite-db module so the on-disk encoding is decoded exactly the way
 * the backend wrote it (needs `dist/` built — true on the prod host).
 */
async function loadUserProfiles() {
  const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
  if (!sqlitePath) {
    throw new Error('SQLITE_DB_PATH is not set. Run on the backend host with backend.env loaded.');
  }
  const { openSqliteDb, deserializeDoc } = await import(
    new URL('../dist/services/sqlite/sqlite-db.js', import.meta.url)
  );
  const db = openSqliteDb(sqlitePath);
  return db.prepare('SELECT user_id, doc FROM users').all()
    .map((row) => ({ id: row.user_id, profile: deserializeDoc(row.doc) }));
}

/** Total provisioned GB across an app's volumes, or undefined when unreachable. */
async function flyVolumeGb(appName, apiToken) {
  const response = await fetch(`${FLY_API_BASE_URL}/apps/${encodeURIComponent(appName)}/volumes`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (response.status === 404) return 0; // app already destroyed → nothing billing
  if (!response.ok) throw new Error(`Fly API ${response.status} for ${appName}`);
  const volumes = await response.json();
  return (Array.isArray(volumes) ? volumes : []).reduce((sum, v) => sum + (v.size_gb ?? 0), 0);
}

function hours(ms) {
  return ms / 3_600_000;
}

function fmtUsd(value) {
  return `$${value.toFixed(2)}`;
}

async function main() {
  loadEnvFiles();
  const options = parseArgs(process.argv.slice(2));
  const flyToken = process.env.FLY_API_TOKEN?.trim();
  const withVolumes = options.volumes && Boolean(flyToken);
  if (options.volumes && !flyToken) {
    console.warn('FLY_API_TOKEN not set — reporting runtime only (as if --no-volumes).');
  }

  const users = await loadUserProfiles();
  const rows = [];
  for (const { id, profile } of users) {
    for (const agent of Object.values(profile.telegram?.agents ?? {})) {
      const runtimeMs = agent.machineRuntimeMs?.[options.month] ?? 0;
      const appName = FLY_RECORD_ID_PATTERN.exec((agent.serverId ?? '').trim())?.[1];
      let volumeGb;
      if (withVolumes && appName) {
        try {
          volumeGb = await flyVolumeGb(appName, flyToken);
        } catch (error) {
          console.warn(`volumes for ${appName}: ${error.message}`);
        }
      }
      if (runtimeMs === 0 && !appName) continue; // never provisioned, nothing metered
      rows.push({
        user: profile.username ?? id,
        agent: agent.name ?? agent.id,
        app: appName ?? '(recycled)',
        runtimeH: hours(runtimeMs),
        volumeGb,
        computeUsd: hours(runtimeMs) * COMPUTE_USD_PER_HOUR,
        volumeUsd: volumeGb !== undefined ? volumeGb * VOLUME_USD_PER_GB_MONTH : undefined,
      });
    }
  }

  rows.sort((a, b) => (b.computeUsd + (b.volumeUsd ?? 0)) - (a.computeUsd + (a.volumeUsd ?? 0)));
  console.log(`Machine usage for ${options.month} (runtime sampled by the idle reaper's sweeps)\n`);
  console.table(rows.map((row) => ({
    user: row.user,
    agent: row.agent,
    app: row.app,
    'runtime h': row.runtimeH.toFixed(1),
    'volume GB': row.volumeGb ?? 'n/a',
    'est cost': fmtUsd(row.computeUsd + (row.volumeUsd ?? 0)),
  })));

  const totalCompute = rows.reduce((sum, row) => sum + row.computeUsd, 0);
  const totalVolume = rows.reduce((sum, row) => sum + (row.volumeUsd ?? 0), 0);
  console.log(`agents: ${rows.length}`);
  console.log(`compute: ${fmtUsd(totalCompute)} (${rows.reduce((s, r) => s + r.runtimeH, 0).toFixed(1)} h @ $${COMPUTE_USD_PER_HOUR}/h)`);
  console.log(`volumes: ${fmtUsd(totalVolume)} (@ $${VOLUME_USD_PER_GB_MONTH}/GB-month, full-month rate on today's size)`);
  console.log(`total:   ${fmtUsd(totalCompute + totalVolume)}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
