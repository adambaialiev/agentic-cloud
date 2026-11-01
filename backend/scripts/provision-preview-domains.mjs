#!/usr/bin/env node
/**
 * Retrofit branded preview hostnames (<slug>.agentbuilt.app) onto EXISTING
 * agent machines, and migrate certificate-era agents to the Worker model.
 * New machines get a name at creation; this walks the fleet.
 *
 * Agents WITHOUT a name get one minted (stamped on the record, which the
 * backend's /api/preview-map answers the preview-router Worker from — no DNS
 * record since 2026-10-13). Agents WITH a name get any legacy grey-cloud CNAME
 * at the slug deleted, flipping them from the per-name Fly-certificate path
 * onto the Worker path.
 *
 * Run ON the backend host from /opt/infinite-agents/current:
 *   set -a; source /etc/infinite-agents/backend.env; set +a
 *   node scripts/provision-preview-domains.mjs            # dry run
 *   node scripts/provision-preview-domains.mjs --apply
 *
 * Newly minted names are stamped onto the record via json_set (no
 * read-modify-write of the whole doc — the backend may be writing
 * concurrently) with identityVersion CLEARED so the next turn rewrites the
 * identity block with the branded URL. Safe on running machines: nothing
 * touches machine config, so no reboots, and the mapping is live instantly.
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

const { openSqliteDb } = await import(path.join(backendRoot, 'dist', 'services', 'sqlite', 'sqlite-db.js'));
const { SqliteDeploymentStorage } = await import(path.join(backendRoot, 'dist', 'services', 'sqlite', 'sqlite-deployment-storage.js'));
const { PreviewDomainService, previewMappingsFromProfiles } = await import(path.join(backendRoot, 'dist', 'services', 'preview-domain-service.js'));
const { CloudflareAppsDns } = await import(path.join(backendRoot, 'dist', 'services', 'deployment-service.js'));

const apply = process.argv.includes('--apply');
const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
const dnsToken = process.env.CLOUDFLARE_APPS_DNS_TOKEN?.trim();
const zoneId = process.env.CLOUDFLARE_APPS_ZONE_ID?.trim();
const appsDomain = process.env.APPS_DOMAIN?.trim() || 'agentbuilt.app';
if (!sqlitePath || !dnsToken || !zoneId) {
  console.error('Need SQLITE_DB_PATH, CLOUDFLARE_APPS_DNS_TOKEN, CLOUDFLARE_APPS_ZONE_ID.');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);
const deploymentStorage = new SqliteDeploymentStorage(db);
const dns = new CloudflareAppsDns(dnsToken, zoneId);
const previews = new PreviewDomainService({
  dns,
  appsDomain,
  isNameTaken: async (name) => Boolean(await deploymentStorage.getByName(name)),
  // So a minted name never repeats another agent's.
  loadMappings: async () => previewMappingsFromProfiles(
    db.prepare('SELECT doc FROM users').all().map((row) => JSON.parse(row.doc)),
  ),
});

const rows = db.prepare('SELECT user_id, doc FROM users').all();
let provisioned = 0;
let migrated = 0;

for (const row of rows) {
  const profile = JSON.parse(row.doc);
  const agents = profile.telegram?.agents ?? {};
  for (const [agentId, agent] of Object.entries(agents)) {
    const serverId = agent.serverId ?? '';
    const match = serverId.match(/^fly_([a-z0-9-]+)\.([a-z0-9]+)$/);
    if (!match) continue;
    const appName = match[1];
    if (agent.previewHostname) {
      // Certificate-era agent: ensure the Worker mapping, drop the legacy
      // CNAME. Same slug, same URL — only the serving path changes.
      if (!apply) {
        console.log(`would migrate: ${agent.name} (${appName}, ${agent.previewHostname})`);
        migrated += 1;
        continue;
      }
      try {
        await previews.provision(appName, agent.previewHostname);
        await dns.deleteCname(agent.previewHostname);
        console.log(`migrated: ${agent.name} → https://${agent.previewHostname}.${appsDomain} (worker path)`);
        migrated += 1;
      } catch (error) {
        console.error(`MIGRATION FAILED for ${agent.name}: ${error.message}`);
      }
      continue;
    }
    if (!apply) {
      console.log(`would provision: ${agent.name} (${row.user_id}/${agentId}, ${appName})`);
      provisioned += 1;
      continue;
    }
    try {
      const name = await previews.provision(appName);
      db.prepare(`
        UPDATE users
        SET doc = json_remove(json_set(doc, '$.telegram.agents.' || ? || '.previewHostname', ?),
                              '$.telegram.agents.' || ? || '.identityVersion')
        WHERE user_id = ?
      `).run(agentId, name, agentId, row.user_id);
      console.log(`provisioned: ${agent.name} (${appName}) → https://${name}.${appsDomain}`);
      provisioned += 1;
    } catch (error) {
      console.error(`FAILED for ${agent.name} (${appName}): ${error.message}`);
    }
  }
}

console.log(`\n${apply ? 'provisioned' : 'would provision'}: ${provisioned}, ${apply ? 'migrated' : 'would migrate'}: ${migrated}`);
if (!apply) console.log('DRY RUN — nothing written. Re-run with --apply.');
