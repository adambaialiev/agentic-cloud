/**
 * The installer's tests: install, upgrade (with its rollback and drill), and
 * the parts they are made of. flyctl, Fly's API, the update service and the
 * domain's name servers are fakes here, so nothing is created anywhere.
 *
 *   node --test test/
 */
import { afterEach, before, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { expect } from './expect.mjs';

const INSTALLER = path.resolve(import.meta.dirname, '../install.mjs');
// Licensing ships OFF (the product is free for now). Most tests below were
// written with it on and still prove that path; the 'licensing off' tests
// at the end switch it off for themselves.
process.env.COPY_LICENCE = 'on';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let installer;

before(async () => {
  installer = await import(/* @vite-ignore */ pathToFileURL(INSTALLER).href);
});

const DOMAIN = 'agents.theirco.test';
const keyText = (payload) => `acc1.${Buffer.from(JSON.stringify({
  kind: 'update', id: 'k1', customer: 'theirco', domain: DOMAIN, updatesUntil: '2027-10-27', ...payload,
})).toString('base64url')}.c2lnbmF0dXJl`;
// The installer reads only who a licence is for; the copy checks the signature.
const LICENCE = `acc1.${Buffer.from(JSON.stringify({
  kind: 'licence', id: 'l1', customer: 'theirco', domain: DOMAIN, people: 50, starts: '2026-10-27', ends: '2027-10-26', updatesUntil: '2027-10-26', issuedAt: '2026-10-27T12:00:00Z',
})).toString('base64url')}.c2lnbmF0dXJl`;
const TAGS = Object.fromEntries(['backend', 'git-host', 'msg-host', 'router', 'mx', 'machine', 'app-runtime'].map((name) => [name, `${name}-2026.10.27.1`]));

/** A resolver as node:dns hands one out, answering from a zone of records. */
function fakeResolver(zone) {
  const find = (name, type) => zone().filter((record) => record.type === type && (
    record.name === name || (record.name.startsWith('*.') && name.endsWith(record.name.slice(1)))));
  const answer = (type, map) => (name, done) => {
    const found = find(name, type);
    if (found.length) done(null, found.map(map));
    else done(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  };
  return {
    resolve4: answer('A', (r) => r.value),
    resolve6: answer('AAAA', (r) => r.value),
    resolveCname: answer('CNAME', (r) => r.value),
    resolveMx: answer('MX', (r) => ({ priority: r.priority, exchange: r.value })),
    resolveTxt: answer('TXT', (r) => [r.value.slice(0, 10), r.value.slice(10)]),
  };
}

/** flyctl and Fly as the installer sees them: apps, buckets, secrets,
 *  addresses, deploys and certificates, each remembered. */
function fakeFly({ failOnce, stuckCert } = {}) {
  const calls = [];
  const apps = new Set();
  const ips = new Map();
  const certs = new Map();
  const ready = new Set();
  const secrets = {};
  const deploys = [];
  let mxRestarts = 0;
  let failed = false;
  // The backend's database, as far as sqlite3 over `fly ssh` touches it.
  let db = {};
  let snapshot = {};
  const sql = [];
  const volumeSnapshots = [];
  let next = 1;
  // The backend machine's private address; a test moves it.
  let backendIp = 'fdaa:0:1::2';
  const peers = [{ Name: 'interactive-up1-abc-tokens-fly-io-01' }, { Name: 'interactive-someoneelse-1' }];
  const fly = async (args, opts = {}) => {
    calls.push(args);
    const [a, b] = args;
    const flag = (name) => args[args.indexOf(name) + 1];
    if (failOnce && !failed && args.join(' ').includes(failOnce)) { failed = true; throw new Error(`fly ${a} ${b}: the network went away`); }
    if (a === 'apps' && b === 'list') return JSON.stringify([...apps].map((name) => ({ Name: name })));
    if (a === 'orgs' && b === 'list') return JSON.stringify({ 'theirco-org': 'TheirCo', personal: 'Someone' });
    if (a === 'apps' && b === 'create') { apps.add(args[2]); return ''; }
    if (a === 'apps' && b === 'restart') { mxRestarts += 1; ready.add('mx'); return ''; }
    if (a === 'storage') {
      const name = flag('-n');
      return `Your Tigris project (${name}) is ready.\n\nSet one or more of the following secrets on your target app.\nAWS_ENDPOINT_URL_S3: https://fly.storage.tigris.dev\nAWS_REGION: auto\nBUCKET_NAME: ${name}\nAWS_ACCESS_KEY_ID: tid_${name}\nAWS_SECRET_ACCESS_KEY: tsec_${name}\n`;
    }
    if (a === 'tokens') throw new Error('fly tokens create: Not authorized to access this createlimitedaccesstoken');
    if (a === 'secrets') {
      const values = Object.fromEntries(String(opts.input).trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      (secrets[flag('-a')] ??= []).push({ staged: args.includes('--stage'), values });
      return '';
    }
    if (a === 'ips' && b === 'list') return JSON.stringify(ips.get(flag('-a')) ?? []);
    if (a === 'ips' && b === 'allocate-v4') {
      const app = flag('-a');
      ips.set(app, [...(ips.get(app) ?? []), { Type: args.includes('--shared') ? 'shared_v4' : 'v4', Address: `203.0.113.${next++}` }]);
      return '';
    }
    if (a === 'ips' && b === 'allocate-v6') {
      const app = flag('-a');
      ips.set(app, [...(ips.get(app) ?? []), { Type: 'v6', Address: `2001:db8::${next++}` }]);
      return '';
    }
    if (a === 'deploy') {
      const toml = readFileSync(flag('--config'), 'utf8');
      deploys.push({ app: flag('--app'), image: flag('--image'), toml });
      // A backend that listens where the health check does not look never turns healthy.
      if (toml.includes('PORT = "8081"')) throw new Error('fly deploy: machine m1 failed to reach a healthy state: 1 of 1 checks failing');
      return '';
    }
    if (a === 'wireguard' && b === 'list') return JSON.stringify(peers);
    if (a === 'wireguard' && b === 'remove') { peers.splice(peers.findIndex((p) => p.Name === args[3]), 1); return ''; }
    if (a === 'machine') return JSON.stringify([{ id: 'm1', private_ip: backendIp }]);
    if (a === 'ssh') {
      const command = flag('-C');
      sql.push(command);
      if (command.includes('.backup')) snapshot = { ...db };
      if (command.includes('.restore')) db = { ...snapshot };
      if (command.includes('CREATE TABLE IF NOT EXISTS upgrade_drill')) db.drill = true;
      if (command.includes('sqlite_master')) return `${db.drill ? 1 : 0}\n`;
      if (command.includes('integrity_check')) return 'ok\n';
      return '';
    }
    if (a === 'volumes' && b === 'list') return JSON.stringify([{ id: `vol_${flag('-a')}` }]);
    if (a === 'volumes' && b === 'snapshots') { volumeSnapshots.push(args[3]); return ''; }
    if (a === 'certs' && b === 'list') return JSON.stringify([...(certs.get(flag('-a')) ?? [])].map((hostname) => ({ hostname })));
    if (a === 'certs' && b === 'add') { const app = flag('-a'); certs.set(app, new Set([...(certs.get(app) ?? []), args[2]])); return ''; }
    if (a === 'certs' && b === 'check') { if (args[2] !== stuckCert) ready.add(args[2]); return ''; }
    if (a === 'certs' && b === 'show') {
      return JSON.stringify({
        hostname: args[2], status: ready.has(args[2]) ? 'Ready' : 'Awaiting configuration',
        // Fly names a DNS-validation target for every certificate, the wildcard's and the others'.
        dns_requirements: { acme_challenge: { name: `_acme-challenge.${args[2].replace(/^\*\./, '')}`, target: `${args[2].replace(/^\*\./, '')}.x1y2z3.flydns.net.` } },
      });
    }
    throw new Error(`unexpected fly ${args.join(' ')}`);
  };
  return { fly, calls, apps, ips, secrets, deploys, ready, sql, volumeSnapshots, peers, db: () => db, mxRestarts: () => mxRestarts, moveBackend: (ip) => { backendIp = ip; } };
}

function harness({ billing = 'CURRENT', failOnce, stuckCert, dnsNever = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'copy-install-'));
  const keyFile = path.join(dir, 'update.key');
  writeFileSync(keyFile, `${keyText({})}\n`);
  const licenceFile = path.join(dir, 'licence.txt');
  writeFileSync(licenceFile, `${LICENCE}\n`);
  const flyFake = fakeFly({ failOnce, stuckCert });
  const lines = [];
  let dnsAdded = false;
  const zone = () => {
    if (!dnsAdded) return [];
    const ipsOf = (app) => flyFake.ips.get(app) ?? [];
    return installer.dnsRecords({
      domain: DOMAIN,
      names: installer.namesFor('theirco'),
      backendV4: ipsOf('theirco-backend').find((ip) => ip.Type === 'shared_v4').Address,
      backendV6: ipsOf('theirco-backend').find((ip) => ip.Type === 'v6').Address,
      acmeTarget: `${DOMAIN}.x1y2z3.flydns.net`,
      gitAcmeTarget: `git.${DOMAIN}.x1y2z3.flydns.net`,
    });
  };
  const fetchImpl = async (url) => {
    if (url === 'https://api.fly.io/graphql') {
      return new Response(JSON.stringify({ data: { organization: { slug: 'theirco-org', name: 'TheirCo', billable: true, billingStatus: billing }, nearestRegion: { code: 'fra' } } }));
    }
    if (url.endsWith('/api/health')) return new Response(JSON.stringify({ status: 'ok' }));
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, starttls: flyFake.ready.has('mx') }));
    throw new Error(`unexpected fetch ${url}`);
  };
  const copied = [];
  const deps = {
    token: 'FlyV1 their-org-token',
    flyctl: '/usr/bin/fly',
    fly: flyFake.fly,
    fetchImpl,
    pollMs: 1,
    settleMs: 0,
    say: (line) => {
      lines.push(line);
      if (line.includes('Add these') && !dnsNever) dnsAdded = true;
    },
    updatesSource: () => ({ release: async () => ({ version: '2026.10.27.1', commit: 'abc123', images: {} }) }),
    flyRegistry: ({ app }) => ({ app }),
    copyRelease: async ({ dest, version }) => {
      copied.push(`${dest.app} ${version}`);
      return { release: { version, commit: `c-${version}` }, copied: Object.fromEntries(Object.keys(TAGS).map((name) => [name, { tag: `${name}-${version}`, digest: 'sha256:x' }])) };
    },
    authoritativeResolver: async () => ({ zone: 'theirco.test', resolver: fakeResolver(zone) }),
    smokeTest: async () => [{ what: 'everything', ok: true, detail: 'fine' }],
  };
  const options = { org: 'theirco-org', domain: DOMAIN, 'key-file': keyFile, 'licence-file': licenceFile, state: path.join(dir, 'theirco-copy.json'), 'contact-email': 'it@theirco.test', 'contact-name': 'Theirco IT' };
  return {
    dir, options, deps, fly: flyFake, lines, copied, stateText: () => readFileSync(options.state, 'utf8'), addDns: () => { dnsAdded = true; },
  };
}

