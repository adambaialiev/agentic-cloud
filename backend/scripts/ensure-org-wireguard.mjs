#!/usr/bin/env node
/**
 * Converge one org's WireGuard peer (byo-fly-design slice 4): register with
 * Fly if needed, persist (key as org secret, public half on the org doc),
 * write /etc/wireguard/<iface>.conf, bring the interface up, enable at boot.
 * `--remove` tears all of that down instead.
 *
 * Run ON the backend host from /opt/infinite-agents/current with backend.env
 * loaded (it shells to ip/wg-quick/systemctl as root):
 *
 *   node backend/scripts/ensure-org-wireguard.mjs --org <id>            # dry run
 *   node backend/scripts/ensure-org-wireguard.mjs --org <id> --apply
 *   node backend/scripts/ensure-org-wireguard.mjs --org <id> --remove
 *
 * Safe on org #0 by construction: its network is already routed by the legacy
 * peer, so ensure answers `route-conflict` and rolls the registration back
 * rather than fighting the route that carries the whole fleet's SSH.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
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

const dist = (rel) => new URL(path.join('..', 'dist', rel), import.meta.url);
const { openSqliteDb } = await import(dist('services/sqlite/sqlite-db.js'));
const { SqliteOrgStorage } = await import(dist('services/sqlite/sqlite-org-storage.js'));
const { SqliteSecretStorage } = await import(dist('services/sqlite/sqlite-secret-storage.js'));
const { EncryptedSecretStorage } = await import(dist('services/encrypted-secret-storage.js'));
const { secretCipherFromEnv } = await import(dist('services/secret-cipher.js'));
const { OrgSecretsService } = await import(dist('services/org-secrets.js'));
const { OrgFlyService } = await import(dist('services/org-fly.js'));
const { OrgWireGuardService, orgWireGuardInterfaceName } = await import(dist('services/org-wireguard.js'));

const apply = process.argv.includes('--apply');
const remove = process.argv.includes('--remove');
const orgFlagIndex = process.argv.indexOf('--org');
const orgId = orgFlagIndex >= 0 ? process.argv[orgFlagIndex + 1] : undefined;
if (!orgId) {
  console.error('Usage: ensure-org-wireguard.mjs --org <id> [--apply | --remove]');
  process.exit(1);
}
const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
const cipher = secretCipherFromEnv();
if (!sqlitePath || !cipher) {
  console.error('Need SQLITE_DB_PATH and SECRETS_MASTER_KEY (run on the backend host with backend.env loaded).');
  process.exit(1);
}

const db = openSqliteDb(sqlitePath);
const orgStorage = new SqliteOrgStorage(db);
const orgSecrets = new OrgSecretsService(new EncryptedSecretStorage(new SqliteSecretStorage(db), cipher));
const orgFly = new OrgFlyService({ orgStorage, orgSecrets });

const exec = (argv, opts = {}) => new Promise((resolve) => {
  const child = execFile(argv[0], argv.slice(1), (error, stdout, stderr) => {
    resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? (error.code ?? 1) : 0 });
  });
  if (opts.stdin !== undefined) {
    child.stdin.end(opts.stdin);
  } else {
    child.stdin.end();
  }
});

const service = new OrgWireGuardService({ orgStorage, orgSecrets, orgFly, exec });

const org = await orgStorage.getOrg(orgId);
if (!org) {
  console.error(`No org with id ${orgId}.`);
  process.exit(1);
}
console.log(`org:       ${org.name} (${org.orgId})`);
console.log(`fly org:   ${org.fly?.orgSlug ?? '(not connected)'}`);
console.log(`interface: ${orgWireGuardInterfaceName(org.orgId)}`);
console.log(`peer:      ${org.fly?.wireguard ? `${org.fly.wireguard.peerName} @ ${org.fly.wireguard.peerIp}` : '(none registered)'}`);

if (remove) {
  await service.removeOrgWireGuard(org.orgId);
  console.log('\nRemoved: interface down + disabled, conf deleted, Fly peer removed, key deleted.');
  process.exit(0);
}
if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply (or --remove).');
  process.exit(0);
}

const result = await service.ensureOrgWireGuard(org.orgId);
if (result.status === 'route-conflict') {
  console.log(`\nROUTE CONFLICT — not brought up. ${result.network} is already routed: ${result.detail}`);
  console.log('(Expected for org #0: the legacy peer already carries that network.)');
  process.exit(0);
}
console.log(`\nUp: ${result.interfaceName} @ ${result.peerIp}, enabled across reboots.`);
