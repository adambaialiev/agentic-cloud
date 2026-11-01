#!/usr/bin/env node
/**
 * BYO-Fly end-to-end rehearsal (byo-fly-design slice 4 part 4). Runs ON the
 * backend host from /opt/infinite-agents/current with backend.env loaded.
 *
 *   node /root/e2e-byo-fly.mjs setup      # scratch org+member+user rows, connectOrgFly
 *   (then: node backend/scripts/ensure-org-wireguard.mjs --org <id> --apply)
 *   node /root/e2e-byo-fly.mjs provision  # real-path machine in the scratch org + exec proof
 *   node /root/e2e-byo-fly.mjs teardown   # destroy machine, remove rows + secrets
 *
 * setup reads the scratch org token from /root/.scratch-org-token (0600) and
 * never prints it; after setup it lives only in the encrypted org-secret store.
 */
import path from 'node:path';
import process from 'node:process';
import { readFileSync, rmSync, existsSync } from 'node:fs';

// Env arrives from the invoking shell (`set -a; . backend.env`).
const CURRENT = '/opt/infinite-agents/current';
// Same normalization index.ts applies: backend.env stores \n-encoded keys.
const decodeMultilineEnv = (value) => (value || '').replace(/\\n/g, '\n');
const SSH_PUBLIC_KEY = decodeMultilineEnv(process.env.FLY_SSH_PUBLIC_KEY) || decodeMultilineEnv(process.env.HETZNER_SSH_PUBLIC_KEY);
const SSH_PRIVATE_KEY = decodeMultilineEnv(process.env.FLY_SSH_PRIVATE_KEY) || decodeMultilineEnv(process.env.HETZNER_SSH_PRIVATE_KEY);
const SSH_PASSPHRASE = process.env.FLY_SSH_PASSPHRASE || process.env.HETZNER_SSH_PASSPHRASE || '';
const dist = (rel) => path.join(CURRENT, 'dist', rel);
const { openSqliteDb } = await import(dist('services/sqlite/sqlite-db.js'));
const { SqliteOrgStorage } = await import(dist('services/sqlite/sqlite-org-storage.js'));
const { SqliteUserStorage } = await import(dist('services/sqlite/sqlite-user-storage.js'));
const { SqliteDeploymentStorage } = await import(dist('services/sqlite/sqlite-deployment-storage.js'));
const { SqliteSecretStorage } = await import(dist('services/sqlite/sqlite-secret-storage.js'));
const { EncryptedSecretStorage } = await import(dist('services/encrypted-secret-storage.js'));
const { secretCipherFromEnv } = await import(dist('services/secret-cipher.js'));
const { OrgSecretsService } = await import(dist('services/org-secrets.js'));
const { OrgFlyService } = await import(dist('services/org-fly.js'));
const { FlyAppOrgContextResolver } = await import(dist('services/fly-app-org-context.js'));
const { FlySandboxClient } = await import(dist('services/fly-sandbox-client.js'));

const SCRATCH_ORG_NAME = 'Scratch client (BYO-Fly E2E)';
const SCRATCH_SLUG = 'ia-scratch-client';
const SCRATCH_USER = 'u_e2e_scratch';
const SCRATCH_AGENT = 'a_e2e_scratch';
const TOKEN_FILE = '/root/.scratch-org-token';

const mode = process.argv[2];
const sqlitePath = process.env.SQLITE_DB_PATH?.trim();
const cipher = secretCipherFromEnv();
if (!sqlitePath || !cipher) {
  console.error('Need SQLITE_DB_PATH and SECRETS_MASTER_KEY.');
  process.exit(1);
}
const db = openSqliteDb(sqlitePath);
const orgStorage = new SqliteOrgStorage(db);
const userStorage = new SqliteUserStorage(db);
const orgSecrets = new OrgSecretsService(new EncryptedSecretStorage(new SqliteSecretStorage(db), cipher));
const orgFly = new OrgFlyService({ orgStorage, orgSecrets });

async function scratchOrg() {
  const orgs = await orgStorage.listOrgs();
  return orgs.find((org) => org.name === SCRATCH_ORG_NAME) ?? null;
}

if (mode === 'setup') {
  if (!existsSync(TOKEN_FILE)) {
    console.error(`${TOKEN_FILE} missing — pipe the token there first.`);
    process.exit(1);
  }
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  let org = await scratchOrg();
  if (!org) {
    org = await orgStorage.createOrg({ name: SCRATCH_ORG_NAME, createdByUserId: SCRATCH_USER });
    await orgStorage.addMember({ orgId: org.orgId, userId: SCRATCH_USER, role: 'admin' });
    await userStorage.createProfile(SCRATCH_USER, {
      email: 'e2e-scratch@invalid.test',
      telegram: {
        agents: {
          [SCRATCH_AGENT]: { id: SCRATCH_AGENT, cli: 'claude', name: 'E2E scratch', createdAt: new Date().toISOString() },
        },
      },
    });
  }
  const connected = await orgFly.connectOrgFly({ orgId: org.orgId, orgSlug: SCRATCH_SLUG, token });
  rmSync(TOKEN_FILE);
  console.log(`org: ${org.orgId}`);
  console.log(`connected: ${connected.orgSlug} (${connected.appCount} apps), token in org-secret store, token file deleted`);
  console.log(`next: node ${CURRENT}/backend/scripts/ensure-org-wireguard.mjs --org ${org.orgId} --apply`);
  process.exit(0);
}