describe('the installer: one command, an organization and a domain', () => {
  it('builds the whole of it in order, from its own registry', async () => {
    const h = harness();
    const state = await installer.install(h.options, h.deps);
    const verbs = h.fly.calls.map((args) => args.slice(0, 2).join(' '));
    // Everything named before anything is stored, stored before it starts.
    expect(verbs.indexOf('apps create')).toBeLessThan(verbs.indexOf('storage create'));
    expect(verbs.lastIndexOf('secrets import')).toBeLessThan(verbs.indexOf('deploy --config'));
    // No mail receiver: email is set up later, from the Workspace (note #946).
    expect([...h.fly.apps].sort()).toEqual(['theirco-backend', 'theirco-git', 'theirco-images', 'theirco-router']);
    expect(h.copied).toEqual(['theirco-images 2026.10.27.1']);

    // Three apps, then the backend again with its own private address.
    expect(h.fly.deploys.map((d) => d.app)).toEqual(['theirco-backend', 'theirco-git', 'theirco-router', 'theirco-backend']);
    expect(h.fly.deploys[0].image).toBe('registry.fly.io/theirco-images:backend-2026.10.27.1');
    expect(h.fly.deploys[0].toml).not.toContain('FLY_BACKEND_PEER_IP');
    expect(h.fly.deploys[3].toml).toContain('FLY_BACKEND_PEER_IP = "fdaa:0:1::2"');
    const backendToml = h.fly.deploys[3].toml;
    for (const line of [
      'FLY_MACHINE_IMAGE = "registry.fly.io/theirco-images:machine-2026.10.27.1"',
      'FLY_IMAGE_APP = "theirco-images"',
      `WORKSPACE_URL = "https://${DOMAIN}"`,
      `GIT_HOST_BASE_URL = "https://git.${DOMAIN}"`,
      `MAIL_DOMAIN = "${DOMAIN}"`,
      'PRIVATE_COPY = "1"',
      'FLY_REGION = "fra"',
      // The image the Workspace starts the mail receiver from, when an admin sets email up.
      'FLY_MX_IMAGE = "registry.fly.io/theirco-images:mx-2026.10.27.1"',
    ]) expect(backendToml).toContain(line);
    expect(h.fly.deploys.some((d) => d.toml.includes('proxy_proto'))).toBe(false);

    // The keys: staged before the first deploy, shared where they must match.
    const backend = h.fly.secrets['theirco-backend'][0];
    expect(backend.staged).toBe(true);
    expect(backend.values.FLY_API_TOKEN).toBe('FlyV1 their-org-token');
    expect(backend.values.FLY_SSH_PRIVATE_KEY).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\\n.*\\n-----END OPENSSH PRIVATE KEY-----\\n$/);
    expect(backend.values.MEDIA_S3_BUCKET).toBe('theirco-media');
    expect(backend.values.BACKUP_S3_BUCKET).toBe('theirco-backups');
    expect(backend.values.FIRST_ACCOUNT_CODE.length).toBeGreaterThanOrEqual(16);
    expect(backend.values.LICENCE).toBe(LICENCE);
    expect(h.fly.deploys[0].toml).toContain('COPY_LICENCE = "on"');
    expect(h.fly.secrets['theirco-git'][0].values).toEqual({ GIT_HOST_SECRET: backend.values.GIT_HOST_SECRET, CI_WEBHOOK_SECRET: backend.values.GIT_HOST_SECRET });
    // The backend keeps the secret its mail receiver will present, once there is one.
    expect(backend.values.MAIL_INGEST_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(h.fly.secrets['theirco-mx']).toBeUndefined();

    // No dedicated address (mail's $2 a month), and nothing restarted for it.
    expect(h.fly.ips.get('theirco-mx')).toBeUndefined();
    expect([...h.fly.ips.values()].flat().some((ip) => ip.Type === 'v4')).toBe(false);
    expect(h.fly.mxRestarts()).toBe(0);

    // The records are printed, and the two things the admin needs come once.
    const out = h.lines.join('\n');
    expect(out).toContain(`*.${DOMAIN}`);
    expect(out).toContain(`_acme-challenge.${DOMAIN}`);
    expect(out).toContain(`https://${DOMAIN}/signup#first-account=${backend.values.FIRST_ACCOUNT_CODE}`);
    expect(out).toContain(`Master key:       ${backend.values.SECRETS_MASTER_KEY}`);
    expect(out).toContain('Email:            not set up yet. An admin sets it up in the Workspace, under Mail');
    for (const mail of [`mx.${DOMAIN}`, '_dmarc.', ' MX ']) expect(out).not.toContain(mail);
    // What stays on the engineer's disk holds names and addresses, never a key.
    const kept = h.stateText();
    for (const value of Object.values(backend.values)) expect(kept).not.toContain(value);
    expect(Object.keys(state.steps)).toEqual(['apps', 'release', 'buckets', 'keys', 'secrets', 'addresses', 'deploy', 'certificates', 'dns', 'smoke']);
    expect(state.mxV4).toBeUndefined();
  });

  it('run again, makes nothing twice and shows the master key never again', async () => {
    const h = harness();
    await installer.install(h.options, h.deps);
    const before = h.fly.calls.length;
    h.lines.length = 0;
    await installer.install(h.options, h.deps);
    const again = h.fly.calls.slice(before).map((args) => args.slice(0, 2).join(' '));
    expect(again).toEqual([]);
    expect(h.lines.filter((line) => line.includes('done before'))).toHaveLength(10);
    expect(h.lines.join('\n')).not.toContain('Master key');
  });

  it('carries on from where it stopped, with the same keys', async () => {
    const h = harness({ failOnce: '--app theirco-router' });
    await expect(installer.install(h.options, h.deps)).rejects.toThrow('the network went away');
    const firstSecrets = h.fly.secrets['theirco-backend'][0].values;
    const stopped = JSON.parse(h.stateText());
    expect(stopped.steps.deploy).toBeUndefined();
    expect(stopped.steps.secrets).toBeDefined();
    const before = h.fly.calls.length;
    await installer.install(h.options, h.deps);
    const again = h.fly.calls.slice(before).map((args) => args.slice(0, 2).join(' '));
    expect(again).not.toContain('apps create');
    expect(again).not.toContain('storage create');
    expect(again).not.toContain('secrets import');
    expect(h.fly.secrets['theirco-backend']).toHaveLength(1);
    expect(h.lines.join('\n')).toContain(`Master key:       ${firstSecrets.SECRETS_MASTER_KEY}`);
  });

  it('stops before making anything when the organization\'s bill is not paid', async () => {
    const h = harness({ billing: 'PAST_DUE' });
    await expect(installer.install(h.options, h.deps)).rejects.toThrow(/bill is not paid \(past due\).*fly\.io\/dashboard\/theirco-org\/billing/);
    expect(h.fly.calls).toEqual([]);
  });

  it('refuses an update key issued for another domain', async () => {
    const h = harness();
    writeFileSync(h.options['key-file'], keyText({ domain: 'agents.other.test' }));
    await expect(installer.install(h.options, h.deps)).rejects.toThrow('issued for agents.other.test, not agents.theirco.test');
    expect(h.fly.calls).toEqual([]);
  });
});

