#!/usr/bin/env node
/**
 * Fleet retrofit for wake-on-traffic previews: set `autostart: true` on every
 * agent machine's edge-proxy service, so a visitor hitting the stopped
 * machine's fly.dev URL boots it instead of getting a dead page. New machines
 * get this at create (fly-sandbox-client buildPublicHttpsService); this
 * one-off covers the fleet that predates it.
 *
 * Run ON the backend host from /opt/infinite-agents/current:
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/enable-preview-autostart.mjs            # dry run: inventory only
 *   node scripts/enable-preview-autostart.mjs --apply    # write configs
 *
 * Only STOPPED machines are touched: a config update reboots a running
 * machine, which would kill an agent's live processes for a flag it will pick
 * up at its next natural stop anyway. Re-run until nothing reports "running".
 * Deployment (hosting) apps and the machine-image registry are skipped —
 * hosting machines never stop, autostart is meaningless there.
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

const apply = process.argv.includes('--apply');
const apiToken = process.env.FLY_API_TOKEN?.trim();
const orgSlug = (process.env.FLY_ORG || process.env.FLY_ORG_SLUG || '').trim();
if (!apiToken || !orgSlug) {
  console.error('FLY_API_TOKEN and FLY_ORG must be set (source the host backend.env).');
  process.exit(1);
}

const client = new FlyClient(apiToken);
const apps = await client.listApps(orgSlug);
let updated = 0;
let running = 0;
let already = 0;
let skippedApps = 0;

for (const app of apps) {
  const appName = app.name ?? '';
  if (!appName || isDeploymentAppName(appName) || appName.includes('machine-images')) {
    skippedApps += 1;
    continue;
  }
  const machines = await client.listMachines(appName);
  for (const machine of machines) {
    const services = Array.isArray(machine.config?.services) ? machine.config.services : [];
    if (services.length === 0) continue;
    if (services.every((service) => service.autostart === true)) {
      already += 1;
      continue;
    }
    const label = `${appName}/${machine.id} (${machine.state})`;
    if (machine.state !== 'stopped') {
      console.log(`running, left alone: ${label}`);
      running += 1;
      continue;
    }
    if (!apply) {
      console.log(`would update: ${label}`);
      updated += 1;
      continue;
    }
    const amended = services.map((service) => ({ ...service, autostart: true }));
    await client.updateMachine(appName, machine.id, { ...machine.config, services: amended });
    console.log(`updated: ${label}`);
    updated += 1;
  }
}

console.log(`\n${apply ? 'updated' : 'would update'}: ${updated}, already done: ${already}, running (re-run later): ${running}, apps skipped: ${skippedApps}`);
if (!apply) console.log('DRY RUN — nothing written. Re-run with --apply.');
