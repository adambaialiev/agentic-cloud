#!/usr/bin/env node
/**
 * Force the agent fleet onto a new machine image, now.
 *
 * The fleet also converges on its own — `MachineImageUpdater` rolls each
 * machine onto `FLY_MACHINE_IMAGE` the next time the idle reaper finds it
 * asleep, which is the same write this makes, at the moment it costs the user
 * nothing. This script exists for when waiting a sleep cycle is not acceptable
 * (a security fix), or to see what is still behind: run it without `--apply`
 * and it reports the drift without touching anything.
 *
 * Run ON the backend host from /opt/infinite-agents/current:
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/roll-machine-image.mjs                    # dry run
 *   node scripts/roll-machine-image.mjs --apply            # write configs
 *   node scripts/roll-machine-image.mjs --image <ref>      # override target
 *                                        (default: $FLY_MACHINE_IMAGE)
 *
 * Only STOPPED machines are touched: an image update restarts a running
 * machine, killing the agent's processes mid-work. The rootfs is ephemeral
 * and the /data volume (the agent's home) survives the image swap — that is
 * the design. Re-run until nothing reports "running". Deployment (hosting)
 * apps and the image registry app are skipped: hosting machines run the
 * runtime image, not this one.
 *
 * Ownership is record-driven (byo-fly-design): the walk covers only apps an
 * agent record claims (serverId or provisioning marker, read from the SQLite
 * DB at SQLITE_DB_PATH), so an app nothing claims is listed in the summary
 * and never written to — the posture that has to hold before this script can
 * ever run against a client's Fly org.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');
for (const envPath of [path.join(backendRoot, '.env'), path.join(backendRoot, '..', '.env')]) {
  dotenv.config({ path: envPath, override: false });
}

const { FlyClient } = await import(path.join(backendRoot, 'dist', 'services', 'fly-client.js'));
const { isDeploymentAppName } = await import(path.join(backendRoot, 'dist', 'services', 'deployment-service.js'));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const imageFlagIndex = args.indexOf('--image');
const targetImage = (imageFlagIndex >= 0 ? args[imageFlagIndex + 1] : process.env.FLY_MACHINE_IMAGE)?.trim();
const apiToken = process.env.FLY_API_TOKEN?.trim();
const orgSlug = (process.env.FLY_ORG || process.env.FLY_ORG_SLUG || '').trim();
const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
if (!apiToken || !orgSlug || !targetImage) {
  console.error('Need FLY_API_TOKEN, FLY_ORG and a target image (FLY_MACHINE_IMAGE or --image <ref>).');
  process.exit(1);
}
if (!sqlitePath) {
  console.error('SQLITE_DB_PATH is not set — the walk covers only record-claimed apps, so it needs the DB.');
  process.exit(1);
}

/** App slugs the agent records claim: serverId apps + provisioning markers. */
async function loadClaimedAppNames(dbPath) {
  const { openSqliteDb, deserializeDoc } = await import(
    new URL('../dist/services/sqlite/sqlite-db.js', import.meta.url)
  );
  const { parseFlyServerRecordId, parseFlySandboxId } = await import(
    new URL('../dist/services/fly-sandbox-id.js', import.meta.url)
  );
  const { listAgents } = await import(new URL('../dist/types/user.js', import.meta.url));
  const db = openSqliteDb(dbPath);
  const claimed = new Set();
  for (const row of db.prepare('SELECT doc FROM users').all()) {
    const profile = deserializeDoc(row.doc);
    for (const agent of listAgents(profile.telegram)) {
      const marker = agent.provisioningAppName?.trim();
      if (marker) claimed.add(marker);
      const sandboxId = parseFlyServerRecordId(agent.serverId);
      const target = sandboxId ? parseFlySandboxId(sandboxId) : null;
      if (target) claimed.add(target.appName);
    }
  }
  return claimed;
}

console.log(`target image: ${targetImage}\n`);
const claimedApps = await loadClaimedAppNames(sqlitePath);
const client = new FlyClient(apiToken);
const apps = await client.listApps(orgSlug);
let updated = 0;
let running = 0;
let already = 0;
const unrecorded = [];

for (const app of apps) {
  const appName = app.name ?? '';
  if (!appName || isDeploymentAppName(appName) || appName.includes('machine-images')) continue;
  if (!claimedApps.has(appName)) {
    unrecorded.push(appName);
    continue;
  }
  const machines = await client.listMachines(appName);
  for (const machine of machines) {
    // Fly reports image as registry/repository:tag object or in config.image.
    const currentImage = machine.config?.image ?? '';
    // Machines created before the rootfs.persist default (see DEFAULT_FLY_ROOTFS
    // in fly-sandbox-client.ts) converge here: without it, Fly wipes the rootfs
    // on every stop/start and agents lose their apt installs at every sleep.
    const persistRootfs = machine.config?.rootfs?.persist ?? 'never';
    if (currentImage === targetImage && persistRootfs === 'restart') {
      already += 1;
      continue;
    }
    const label = `${appName}/${machine.id} (${machine.state}, on ${currentImage.split(':').pop()}, rootfs.persist=${persistRootfs})`;
    if (machine.state !== 'stopped') {
      console.log(`running, left alone: ${label}`);
      running += 1;
      continue;
    }
    if (!apply) {
      console.log(`would roll: ${label}`);
      updated += 1;
      continue;
    }
    // skipLaunch or Fly BOOTS every machine this touches: the update leaves a
    // machine running by default, whatever state it was in before. Rolling a
    // sleeping fleet without it wakes all of it at once.
    await client.updateMachine(appName, machine.id, {
      ...machine.config,
      image: targetImage,
      rootfs: { ...machine.config?.rootfs, persist: 'restart' },
    }, { skipLaunch: true });
    console.log(`rolled: ${label}`);
    updated += 1;
  }
}

console.log(`\n${apply ? 'rolled' : 'would roll'}: ${updated}, already on target: ${already}, running (re-run later): ${running}`);
if (unrecorded.length > 0) {
  console.log(`claimed by no agent record, left untouched (${unrecorded.length}): ${unrecorded.sort().join(', ')}`);
}
if (!apply) console.log('DRY RUN — nothing written. Re-run with --apply.');