/** A finished install, then the upgrade's own fakes: a newer release and a
 *  smoke test that can be told to fail on it. */
async function installed({ failNew = false } = {}) {
  const h = harness();
  await installer.install(h.options, h.deps);
  h.lines.length = 0;
  const backendImage = () => h.fly.deploys.filter((d) => d.app === 'theirco-backend').at(-1).image;
  const deps = {
    ...h.deps,
    updatesSource: () => ({ release: async () => ({ version: '2026.10.28.1', commit: 'def456', images: {} }) }),
    smokeTest: async () => [{ what: 'everything', ok: !(failNew && backendImage().endsWith('2026.10.28.1')), detail: 'checked' }],
  };
  return { ...h, deps, before: h.fly.deploys.length, backendImage };
}

describe('upgrades with a way back', () => {
  it('snapshots the database, then rolls each app to the new release', async () => {
    const h = await installed();
    const state = await installer.upgrade(h.options, h.deps);
    const rolled = h.fly.deploys.slice(h.before);
    expect(rolled.map((d) => `${d.app} ${d.image.split(':')[1]}`)).toEqual([
      'theirco-backend backend-2026.10.28.1', 'theirco-git git-host-2026.10.28.1', 'theirco-router router-2026.10.28.1',
    ]);
    expect(rolled[0].toml).toContain('COPY_RELEASE = "2026.10.28.1"');
    expect(rolled[0].toml).toContain('FLY_BACKEND_PEER_IP = "fdaa:0:1::2"');
    // The snapshot comes before the first app moves, and is checked.
    const verbs = h.fly.calls.map((args) => args.slice(0, 2).join(' '));
    expect(verbs.lastIndexOf('ssh console')).toBeLessThan(verbs.lastIndexOf('deploy --config'));
    expect(h.fly.sql.some((c) => c.includes('.backup /data/pre-upgrade-2026.10.27.1.db'))).toBe(true);
    expect(h.fly.sql.some((c) => c.includes('integrity_check'))).toBe(true);
    expect(h.fly.volumeSnapshots).toEqual(['vol_theirco-backend', 'vol_theirco-git']);
    expect(state.release.version).toBe('2026.10.28.1');
    expect(state.previous.version).toBe('2026.10.27.1');
    expect(state.upgrade).toBeUndefined();
    expect(JSON.parse(h.stateText()).release.version).toBe('2026.10.28.1');
  });

  it('gives the backend its address as it is now, when Fly has moved it', async () => {
    const h = await installed();
    h.fly.moveBackend('fdaa:0:1::9');
    const state = await installer.upgrade(h.options, h.deps);
    expect(h.fly.deploys.slice(h.before)[0].toml).toContain('FLY_BACKEND_PEER_IP = "fdaa:0:1::9"');
    expect(state.peerIp).toBe('fdaa:0:1::9');
    expect(h.lines.join('\n')).toContain('The backend\'s private address is now fdaa:0:1::9 (was fdaa:0:1::2).');
  });

  it('rolls everything back to the snapshot when the new release fails its smoke test', async () => {
    const h = await installed({ failNew: true });
    await expect(installer.upgrade(h.options, h.deps)).rejects.toThrow('The upgrade to 2026.10.28.1 failed and agents.theirco.test is back on 2026.10.27.1');
    const rolled = h.fly.deploys.slice(h.before).map((d) => `${d.app} ${d.image.split('-').pop()}`);
    expect(rolled).toEqual([
      'theirco-backend 2026.10.28.1', 'theirco-git 2026.10.28.1', 'theirco-router 2026.10.28.1',
      'theirco-backend 2026.10.27.1', 'theirco-git 2026.10.27.1', 'theirco-router 2026.10.27.1',
    ]);
    expect(h.fly.sql.some((c) => c.includes('.restore /data/pre-upgrade-2026.10.27.1.db'))).toBe(true);
    expect(h.fly.calls.some((args) => args.join(' ') === 'apps restart theirco-backend')).toBe(true);
    const kept = JSON.parse(h.stateText());
    expect(kept.release.version).toBe('2026.10.27.1');
    expect(kept.upgrade).toBeUndefined();
  });

  it('rehearses a rollback with --drill and proves the database is the snapshot', async () => {
    const h = await installed();
    await installer.upgrade({ ...h.options, drill: true }, h.deps);
    expect(h.fly.sql.some((c) => c.includes('INSERT INTO upgrade_drill'))).toBe(true);
    expect(h.fly.db().drill).toBeUndefined();
    const out = h.lines.join('\n');
    expect(out).toContain('The drill\'s mark, written after the snapshot, is gone');
    expect(out).toContain('Drill done');
    expect(JSON.parse(h.stateText()).release.version).toBe('2026.10.27.1');
  });

  it('says so and does nothing when it already runs the release', async () => {
    const h = await installed();
    const before = h.fly.calls.length;
    await installer.upgrade(h.options, { ...h.deps, updatesSource: () => ({ release: async () => ({ version: '2026.10.27.1', images: {} }) }) });
    expect(h.fly.calls.length).toBe(before);
    expect(h.lines.join('\n')).toContain('already runs release 2026.10.27.1');
  });

  it('carries on after an interruption with the snapshot it already took', async () => {
    const h = await installed();
    const kept = JSON.parse(h.stateText());
    // Stopped after the snapshot, before any app moved.
    kept.upgrade = {
      from: kept.release, toVersion: '2026.10.28.1', startedAt: '2026-10-28T09:00:00Z',
      to: { version: '2026.10.28.1', commit: 'def456', tags: Object.fromEntries(Object.keys(TAGS).map((name) => [name, `${name}-2026.10.28.1`])) },
      snapshot: { file: '/data/pre-upgrade-2026.10.27.1.db', at: '2026-10-28T09:01:00Z' },
    };
    writeFileSync(h.options.state, JSON.stringify(kept));
    await installer.upgrade(h.options, h.deps);
    expect(h.fly.sql.some((c) => c.includes('.backup'))).toBe(false);
    expect(h.backendImage()).toBe('registry.fly.io/theirco-images:backend-2026.10.28.1');
    expect(h.lines.join('\n')).toContain('Carrying on with the upgrade from 2026.10.27.1 to 2026.10.28.1');
  });
});

describe('the installer and the licence', () => {
  it('will not install without a licence, or with one for another domain', async () => {
    const h = harness();
    const { 'licence-file': _licence, ...without } = h.options;
    await expect(installer.install(without, h.deps)).rejects.toThrow('Your own Agentic Cloud needs its licence: --licence-file <file>');
    writeFileSync(h.options['licence-file'], LICENCE.replace(/^acc1\.[^.]+/, `acc1.${Buffer.from(JSON.stringify({ kind: 'licence', domain: 'agents.other.test' })).toString('base64url')}`));
    await expect(installer.install(h.options, h.deps)).rejects.toThrow('This licence was issued for agents.other.test');
    expect(h.fly.calls).toEqual([]);
  });

  it('leaves the check off with --no-licence, for a design partner', async () => {
    const h = harness();
    const { 'licence-file': _licence, ...without } = h.options;
    await installer.install({ ...without, 'no-licence': true }, h.deps);
    expect(h.fly.secrets['theirco-backend'][0].values.LICENCE).toBeUndefined();
    expect(h.fly.deploys.at(-1).toml).toContain('COPY_LICENCE = "off"');
  });

  it('takes no mail flags any more, and says email is set up later in the Workspace (note #946)', async () => {
    for (const flag of ['resend-key-file', 'smtp-host', 'smtp-user', 'smtp-password-file', 'smtp-port']) {
      const h = harness();
      await expect(installer.install({ ...h.options, [flag]: 'x' }, h.deps)).rejects.toThrow(`--${flag} is not taken any more. Email is not part of the install`);
      expect(h.fly.calls).toEqual([]);
    }
  });
});

