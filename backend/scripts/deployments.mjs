#!/usr/bin/env node
/**
 * Operator tool for production deployments (docs/deployments-phase1.md).
 * Runs against the compiled backend (npm run build first) and the host's env
 * (SQLITE_DB_PATH, FLY_*, CLOUDFLARE_APPS_*). This is the pre-billing E2E
 * driver on dev, and the abuse kill switch everywhere.
 *
 *   node backend/scripts/deployments.mjs list
 *   node backend/scripts/deployments.mjs create  --user tg_… --agent ag_… --name ember-coffee --preset static
 *   node backend/scripts/deployments.mjs provision --name ember-coffee   # skips billing: operator-forced
 *   node backend/scripts/deployments.mjs sync    --name ember-coffee --dir ./site
 *   node backend/scripts/deployments.mjs logs    --name ember-coffee [--lines 200]
 *   node backend/scripts/deployments.mjs restart --name ember-coffee
 *   node backend/scripts/deployments.mjs stop    --name ember-coffee    # dunning-style stop
 *   node backend/scripts/deployments.mjs resume  --name ember-coffee
 *   node backend/scripts/deployments.mjs destroy --name ember-coffee --yes
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..');

for (const envPath of [path.join(backendRoot, '.env'), path.join(backendRoot, '..', '.env')]) {
  dotenv.config({ path: envPath, override: false });
}

const { openSqliteDb } = await import(path.join(backendRoot, 'dist', 'services', 'sqlite', 'sqlite-db.js'));
const { SqliteDeploymentStorage } = await import(path.join(backendRoot, 'dist', 'services', 'sqlite', 'sqlite-deployment-storage.js'));
const { InMemoryDeploymentStorage } = await import(path.join(backendRoot, 'dist', 'services', 'deployment-storage.js'));
const { DeploymentService, CloudflareAppsDns } = await import(path.join(backendRoot, 'dist', 'services', 'deployment-service.js'));
const { FlyClient } = await import(path.join(backendRoot, 'dist', 'services', 'fly-client.js'));
const { FlySandboxClient } = await import(path.join(backendRoot, 'dist', 'services', 'fly-sandbox-client.js'));
const { SshClient } = await import(path.join(backendRoot, 'dist', 'services', 'ssh-client.js'));

function decodeMultiline(value) {
  return value ? value.replace(/\\n/g, '\n') : value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env ${name}`);
    process.exit(1);
  }
  return value;
}

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
const storage = sqlitePath
  ? new SqliteDeploymentStorage(openSqliteDb(sqlitePath))
  : new InMemoryDeploymentStorage();
if (!sqlitePath) {
  console.warn('WARNING: no SQLITE_DB_PATH — using in-memory storage (records will not persist).');
}

function buildService() {
  const apiToken = requireEnv('FLY_API_TOKEN');
  const image = requireEnv('FLY_APP_RUNTIME_IMAGE');
  const sshPrivateKey = decodeMultiline(process.env.FLY_SSH_PRIVATE_KEY || process.env.HETZNER_SSH_PRIVATE_KEY);
  const sshPublicKey = decodeMultiline(process.env.FLY_SSH_PUBLIC_KEY || process.env.HETZNER_SSH_PUBLIC_KEY);
  const orgSlug = process.env.FLY_ORG || process.env.FLY_ORG_SLUG || 'personal';
  const region = process.env.FLY_REGION || 'ams';
  const dnsToken = process.env.CLOUDFLARE_APPS_DNS_TOKEN;
  const dnsZone = process.env.CLOUDFLARE_APPS_ZONE_ID;
  const sandboxClient = new FlySandboxClient({
    apiToken,
    orgSlug,
    region,
    machineImage: image, // unused for exec paths; required by the constructor
    sshPublicKey,
    sshPrivateKey,
    ...(process.env.FLY_BACKEND_PEER_IP ? { backendPeerIp: process.env.FLY_BACKEND_PEER_IP } : {}),
    sshClient: new SshClient(),
  });
  return new DeploymentService({
    fly: new FlyClient(apiToken),
    sandboxClient,
    storage,
    dns: dnsToken && dnsZone ? new CloudflareAppsDns(dnsToken, dnsZone) : null,
    orgSlug,
    region,
    image,
    appsDomain: process.env.APPS_DOMAIN || 'agentbuilt.app',
    // Same staging dir as the backend, so an operator `provision` picks up
    // content a CLI deploy staged while the record was pending-payment.
    stagingDir: process.env.DEPLOY_STAGING_DIR || '/var/lib/infinite-agents/deploy-staging',
    ...(sshPublicKey ? { authorizedKeys: sshPublicKey } : {}),
    ...(process.env.FLY_BACKEND_PEER_IP ? { backendPeerIp: process.env.FLY_BACKEND_PEER_IP } : {}),
  });
}

async function byNameOrExit(name) {
  if (!name) {
    console.error('--name is required');
    process.exit(1);
  }
  const doc = await storage.getByName(name);
  if (!doc) {
    console.error(`No deployment named "${name}"`);
    process.exit(1);
  }
  return doc;
}

switch (command) {
  case 'list': {
    const all = await storage.listAll();
    if (all.length === 0) console.log('(no deployments)');
    for (const d of all) {
      console.log(
        `${d.name.padEnd(24)} ${d.preset.padEnd(8)} ${d.status.padEnd(16)} `
        + `${(d.flyApp ?? '-').padEnd(18)} user=${d.userId} agent=${d.agentId} created=${d.createdAt}`,
      );
    }
    break;
  }
  case 'create': {
    const service = buildService();
    const doc = await service.createPending({
      userId: flag('user') ?? 'operator',
      agentId: flag('agent') ?? 'operator',
      name: flag('name') ?? '',
      preset: flag('preset') === 'service' ? 'service' : 'static',
    });
    console.log(`created ${doc.name} (${doc.id}) status=${doc.status}`);
    break;
  }
  case 'provision': {
    const doc = await byNameOrExit(flag('name'));
    const service = buildService();
    const { url } = await service.provision(doc.id);
    console.log(`live: ${url}`);
    break;
  }
  case 'sync': {
    const doc = await byNameOrExit(flag('name'));
    const dir = flag('dir');
    if (!dir) { console.error('--dir is required'); process.exit(1); }
    const tarball = execFileSync('tar', ['-C', dir, '-czf', '-', '.'], { maxBuffer: 200 * 1024 * 1024 });
    const service = buildService();
    await service.syncTarball(doc.id, tarball);
    console.log(`synced ${dir} → ${doc.name} (${Math.round(tarball.length / 1024)} kB)`);
    break;
  }
  case 'logs': {
    const doc = await byNameOrExit(flag('name'));
    const service = buildService();
    process.stdout.write(await service.readLogs(doc.id, Number(flag('lines') ?? 100)));
    break;
  }
  case 'restart': {
    const doc = await byNameOrExit(flag('name'));
    await buildService().restart(doc.id);
    console.log(`restarted ${doc.name}`);
    break;
  }
  case 'stop': {
    const doc = await byNameOrExit(flag('name'));
    await buildService().stopForLapse(doc.id);
    console.log(`stopped ${doc.name} (payment-lapsed)`);
    break;
  }
  case 'resume': {
    const doc = await byNameOrExit(flag('name'));
    await buildService().resume(doc.id);
    console.log(`resumed ${doc.name}`);
    break;
  }
  case 'destroy': {
    const doc = await byNameOrExit(flag('name'));
    if (!hasFlag('yes')) {
      console.error(`Refusing to destroy ${doc.name} without --yes`);
      process.exit(1);
    }
    await buildService().destroy(doc.id);
    console.log(`destroyed ${doc.name}`);
    break;
  }
  default:
    console.error('Usage: deployments.mjs list|create|provision|sync|logs|restart|stop|resume|destroy (see header)');
    process.exit(1);
}
process.exit(0);