if (mode === 'provision') {
  const org = await scratchOrg();
  if (!org?.fly?.wireguard) {
    console.error('Scratch org missing or has no WireGuard peer yet — run setup + ensure-org-wireguard first.');
    process.exit(1);
  }
  const resolver = new FlyAppOrgContextResolver({
    userStorage,
    deploymentStorage: new SqliteDeploymentStorage(db),
    orgStorage,
    orgFly,
  });
  const sandbox = new FlySandboxClient({
    apiToken: process.env.FLY_API_TOKEN,
    orgSlug: process.env.FLY_ORG,
    machineImage: process.env.FLY_MACHINE_IMAGE,
    region: process.env.FLY_REGION || 'ams',
    sshPublicKey: SSH_PUBLIC_KEY,
    sshPrivateKey: SSH_PRIVATE_KEY,
    ...(SSH_PASSPHRASE ? { sshPassphrase: SSH_PASSPHRASE } : {}),
    ...(process.env.FLY_BACKEND_PEER_IP ? { backendPeerIp: process.env.FLY_BACKEND_PEER_IP } : {}),
    volumeSizeGb: 1,
    resolveAppContext: (appName) => resolver.resolve(appName),
  });

  console.log('provisioning through the real path (resolver decides the org)…');
  const created = await sandbox.createAgentSandbox({
    name: 'E2E scratch',
    onAppNamed: async (appName) => {
      await userStorage.updateAgentFields(SCRATCH_USER, SCRATCH_AGENT, { provisioningAppName: appName });
      console.log(`onAppNamed: ${appName} claimed by ${SCRATCH_AGENT}`);
    },
  });
  await userStorage.updateAgentFields(SCRATCH_USER, SCRATCH_AGENT, {
    serverId: `fly_${created.appName}.${created.machineId}`,
    connectedAt: new Date().toISOString(),
  });
  console.log(`created: app=${created.appName} machine=${created.machineId} region=${created.region}`);

  const result = await sandbox.execSync(created.sandboxId, 'hostname && cat /etc/os-release | head -1 && echo E2E-OK', undefined, { timeoutMs: 30_000 });
  console.log(`exec over the scratch-org peer: exit=${result.exitCode}`);
  console.log(result.stdout.trim());
  if (result.exitCode !== 0 || !result.stdout.includes('E2E-OK')) {
    console.error('EXEC PROOF FAILED');
    process.exit(1);
  }
  console.log('\nEND-TO-END PROOF COMPLETE — machine lives in the client org, reached over its own peer.');
  process.exit(0);
}

if (mode === 'teardown') {
  const org = await scratchOrg();
  if (!org) {
    console.log('no scratch org — nothing to tear down');
    process.exit(0);
  }
  const profile = await userStorage.getProfile(SCRATCH_USER);
  const agent = profile?.telegram?.agents?.[SCRATCH_AGENT];
  const serverId = agent?.serverId;
  if (serverId?.startsWith('fly_')) {
    const resolver = new FlyAppOrgContextResolver({
      userStorage,
      deploymentStorage: new SqliteDeploymentStorage(db),
      orgStorage,
      orgFly,
    });
    const sandbox = new FlySandboxClient({
      apiToken: process.env.FLY_API_TOKEN,
      orgSlug: process.env.FLY_ORG,
      machineImage: process.env.FLY_MACHINE_IMAGE,
      sshPrivateKey: SSH_PRIVATE_KEY,
      ...(SSH_PASSPHRASE ? { sshPassphrase: SSH_PASSPHRASE } : {}),
      resolveAppContext: (appName) => resolver.resolve(appName),
    });
    const sandboxId = `fly-sandbox-${serverId.slice('fly_'.length)}`;
    await sandbox.destroySandbox(sandboxId);
    console.log(`destroyed ${sandboxId} (machine + volume + app, in the scratch org)`);
  }
  // WG peer removal is a separate, existing verb — run it BEFORE this:
  //   node backend/scripts/ensure-org-wireguard.mjs --org <id> --remove
  if (org.fly?.wireguard) {
    console.error('Peer still present — run ensure-org-wireguard --remove first.');
    process.exit(1);
  }
  await orgSecrets.deleteOrgSecret(org.orgId, 'FLY_ORG_TOKEN');
  await orgStorage.removeMember(org.orgId, SCRATCH_USER);
  db.prepare('DELETE FROM orgs WHERE org_id = ?').run(org.orgId);
  db.prepare('DELETE FROM users WHERE user_id = ?').run(SCRATCH_USER);
  console.log('scratch org record, membership, user, and secrets removed. Fly-side org remains for future rehearsals.');
  process.exit(0);
}

console.error('Usage: e2e-byo-fly.mjs <setup|provision|teardown>');
process.exit(1);