describe('Fly\'s registry saying "repository not found" mid-copy (1 Nov 2026)', () => {
  it('asks again on NAME_UNKNOWN and 5xx, then succeeds; a 401 is not asked again', async () => {
    const seen = [];
    let uploadStarts = 0;
    let manifestPuts = 0;
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url.split('?')[0]}`);
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST' && req.url.startsWith('/v2/app-images/blobs/uploads/')) {
          uploadStarts += 1;
          if (uploadStarts === 1) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end('{"errors":[{"code":"NAME_UNKNOWN","message":"app repository not found"}]}');
          }
          res.writeHead(202, { location: '/v2/app-images/blobs/uploads/session-1' });
          return res.end();
        }
        if (req.method === 'PUT' && req.url.startsWith('/v2/app-images/blobs/uploads/session-1')) {
          res.writeHead(201);
          return res.end();
        }
        if (req.method === 'PUT' && req.url === '/v2/app-images/manifests/v1') {
          manifestPuts += 1;
          if (manifestPuts === 1) { res.writeHead(502); return res.end('bad gateway'); }
          res.writeHead(201, { 'docker-content-digest': 'sha256:abc' });
          return res.end();
        }
        if (req.url === '/v2/locked/blobs/uploads/') { res.writeHead(401); return res.end('denied'); }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const waited = [];
    const retry = { wait: async (s) => { waited.push(s); }, log: () => {} };
    try {
      const dir = mkdtempSync(path.join(tmpdir(), 'reg-retry-'));
      const file = path.join(dir, 'layer');
      writeFileSync(file, 'layer bytes');
      const dest = installer.flyRegistry({ app: 'app-images', token: 't', base, retry });
      await dest.putBlob('sha256:0000000000000000000000000000000000000000000000000000000000000000', file);
      expect(uploadStarts).toBe(2);
      expect(await dest.putManifest('v1', Buffer.from('{}'), 'application/vnd.oci.image.manifest.v1+json')).toBe('sha256:abc');
      expect(manifestPuts).toBe(2);
      expect(waited).toEqual([5, 5]);
      const locked = installer.flyRegistry({ app: 'locked', token: 't', base, retry });
      let refused = null;
      try { await locked.putBlob('sha256:1111111111111111111111111111111111111111111111111111111111111111', file); } catch (error) { refused = error; }
      expect(String(refused?.message)).toContain('401');
      expect(waited).toEqual([5, 5]);
    } finally {
      server.close();
    }
  });

  it('gives up after its waits, with the registry\'s own words', async () => {
    let calls = 0;
    const waited = [];
    const error = await installer.retryRegistry('image v1', async () => {
      calls += 1;
      throw new Error('Image v1 refused: 404 {"errors":[{"code":"NAME_UNKNOWN"}]}');
    }, { waits: [1, 2], wait: async (s) => { waited.push(s); }, log: () => {} }).catch((e) => e);
    expect(calls).toBe(3);
    expect(waited).toEqual([1, 2]);
    expect(String(error.message)).toContain('NAME_UNKNOWN');
  });
});

describe('the installer\'s parts', () => {
  it('makes an Ed25519 SSH key pair in OpenSSH form', () => {
    const pair = installer.sshKeyPair('theirco-backend@agents.theirco.test');
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n$/);
    const [type, body, comment] = pair.publicKey.split(' ');
    expect(type).toBe('ssh-ed25519');
    expect(comment).toBe('theirco-backend@agents.theirco.test');
    // The wire form: a length-prefixed type name, then the 32-byte key.
    const wire = Buffer.from(body, 'base64');
    expect(wire.readUInt32BE(0)).toBe(11);
    expect(wire.subarray(4, 15).toString()).toBe('ssh-ed25519');
    expect(wire.readUInt32BE(15)).toBe(32);
    expect(wire.length).toBe(51);
  });

  it('checks each record against what the name servers answer', async () => {
    const zone = [
      { name: DOMAIN, type: 'A', value: '203.0.113.1' },
      { name: DOMAIN, type: 'AAAA', value: '2001:db8:0:0::1' },
      { name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}.`, priority: 10 },
      { name: `*.${DOMAIN}`, type: 'CNAME', value: 'theirco-router.fly.dev.' },
      { name: `_dmarc.${DOMAIN}`, type: 'TXT', value: 'v=DMARC1; p=reject; rua=mailto:dmarc@theirco.test' },
    ];
    const resolver = fakeResolver(() => zone);
    const check = (record) => installer.checkRecord(resolver, record).then((result) => result.ok);
    expect(await check({ name: DOMAIN, type: 'A', value: '203.0.113.1' })).toBe(true);
    expect(await check({ name: DOMAIN, type: 'A', value: '203.0.113.9' })).toBe(false);
    expect(await check({ name: DOMAIN, type: 'AAAA', value: '2001:db8::1' })).toBe(true);
    expect(await check({ name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}`, priority: 10 })).toBe(true);
    expect(await check({ name: `*.${DOMAIN}`, type: 'CNAME', value: 'theirco-router.fly.dev' })).toBe(true);
    expect(await check({ name: `git.${DOMAIN}`, type: 'CNAME', value: 'theirco-git.fly.dev' })).toBe(false);
    // Any DMARC policy the owner prefers will do.
    expect(await check({ name: `_dmarc.${DOMAIN}`, type: 'TXT', value: 'v=DMARC1; p=quarantine' })).toBe(true);
  });

  it('reads a bucket\'s keys from flyctl\'s words', () => {
    expect(installer.bucketKeys('ready\nAWS_ENDPOINT_URL_S3: https://fly.storage.tigris.dev\nAWS_REGION: auto\nBUCKET_NAME: b\nAWS_ACCESS_KEY_ID: tid_1\nAWS_SECRET_ACCESS_KEY: tsec_2\n'))
      .toEqual({ bucket: 'b', endpoint: 'https://fly.storage.tigris.dev', region: 'auto', accessKeyId: 'tid_1', secretAccessKey: 'tsec_2' });
    expect(() => installer.bucketKeys('Error: something')).toThrow('did not print');
  });
});

/** flyctl's verbs that only read. Everything else changes something. */
const READS = new Set(['apps list', 'orgs list', 'auth token', 'certs show']);
const writes = (calls) => calls.map((args) => args.slice(0, 2).join(' ')).filter((verb) => !READS.has(verb));
const stopped = (promise) => promise.then(() => { throw new Error('expected it to stop'); }, (error) => error);

describe('driven by an agent: a plan, JSON, and when a person is needed', () => {
  it('plans without changing anything, and says what it would create and what it costs', async () => {
    const h = harness();
    const events = [];
    const result = await installer.plan({ ...h.options, json: true }, { ...h.deps, emit: (event) => events.push(event) });
    expect(result.outcome).toBe('ready');
    expect(result.exitCode).toBe(0);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    // Nothing made, nothing written: no state, no log, no Fly call that changes anything.
    expect(writes(h.fly.calls)).toEqual([]);
    expect(readdirSync(h.dir).sort()).toEqual(['licence.txt', 'update.key']);
    expect(h.copied).toEqual([]);

    expect(result.creates.filter((item) => item.kind === 'app').map((item) => item.name))
      .toEqual(['theirco-images', 'theirco-backend', 'theirco-git', 'theirco-router']);
    // Email is not in the price (note #946): no receiver, no disk for its
    // certificate, no dedicated IPv4. What it adds later is said apart.
    expect(result.creates.some((item) => /mx|IPv4 on|mail/i.test(`${item.name} ${item.what}`) && item.monthlyUsd)).toBe(false);
    expect(result.creates.find((item) => item.name === 'theirco-backend').monthlyUsd).toBe(11.38);
    expect(result.monthlyUsd).toBe(17.41);
    expect(result.mail).toEqual({ included: false, laterMonthlyUsd: 4.09, how: installer.MAIL_LATER });
    expect(result.checks.find((check) => check.key === 'mail')).toEqual({ key: 'mail', ok: true, detail: 'not part of the install: an admin sets it up later in the Workspace, under Mail' });
    expect(result.records.find((record) => record.name === `*.${DOMAIN}`).value).toBe('theirco-router.fly.dev');
    expect(result.records).toHaveLength(6);
    expect(result.release).toBe('2026.10.27.1');
    // The result is the last event, and no key rides in it.
    expect(events.at(-1)).toEqual(result);
    const said = JSON.stringify(events);
    expect(said).not.toContain(readFileSync(h.options['key-file'], 'utf8').trim());
    expect(said).not.toContain(LICENCE);
    expect(h.lines.join('\n')).toContain('Nothing has been created or changed');
  });

  it('plans with the same machine shapes the install deploys', async () => {
    const h = harness();
    await installer.install(h.options, h.deps);
    const backend = h.fly.deploys.find((deploy) => deploy.app === 'theirco-backend').toml;
    expect(backend).toContain(`size = "${installer.SHAPES.backend.size}"`);
    expect(backend).toContain(`memory = "${installer.SHAPES.backend.memory}"`);
    expect(backend).toContain(`initial_size = "${installer.SHAPES.backend.diskGb}gb"`);
  });

  it('names what only a person can do, and still changes nothing', async () => {
    const h = harness({ billing: 'PAST_DUE' });
    const { 'licence-file': _licence, ...without } = h.options;
    const result = await installer.plan(without, h.deps);
    expect(result.outcome).toBe('needs-person');
    expect(result.exitCode).toBe(3);
    expect(result.reason).toBe('licence');
    expect(result.checks.filter((check) => !check.ok).map((check) => `${check.who} ${check.reason}`)).toEqual(['person licence', 'person billing']);
    expect(result.checks.find((check) => check.reason === 'billing').billingUrl).toBe('https://fly.io/dashboard/theirco-org/billing');
    expect(result.person[0]).toContain('needs its licence');
    expect(writes(h.fly.calls)).toEqual([]);
  });

  it('plans before the update key and licence arrive, given a prefix, and says the key is what is missing', async () => {
    const h = harness();
    const { 'key-file': _key, 'licence-file': _licence, ...without } = h.options;
    const result = await installer.plan({ ...without, name: 'theirco' }, h.deps);
    expect(result.exitCode).toBe(3);
    expect(result.reason).toBe('update-key');
    expect(result.checks.filter((check) => !check.ok).map((check) => `${check.who} ${check.reason}`)).toEqual(['person update-key', 'person licence']);
    // Everything else is still checked, and the plan is still shown.
    for (const key of ['node', 'domain', 'flyctl', 'fly-sign-in', 'fly-organization', 'apps']) {
      expect(result.checks.find((check) => check.key === key)?.ok, key).toBe(true);
    }
    expect(result.creates.filter((item) => item.kind === 'app')).toHaveLength(4);
    expect(result.monthlyUsd).toBe(17.41);
    expect(result.records).toHaveLength(6);
    expect(result.release).toBe(null);
    expect(writes(h.fly.calls)).toEqual([]);
  });

  it('without --org, lists the organizations the sign-in reaches for the person to choose', async () => {
    const h = harness();
    const { org: _org, ...noOrg } = h.options;
    const result = await installer.plan(noOrg, h.deps);
    const org = result.checks.find((check) => check.key === 'fly-organization');
    expect(org.reason).toBe('fly-organization');
    expect(org.organizations).toEqual(['theirco-org', 'personal']);
    expect(result.exitCode).toBe(3);
  });

  it('with --json, reports each step and the result, keeps every key off the screen, and leaves the two secrets in a handover file', async () => {
    const h = harness();
    const events = [];
    await installer.install({ ...h.options, json: true }, { ...h.deps, emit: (event) => events.push(event) });
    expect(events.filter((event) => event.event === 'step' && event.status === 'done').map((event) => event.key)).toEqual(['checks', ...installer.INSTALL_STEPS]);
    expect(events.find((event) => event.event === 'dns-records').records).toHaveLength(6);
    const result = events.at(-1);
    expect(result.outcome).toBe('done');
    expect(result.exitCode).toBe(0);
    expect(result.signInUrl).toBe(`https://${DOMAIN}`);
    expect(result.handoverFile).toBe(path.join(h.dir, 'theirco-handover.txt'));

    const stored = h.fly.secrets['theirco-backend'][0].values;
    const keys = ['FLY_API_TOKEN', 'FLY_SSH_PRIVATE_KEY', 'SECRETS_MASTER_KEY', 'GIT_HOST_SECRET', 'CI_STATUS_SECRET', 'MAIL_INGEST_SECRET', 'FIRST_ACCOUNT_CODE', 'MEDIA_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_SECRET_ACCESS_KEY', 'LICENCE'];
    const said = `${JSON.stringify(events)}\n${h.lines.join('\n')}\n${h.stateText()}`;
    for (const name of keys) expect(said, `${name} was shown`).not.toContain(stored[name]);

    const handover = readFileSync(result.handoverFile, 'utf8');
    expect(handover).toContain(`https://${DOMAIN}/signup#first-account=${stored.FIRST_ACCOUNT_CODE}`);
    expect(handover).toContain(stored.SECRETS_MASTER_KEY);
    expect(statSync(result.handoverFile).mode & 0o777).toBe(0o600);
  });

  it('stops for a person when the DNS records are not in, with exactly the records to add (exit 3), and carries on once they are', async () => {
    const h = harness({ dnsNever: true });
    const error = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(error instanceof installer.PersonNeeded).toBe(true);
    expect(installer.exitCodeOf(error)).toBe(3);
    const result = installer.resultOf(error);
    expect(result.outcome).toBe('needs-person');
    expect(result.reason).toBe('dns');
    expect(result.records).toHaveLength(6);
    expect(result.records.find((record) => record.name === `git.${DOMAIN}`)).toEqual({ name: `git.${DOMAIN}`, type: 'CNAME', value: 'theirco-git.fly.dev', why: 'the code host' });
    expect(result.records.map((record) => record.name)).not.toContain(`mx.${DOMAIN}`);
    expect(result.records.some((record) => record.type === 'MX' || record.name.startsWith('_dmarc.'))).toBe(false);
    expect(JSON.parse(h.stateText()).steps.dns).toBeUndefined();

    h.addDns();
    const state = await installer.install(h.options, h.deps);
    expect(state.steps.smoke).toBeDefined();
  });

  it('asks up front for the code host certificate\'s DNS-validation record, as Fly names it, and checks it like the rest', async () => {
    const want = { name: `_acme-challenge.git.${DOMAIN}`, type: 'CNAME', value: `git.${DOMAIN}.x1y2z3.flydns.net`, why: 'the certificate for the code host, proved by DNS' };
    const planned = await installer.plan(harness().options, harness().deps);
    expect(planned.records.find((record) => record.name === want.name).value).toBe('(given by Fly with the certificate)');

    const h = harness({ dnsNever: true });
    const error = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(error.details.records.find((record) => record.name === want.name)).toEqual(want);
    expect(h.lines.join('\n')).toContain(`_acme-challenge.git.${DOMAIN}`);
    expect(JSON.parse(h.stateText()).gitAcmeTarget).toBe(want.value);

    // An install begun before the installer asked for it reads it from Fly when it carries on.
    const older = JSON.parse(h.stateText());
    delete older.gitAcmeTarget;
    writeFileSync(h.options.state, JSON.stringify(older));
    const resumed = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(resumed.details.records.map((record) => record.name)).toContain(want.name);
    expect(h.fly.calls.filter((args) => args.join(' ') === `certs show git.${DOMAIN} -a theirco-git --json`).length).toBeGreaterThanOrEqual(2);
  });

  it('says it is still waiting, not failing, when only a certificate is slow (exit 4)', async () => {
    const h = harness({ stuckCert: `git.${DOMAIN}` });
    const error = await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    expect(error instanceof installer.StillWaiting).toBe(true);
    expect(installer.exitCodeOf(error)).toBe(4);
    const result = installer.resultOf(error);
    expect(result.outcome).toBe('waiting');
    expect(result.reason).toBe('certificates');
    expect(result.certificatesWaiting).toContain(`git.${DOMAIN}`);
    expect(result.missing).toEqual([]);
  });

  it('asks a person for the update key it cannot find, before anything is made', async () => {
    const h = harness();
    const error = await stopped(installer.install({ ...h.options, 'key-file': path.join(h.dir, 'missing.key') }, h.deps));
    expect(installer.resultOf(error)).toEqual({
      event: 'result', outcome: 'needs-person', exitCode: 3, reason: 'update-key',
      message: `There is no update key at ${path.join(h.dir, 'missing.key')}. It comes from us with the agreement, one line in a file.`,
    });
    expect(h.fly.calls).toEqual([]);
  });

  it('ends an upgrade with a JSON result too', async () => {
    const h = await installed();
    const events = [];
    await installer.upgrade({ ...h.options, json: true }, { ...h.deps, emit: (event) => events.push(event) });
    expect(events.at(-1)).toEqual({ event: 'result', outcome: 'done', exitCode: 0, command: 'upgrade', domain: DOMAIN, release: '2026.10.28.1', previous: '2026.10.27.1' });
  });
});

describe('status: it only looks', () => {
  it('says a person is needed while records are missing, waiting while certificates are, and installed at the end', async () => {
    const h = harness({ dnsNever: true });
    await stopped(installer.install({ ...h.options, wait: '0' }, h.deps));
    const look = async () => {
      const before = h.fly.calls.length;
      const kept = h.stateText();
      const result = await installer.status({ state: h.options.state, json: true }, h.deps);
      // Read only: no flyctl verb that changes anything, no nudge, and the record untouched.
      expect(writes(h.fly.calls.slice(before))).toEqual([]);
      expect(h.stateText()).toBe(kept);
      return result;
    };

    const missing = await look();
    expect(missing.outcome).toBe('needs-person');
    expect(missing.exitCode).toBe(3);
    expect(missing.reason).toBe('dns');
    expect(missing.records).toHaveLength(6);

    h.addDns();
    const waiting = await look();
    expect(waiting.outcome).toBe('waiting');
    expect(waiting.exitCode).toBe(4);
    expect(waiting.reason).toBe('certificates');
    expect(waiting.next).toBe('install');

    await installer.install(h.options, h.deps);
    const done = await look();
    expect(done.outcome).toBe('installed');
    expect(done.exitCode).toBe(0);
    expect(done.release).toBe('2026.10.27.1');
  });
});

describe('the command line', () => {
  /** The real command, as an agent runs it, with only a local stand-in for the update service. */
  const run = (args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [INSTALLER, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
  });

  it('--plan --json prints JSON lines only, ends on the result, and exits 3 when a person must sign in to Fly', async () => {
    const h = harness();
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: '2026.10.27.1', commit: 'abc123', images: {} }));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    // A flyctl that is installed and signed in to nothing.
    const flyctl = path.join(h.dir, 'fly');
    writeFileSync(flyctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const { code, out } = await run([
        'install', '--org', 'theirco-org', '--domain', DOMAIN, '--contact-email', 'it@theirco.test', '--key-file', h.options['key-file'], '--licence-file', h.options['licence-file'],
        '--state', h.options.state, '--updates', `http://127.0.0.1:${server.address().port}`, '--plan', '--json',
      ], { FLYCTL: flyctl, FLY_API_TOKEN: '' });
      const lines = out.trim().split('\n').map((line) => JSON.parse(line));
      expect(code).toBe(3);
      expect(lines.at(-1).event).toBe('result');
      expect(lines.at(-1).outcome).toBe('needs-person');
      expect(lines.at(-1).reason).toBe('fly-sign-in');
      expect(lines.at(-1).release).toBe('2026.10.27.1');
      expect(out).not.toContain(readFileSync(h.options['key-file'], 'utf8').trim());
      expect(existsSync(h.options.state)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('ends on a JSON result when it fails, too', async () => {
    const { code, out } = await run(['status', '--state', path.join(tmpdir(), 'nothing-here-copy.json'), '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(out.trim().split('\n').at(-1)).outcome).toBe('failed');
  });
});

describe('licensing off: the product is free for now, and nothing asks for a key or a licence', () => {
  const off = async (run) => {
    delete process.env.COPY_LICENCE;
    try { return await run(); } finally { process.env.COPY_LICENCE = 'on'; }
  };

  it('installs with no update key and no licence, fetches releases as nobody in particular, and leaves the cloud unlicensed', () => off(async () => {
    const h = harness();
    const asked = [];
    const { 'key-file': _key, 'licence-file': _licence, ...bare } = h.options;
    // The harness's DNS zone is built for the prefix theirco; the prefix a
    // domain gives by itself is proved by the plan test and prefixFromDomain.
    const state = await installer.install({ ...bare, name: 'theirco' }, {
      ...h.deps,
      updatesSource: (opts) => { asked.push(opts); return { release: async () => ({ version: '2026.10.27.1', commit: 'abc123', images: {} }) }; },
    });
    expect(asked[0].key).toBe(null);
    expect(state.prefix).toBe('theirco');
    expect(h.fly.secrets['theirco-backend'][0].values.LICENCE).toBeUndefined();
    expect(h.fly.deploys.at(-1).toml).toContain('COPY_LICENCE = "off"');
    expect(state.steps.smoke).toBeDefined();
  }));

  it('ignores an update key and a licence an older guide still passes', () => off(async () => {
    const h = harness();
    writeFileSync(h.options['key-file'], 'not a key at all');
    const state = await installer.install({ ...h.options, name: 'theirco' }, h.deps);
    expect(state.steps.smoke).toBeDefined();
    expect(h.fly.secrets['theirco-backend'][0].values.LICENCE).toBeUndefined();
  }));

  it('plans with no key: both checks say not needed, and the plan is ready', () => off(async () => {
    const h = harness();
    const { 'key-file': _key, 'licence-file': _licence, ...bare } = h.options;
    const result = await installer.plan(bare, h.deps);
    expect(result.outcome).toBe('ready');
    expect(result.checks.find((check) => check.key === 'update-key').detail).toContain('not needed');
    expect(result.checks.find((check) => check.key === 'licence').detail).toContain('not needed');
    expect(result.creates.find((item) => item.kind === 'app').name).toBe('agents-theirco-images');
  }));

  it('asks the update service with no sign-in at all', async () => {
    const seen = [];
    const source = installer.updatesSource({ url: 'https://updates.test', customer: 'x', key: null, fetchImpl: async (url, init) => { seen.push(init.headers); return new Response('{"version":"1"}'); } });
    await source.release();
    expect(seen[0].authorization).toBeUndefined();
  });

  it('makes a prefix from the domain', () => {
    expect(installer.prefixFromDomain('agents.bookface.site')).toBe('agents-bookface');
    expect(installer.prefixFromDomain('bookface.site')).toBe('bookface');
    expect(installer.prefixFromDomain('1st.example.com')).toBe('st-example');
  });
});

/** Fly's Machines API as the upgrader reads it, made from a finished install:
 *  the backend's config.env exactly as the deploy wrote it, and each app's image. */
function fakeMachines(h, { upgraderApp = true, secrets = ['FLY_API_TOKEN', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'], running = [] } = {}) {
  const created = [];
  const destroyed = [];
  const imageOf = (app) => h.fly.deploys.filter((d) => d.app === app).at(-1)?.image;
  const envOf = () => {
    const toml = h.fly.deploys.filter((d) => d.app === 'theirco-backend').at(-1).toml;
    const block = toml.split('[env]\n')[1].split('\n\n')[0];
    return Object.fromEntries(block.split('\n').map((line) => /^\s+(\S+) = (".*")$/.exec(line)).filter(Boolean).map((m) => [m[1], JSON.parse(m[2])]));
  };
  const api = {
    app: async (name) => (name === 'theirco-upgrader' && !upgraderApp ? null : { name, organization: { slug: 'theirco-org' } }),
    machines: async (app) => {
      if (app === 'theirco-upgrader') return running;
      const image = imageOf(app);
      if (!image) return [];
      return [{ id: `m-${app}`, state: 'started', region: 'fra', private_ip: 'fdaa:0:1::2', config: { image, env: app === 'theirco-backend' ? { ...envOf(), FLY_PROCESS_GROUP: 'app', PRIMARY_REGION: 'fra' } : {} } }];
    },
    machine: async () => ({ state: 'destroyed' }),
    createMachine: async (app, request) => { created.push({ app, request }); return { id: `up${created.length}` }; },
    destroyMachine: async (app, id) => { destroyed.push(id); },
    secretNames: async (app) => (app === 'theirco-upgrader' && upgraderApp ? secrets : null),
  };
  return { api, created, destroyed };
}

/** The copy's backup bucket, in memory. */
function fakeBucket(seed = {}) {
  const objects = { ...seed };
  return {
    objects,
    getText: async (key) => objects[key] ?? null,
    getJson: async (key) => (objects[key] ? JSON.parse(objects[key]) : null),
    put: async (key, text) => { objects[key] = text; },
    putJson: async (key, value) => { objects[key] = JSON.stringify(value); },
    remove: async (key) => { delete objects[key]; },
  };
}

const UPGRADER_ENV = {
  ACC_PREFIX: 'theirco', ACC_RUN_ID: 'run1', ACC_RELEASE: '2026.10.28.1', ACC_REQUESTED_BY: 'Dana Rivera', FLY_MACHINE_ID: 'up1',
  FLY_API_TOKEN: 'FlyV1 org', BACKUP_S3_ENDPOINT: 'https://fly.storage.tigris.dev', BACKUP_S3_BUCKET: 'theirco-backups', BACKUP_S3_ACCESS_KEY_ID: 'tid', BACKUP_S3_SECRET_ACCESS_KEY: 'tsec',
};

describe('the upgrader machine (note #1008): the same upgrade, outside every app it rolls', () => {
  // Licensing is off in every copy today, and the upgrader is handed no key.
  const installedFree = async (options) => {
    process.env.COPY_LICENCE = 'on';
    const h = await installed(options);
    delete process.env.COPY_LICENCE;
    return h;
  };
  afterEach(() => { process.env.COPY_LICENCE = 'on'; });
  it('reads the copy from Fly: the same release, address and additions the state file holds', async () => {
    const h = await installedFree();
    const m = fakeMachines(h);
    const shape = await installer.stateFromFly({ api: m.api, prefix: 'theirco' });
    const kept = JSON.parse(h.stateText());
    expect(shape.domain).toBe(DOMAIN);
    expect(shape.org).toBe('theirco-org');
    expect(shape.release.version).toBe(kept.release.version);
    for (const name of ['backend', 'git-host', 'router', 'machine', 'app-runtime', 'msg-host', 'mx']) expect(shape.release.tags[name]).toBe(kept.release.tags[name]);
    expect(shape.peerIp).toBe('fdaa:0:1::2');
    // The admin's own additions come back, and nothing Fly adds by itself.
    expect(shape.extraEnv).toEqual(kept.extraEnv);
    expect(shape.mxV4).toBeUndefined();
  });

  it('runs a whole upgrade from the run record, and leaves the outcome, events and heartbeat in the bucket', async () => {
    const h = await installedFree();
    const m = fakeMachines(h);
    const bucket = fakeBucket();
    const out = [];
    const run = await installer.runUpgrader(UPGRADER_ENV, { ...h.deps, machinesApi: m.api, bucket, say: (line) => out.push(line), logFile: null, heartbeatMs: 5 });
    expect(run.outcome).toBe('done');
    expect(run.requestedBy).toBe('Dana Rivera');
    expect(run.release.version).toBe('2026.10.28.1');
    expect(h.backendImage()).toBe('registry.fly.io/theirco-images:backend-2026.10.28.1');
    const stored = JSON.parse(bucket.objects['upgrades/run1/run.json']);
    expect(stored.outcome).toBe('done');
    expect(stored.upgrade).toBeNull();
    const events = bucket.objects['upgrades/run1/events.jsonl'].trim().split('\n').map((line) => JSON.parse(line));
    expect(events.some((e) => e.event === 'step' && e.title === 'Snapshotting the database' && e.status === 'done')).toBe(true);
    expect(events.at(-1).event).toBe('result');
    expect(JSON.parse(bucket.objects['upgrades/run1/heartbeat.json']).machine).toBe('up1');
    expect(bucket.objects['upgrades/current.json']).toBeUndefined();
    // Its own WireGuard peer goes; another machine's stays.
    expect(h.fly.peers.map((p) => p.Name)).toEqual(['interactive-someoneelse-1']);
  });

  it('carries on after Fly restarts it, with the snapshot it already took', async () => {
    const h = await installedFree();
    const m = fakeMachines(h);
    const shape = await installer.stateFromFly({ api: m.api, prefix: 'theirco' });
    const to = { version: '2026.10.28.1', commit: 'def456', tags: Object.fromEntries(Object.keys(TAGS).map((name) => [name, `${name}-2026.10.28.1`])) };
    const bucket = fakeBucket({
      'upgrades/run1/run.json': JSON.stringify({
        id: 'run1', requestedBy: 'Dana Rivera', toVersion: '2026.10.28.1', drill: '', startedAt: '2026-10-28T09:00:00Z', shape,
        upgrade: { from: shape.release, toVersion: '2026.10.28.1', startedAt: '2026-10-28T09:00:00Z', to, snapshot: { file: '/data/pre-upgrade-2026.10.27.1.db', at: '2026-10-28T09:01:00Z' } },
      }),
    });
    const out = [];
    const run = await installer.runUpgrader(UPGRADER_ENV, { ...h.deps, machinesApi: m.api, bucket, say: (line) => out.push(line), logFile: null });
    expect(run.outcome).toBe('done');
    expect(h.fly.sql.some((c) => c.includes('.backup'))).toBe(false);
    expect(out.join('\n')).toContain('Carrying on with the upgrade from 2026.10.27.1 to 2026.10.28.1');
  });

  it('does nothing when started again for a run that already ended', async () => {
    const h = await installedFree();
    const bucket = fakeBucket({ 'upgrades/run1/run.json': JSON.stringify({ id: 'run1', outcome: 'done', result: { event: 'result', outcome: 'done' } }) });
    const before = h.fly.calls.length;
    const run = await installer.runUpgrader(UPGRADER_ENV, { ...h.deps, machinesApi: fakeMachines(h).api, bucket, say: () => {}, logFile: null });
    expect(run.outcome).toBe('done');
    expect(h.fly.calls.length).toBe(before);
  });

  it('carries on an open run whose upgrader went quiet, and refuses one that is still heard', async () => {
    const h = await installedFree();
    const now = new Date('2026-11-05T15:00:00Z');
    const quiet = fakeBucket({
      'upgrades/current.json': JSON.stringify({ id: 'old', startedAt: '2026-11-05T14:50:00Z' }),
      'upgrades/old/heartbeat.json': JSON.stringify({ at: '2026-11-05T14:55:00Z' }),
    });
    const lines = [];
    const run = await installer.runUpgrader(UPGRADER_ENV, { ...h.deps, machinesApi: fakeMachines(h).api, bucket: quiet, say: (line) => lines.push(line), logFile: null, now: () => now });
    expect(run.id).toBe('old');
    expect(lines.join('\n')).toContain('Carrying on run old');
    const heard = fakeBucket({
      'upgrades/current.json': JSON.stringify({ id: 'other', startedAt: '2026-11-05T14:59:00Z' }),
      'upgrades/other/heartbeat.json': JSON.stringify({ at: '2026-11-05T14:59:50Z' }),
    });
    await expect(installer.runUpgrader(UPGRADER_ENV, { ...h.deps, machinesApi: fakeMachines(h).api, bucket: heard, say: () => {}, logFile: null, now: () => now })).rejects.toThrow('Another upgrade (other) is running');
  });

  it('records a put-back when the new release fails, with the old one back on every app', async () => {
    const h = await installedFree({ failNew: true });
    const bucket = fakeBucket();
    const run = await installer.runUpgrader(UPGRADER_ENV, { ...h.deps, machinesApi: fakeMachines(h).api, bucket, say: () => {}, logFile: null });
    expect(run.outcome).toBe('put-back');
    expect(run.message).toContain('is back on 2026.10.27.1');
    expect(h.backendImage()).toBe('registry.fly.io/theirco-images:backend-2026.10.27.1');
  });

  it('--drill backend: the new Workspace does not start, and the old one and its database come back without it', async () => {
    const h = await installedFree();
    const state = await installer.upgrade({ ...h.options, drill: 'backend' }, h.deps);
    const rolled = h.fly.deploys.slice(h.before);
    expect(rolled[0].toml).toContain('PORT = "8081"');
    expect(rolled.slice(1).map((d) => `${d.app} ${d.image.split('-').pop()}`)).toEqual([
      'theirco-backend 2026.10.27.1', 'theirco-git 2026.10.27.1', 'theirco-router 2026.10.27.1',
    ]);
    // The mark was written after the snapshot and before anything moved, and the restore took it away.
    const marked = h.fly.sql.findIndex((c) => c.includes('INSERT INTO upgrade_drill'));
    expect(marked).toBeGreaterThan(h.fly.sql.findIndex((c) => c.includes('.backup')));
    expect(h.fly.db().drill).toBeUndefined();
    expect(state.release.version).toBe('2026.10.27.1');
    expect(h.lines.join('\n')).toContain('Drill done: the new Workspace did not start');
  });

  it('the command starts the upgrader with the run\'s settings, and follows it', async () => {
    const h = await installedFree();
    const m = fakeMachines(h);
    const copied = [];
    const result = await installer.upgradeCommand({ ...h.options, drill: 'backend' }, {
      ...h.deps,
      machinesApi: m.api,
      updatesSource: () => ({ release: async () => ({ version: '2026.10.28.1', commit: 'def456', images: { upgrader: { tag: 'upgrader-2026.10.28.1' } } }) }),
      copyOneImage: async () => { copied.push('upgrader'); },
      follow: async () => ({ event: 'result', upgrade: 'drill-done', outcome: 'done' }),
    });
    expect(result.upgrade).toBe('drill-done');
    expect(copied).toEqual(['upgrader']);
    const { app, request } = m.created[0];
    expect(app).toBe('theirco-upgrader');
    expect(request.config.image).toBe('registry.fly.io/theirco-images:upgrader-2026.10.28.1');
    expect(request.config.auto_destroy).toBe(true);
    expect(request.config.restart).toEqual({ policy: 'on-failure', max_retries: 3 });
    expect(request.config.env).toMatchObject({ ACC_PREFIX: 'theirco', ACC_RELEASE: '2026.10.28.1', ACC_DRILL: 'backend' });
    // No key rides the machine's env: the app's secrets carry them.
    expect(JSON.stringify(request)).not.toContain('FlyV1');
  });

  it('the command runs here, once, when the copy has no upgrader yet', async () => {
    const h = await installedFree();
    const m = fakeMachines(h, { upgraderApp: false });
    await installer.upgradeCommand(h.options, { ...h.deps, machinesApi: m.api });
    expect(m.created).toEqual([]);
    expect(h.lines.join('\n')).toContain('theirco-upgrader does not exist yet');
    expect(JSON.parse(h.stateText()).release.version).toBe('2026.10.28.1');
  });

  it('the command refuses while an upgrade is running, and --here takes the same lock', async () => {
    const h = await installedFree();
    const busy = fakeMachines(h, { running: [{ id: 'up9', state: 'started', name: 'upgrader' }] });
    await expect(installer.upgradeCommand(h.options, { ...h.deps, machinesApi: busy.api })).rejects.toThrow('An upgrade is already running: machine up9');
    await expect(installer.upgradeCommand({ ...h.options, here: true }, { ...h.deps, machinesApi: busy.api })).rejects.toThrow('An upgrade is already running');
    const free = fakeMachines(h);
    await installer.upgradeCommand({ ...h.options, here: true }, { ...h.deps, machinesApi: free.api });
    expect(free.created[0].request.name).toMatch(/^here-lock-/);
    expect(free.created[0].request.skip_launch).toBe(true);
    expect(free.destroyed).toEqual(['up1']);
  });

  it('--here goes by Fly when the file is behind an upgrade made elsewhere', async () => {
    const h = await installedFree();
    await installer.upgrade(h.options, h.deps);
    const kept = JSON.parse(h.stateText());
    writeFileSync(h.options.state, JSON.stringify({ ...kept, release: kept.previous }));
    await installer.upgradeCommand({ ...h.options, here: true, release: '2026.10.28.1' }, { ...h.deps, machinesApi: fakeMachines(h).api });
    expect(h.lines.join('\n')).toContain('says 2026.10.27.1; Fly says theirco runs 2026.10.28.1. Going by Fly.');
  });

  it('a stale --here lock does not hold up an upgrade', () => {
    const now = Date.parse('2026-11-05T15:00:00Z');
    expect(installer.upgradesUnderWay([
      { id: 'a', state: 'created', name: 'here-lock-1', created_at: '2026-11-05T12:00:00Z' },
      { id: 'b', state: 'created', name: 'here-lock-2', created_at: '2026-11-05T14:30:00Z' },
      { id: 'c', state: 'destroyed', name: 'upgrader' },
    ], now).map((machine) => machine.id)).toEqual(['b']);
  });

  it('says in one word how a run ended', () => {
    expect(installer.outcomeOf({ release: 'x' }, null, false)).toBe('done');
    expect(installer.outcomeOf({ drill: true }, null, false)).toBe('drill-done');
    expect(installer.outcomeOf({ unchanged: true }, null, false)).toBe('unchanged');
    expect(installer.outcomeOf(null, new Error('The upgrade to 2 failed and a.test is back on 1 (3 min)'), false)).toBe('put-back');
    expect(installer.outcomeOf(null, new Error('Release 2: 404'), false)).toBe('failed');
    // Cut off with the run still open: no outcome, so Fly starts it again.
    expect(installer.outcomeOf(null, new Error('ssh: connection lost'), true)).toBeNull();
  });

  it('reads its own lines out of `fly logs`', () => {
    expect(installer.logLineText('2026-11-05T15:05:09Z app[up1] ams [info]ACC-EVENT {"event":"step"}')).toBe('ACC-EVENT {"event":"step"}');
    expect(installer.logLineText('\u001b[2m2026-11-05T15:05:09Z\u001b[0m app[up1] \u001b[32mams\u001b[0m [\u001b[34minfo\u001b[0m]  Snapshotting the database…')).toBe('  Snapshotting the database…');
  });

  it('signs S3 requests the way AWS documents (Signature Version 4, GET object example)', () => {
    const signed = installer.signV4({
      method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(signed.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

describe('the contact person (note #1057)', () => {
  it('will not install without a contact email, and asks before it creates anything', async () => {
    const h = harness();
    const { 'contact-email': _email, 'contact-name': _name, ...without } = h.options;
    let thrown;
    try { await installer.install(without, h.deps); } catch (error) { thrown = error; }
    expect(thrown?.name).toBe('PersonNeeded');
    expect(thrown?.reason).toBe('contact');
    expect(thrown?.message).toContain('--contact-email');
    expect(writes(h.fly.calls)).toEqual([]);
    expect(existsSync(h.options.state)).toBe(false);
  });

  it('refuses an address that is not one', async () => {
    const h = harness();
    for (const bad of ['nobody', 'a b@c.d', true]) {
      let thrown;
      try { await installer.install({ ...h.options, 'contact-email': bad }, h.deps); } catch (error) { thrown = error; }
      expect(thrown?.reason, String(bad)).toBe('contact');
    }
  });

  it('the plan names it as something a person gives, and shows it once given', async () => {
    const h = harness();
    const { 'contact-email': _email, 'contact-name': _name, ...without } = h.options;
    const missing = await installer.plan(without, h.deps);
    expect(missing.exitCode).toBe(3);
    expect(missing.checks.find((check) => check.key === 'contact')).toMatchObject({ ok: false, who: 'person', reason: 'contact' });
    const given = await installer.plan(h.options, h.deps);
    expect(given.checks.find((check) => check.key === 'contact')).toMatchObject({ ok: true });
    expect(given.checks.find((check) => check.key === 'contact').detail).toContain('Theirco IT <it@theirco.test>');
  });

  it('hands the contact to the backend, and a run that carries on keeps it', async () => {
    const h = harness();
    await installer.install(h.options, h.deps);
    const state = JSON.parse(readFileSync(h.options.state, 'utf8'));
    expect(state.extraEnv.backend).toMatchObject({ COPY_CONTACT_EMAIL: 'it@theirco.test', COPY_CONTACT_NAME: 'Theirco IT' });
    const { 'contact-email': _email, 'contact-name': _name, ...again } = h.options;
    await installer.install(again, h.deps);
    const after = JSON.parse(readFileSync(h.options.state, 'utf8'));
    expect(after.extraEnv.backend).toMatchObject({ COPY_CONTACT_EMAIL: 'it@theirco.test', COPY_CONTACT_NAME: 'Theirco IT' });
  });

  it('takes the address as the name when no name is given, and a new address on a later run', () => {
    expect(installer.contactFor({ 'contact-email': 'ops@theirco.test' }, null)).toEqual({ email: 'ops@theirco.test', name: 'ops@theirco.test' });
    const state = { extraEnv: { backend: { COPY_CONTACT_EMAIL: 'it@theirco.test', COPY_CONTACT_NAME: 'Theirco IT' } } };
    expect(installer.contactFor({}, state)).toEqual({ email: 'it@theirco.test', name: 'Theirco IT' });
    expect(installer.contactFor({ 'contact-email': 'new@theirco.test' }, state)).toEqual({ email: 'new@theirco.test', name: 'new@theirco.test' });
  });
});
