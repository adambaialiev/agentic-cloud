#!/usr/bin/env node
/**
 * The private copy's own command, run by the customer's engineer
 * with Node 20 or newer and flyctl. Nothing else to install: one file, no
 * packages. The Fly token is FLY_API_TOKEN (or flyctl's own sign-in).
 *
 *   node install.mjs install --org <fly organization> --domain <copy's domain> \
 *        [--name <prefix>] [--region <code>] [--release <version|latest>]
 *
 * Email is not part of the install (note #946): nothing here asks for a mail
 * provider, makes a mail receiver or prints a mail record. People's addresses
 * are on the domain from the first account, and an admin turns email on later
 * from the Workspace (Mail): it takes the provider's details, creates the
 * mail receiver in this same organization, prints its records, checks them
 * and turns mail on.
 *
 * Licensing is off (the product is free for now): no update key, no licence,
 * and the prefix comes from the domain unless --name gives one. With
 * COPY_LICENCE=on the installer asks for --key-file and --licence-file (or
 * --no-licence) as before, and the installed cloud checks its licence.
 *
 * `install` builds a whole copy in the organization, start to finish, and can
 * be run again at any point: it carries on from what is already there. It
 * checks the organization's billing, creates the four apps (images, backend,
 * code host, router) and the two buckets, copies one release into the copy's
 * own registry, makes and stores the keys, deploys, asks for the certificates,
 * prints the DNS records and waits until they and the certificates check out,
 * runs a smoke test, and prints the first admin's one-time sign-up link and
 * the master key (once). What it made is recorded in ./<prefix>-copy.json,
 * names and addresses only, which the upgrade command reads.
 *
 * `install --plan`, with the same flags, changes nothing and costs nothing:
 * it makes every check the install makes before it creates anything (Node,
 * flyctl and its sign-in, the organization and its bill, the domain, the
 * update key and the release it opens, the licence), and lists
 * everything the install would create with Fly's list price, and the DNS
 * records it will ask for. It writes no file, not even its state or a log.
 *
 *   node install.mjs status [--state <file>]
 *
 * `status` only looks: it asks the domain's own name servers for each record
 * and Fly for each certificate, and says what is still missing. It never creates, restarts or nudges anything.
 *
 * With --json, stdout carries one JSON object per line: progress, then the
 * result, always the last line. The readable lines stay on stderr. No line
 * on either holds a key: with --json, the first admin's link and the master
 * key go to ./<prefix>-handover.txt (mode 600) instead of the screen.
 *
 * Exit codes: 0 done, 1 failed, 2 the command was wrong, 3 a person is
 * needed (the result's `reason` says for what), 4 still waiting on Fly or
 * Let's Encrypt, with nothing for anyone to do but run the
 * same command again later.
 *
 *   node install.mjs copy --customer <id> --key-file <update key file> \
 *        --to-app <the copy's images app> [--release <version|latest>]
 *
 * `copy` takes one release from our update service and copies every image it
 * names into the copy's own Fly registry (registry.fly.io/<to-app>). From then
 * on the copy runs only from there: nothing it runs is pulled from us. The
 * update key is the one we issued with the contract; it covers the releases
 * dated on or before its end date.
 */
import {
  appendFileSync, chmodSync, createReadStream, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Resolver, promises as dnsPromises } from 'node:dns';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';

export const UPDATES_URL = process.env.ACC_UPDATES_URL || 'https://acc-updates.fly.dev';
export const SOURCE_REPO = 'acc-copy';
const FLY_REGISTRY = 'https://registry.fly.io';
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const say = (line) => process.stderr.write(`${line}\n`);
const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** Not a failure: something only a person can do, such as adding the DNS
 *  records, handing over a file from us, or settling a Fly bill. Exit 3,
 *  with a `reason` a program can read and the details it needs. */
export class PersonNeeded extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'PersonNeeded';
    this.reason = reason;
    this.details = details;
  }
}

/** Not a failure either: Fly or Let's Encrypt is still at it, and nobody can hurry it. Exit 4: run the same command again later. */
export class StillWaiting extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'StillWaiting';
    this.reason = reason;
    this.details = details;
  }
}

/** The command itself was wrong: a flag missing or two that clash. Exit 2. */
export class UsageError extends Error {}

export const EXIT = { done: 0, failed: 1, usage: 2, person: 3, waiting: 4 };

export function exitCodeOf(error) {
  if (error instanceof PersonNeeded) return EXIT.person;
  if (error instanceof StillWaiting) return EXIT.waiting;
  if (error instanceof UsageError) return EXIT.usage;
  return EXIT.failed;
}

/** The last line a command prints with --json when it stopped. */
export function resultOf(error) {
  const outcome = error instanceof PersonNeeded ? 'needs-person' : error instanceof StillWaiting ? 'waiting' : 'failed';
  return { event: 'result', outcome, exitCode: exitCodeOf(error), reason: error.reason ?? null, message: error.message, ...(error.details ?? {}) };
}

const jsonLine = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
/** Where a command's events go: a test's own list, stdout with --json, or nowhere. */
const eventSink = (options, deps) => deps.emit ?? (options.json ? jsonLine : () => {});

/** Where releases come from: our update service, signed in as the customer. */
export function updatesSource({ url = UPDATES_URL, customer, key, fetchImpl = fetch }) {
  // With licensing off there is no key: the service hands releases to anyone.
  const auth = key ? { authorization: basic(customer, key) } : {};
  const get = async (pathname, init = {}) => {
    const answer = await fetchImpl(`${url}${pathname}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    if (answer.status === 401) throw new PersonNeeded('update-key', 'The update service did not accept this customer id and update key.');
    return answer;
  };
  return {
    async release(version = 'latest') {
      const answer = await get(`/releases/${version}/copy-release.json`);
      if (!answer.ok) throw new Error(`Release ${version}: ${answer.status} ${(await answer.text()).trim()}`);
      return answer.json();
    },
    async manifest(ref) {
      const answer = await get(`/v2/${SOURCE_REPO}/manifests/${ref}`, { headers: { accept: MANIFEST_TYPES } });
      if (!answer.ok) throw new Error(`Image ${ref}: ${answer.status} ${(await answer.text()).trim()}`);
      return { bytes: Buffer.from(await answer.arrayBuffer()), type: answer.headers.get('content-type') };
    },
    async blobTo(digest, file) {
      const answer = await get(`/v2/${SOURCE_REPO}/blobs/${digest}`);
      if (!answer.ok || !answer.body) throw new Error(`Layer ${digest}: ${answer.status}`);
      await pipeline(Readable.fromWeb(answer.body), createWriteStream(file));
    },
  };
}

/** A refusal from Fly's registry that is worth asking again: it has said
 *  "404 NAME_UNKNOWN: app repository not found" for an app it had taken five
 *  images into a moment before (a real install, 1 Nov 2026), and like any
 *  registry it answers 429 and 5xx now and then. Never a 401 or 403, and never
 *  a manifest it judged invalid: those do not change by waiting. */
export function registryHiccup(error) {
  const text = String(error?.message ?? error);
  return /NAME_UNKNOWN|repository not found|: (429|5\d\d)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(text);
}

/** Ask again, about three minutes in all, while the answer is a hiccup. */
export async function retryRegistry(what, attempt, { waits = [5, 10, 20, 40, 60, 60], wait = (s) => sleep(s * 1000), log = say } = {}) {
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= waits.length || !registryHiccup(error)) throw error;
      log(`  ${what}: ${error.message}; asking again in ${waits[tries]} s`);
      await wait(waits[tries]);
    }
  }
}

/** Where the copy runs from: its own Fly registry, one app's repository. */
export function flyRegistry({ app, token, base = FLY_REGISTRY, fetchImpl = fetch, retry = {} }) {
  const auth = basic('x', token);
  const url = (pathname) => `${base}/v2/${app}/${pathname}`;
  const self = {
    async hasBlob(digest) {
      const answer = await fetchImpl(url(`blobs/${digest}`), { method: 'HEAD', headers: { authorization: auth } });
      return answer.ok;
    },
    async putBlob(digest, file) {
      const start = await fetchImpl(url('blobs/uploads/'), { method: 'POST', headers: { authorization: auth, 'content-length': '0' } });
      if (start.status !== 202) throw new Error(`Upload of ${digest} refused: ${start.status} ${(await start.text()).trim()}`);
      const location = new URL(start.headers.get('location'), base);
      location.searchParams.set('digest', digest);
      const size = statSync(file).size;
      // node:https rather than fetch: a layer can be a gigabyte, and this
      // streams it from disk with the length a registry wants up front.
      await new Promise((resolve, reject) => {
        const put = (location.protocol === 'http:' ? httpRequest : httpsRequest)(location, {
          method: 'PUT',
          headers: { authorization: auth, 'content-type': 'application/octet-stream', 'content-length': size },
        }, (res) => {
          res.resume();
          res.on('end', () => (res.statusCode === 201 ? resolve() : reject(new Error(`Upload of ${digest}: ${res.statusCode}`))));
        });
        put.on('error', reject);
        createReadStream(file).pipe(put);
      });
    },
    async putManifest(tag, bytes, type) {
      const answer = await fetchImpl(url(`manifests/${tag}`), {
        method: 'PUT', headers: { authorization: auth, 'content-type': type }, body: bytes,
      });
      if (answer.status !== 201) throw new Error(`Image ${tag} refused: ${answer.status} ${(await answer.text()).trim()}`);
      return answer.headers.get('docker-content-digest');
    },
  };
  // Every write is asked again on a hiccup. An upload starts over from its
  // POST, because a refused or broken session cannot be resumed.
  const putBlob = self.putBlob;
  const putManifest = self.putManifest;
  self.putBlob = (digest, file) => retryRegistry(`layer ${digest.slice(0, 19)}`, () => putBlob(digest, file), retry);
  self.putManifest = (tag, bytes, type) => retryRegistry(`image ${tag}`, () => putManifest(tag, bytes, type), retry);
  return self;
}

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(`sha256:${hash.digest('hex')}`)).on('error', reject);
});

/** One image, source tag to destination tag, layer by layer. An index is
 *  narrowed to its linux/amd64 image: that is what Fly machines run. */
export async function copyImage(source, dest, tag, workdir) {
  let { bytes, type } = await source.manifest(tag);
  let doc = JSON.parse(bytes.toString('utf8'));
  if (Array.isArray(doc.manifests)) {
    const pick = doc.manifests.find((entry) => entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64');
    if (!pick) throw new Error(`${tag} has no linux/amd64 image`);
    ({ bytes, type } = await source.manifest(pick.digest));
    doc = JSON.parse(bytes.toString('utf8'));
  }
  let moved = 0;
  for (const blob of [doc.config, ...(doc.layers ?? [])]) {
    if (await dest.hasBlob(blob.digest)) continue;
    const file = path.join(workdir, blob.digest.replace(':', '-'));
    await source.blobTo(blob.digest, file);
    // Checked before it goes anywhere: a layer is only ever the bytes its
    // digest names.
    if ((await sha256(file)) !== blob.digest) throw new Error(`Layer ${blob.digest} arrived damaged`);
    await dest.putBlob(blob.digest, file);
    moved += blob.size ?? 0;
    rmSync(file, { force: true });
  }
  const digest = await dest.putManifest(tag, bytes, type);
  return { digest, moved };
}

/** Every image of one release into the copy's registry. */
export async function copyRelease({ source, dest, version = 'latest', log = say }) {
  const release = await source.release(version);
  const workdir = mkdtempSync(path.join(tmpdir(), 'acc-copy-'));
  const copied = {};
  try {
    for (const [name, image] of Object.entries(release.images)) {
      const started = Date.now();
      const { digest, moved } = await copyImage(source, dest, image.tag, workdir);
      copied[name] = { tag: image.tag, digest };
      log(`  ${name.padEnd(12)} ${image.tag}  ${(moved / 1e6).toFixed(0)} MB moved in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  return { release, copied };
}

// ── The installer: one command, an organization and a domain ──

const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PREFIX_SHAPE = /^[a-z][a-z0-9-]{0,40}[a-z0-9]$/;
const FLY_GRAPHQL = 'https://api.fly.io/graphql';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const lastLines = (text, n = 6) => String(text ?? '').trim().split('\n').slice(-n).join('\n');

// What a person is asked for, in the same words wherever it is asked.
const ORG_NEEDED = '--org is the Fly organization your own Agentic Cloud goes into (its slug, as `fly orgs list` shows). Its bill pays for every machine, so the person who owns it chooses.';
const DOMAIN_NEEDED = '--domain is the name your own Agentic Cloud lives on, like agents.theirco.com: a name of its own, not the company\'s main domain.';
const PREFIX_NEEDED = '--name is a short lowercase prefix for its app names, like theirco.';
const NO_TOKEN = 'No Fly token: set FLY_API_TOKEN, or sign in with `fly auth login`.';
const keyForAnotherDomain = (updateKey, domain) => `This update key was issued for ${updateKey.domain}, not ${domain}. Ask us for a key for ${domain}, or use that domain.`;

/** What the install says about email, wherever it says it. */
export const MAIL_LATER = 'Email is not part of the install: once your own Agentic Cloud is up, an admin sets it up in the Workspace, under Mail, with the mail provider\'s details. The Workspace then creates the mail receiver in this same Fly organization and shows the records to add.';

/** The mail flags of installers before note #946. Mail is set up later, in
 *  the Workspace, so they are refused rather than quietly ignored: whoever
 *  passed one expects mail to be working at the end. */
export function refuseMailFlags(options) {
  const given = ['resend-key-file', 'smtp-host', 'smtp-port', 'smtp-user', 'smtp-password-file'].filter((flag) => options[flag] !== undefined);
  if (given.length) throw new UsageError(`--${given[0]} is not taken any more. ${MAIL_LATER}`);
}

/** What an update key says about itself: who it was issued to and for which
 *  domain. The update service checks the signature; this only reads. */
export function readUpdateKey(text) {
  const key = String(text ?? '').trim();
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'acc1') throw new Error('That file does not hold an update key (one line starting acc1.).');
  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { /* damaged, below */ }
  if (payload?.kind !== 'update' || !payload.customer || !payload.domain) throw new Error('That update key is damaged. Ask us for the file again.');
  return { key, customer: payload.customer, domain: payload.domain, until: payload.updatesUntil };
}

/**
 * Licensing is OFF: the product is free for now, so an install needs no
 * update key and no licence, the update service hands releases to anyone,
 * and the installed cloud checks and counts nothing. The whole mechanism
 * stays in the code behind this one switch, COPY_LICENCE=on (the same name
 * on the update service and in the installed backend), and comes back by
 * setting it.
 */
export const licensingOn = () => String(process.env.COPY_LICENCE ?? '').trim().toLowerCase() === 'on';

/** The app prefix when nobody gives one and no key names a customer: the
 *  domain's labels before its last, so agents.theirco.com is agents-theirco. */
export function prefixFromDomain(domain) {
  const labels = String(domain).toLowerCase().split('.').slice(0, -1);
  const prefix = labels.join('-').replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, '').slice(0, 42).replace(/-+$/, '');
  return prefix;
}

/** Who the releases are fetched as: with licensing off, nobody in particular
 *  (no key is read, even if one is given); with it on, the update key. */
export function releaseAccess(options, domain) {
  if (!licensingOn()) {
    const customer = String(options.name ?? prefixFromDomain(domain)).toLowerCase();
    return { key: null, customer, domain, until: null };
  }
  const updateKey = readKeyFile(options['key-file']);
  if (domain && updateKey.domain !== domain) throw new PersonNeeded('update-key', keyForAnotherDomain(updateKey, domain));
  return updateKey;
}

/** The update key from its file. It comes from us with the agreement, so a
 *  missing or damaged one is for a person to fetch, not a failure. */
export function readKeyFile(file) {
  const fromUs = 'It comes from us with the agreement, one line in a file.';
  if (!file || file === true) throw new PersonNeeded('update-key', `The install needs its update key: --key-file <file>. ${fromUs}`);
  if (!existsSync(file)) throw new PersonNeeded('update-key', `There is no update key at ${file}. ${fromUs}`);
  try {
    return readUpdateKey(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PersonNeeded('update-key', error.message);
  }
}

/** The licence, or its deliberate absence (--no-licence). Read for its
 *  domain only: the installed backend checks the signature itself. A run
 *  that carries on from a state file already stored it. */
export function readLicence(options, domain, { resuming = false } = {}) {
  if (!licensingOn()) return { text: null, detail: 'not needed: licensing is off, the product is free for now' };
  if (options['licence-file'] && options['licence-file'] !== true) {
    const file = options['licence-file'];
    if (!existsSync(file)) throw new PersonNeeded('licence', `There is no licence at ${file}. It comes from us with the agreement, one line in a file.`);
    const text = readFileSync(file, 'utf8').trim();
    let payload = null;
    try { payload = JSON.parse(Buffer.from(text.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { /* below */ }
    if (payload?.kind !== 'licence') throw new PersonNeeded('licence', 'That file does not hold a licence. Ask us for the licence file.');
    if (payload.domain !== domain) throw new PersonNeeded('licence', `This licence was issued for ${payload.domain}, not ${domain}.`);
    return { text, detail: `for ${payload.people ?? 'any number of'} people at ${payload.domain}, until ${payload.ends ?? 'no end date'}` };
  }
  if (options['no-licence']) return { text: null, detail: 'none, by --no-licence (only when the agreement says so)' };
  if (resuming) return { text: null, detail: 'stored by an earlier run' };
  throw new PersonNeeded('licence', 'Your own Agentic Cloud needs its licence: --licence-file <file>. Run with --no-licence only if your contract says it has none.');
}

/** Everything a copy is made of, named from one prefix. Fly app names are
 *  shared by every Fly customer, so the prefix must be one nobody else took. */
export function namesFor(prefix) {
  return {
    images: `${prefix}-images`,
    backend: `${prefix}-backend`,
    git: `${prefix}-git`,
    router: `${prefix}-router`,
    mx: `${prefix}-mx`,
    media: `${prefix}-media`,
    backups: `${prefix}-backups`,
  };
}

/** Each app's machine and disk: what appConfigs writes, and what --plan
 *  prices, from this one table. */
export const SHAPES = {
  backend: { size: 'shared-cpu-2x', cpus: 2, memory: '2gb', mb: 2048, diskGb: 3 },
  git: { size: 'shared-cpu-1x', cpus: 1, memory: '512mb', mb: 512, diskGb: 3 },
  router: { size: 'shared-cpu-1x', cpus: 1, memory: '256mb', mb: 256 },
  // Only a mail receiver an installer before note #946 made: the upgrade
  // keeps rolling it. One the Workspace makes is the Workspace's to keep.
  mx: { size: 'shared-cpu-1x', cpus: 1, memory: '256mb', mb: 256, diskGb: 1 },
};

/** Fly's published prices, as estimates (Fly's dashboard has the real bill):
 *  a shared core with 256 MB is $1.94 a month and each GB beyond it $5, a
 *  disk $0.15 per GB, a dedicated IPv4 $2, and an agent's machine
 *  (performance-2x, 4 GB) about $0.09 an hour while it is awake. */
const PRICE = { sharedCore: 1.94, ramGb: 5, includedGbPerCore: 0.25, diskGb: 0.15, ipv4: 2, agentHour: 0.09 };
const cents = (usd) => Math.round(usd * 100) / 100;
export const machineMonthlyUsd = ({ cpus, mb }) => cents(cpus * PRICE.sharedCore + Math.max(0, mb / 1024 - cpus * PRICE.includedGbPerCore) * PRICE.ramGb);

const q = (value) => JSON.stringify(String(value));
const envBlock = (env) => Object.entries(env).map(([name, value]) => `  ${name} = ${q(value)}`).join('\n');

/** The backend's settings. Every name a copy hands out is its own domain;
 *  every image is in its own registry; PRIVATE_COPY turns on what a copy does
 *  differently (invite-only, its own code host and spend). */
export function backendEnv({ names, org, region, domain, tags, peerIp, version, extra = {} }) {
  const image = (name) => `registry.fly.io/${names.images}:${tags[name]}`;
  return {
    NODE_ENV: 'production',
    PORT: '8080',
    SQLITE_DB_PATH: '/data/backend.db',
    DEPLOY_STAGING_DIR: '/data/deploy-staging',
    FLY_ORG: org,
    FLY_REGION: region,
    FLY_IDLE_STOP_MINUTES: '3',
    FLY_VOLUME_SIZE_GB: '5',
    HARNESS_STREAM_INPUT: '1',
    FLY_MACHINE_IMAGE: image('machine'),
    FLY_APP_RUNTIME_IMAGE: image('app-runtime'),
    FLY_GIT_HOST_IMAGE: image('git-host'),
    FLY_MSG_HOST_IMAGE: image('msg-host'),
    // The mail receiver the Workspace makes when an admin sets email up.
    ...(tags.mx ? { FLY_MX_IMAGE: image('mx') } : {}),
    FLY_IMAGE_APP: names.images,
    WORKSPACE_URL: `https://${domain}`,
    WORKSPACE_COMPATIBLE_ORIGINS: `https://${names.backend}.fly.dev`,
    AGENTBUILT_API_URL: `https://${domain}`,
    CORS_ORIGIN: `https://${domain}`,
    GIT_HOST_BASE_URL: `https://git.${domain}`,
    GIT_HOST_CONTROL_URL: `https://${names.git}.fly.dev`,
    APPS_DOMAIN: domain,
    MAIL_DOMAIN: domain,
    PRIVATE_COPY: '1',
    // What the health page says the copy runs.
    ...(version ? { COPY_RELEASE: version } : {}),
    ...(peerIp ? { FLY_BACKEND_PEER_IP: peerIp } : {}),
    // The admin's own additions, kept in the state file's extraEnv.backend.
    ...extra,
  };
}

/** The four apps' Fly configurations for one copy and one release. */
export function appConfigs({ names, org, region, domain, tags, peerIp, version, extraEnv = {} }) {
  const head = (app, what) => [
    `# ${what}: your own Agentic Cloud at ${domain}, release ${version}. Written by install.mjs;`,
    '# the installer and the upgrade command write it again, so change it there.',
    `app = ${q(app)}`,
    `primary_region = ${q(region)}`,
  ].join('\n');
  const vm = (shape) => `[[vm]]\n  size = ${q(shape.size)}\n  memory = ${q(shape.memory)}`;
  const check = (path, grace) => [
    '[[http_service.checks]]',
    `  grace_period = ${q(grace)}`,
    '  interval = "30s"',
    '  method = "GET"',
    '  timeout = "5s"',
    `  path = ${q(path)}`,
  ].join('\n');
  const http = (alwaysOn) => [
    '[http_service]',
    '  internal_port = 8080',
    '  force_https = true',
    `  auto_stop_machines = ${alwaysOn ? '"off"' : '"stop"'}`,
    '  auto_start_machines = true',
    `  min_machines_running = ${alwaysOn ? 1 : 0}`,
  ].join('\n');
  const mount = (source, size, snapshots = true) => [
    '[[mounts]]',
    `  source = ${q(source)}`,
    '  destination = "/data"',
    `  initial_size = ${q(size)}`,
    ...(snapshots ? ['  snapshot_retention = 7'] : []),
  ].join('\n');
  const internal = `http://${names.backend}.internal:8080`;
  return {
    backend: [
      head(names.backend, 'The Workspace and everything behind it'),
      'kill_signal = "SIGTERM"\nkill_timeout = "30s"',
      `[env]\n${envBlock(backendEnv({ names, org, region, domain, tags, peerIp, version, extra: extraEnv.backend }))}`,
      mount('backend_data', `${SHAPES.backend.diskGb}gb`),
      `${http(true)}\n  [http_service.concurrency]\n    type = "requests"\n    soft_limit = 200\n    hard_limit = 250`,
      check('/api/health', '60s'),
      vm(SHAPES.backend),
    ].join('\n\n'),
    git: [
      head(names.git, 'The code host'),
      `[env]\n${envBlock({
        HOST: '::',
        PORT: '8080',
        DATA_ROOT: '/data',
        BACKEND_URL: `https://${domain}`,
        CI_WEBHOOK_URL: `https://${domain}/api/agent-cli/git/ci-webhook`,
        COMMIT_EMAIL: `noreply@${domain}`,
      })}`,
      mount('git_data', `${SHAPES.git.diskGb}gb`),
      http(false),
      vm(SHAPES.git),
    ].join('\n\n'),
    router: [
      head(names.router, 'Previews and sites on *.' + domain),
      `[env]\n${envBlock({ APPS_DOMAIN: domain, BACKEND_URL: internal, PORT: '8080' })}`,
      http(true),
      check('/__router/health', '10s'),
      vm(SHAPES.router),
    ].join('\n\n'),
    mx: [
      head(names.mx, 'The mail receiver'),
      `[env]\n${envBlock({
        MAIL_DOMAIN: domain,
        MX_HOSTNAME: `mx.${domain}`,
        BACKEND_URL: internal,
        PORT: '2525',
        CERT_DIR: '/data/tls',
        HTTP_PORT: '8080',
      })}`,
      [
        '[[services]]',
        '  internal_port = 2525',
        '  protocol = "tcp"',
        '  auto_stop_machines = "off"',
        '  auto_start_machines = true',
        '  min_machines_running = 1',
        '  [[services.ports]]',
        '    port = 25',
        '    handlers = ["proxy_proto"]',
        '    [services.ports.proxy_proto_options]',
        '      version = "v1"',
        '  [[services.tcp_checks]]',
        '    interval = "30s"',
        '    timeout = "5s"',
        '    grace_period = "10s"',
      ].join('\n'),
      '# Port 80 on the receiver\'s own address: Let\'s Encrypt\'s HTTP-01 check and /health.',
      [
        '[[services]]',
        '  internal_port = 8080',
        '  protocol = "tcp"',
        '  auto_stop_machines = "off"',
        '  auto_start_machines = true',
        '  [[services.ports]]',
        '    port = 80',
        '    handlers = ["http"]',
      ].join('\n'),
      mount('mx_data', `${SHAPES.mx.diskGb}gb`, false),
      vm(SHAPES.mx),
    ].join('\n\n'),
  };
}

/** The records the copy's domain needs, all DNS only (never proxied). */
export function dnsRecords({ domain, names, backendV4, backendV6, acmeTarget, gitAcmeTarget }) {
  return [
    { name: domain, type: 'A', value: backendV4, why: 'the Workspace' },
    { name: domain, type: 'AAAA', value: backendV6, why: 'the Workspace' },
    { name: `git.${domain}`, type: 'CNAME', value: `${names.git}.fly.dev`, why: 'the code host' },
    { name: `*.${domain}`, type: 'CNAME', value: `${names.router}.fly.dev`, why: 'previews and sites' },
    { name: `_acme-challenge.${domain}`, type: 'CNAME', value: acmeTarget, why: 'the certificate for previews and sites' },
    // The code host's certificate can be proved by DNS too, from the start,
    // instead of only through the sleeping code host itself.
    ...(gitAcmeTarget ? [{ name: `_acme-challenge.git.${domain}`, type: 'CNAME', value: gitAcmeTarget, why: 'the certificate for the code host, proved by DNS' }] : []),
    // No mail records: the Workspace shows those when an admin sets email up.
  ];
}

export function formatRecords(records) {
  const width = Math.max(...records.map((record) => record.name.length));
  return records.map((record) => {
    const value = record.type === 'MX' ? `${record.priority} ${record.value}` : record.type === 'TXT' ? q(record.value) : record.value;
    return `  ${record.name.padEnd(width)}  ${record.type.padEnd(5)}  ${value}`;
  }).join('\n');
}

/** Where Fly wants the code host's DNS-validation record to point (the
 *  `_acme-challenge.git.` CNAME), as `fly certs show` reports it for that
 *  name; null when Fly gives none. Only reads. */
export async function gitAcmeTargetOf(fly, names, domain) {
  try {
    const cert = JSON.parse(await fly(['certs', 'show', `git.${domain}`, '-a', names.git, '--json']));
    return bareHost(cert.dns_requirements?.acme_challenge?.target) || null;
  } catch {
    return null;
  }
}

/** One record as --json shows it: exactly what to add, and why. */
const publicRecord = (record) => ({
  name: record.name, type: record.type, value: record.value, ...(record.priority !== undefined ? { priority: record.priority } : {}), why: record.why,
});

const bareHost = (value) => String(value ?? '').trim().replace(/\.$/, '').toLowerCase();
const sameAddress = (a, b) => {
  const norm = (ip) => (String(ip).includes(':') ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : String(ip));
  try { return norm(a) === norm(b); } catch { return false; }
};

/** Asks the domain's own name servers, never a public resolver: a name asked
 *  before it exists is remembered as missing by resolvers for up to an hour,
 *  and the installer asks early and often. */
export async function authoritativeResolver(domain, { resolveNs = dnsPromises.resolveNs, resolve4 = dnsPromises.resolve4 } = {}) {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const zone = labels.slice(i).join('.');
    let servers = [];
    try { servers = await resolveNs(zone); } catch { continue; }
    const addresses = [];
    for (const server of servers) {
      try { addresses.push(...await resolve4(server)); } catch { /* the next one */ }
    }
    if (!addresses.length) continue;
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(addresses);
    return { zone, resolver };
  }
  throw new Error(`Could not find the name servers for ${domain}.`);
}

/** Whether one record answers as it should, and what it answers instead. */
export async function checkRecord(resolver, record) {
  const ask = (fn, name) => new Promise((resolve) => {
    resolver[fn](name, (error, answer) => resolve(error ? [] : answer));
  });
  // A wildcard is asked through a name under it.
  const name = record.name.startsWith('*.') ? `install-check.${record.name.slice(2)}` : record.name;
  let seen = [];
  if (record.type === 'A') seen = await ask('resolve4', name);
  else if (record.type === 'AAAA') seen = await ask('resolve6', name);
  else if (record.type === 'CNAME') seen = (await ask('resolveCname', name)).map(bareHost);
  else if (record.type === 'MX') seen = (await ask('resolveMx', name)).map((mx) => `${mx.priority} ${bareHost(mx.exchange)}`);
  else if (record.type === 'TXT') seen = (await ask('resolveTxt', name)).map((chunks) => chunks.join(''));
  const want = record.type === 'MX' ? `${record.priority} ${bareHost(record.value)}` : record.type === 'CNAME' ? bareHost(record.value) : record.value;
  // Any DMARC policy the domain's owner prefers will do; ours is a suggestion.
  const matches = record.name.startsWith('_dmarc.')
    ? (answer) => answer.startsWith('v=DMARC1')
    : (answer) => (record.type === 'A' || record.type === 'AAAA' ? sameAddress(answer, want) : answer === want);
  const ok = seen.some(matches);
  return { ok, seen };
}

/** flyctl, run with the copy's token. Output goes to the install log, except
 *  a command marked quiet, whose output holds keys. */
export function flyRunner({ bin, token, logFile }) {
  return (args, { input, quiet = false, cwd } = {}) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, FLY_API_TOKEN: token, FLY_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (logFile) appendFileSync(logFile, `\n$ fly ${args.join(' ')}\n${quiet ? '(output not kept: it holds keys)\n' : out}${err}`, { mode: 0o600 });
      if (code === 0) return resolve(out);
      reject(new Error(`fly ${args.slice(0, 2).join(' ')}: ${lastLines(err || (quiet ? '' : out)) || `exit ${code}`}`));
    });
    // A flyctl that exits without reading its input (most commands) must
    // not crash the installer with EPIPE: its exit code says how it went.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function findFlyctl(env = process.env) {
  if (env.FLYCTL) return env.FLYCTL;
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    for (const name of ['fly', 'flyctl']) {
      const candidate = path.join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  const home = path.join(homedir(), '.fly', 'bin', 'flyctl');
  return existsSync(home) ? home : null;
}

export async function flyGraphql(token, query, variables = {}, fetchImpl = fetch) {
  const answer = await fetchImpl(FLY_GRAPHQL, {
    method: 'POST',
    headers: { authorization: token.startsWith('FlyV1 ') ? token : `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await answer.json().catch(() => ({}));
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
  if (!answer.ok) throw new Error(`Fly answered ${answer.status}`);
  return body.data;
}

/** The organization can pay for what the copy needs, or the install stops
 *  before anything is made. */
export async function checkOrganization(token, org, fetchImpl = fetch) {
  let data;
  try {
    data = await flyGraphql(token, 'query($slug: String!) { organization(slug: $slug) { slug name billable billingStatus } nearestRegion { code } }', { slug: org }, fetchImpl);
  } catch (error) {
    throw new PersonNeeded('fly-organization', `Fly did not show the organization ${org} to this token (${error.message}). Use a token of that organization.`);
  }
  const found = data?.organization;
  if (!found) throw new PersonNeeded('fly-organization', `There is no Fly organization ${org} for this token.`);
  const billing = { billingUrl: `https://fly.io/dashboard/${org}/billing` };
  if (!found.billable) throw new PersonNeeded('billing', `The organization ${org} has no card on file. Your own Agentic Cloud needs one: Fly bills the organization for its machines. Add it at fly.io/dashboard/${org}/billing and run this again.`, billing);
  if (found.billingStatus !== 'CURRENT') {
    throw new PersonNeeded('billing', `Fly says the organization ${org}'s bill is not paid (${String(found.billingStatus).toLowerCase().replace('_', ' ')}), and it refuses to create anything until it is. Settle it at fly.io/dashboard/${org}/billing and run this again.`, billing);
  }
  return { name: found.name, nearestRegion: data.nearestRegion?.code ?? null };
}

/** An Ed25519 key pair in OpenSSH's own format, the one the backend uses to
 *  reach its agents' machines (no ssh-keygen needed on the engineer's side). */
export function sshKeyPair(comment) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const u32 = (n) => { const buf = Buffer.alloc(4); buf.writeUInt32BE(n); return buf; };
  const str = (value) => { const buf = Buffer.from(value); return Buffer.concat([u32(buf.length), buf]); };
  const wirePub = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = randomBytes(4);
  let secret = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  for (let pad = 1; secret.length % 8 !== 0; pad += 1) secret = Buffer.concat([secret, Buffer.from([pad])]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(wirePub), str(secret)]);
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${wirePub.toString('base64')} ${comment}`,
  };
}

/** `fly storage create` prints a bucket's keys once, as NAME: value lines. */
export function bucketKeys(output) {
  const found = {};
  for (const line of String(output).split('\n')) {
    const match = /^\s*(AWS_[A-Z_0-9]+|BUCKET_NAME):\s*(\S+)\s*$/.exec(line);
    if (match) found[match[1]] = match[2];
  }
  if (!found.AWS_ACCESS_KEY_ID || !found.AWS_SECRET_ACCESS_KEY || !found.BUCKET_NAME) throw new Error('fly storage create did not print the bucket\'s keys');
  return {
    bucket: found.BUCKET_NAME,
    endpoint: found.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
    region: found.AWS_REGION || 'auto',
    accessKeyId: found.AWS_ACCESS_KEY_ID,
    secretAccessKey: found.AWS_SECRET_ACCESS_KEY,
  };
}

/** What the copy answers once it is up: every piece, over its own names. */
export async function smokeTest({ domain, fetchImpl = fetch }) {
  const results = [];
  const probe = async (what, run) => {
    try {
      const detail = await run();
      results.push({ what, ok: true, detail });
    } catch (error) {
      results.push({ what, ok: false, detail: error.message });
    }
  };
  const json = async (url) => {
    const answer = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
    return answer.json();
  };
  await probe(`https://${domain} answers`, async () => {
    const health = await json(`https://${domain}/api/health`);
    if (health.status !== 'ok') throw new Error(`health says ${JSON.stringify(health)}`);
    return 'healthy';
  });
  await probe('the sign-up page is its own', async () => {
    const answer = await fetchImpl(`https://${domain}/signup`, { signal: AbortSignal.timeout(20_000) });
    const page = await answer.text();
    if (!page.includes('<meta name="acc-private-copy" content="1">')) throw new Error('the page does not say it is your own Agentic Cloud');
    if (!page.includes(`<meta name="acc-public-host" content="${domain}">`)) throw new Error(`the page does not name ${domain}`);
    return 'invite-only, on its own name';
  });
  await probe(`https://git.${domain} answers`, async () => {
    const health = await json(`https://git.${domain}/health`);
    if (!health.ok) throw new Error(`health says ${JSON.stringify(health)}`);
    return `disk ${health.diskUsedPercent}% used`;
  });
  await probe(`previews and sites (*.${domain}) answer`, async () => {
    const health = await json(`https://install-check-${randomBytes(3).toString('hex')}.${domain}/__router/health`);
    if (!health.ok || health.domain !== domain) throw new Error(`router says ${JSON.stringify(health)}`);
    return 'certificate and router fine';
  });
  return results;
}

const jsonList = (text) => JSON.parse(text || '[]') ?? [];
const minutes = (ms) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/**
 * The whole install. Every step records itself in the state file when it is
 * done, so running the command again carries on from the first step that is
 * not; nothing is made twice. Keys live in the state file (mode 600) only
 * until they are stored in Fly, and the two the admin must see (the master
 * key and the first account's code) until they are printed at the end.
 */
export async function install(options, deps = {}) {
  const log = deps.say ?? say;
  const emit = eventSink(options, deps);
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) throw new Error(`Node ${process.versions.node} is too old; the installer needs 20 or newer.`);

  const domain = String(options.domain ?? '').toLowerCase().replace(/\.$/, '');
  const org = String(options.org ?? '');
  if (!org) throw new PersonNeeded('fly-organization', ORG_NEEDED);
  if (!DOMAIN_SHAPE.test(domain)) throw new PersonNeeded('domain', DOMAIN_NEEDED);
  const updateKey = releaseAccess(options, domain);
  refuseMailFlags(options);
  const prefix = String(options.name ?? updateKey.customer).toLowerCase();
  const licence = readLicence(options, domain, { resuming: existsSync(path.resolve(options.state ?? `${prefix}-copy.json`)) });
  const licenceText = licence.text;
  if (!PREFIX_SHAPE.test(prefix)) throw new UsageError(PREFIX_NEEDED);
  const names = namesFor(prefix);

  const stateFile = path.resolve(options.state ?? `${prefix}-copy.json`);
  const logFile = path.resolve(`${prefix}-install.log`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { steps: {} };
  if (state.domain && state.domain !== domain) throw new Error(`${stateFile} is the record of ${state.domain}, not ${domain}.`);
  const save = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  Object.assign(state, { prefix, org, domain, customer: updateKey.customer });
  if (options['no-licence'] || !licensingOn()) state.extraEnv = { ...state.extraEnv, backend: { ...state.extraEnv?.backend, COPY_LICENCE: 'off' } };
  else state.extraEnv = { ...state.extraEnv, backend: { ...state.extraEnv?.backend, COPY_LICENCE: 'on' } };

  const bin = deps.flyctl ?? findFlyctl();
  if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token, logFile })(args, opts));
  if (!token) token = (await fly(['auth', 'token'], { quiet: true })).trim();
  if (!token) throw new PersonNeeded('fly-sign-in', NO_TOKEN);

  let stepNumber = 0;
  const STEPS = 11;
  const step = async (key, title, run) => {
    stepNumber += 1;
    const label = `[${String(stepNumber).padStart(2)}/${STEPS}] ${title}`;
    const said = { event: 'step', step: stepNumber, of: STEPS, key, title };
    if (state.steps[key]) { log(`${label}: done before`); emit({ ...said, status: 'done-before' }); return; }
    const at = Date.now();
    log(`${label}…`);
    emit({ ...said, status: 'running' });
    await run();
    state.steps[key] = new Date().toISOString();
    save();
    const seconds = Math.round((Date.now() - at) / 1000);
    log(`${' '.repeat(8)}done in ${seconds} s`);
    emit({ ...said, status: 'done', seconds });
  };
  const setSecrets = async (app, values) => {
    const lines = Object.entries(values).map(([name, value]) => `${name}=${String(value).replace(/\n/g, '\\n')}`).join('\n');
    // Before the first deploy they wait for it; afterwards they restart the app.
    await fly(['secrets', 'import', '-a', app, ...(state.steps.deploy ? [] : ['--stage'])], { input: `${lines}\n`, quiet: true });
  };
  const ips = async (app) => jsonList(await fly(['ips', 'list', '-a', app, '--json']));

  log(`Your own Agentic Cloud for ${domain}, in the Fly organization ${org} (apps ${prefix}-*).`);
  log(`State: ${stateFile}   Log: ${logFile}`);

  // 1. Before anything is made: the organization can pay, the key opens a release.
  stepNumber += 1;
  log(`[ 1/${STEPS}] Checking the organization, the update key and the release…`);
  emit({ event: 'step', step: 1, of: STEPS, key: 'checks', title: 'Checking the organization, the update key and the release', status: 'running' });
  const orgFacts = await checkOrganization(token, org, fetchImpl);
  state.region = state.region ?? options.region ?? orgFacts.nearestRegion ?? 'iad';
  const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
  const release = state.release ?? await source.release(options.release || 'latest');
  log(`        ${orgFacts.name}: billing current. Region ${state.region}. Release ${release.version}.${updateKey.until ? ` Update key good for releases until ${updateKey.until}.` : ''}`);
  save();
  emit({ event: 'step', step: 1, of: STEPS, key: 'checks', title: 'Checking the organization, the update key and the release', status: 'done', release: release.version, region: state.region });

  await step('apps', 'Creating the four apps', async () => {
    const listed = jsonList(await fly(['apps', 'list', '-o', org, '--json'])).map((app) => app.Name ?? app.name);
    for (const app of [names.images, names.backend, names.git, names.router]) {
      if (listed.includes(app)) continue;
      try {
        await fly(['apps', 'create', app, '-o', org]);
      } catch (error) {
        if (/taken|already exists/i.test(error.message)) throw new Error(`The app name ${app} belongs to someone else on Fly. Run again with --name <another prefix>.`);
        throw error;
      }
    }
  });

  await step('release', `Copying release ${release.version} into registry.fly.io/${names.images}`, async () => {
    const dest = (deps.flyRegistry ?? flyRegistry)({ app: names.images, token, fetchImpl });
    const { copied } = await (deps.copyRelease ?? copyRelease)({ source, dest, version: release.version, log });
    state.release = { version: release.version, commit: release.commit, tags: Object.fromEntries(Object.entries(copied).map(([name, image]) => [name, image.tag])) };
  });

  await step('buckets', 'Creating the two buckets (files, database backups)', async () => {
    state.pending = state.pending ?? {};
    for (const [key, bucket] of [['media', names.media], ['backups', names.backups]]) {
      if (state.pending[key]) continue;
      const output = await fly(['storage', 'create', '-n', bucket, '-o', org, '--yes'], { quiet: true });
      state.pending[key] = bucketKeys(output);
      save();
    }
  });

  await step('keys', 'Making the keys', async () => {
    const ssh = sshKeyPair(`${names.backend}@${domain}`);
    let backendToken = null;
    try {
      const minted = (await fly(['tokens', 'create', 'org', '-o', org, '-n', `${names.backend} (your own Agentic Cloud)`, '-x', '87600h'], { quiet: true })).trim();
      backendToken = minted.split('\n').find((line) => line.startsWith('FlyV1 ')) ?? null;
    } catch { /* an organization token cannot make another: the backend keeps this one */ }
    if (!backendToken) log('        The backend keeps the organization token this install runs with (it cannot make a second one).');
    state.pending = {
      ...state.pending,
      FLY_API_TOKEN: backendToken ?? token,
      FLY_SSH_PRIVATE_KEY: ssh.privateKey,
      FLY_SSH_PUBLIC_KEY: ssh.publicKey,
      SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
      GIT_HOST_SECRET: randomBytes(32).toString('hex'),
      CI_STATUS_SECRET: randomBytes(32).toString('hex'),
      // Kept by the backend for the mail receiver it makes later, if an admin
      // sets email up: the receiver presents it on every message it hands in.
      MAIL_INGEST_SECRET: randomBytes(32).toString('hex'),
      FIRST_ACCOUNT_CODE: randomBytes(18).toString('base64url'),
    };
  });

  await step('secrets', 'Storing the keys in Fly', async () => {
    const p = state.pending;
    await setSecrets(names.backend, {
      FLY_API_TOKEN: p.FLY_API_TOKEN,
      FLY_SSH_PRIVATE_KEY: p.FLY_SSH_PRIVATE_KEY,
      FLY_SSH_PUBLIC_KEY: p.FLY_SSH_PUBLIC_KEY,
      SECRETS_MASTER_KEY: p.SECRETS_MASTER_KEY,
      GIT_HOST_SECRET: p.GIT_HOST_SECRET,
      CI_STATUS_SECRET: p.CI_STATUS_SECRET,
      MAIL_INGEST_SECRET: p.MAIL_INGEST_SECRET,
      FIRST_ACCOUNT_CODE: p.FIRST_ACCOUNT_CODE,
      ...(licenceText ? { LICENCE: licenceText } : {}),
      MEDIA_S3_ENDPOINT: p.media.endpoint,
      MEDIA_S3_BUCKET: p.media.bucket,
      MEDIA_S3_REGION: p.media.region,
      MEDIA_S3_ACCESS_KEY_ID: p.media.accessKeyId,
      MEDIA_S3_SECRET_ACCESS_KEY: p.media.secretAccessKey,
      BACKUP_S3_ENDPOINT: p.backups.endpoint,
      BACKUP_S3_BUCKET: p.backups.bucket,
      BACKUP_S3_ACCESS_KEY_ID: p.backups.accessKeyId,
      BACKUP_S3_SECRET_ACCESS_KEY: p.backups.secretAccessKey,
    });
    await setSecrets(names.git, { GIT_HOST_SECRET: p.GIT_HOST_SECRET, CI_WEBHOOK_SECRET: p.GIT_HOST_SECRET });
    // Stored: from here the file keeps only what the admin is shown at the end.
    state.pending = { SECRETS_MASTER_KEY: p.SECRETS_MASTER_KEY, FIRST_ACCOUNT_CODE: p.FIRST_ACCOUNT_CODE };
  });

  await step('addresses', 'Taking the addresses (shared, no charge)', async () => {
    for (const app of [names.backend, names.git, names.router]) {
      const have = await ips(app);
      if (!have.some((ip) => ip.Type === 'shared_v4' || ip.Type === 'v4')) await fly(['ips', 'allocate-v4', '--shared', '-a', app, '--yes']);
      if (!have.some((ip) => ip.Type === 'v6')) await fly(['ips', 'allocate-v6', '-a', app]);
    }
  });

  const deployApp = (which, peerIp) => deployOne({ fly, state, names, which, release: state.release, peerIp });

  await step('deploy', 'Starting the three apps from your own registry', async () => {
    for (const which of ['backend', 'git', 'router']) {
      const at = Date.now();
      await deployApp(which);
      log(`        ${names[which].padEnd(22)} up in ${((Date.now() - at) / 1000).toFixed(0)} s`);
    }
    // The backend pins its agents' machines to its own private address, which
    // exists only once its machine does.
    const machines = jsonList(await fly(['machine', 'list', '-a', names.backend, '--json']));
    state.peerIp = machines[0]?.private_ip;
    if (!state.peerIp) throw new Error('the backend\'s machine has no private address yet');
    await deployApp('backend', state.peerIp);
  });

  await step('certificates', 'Asking for the certificates', async () => {
    for (const [app, host] of [[names.backend, domain], [names.git, `git.${domain}`], [names.router, `*.${domain}`]]) {
      const have = jsonList(await fly(['certs', 'list', '-a', app, '--json'])).map((cert) => cert.Hostname ?? cert.hostname);
      if (!have.includes(host)) await fly(['certs', 'add', host, '-a', app]);
    }
    const wildcard = JSON.parse(await fly(['certs', 'show', `*.${domain}`, '-a', names.router, '--json']));
    state.acmeTarget = bareHost(wildcard.dns_requirements?.acme_challenge?.target);
    state.gitAcmeTarget = await gitAcmeTargetOf(fly, names, domain);
    const backendIps = await ips(names.backend);
    state.backendV4 = backendIps.find((ip) => ip.Type === 'shared_v4' || ip.Type === 'v4')?.Address;
    state.backendV6 = backendIps.find((ip) => ip.Type === 'v6')?.Address;
    if (!state.acmeTarget || !state.backendV4 || !state.backendV6) throw new Error('Fly did not report every address yet; run again in a minute.');
  });

  // An install begun before the installer asked for it reads it now.
  if (!state.gitAcmeTarget) {
    state.gitAcmeTarget = await gitAcmeTargetOf(fly, names, domain);
    save();
  }
  if (!state.gitAcmeTarget && !state.steps.dns) log(`        Fly gave no DNS-validation record for git.${domain}; its certificate is proved through the code host alone.`);
  const records = dnsRecords({
    domain, names, backendV4: state.backendV4, backendV6: state.backendV6, acmeTarget: state.acmeTarget, gitAcmeTarget: state.gitAcmeTarget,
  });
  await step('dns', 'Waiting for the DNS records and the certificates', async () => {
    log(`\n  Add these ${records.length} records at ${domain}'s DNS provider, all DNS only (not proxied):\n\n${formatRecords(records)}\n`);
    emit({ event: 'dns-records', domain, records: records.map(publicRecord) });
    log('  The installer checks them with the domain\'s own name servers every 15 s. You can stop it and');
    log('  run the same command again later: it carries on from here.\n');
    const { resolver } = await (deps.authoritativeResolver ?? authoritativeResolver)(domain);
    const deadline = Date.now() + Number(options.wait ?? 60) * 60_000;
    let said = '';
    let certsCheckedAt = 0;
    for (;;) {
      const missing = [];
      for (const record of records) if (!(await checkRecord(resolver, record)).ok) missing.push(record);
      const certs = {};
      for (const [app, host] of [[names.backend, domain], [names.git, `git.${domain}`], [names.router, `*.${domain}`]]) {
        certs[host] = JSON.parse(await fly(['certs', 'show', host, '-a', app, '--json'])).status;
      }
      const certsWaiting = Object.entries(certs).filter(([, status]) => status !== 'Ready').map(([host]) => host);
      if (!missing.length && certsWaiting.length && Date.now() - certsCheckedAt > 60_000) {
        for (const host of certsWaiting) {
          const app = host === domain ? names.backend : host.startsWith('git.') ? names.git : names.router;
          await fly(['certs', 'check', host, '-a', app]).catch(() => {});
        }
        certsCheckedAt = Date.now();
      }
      const line = [
        missing.length ? `${records.length - missing.length} of ${records.length} records right (waiting for ${missing.map((r) => `${r.name} ${r.type}`).join(', ')})` : `all ${records.length} records right`,
        certsWaiting.length ? `certificates waiting: ${certsWaiting.join(', ')}` : 'certificates issued',
      ].join('; ');
      const where = { missing: missing.map(publicRecord), certificatesWaiting: certsWaiting };
      if (line !== said) { log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`); said = line; emit({ event: 'waiting', ...where }); }
      if (!missing.length && !certsWaiting.length) break;
      if (Date.now() > deadline) {
        if (missing.length) {
          throw new PersonNeeded('dns', `${missing.length} of ${records.length} DNS records are not in place at ${domain}'s name servers yet. Add them, all DNS only, then run the same command again: it carries on from here.`, { domain, records: missing.map(publicRecord), allRecords: records.map(publicRecord) });
        }
        throw new StillWaiting('certificates', `Every DNS record is in; still waiting for the certificates of ${certsWaiting.join(', ')}. Nobody needs to do anything. Run the same command again later: it carries on from here. Fly can take over an hour for one certificate.`, where);
      }
      await sleep(deps.pollMs ?? 15_000);
    }
  });

  await step('smoke', 'Smoke test', async () => {
    const results = await (deps.smokeTest ?? smokeTest)({ domain, fetchImpl });
    for (const result of results) log(`        ${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}: ${result.detail}`);
    if (results.some((result) => !result.ok)) throw new Error('The smoke test failed (above). Run the same command again once it is fixed.');
  });

  const shown = state.pending ?? {};
  // With --json the two secrets go to a file only its owner can read, never
  // onto a screen or into a program's output: an agent hands the file over.
  const handoverFile = options.json && (shown.FIRST_ACCOUNT_CODE || shown.SECRETS_MASTER_KEY)
    ? path.join(path.dirname(stateFile), `${prefix}-handover.txt`) : null;
  log(`\nYour own Agentic Cloud is ready. This run took ${minutes(Date.now() - started)}.`);
  log(`\n  Sign-in address:  https://${domain}`);
  if (handoverFile) {
    writeFileSync(handoverFile, handoverText(domain, shown), { mode: 0o600 });
    chmodSync(handoverFile, 0o600);
    log(`  First admin and master key: in ${handoverFile}, readable only by this user.`);
    log('                    Give that file to the person who will be the admin. They open the link to');
    log('                    become the admin, keep the master key offline, then delete the file.');
  } else {
    if (shown.FIRST_ACCOUNT_CODE) {
      log(`  First admin:      https://${domain}/signup#first-account=${shown.FIRST_ACCOUNT_CODE}`);
      log('                    The first person to open it and sign up becomes the admin. It works once,');
      log('                    and only while there is no account yet; everyone else joins by invite.');
    }
    if (shown.SECRETS_MASTER_KEY) {
      log(`  Master key:       ${shown.SECRETS_MASTER_KEY}`);
      log('                    Keep it offline, now: this is the only time it is shown. Without it a database');
      log('                    restored into a new install cannot open the keys people saved in it.');
    }
  }
  log(`  Email:            not set up yet. An admin sets it up in the Workspace, under Mail, when they want it.`);
  log(`  Kept here:        ${stateFile} (names and addresses, no keys); the upgrade command reads it.`);
  state.pending = {};
  save();
  emit({
    event: 'result',
    outcome: 'done',
    exitCode: EXIT.done,
    command: 'install',
    domain,
    signInUrl: `https://${domain}`,
    release: state.release?.version ?? null,
    stateFile,
    handoverFile,
    mail: 'later, from the Workspace',
    person: handoverFile ? [
      `Open ${handoverFile}: the first-admin link in it makes the first admin, once.`,
      'Keep the master key in it offline, then delete the file.',
    ] : [],
  });
  return state;
}

/** The file --json leaves for the admin instead of printing the two secrets. */
function handoverText(domain, shown) {
  return [
    `Your own Agentic Cloud at https://${domain}`,
    '',
    ...(shown.FIRST_ACCOUNT_CODE ? [
      'First admin. The first person to open this and sign up becomes the admin. It works once,',
      'and only while there is no account yet; everyone else joins by invite:',
      `  https://${domain}/signup#first-account=${shown.FIRST_ACCOUNT_CODE}`,
      '',
    ] : []),
    ...(shown.SECRETS_MASTER_KEY ? [
      'Master key. Keep it offline, now: this is the only time it is shown. Without it a database',
      'restored into a new install cannot open the keys people saved in it:',
      `  ${shown.SECRETS_MASTER_KEY}`,
      '',
    ] : []),
    'Email is not set up yet. An admin sets it up in the Workspace, under Mail, when they want it.',
    '',
    'Delete this file once the master key is kept somewhere safe.',
    '',
  ].join('\n');
}

/** Which image each app runs, and the order a release rolls through them. */
const IMAGE_OF = { backend: 'backend', git: 'git-host', router: 'router', mx: 'mx' };
const ROLL_ORDER = ['backend', 'git', 'router', 'mx'];
/** The apps this install rolls: the mail receiver only when an installer
 *  before note #946 made it (its address is in the state file). One the
 *  Workspace made later, the Workspace keeps on its own release. */
export const rolledApps = (state) => ROLL_ORDER.filter((which) => which !== 'mx' || Boolean(state.mxV4));

/** One of the copy's four apps, deployed from its own registry at a release. */
export async function deployOne({ fly, state, names, which, release, peerIp, broken = false }) {
  // --drill backend: the new backend listens where Fly's health check never
  // looks, so it never turns healthy, as a Workspace that does not start.
  const extraEnv = broken ? { ...state.extraEnv, backend: { ...state.extraEnv?.backend, PORT: '8081' } } : state.extraEnv;
  const configs = appConfigs({
    names, org: state.org, region: state.region, domain: state.domain, tags: release.tags, peerIp, version: release.version, extraEnv,
  });
  const dir = mkdtempSync(path.join(tmpdir(), `${state.prefix}-${which}-`));
  try {
    writeFileSync(path.join(dir, 'fly.toml'), `${configs[which]}\n`);
    await fly(['deploy', '--config', path.join(dir, 'fly.toml'), '--app', names[which], '--image',
      `registry.fly.io/${names.images}:${release.tags[IMAGE_OF[which]]}`, '--ha=false', '--yes'], { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The copy's database, by SQLite's own tool inside the backend's machine:
 *  the online backup API, safe while the Workspace keeps writing. */
const sqlite = (fly, names, sql) => fly(['ssh', 'console', '-a', names.backend, '-C',
  `sqlite3 -cmd ".timeout 15000" /data/backend.db ${JSON.stringify(sql)}`]);

async function waitHealthy(url, fetchImpl, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const answer = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (answer.ok) return;
    } catch { /* restarting */ }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within ${timeoutMs / 1000} s`);
    await sleep(3000);
  }
}

/**
 * An upgrade with a way back:
 *
 *   node install.mjs upgrade --key-file <update key> [--release <version|latest>] [--drill]
 *
 * run where the installer left <prefix>-copy.json. It copies the new release
 * into the copy's registry, snapshots the database (SQLite's online backup,
 * kept on the backend's disk) and asks Fly for disk snapshots of the backend
 * and code host as a second net, then rolls the backend, code host and router
 * (and a mail receiver an older installer made) to the new release one by one and runs the smoke test. If
 * anything fails from the snapshot on, it rolls every app back to the
 * release it came from and puts the database back as it was at the
 * snapshot. Whatever was written in between is lost, which is why it is
 * minutes. `--drill` rehearses exactly that: once the new release passes, it
 * writes a mark into the database, fails on purpose, rolls back, and checks
 * the mark is gone. An upgrade that was interrupted carries on, with its own
 * snapshot, when the same command runs again.
 */
export async function upgrade(options, deps = {}) {
  const log = deps.say ?? say;
  const emit = eventSink(options, deps);
  const started = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Where the run is recorded: the state file here, or (on the upgrader
  // machine) the copy's own backup bucket, read back if it restarts.
  const store = deps.store ?? fileStore(findStateFile(options));
  const state = await store.load();
  if (!state.release?.tags || !state.steps?.smoke) throw new Error(`${store.name} is not a finished install. Run the installer to the end first.`);
  const updateKey = releaseAccess({ ...options, name: options.name ?? state.prefix }, state.domain);
  const save = () => store.save(state);
  const names = namesFor(state.prefix);
  const domain = state.domain;

  const bin = deps.flyctl ?? findFlyctl();
  if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const logFile = deps.logFile === undefined ? path.resolve(`${state.prefix}-upgrade.log`) : deps.logFile;
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token, logFile })(args, opts));
  if (!token) token = (await fly(['auth', 'token'], { quiet: true })).trim();
  if (!token) throw new PersonNeeded('fly-sign-in', NO_TOKEN);
  const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
  const smoke = deps.smokeTest ?? smokeTest;
  const timed = async (title, run) => {
    const at = Date.now();
    log(`  ${title}…`);
    emit({ event: 'step', title, status: 'running' });
    const result = await run();
    const seconds = Math.round((Date.now() - at) / 1000);
    log(`      done in ${seconds} s`);
    emit({ event: 'step', title, status: 'done', seconds });
    return result;
  };

  let run = state.upgrade;
  if (run) {
    log(`Carrying on with the upgrade from ${run.from.version} to ${run.toVersion} begun ${run.startedAt}.`);
  } else {
    await checkOrganization(token, state.org, fetchImpl);
    const target = await source.release(options.release || 'latest');
    if (target.version === state.release.version && !options.drill) {
      log(`${domain} already runs release ${target.version}; nothing to do.`);
      emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: target.version, unchanged: true });
      return state;
    }
    run = { from: state.release, toVersion: target.version, drill: options.drill === 'backend' ? 'backend' : Boolean(options.drill), startedAt: new Date().toISOString() };
    state.upgrade = run;
    await save();
    log(`Upgrading ${domain} from ${run.from.version} to ${run.toVersion}${run.drill === 'backend' ? ' as a drill: the new Workspace is made not to start, and the old release is put back without it' : run.drill ? ' as a drill: it fails on purpose once the new release is up, and rolls back' : ''}.`);
  }

  const rollBack = async (why) => {
    run.phase = 'rolling-back';
    await save();
    log(`\n  ${why}\n  Rolling back to ${run.from.version}, database as it was at ${run.snapshot.at}.`);
    for (const which of rolledApps(state)) await timed(`${names[which]} back to ${run.from.version}`, () => deployOne({ fly, state, names, which, release: run.from, peerIp: state.peerIp }));
    await timed('database back to the snapshot', async () => {
      await sqlite(fly, names, `.restore ${run.snapshot.file}`);
      // The Workspace drops what it held in memory and opens the snapshot.
      await fly(['apps', 'restart', names.backend]);
      await waitHealthy(`https://${domain}/api/health`, fetchImpl);
    });
    if (run.drill) {
      const marks = (await sqlite(fly, names, "SELECT count(*) FROM sqlite_master WHERE name = 'upgrade_drill'")).trim().split('\n').pop();
      if (marks !== '0') throw new Error('The drill\'s mark is still in the database: the snapshot was NOT put back. Look at the backend before anything else.');
      log('  The drill\'s mark, written after the snapshot, is gone: the database is the snapshot.');
    }
    const results = await smoke({ domain, fetchImpl });
    for (const result of results) log(`    ${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}: ${result.detail}`);
    if (results.some((result) => !result.ok)) throw new Error(`Rolled back to ${run.from.version}, but the smoke test still fails (above). The snapshot is ${run.snapshot.file} on ${names.backend}.`);
    delete state.upgrade;
    await save();
  };

  if (run.phase === 'rolling-back') {
    await rollBack('An earlier run was rolling back when it stopped.');
    log(`\n${domain} is back on ${run.from.version} (${minutes(Date.now() - started)}).`);
    emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: run.from.version, rolledBack: true });
    return state;
  }

  if (!run.to) {
    await timed(`Copying release ${run.toVersion} into registry.fly.io/${names.images}`, async () => {
      const dest = (deps.flyRegistry ?? flyRegistry)({ app: names.images, token, fetchImpl });
      const { release, copied } = await (deps.copyRelease ?? copyRelease)({ source, dest, version: run.toVersion, log });
      run.to = { version: release.version, commit: release.commit, tags: Object.fromEntries(Object.entries(copied).map(([name, image]) => [name, image.tag])) };
      await save();
    });
  }

  if (!run.snapshot) {
    await timed('Snapshotting the database', async () => {
      const file = `/data/pre-upgrade-${run.from.version}.db`;
      // One snapshot on the disk at a time: the one this upgrade can go back to.
      await fly(['ssh', 'console', '-a', names.backend, '-C', 'sh -c \'rm -f /data/pre-upgrade-*.db\'']);
      await sqlite(fly, names, `.backup ${file}`);
      const check = await fly(['ssh', 'console', '-a', names.backend, '-C', `sqlite3 ${file} "PRAGMA integrity_check"`]);
      if (!/\bok\b/.test(check)) throw new Error(`the snapshot ${file} failed its integrity check`);
      run.snapshot = { file, at: new Date().toISOString() };
      await save();
    });
    // A second net: Fly's own snapshots of the two disks that hold data.
    for (const app of [names.backend, names.git]) {
      for (const volume of jsonList(await fly(['volumes', 'list', '-a', app, '--json']).catch(() => '[]'))) {
        await fly(['volumes', 'snapshots', 'create', volume.id ?? volume.ID]).catch((error) => log(`  (Fly disk snapshot of ${app} not taken: ${error.message})`));
      }
    }
  }

  // The backend's address as it is now: Fly moves a machine now and then, and
  // a backend restored onto a new one has a new address. The backend goes by
  // its own and re-pins the machines itself; this keeps the
  // setting it is given, and what a diagnostics bundle shows, the same.
  const backendNow = jsonList(await fly(['machine', 'list', '-a', names.backend, '--json']).catch(() => '[]'))[0]?.private_ip;
  if (backendNow && backendNow !== state.peerIp) {
    log(`  The backend's private address is now ${backendNow} (was ${state.peerIp}).`);
    state.peerIp = backendNow;
    await save();
  }

  if (run.drill === 'backend' && !run.marked) {
    // Written after the snapshot and before anything moves: the put-back
    // database must not have it.
    await sqlite(fly, names, `CREATE TABLE IF NOT EXISTS upgrade_drill (at TEXT); INSERT INTO upgrade_drill VALUES ('${new Date().toISOString()}');`);
    run.marked = true;
    await save();
  }

  try {
    for (const which of rolledApps(state)) {
      const broken = run.drill === 'backend' && which === 'backend';
      await timed(`${names[which]} to ${run.to.version}${broken ? ' (made not to start, for the drill)' : ''}`, () => deployOne({ fly, state, names, which, release: run.to, peerIp: state.peerIp, broken }));
      if (broken) throw new Error(`Drill: the new backend was made not to start, and Fly reported it healthy anyway. Look at ${names.backend} before trusting this drill.`);
    }
    const results = await timed('Smoke test', () => smoke({ domain, fetchImpl }));
    for (const result of results) log(`    ${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}: ${result.detail}`);
    if (results.some((result) => !result.ok)) throw new Error('The smoke test failed on the new release (above).');
    if (run.drill === true) {
      await sqlite(fly, names, `CREATE TABLE IF NOT EXISTS upgrade_drill (at TEXT); INSERT INTO upgrade_drill VALUES ('${new Date().toISOString()}');`);
      throw new Error(`Drill: ${run.to.version} is up and passed; failing on purpose, with a mark written to the database after the snapshot.`);
    }
  } catch (error) {
    await rollBack(error.message);
    if (run.drill === 'backend' && !/Fly reported it healthy anyway/.test(error.message)) {
      log(`\nDrill done: the new Workspace did not start, and ${domain} was put back on ${run.from.version} with its database as it was, without it, in ${minutes(Date.now() - started)}.`);
      emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: run.from.version, drill: 'backend', rehearsed: run.to.version });
      return state;
    }
    if (run.drill === true) {
      log(`\nDrill done: ${domain} went to ${run.to.version}, came back to ${run.from.version} with its database as it was, in ${minutes(Date.now() - started)}.`);
      emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: run.from.version, drill: true, rehearsed: run.to.version });
      return state;
    }
    throw new Error(`The upgrade to ${run.to.version} failed and ${domain} is back on ${run.from.version} (${minutes(Date.now() - started)}).`);
  }

  state.previous = run.from;
  state.release = run.to;
  delete state.upgrade;
  await save();
  log(`\n${domain} runs release ${run.to.version}. This upgrade took ${minutes(Date.now() - started)}.`);
  log(`  The database as it was before is ${run.snapshot.file} on ${names.backend}, until the next upgrade.`);
  emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain, release: run.to.version, previous: run.from.version });
  return state;
}

/** The state file as the command keeps it here: names and addresses only. */
export function fileStore(file) {
  return {
    name: file,
    async load() {
      if (!existsSync(file)) throw new Error(`There is no ${file}. Run this where the installer left it, or give --state <file>.`);
      return JSON.parse(readFileSync(file, 'utf8'));
    },
    async save(state) {
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

// ── Upgrades on the upgrader machine (note #1008, designed on note #1007) ──
//
// An upgrade runs on a one-shot machine in the copy's own Fly organization,
// app <prefix>-upgrader, from the new release's own `upgrader` image. It runs
// the very `upgrade()` above, so its snapshots, smoke test and rollback are
// the command's own. It reads the copy's shape from Fly, not from a file, and
// keeps its run record, events and heartbeat in the copy's backup bucket:
// outside every app it rolls, so it can put the old release back when the
// new Workspace is what broke, and anyone can read where it stands after the
// Workspace restarts. The copy's backend makes the app and gives it its
// secrets (the organization token, the bucket's keys) at every start.

export const upgraderAppOf = (prefix) => `${prefix}-upgrader`;
const MACHINES_API = 'https://api.machines.dev/v1';
/** What the upgrader machine needs, as the app's secrets. */
export const UPGRADER_SECRETS = ['FLY_API_TOKEN', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'];
const HEARTBEAT_MS = 15_000;
/** A run whose heartbeat is older than this has no upgrader left. */
export const STALE_HEARTBEAT_MS = 120_000;

/** Fly's Machines API, the few calls an upgrade needs. A 404 is null. */
export function machinesApi({ token, base = MACHINES_API, fetchImpl = fetch }) {
  const call = async (method, pathname, body) => {
    const answer = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (answer.status === 404) return null;
    const text = await answer.text();
    if (!answer.ok) throw new Error(`Fly ${method} ${pathname.split('?')[0]}: ${answer.status} ${text.trim().slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    app: (name) => call('GET', `/apps/${name}`),
    machines: async (app) => (await call('GET', `/apps/${app}/machines`)) ?? [],
    machine: (app, id) => call('GET', `/apps/${app}/machines/${id}`),
    createMachine: (app, request) => call('POST', `/apps/${app}/machines`, request),
    destroyMachine: (app, id) => call('DELETE', `/apps/${app}/machines/${id}?force=true`),
    // Names only. Fly's answer to SETTING a secret echoes its value, so the
    // installer never sets one: the copy's backend does, and logs nothing.
    secretNames: async (app) => ((await call('GET', `/apps/${app}/secrets`))?.secrets ?? []).map((secret) => secret.name ?? secret.label),
  };
}

const imageTag = (image) => String(image ?? '').split('@')[0].split(':').pop() || null;
/** Settings Fly adds to every machine itself, never ours to write back. */
const FLY_OWN_ENV = new Set(['FLY_PROCESS_GROUP', 'PRIMARY_REGION']);

/**
 * The copy as Fly holds it, in the state file's own shape: no file is
 * needed, and none can be stale. Every setting the deploy writes comes back
 * from the backend machine's own config; whatever else is in it is the
 * admin's own addition (extraEnv), because the deploy writes [env] whole.
 */
export async function stateFromFly({ api, prefix, mx = 'keep' }) {
  const names = namesFor(prefix);
  const machineOf = async (app) => {
    const list = (await api.machines(app)).filter((machine) => machine.state !== 'destroyed');
    return list.find((machine) => machine.state === 'started') ?? list[0] ?? null;
  };
  const backend = await machineOf(names.backend);
  if (!backend?.config?.env) throw new Error(`${names.backend} has no machine to read the copy from.`);
  const env = backend.config.env;
  const [git, router] = [await machineOf(names.git), await machineOf(names.router)];
  if (!env.WORKSPACE_URL || !env.FLY_ORG || !env.COPY_RELEASE) throw new Error(`${names.backend} does not look like a finished install: WORKSPACE_URL, FLY_ORG or COPY_RELEASE is missing.`);
  const domain = new URL(env.WORKSPACE_URL).host;
  const tags = {
    backend: imageTag(backend.config.image),
    'git-host': imageTag(git?.config?.image) ?? imageTag(env.FLY_GIT_HOST_IMAGE),
    router: imageTag(router?.config?.image),
    machine: imageTag(env.FLY_MACHINE_IMAGE),
    'app-runtime': imageTag(env.FLY_APP_RUNTIME_IMAGE),
    'msg-host': imageTag(env.FLY_MSG_HOST_IMAGE),
    ...(env.FLY_MX_IMAGE ? { mx: imageTag(env.FLY_MX_IMAGE) } : {}),
  };
  for (const [name, tag] of Object.entries(tags)) if (!tag) throw new Error(`Could not tell which ${name} image ${prefix} runs.`);
  const region = env.FLY_REGION || backend.region;
  const peerIp = backend.private_ip ?? env.FLY_BACKEND_PEER_IP;
  const written = new Set([
    ...Object.keys(backendEnv({ names, org: env.FLY_ORG, region, domain, tags: { ...tags, mx: tags.mx ?? 'mx' }, peerIp: 'x', version: 'x' })),
  ]);
  const extra = Object.fromEntries(Object.entries(env).filter(([name]) => !written.has(name) && !FLY_OWN_ENV.has(name)));
  return {
    prefix,
    domain,
    org: env.FLY_ORG,
    region,
    peerIp,
    release: { version: env.COPY_RELEASE, commit: null, tags },
    extraEnv: Object.keys(extra).length ? { backend: extra } : {},
    // Only a receiver an installer before note #946 made is rolled; one the
    // Workspace made follows FLY_MX_IMAGE by itself.
    ...(mx === 'roll' ? { mxV4: 'kept' } : {}),
    steps: { smoke: true },
    readFrom: 'fly',
  };
}

// S3 (Signature Version 4) for the bucket, with node:crypto only.
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const uriEncode = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header SigV4 asks for, for one request. */
export function signV4({ method, url, headers, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const target = new URL(url);
  const all = { ...headers, host: target.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
  const query = [...target.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
  const canonical = [method, target.pathname, query, names.map((name) => `${name}:${lower[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
}

/** The copy's backup bucket, path style, as the run record's home. */
export function s3Bucket({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', fetchImpl = fetch }) {
  const urlOf = (key) => `${endpoint.replace(/\/$/, '')}/${bucket}/${key.split('/').map(uriEncode).join('/')}`;
  const send = async (method, key, body) => {
    const url = urlOf(key);
    const bytes = body === undefined ? '' : body;
    const headers = body === undefined ? {} : { 'content-type': 'application/json' };
    const signed = signV4({ method, url, headers, payloadHash: sha256Hex(bytes), accessKeyId, secretAccessKey, region });
    return fetchImpl(url, { method, headers: { ...headers, ...signed }, ...(body === undefined ? {} : { body: bytes }) });
  };
  return {
    async getText(key) {
      const answer = await send('GET', key);
      if (answer.status === 404) return null;
      if (!answer.ok) throw new Error(`bucket GET ${key}: ${answer.status}`);
      return answer.text();
    },
    async getJson(key) {
      const text = await this.getText(key);
      return text === null ? null : JSON.parse(text);
    },
    async put(key, text) {
      const answer = await send('PUT', key, text);
      if (!answer.ok) throw new Error(`bucket PUT ${key}: ${answer.status}`);
    },
    putJson(key, value) { return this.put(key, `${JSON.stringify(value, null, 2)}\n`); },
    async remove(key) {
      const answer = await send('DELETE', key);
      if (!answer.ok && answer.status !== 404) throw new Error(`bucket DELETE ${key}: ${answer.status}`);
    },
  };
}

/** Where a run lives in the bucket. */
export const runKeys = (id) => ({
  run: `upgrades/${id}/run.json`,
  events: `upgrades/${id}/events.jsonl`,
  heartbeat: `upgrades/${id}/heartbeat.json`,
  current: 'upgrades/current.json',
});

/** What a run ended as, in one word, from the upgrade's own result line. */
export function outcomeOf(result, error, open) {
  if (error) return open ? null : /^The upgrade to .* failed and .* is back on/.test(error.message) ? 'put-back' : 'failed';
  if (!result) return 'failed';
  if (result.unchanged) return 'unchanged';
  if (result.drill) return 'drill-done';
  if (result.rolledBack) return 'put-back';
  return 'done';
}

/** The upgrader's own WireGuard peers: flyctl leaves one per run that used `fly ssh`. */
export function ownPeers(listed, machineId) {
  const rows = Array.isArray(listed) ? listed : [];
  return rows.map((row) => row.Name ?? row.name).filter((name) => typeof name === 'string' && machineId && name.startsWith(`interactive-${machineId}-`));
}

/**
 * The upgrader machine's whole job (`node install.mjs upgrader`, the image's
 * command). It takes its run from the environment the command or the
 * Workspace started it with, or carries on the open run whose upgrader is
 * gone. It always exits 0 once the run has an outcome, so Fly's restart
 * (on-failure) brings it back only when it was cut off mid-run.
 */
export async function runUpgrader(env = process.env, deps = {}) {
  const log = deps.say ?? ((line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const token = env.FLY_API_TOKEN;
  const prefix = env.ACC_PREFIX;
  if (!prefix || !token) throw new Error('ACC_PREFIX and FLY_API_TOKEN are needed: this runs on the upgrader machine.');
  for (const name of UPGRADER_SECRETS) if (!env[name]) throw new Error(`${name} is not set on ${upgraderAppOf(prefix)}: the copy's backend sets it at start.`);
  const bucket = deps.bucket ?? s3Bucket({ endpoint: env.BACKUP_S3_ENDPOINT, bucket: env.BACKUP_S3_BUCKET, accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY });
  const api = deps.machinesApi ?? machinesApi({ token, fetchImpl: deps.fetchImpl });
  const machineId = env.FLY_MACHINE_ID ?? null;
  const peersFly = deps.fly ?? ((args, opts) => flyRunner({ bin: deps.flyctl ?? findFlyctl(), token, logFile: null })(args, opts));

  // Which run: the one we were started for, unless another is open and its
  // upgrader has gone quiet, which this one then carries on.
  let id = env.ACC_RUN_ID || `${now().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const current = await bucket.getJson(runKeys('x').current);
  if (current?.id && current.id !== id) {
    const beat = await bucket.getJson(runKeys(current.id).heartbeat);
    const quietFor = now().getTime() - new Date(beat?.at ?? current.startedAt ?? 0).getTime();
    if (quietFor < STALE_HEARTBEAT_MS) throw new Error(`Another upgrade (${current.id}) is running: its upgrader was heard ${Math.round(quietFor / 1000)} s ago.`);
    log(`Carrying on run ${current.id}: its upgrader has not been heard for ${Math.round(quietFor / 1000)} s.`);
    id = current.id;
  }
  const keys = runKeys(id);
  let run = await bucket.getJson(keys.run);
  if (run?.outcome) {
    log(`Run ${id} already ended: ${run.outcome}. Nothing to do.`);
    process.stdout.write(`ACC-EVENT ${JSON.stringify({ event: 'result', ...(run.result ?? {}), outcome: run.result?.outcome ?? 'done', run: id, already: true })}\n`);
    return run;
  }

  // One writer at a time to the bucket, in order.
  let chain = Promise.resolve();
  const queue = (job) => { chain = chain.then(job).catch((error) => log(`  (run record not written: ${error.message})`)); return chain; };
  const events = (await bucket.getText(keys.events))?.split('\n').filter(Boolean).map((line) => JSON.parse(line)) ?? [];
  let lastResult = null;
  const emit = (event) => {
    const stamped = { at: now().toISOString(), ...event };
    events.push(stamped);
    if (event.event === 'result') lastResult = event;
    process.stdout.write(`ACC-EVENT ${JSON.stringify(stamped)}\n`);
    const text = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    queue(() => bucket.put(keys.events, text));
  };
  const beat = () => queue(() => bucket.putJson(keys.heartbeat, { at: now().toISOString(), machine: machineId }));
  const heart = setInterval(beat, deps.heartbeatMs ?? HEARTBEAT_MS);
  heart.unref?.();

  run = run ?? {
    id,
    requestedBy: env.ACC_REQUESTED_BY || 'someone',
    toVersion: env.ACC_RELEASE || 'latest',
    drill: env.ACC_DRILL || '',
    startedAt: now().toISOString(),
    shape: null,
    upgrade: null,
  };
  run.machines = [...new Set([...(run.machines ?? []), machineId].filter(Boolean))];
  if (!run.shape) run.shape = await stateFromFly({ api, prefix, mx: env.ACC_MX || 'keep' });
  const { upgrade: _open, ...shape } = run.shape;
  const state = { ...shape, ...(run.upgrade ? { upgrade: run.upgrade } : {}) };
  const store = {
    name: `the run record ${keys.run}`,
    load: async () => state,
    save: async (s) => {
      run.upgrade = s.upgrade ?? null;
      run.release = s.release;
      await queue(() => bucket.putJson(keys.run, run));
    },
  };
  await store.save(state);
  await queue(() => bucket.putJson(keys.current, { id, startedAt: run.startedAt }));
  beat();
  log(`Upgrader ${machineId ?? '(local)'}: run ${id}, ${run.requestedBy}, ${prefix} to ${run.toVersion}${run.drill ? `, drill ${run.drill}` : ''}.`);

  let error = null;
  try {
    await upgrade(
      { release: run.toVersion, drill: run.drill === 'backend' ? 'backend' : run.drill === 'rollback', updates: env.ACC_UPDATES_URL || undefined, name: prefix },
      { ...deps, store, emit, token, say: log, logFile: deps.logFile ?? '/tmp/acc-upgrade.log' },
    );
  } catch (caught) {
    error = caught;
    log(`upgrade: ${caught.message}`);
    // flyctl's own words for what went wrong, from the log the run keeps.
    try { if (!deps.fly) log(lastLines(readFileSync(deps.logFile ?? '/tmp/acc-upgrade.log', 'utf8'), 30).split('\n').map((line) => `  fly| ${line}`).join('\n')); } catch { /* no log */ }
  }
  const open = Boolean(state.upgrade);
  const outcome = outcomeOf(lastResult, error, open);
  clearInterval(heart);
  if (!outcome) {
    // Cut off with apps possibly moved: let Fly start this machine again,
    // and the next start carries on from the run record.
    await chain;
    await cleanUpPeers({ fly: peersFly, org: run.shape.org, machineId, log });
    throw new Error(`Run ${id} stopped part-way (${error.message}); carrying on at the next start.`);
  }
  run.outcome = outcome;
  run.finishedAt = now().toISOString();
  run.message = error ? error.message : null;
  run.result = lastResult ?? { event: 'result', outcome: 'failed', message: error?.message };
  await queue(() => bucket.putJson(keys.run, run));
  await queue(async () => {
    const still = await bucket.getJson(keys.current);
    if (still?.id === id) await bucket.remove(keys.current);
  });
  await cleanUpPeers({ fly: peersFly, org: run.shape.org, machineId, log });
  process.stdout.write(`ACC-EVENT ${JSON.stringify({ event: 'result', ...(lastResult ?? {}), outcome: lastResult?.outcome ?? 'failed', upgrade: outcome, run: id, ...(error ? { message: error.message } : {}) })}\n`);
  log(`Run ${id}: ${outcome}.`);
  await chain;
  return run;
}

/** The last thing an upgrader does: take away the WireGuard peers its `fly ssh` left. */
async function cleanUpPeers({ fly, org, machineId, log }) {
  if (!machineId || !org) return;
  try {
    const listed = JSON.parse(await fly(['wireguard', 'list', org, '--json']) || '[]');
    for (const name of ownPeers(listed, machineId)) {
      await fly(['wireguard', 'remove', org, name]);
      log(`  WireGuard peer ${name.slice(0, 40)}… removed.`);
    }
  } catch (error) {
    log(`  (WireGuard peers not cleaned up: ${error.message})`);
  }
}

/** One line from `fly logs`: the upgrader's own words after Fly's prefix. */
export function logLineText(line) {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
  const at = plain.indexOf('[info]');
  return at >= 0 ? plain.slice(at + 6) : plain;
}

/**
 * `node install.mjs upgrade`: the engineer's command. It starts the upgrader
 * machine and follows it; closing the terminal does not stop the upgrade.
 * `--here` runs the upgrade on this computer as before: once for a copy whose
 * release predates the upgrader, or when Fly cannot start a machine.
 */
export async function upgradeCommand(options, deps = {}) {
  if (options.here) return upgradeHere(options, deps);
  const log = deps.say ?? say;
  const emit = eventSink(options, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const file = (() => { try { return findStateFile(options); } catch { return null; } })();
  const kept = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const prefix = kept?.prefix ?? (options.name ? String(options.name).toLowerCase() : null);
  if (!prefix) throw new UsageError('Which copy: run this where the installer left <prefix>-copy.json, or give --name <prefix>.');
  const bin = deps.flyctl ?? findFlyctl();
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token, logFile: null })(args, opts));
  if (!token && bin) token = (await fly(['auth', 'token'], { quiet: true }).catch(() => '')).trim();
  if (!token) throw new PersonNeeded('fly-sign-in', NO_TOKEN);
  const api = deps.machinesApi ?? machinesApi({ token, fetchImpl });
  const names = namesFor(prefix);
  const app = upgraderAppOf(prefix);
  const here = (why) => {
    log(`  ${why} So this upgrade runs here, on this computer, as with --here.`);
    return upgradeHere(options, deps);
  };

  const secretNames = await api.secretNames(app).catch(() => null);
  if (!secretNames) return here(`${app} does not exist yet: the Workspace makes it when it starts on a release that has the upgrader.`);
  const missing = UPGRADER_SECRETS.filter((name) => !secretNames.includes(name));
  if (missing.length) return here(`${app} has no ${missing.join(', ')}.`);
  const busy = upgradesUnderWay(await api.machines(app));
  if (busy.length) throw new Error(`An upgrade is already running: machine ${busy[0].id} in ${app} is ${busy[0].state}. Wait for it to finish, or follow it with: fly logs -a ${app}`);

  const shape = await stateFromFly({ api, prefix, mx: kept?.mxV4 ? 'roll' : 'keep' });
  if (kept?.release?.version && kept.release.version !== shape.release.version) {
    log(`  ${file} says ${kept.release.version}; Fly says ${prefix} runs ${shape.release.version}. Going by Fly.`);
  }
  const access = releaseAccess({ ...options, name: prefix }, shape.domain);
  const source = (deps.updatesSource ?? updatesSource)({ customer: access.customer, key: access.key, url: options.updates || UPDATES_URL, fetchImpl });
  const target = await source.release(options.release || 'latest');
  if (target.version === shape.release.version && !options.drill) {
    log(`${shape.domain} already runs release ${target.version}; nothing to do.`);
    emit({ event: 'result', outcome: 'done', exitCode: EXIT.done, command: 'upgrade', domain: shape.domain, release: target.version, unchanged: true });
    return { outcome: 'unchanged' };
  }
  const image = target.images?.upgrader;
  if (!image) return here(`Release ${target.version} has no upgrader image.`);

  await (deps.copyOneImage ?? (async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'acc-upgrader-'));
    try {
      await copyImage(source, (deps.flyRegistry ?? flyRegistry)({ app: names.images, token, fetchImpl }), image.tag, workdir);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }))();
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const drill = options.drill === 'backend' ? 'backend' : options.drill ? 'rollback' : '';
  const machine = await api.createMachine(app, {
    region: shape.region,
    config: {
      image: `registry.fly.io/${names.images}:${image.tag}`,
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
      env: {
        ACC_PREFIX: prefix,
        ACC_RUN_ID: runId,
        ACC_RELEASE: target.version,
        ACC_DRILL: drill,
        ACC_MX: kept?.mxV4 ? 'roll' : 'keep',
        ACC_REQUESTED_BY: 'the engineer\'s command',
        ...(options.updates ? { ACC_UPDATES_URL: options.updates } : {}),
      },
      auto_destroy: true,
      restart: { policy: 'on-failure', max_retries: 3 },
    },
  });
  log(`Upgrading ${shape.domain} from ${shape.release.version} to ${target.version}${drill ? ` as a drill (${drill})` : ''} on the upgrader, machine ${machine.id} in ${app}.`);
  log('  This terminal only follows it: closing it does not stop the upgrade. Follow it again with:');
  log(`  fly logs -a ${app}`);
  const result = await (deps.follow ?? followUpgrader)({ bin, token, app, machineId: machine.id, api, log, emit, pollMs: deps.pollMs });
  if (kept && file && result?.release) {
    // The file stays a cache of what Fly says, so it cannot mislead a --here later.
    const fresh = await stateFromFly({ api, prefix, mx: kept.mxV4 ? 'roll' : 'keep' }).catch(() => null);
    if (fresh) writeFileSync(file, `${JSON.stringify({ ...kept, release: { ...fresh.release, commit: result.commit ?? kept.release?.commit ?? null }, peerIp: fresh.peerIp, ...(result.previous ? { previous: kept.release } : {}) }, null, 2)}\n`, { mode: 0o600 });
  }
  if (result?.upgrade === 'done' || result?.upgrade === 'drill-done' || result?.upgrade === 'unchanged') return result;
  if (result?.upgrade === 'put-back') throw new Error(`The upgrade to ${target.version} failed and ${shape.domain} is back on ${shape.release.version}: ${result.message ?? 'see the lines above'}`);
  throw new Error(result?.message ?? `The upgrader ended without saying how it went. Run node install.mjs status, then this command again: a new upgrader carries on the open run.`);
}

/** A --here run's lock: a machine that never starts, named so, in the upgrader's app. */
export const HERE_LOCK = 'here-lock';
const HERE_LOCK_STALE_MS = 2 * 3600_000;
/** Machines in the upgrader's app that mean an upgrade is under way. */
export const upgradesUnderWay = (machines, now = Date.now()) => machines.filter((machine) => machine.state !== 'destroyed'
  && !(String(machine.name ?? '').startsWith(HERE_LOCK) && now - new Date(machine.created_at ?? 0).getTime() > HERE_LOCK_STALE_MS));

/**
 * The upgrade on this computer (--here): the file's record, but Fly's word
 * on what runs, and the same one-at-a-time lock as the upgrader, so the
 * Workspace never starts one beside it.
 */
async function upgradeHere(options, deps) {
  const log = deps.say ?? say;
  const file = findStateFile(options);
  const fileState = await fileStore(file).load();
  const token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const api = deps.machinesApi ?? (token ? machinesApi({ token, fetchImpl: deps.fetchImpl }) : null);
  let store = fileStore(file);
  let lock = null;
  const app = upgraderAppOf(fileState.prefix);
  if (api) {
    const shape = await stateFromFly({ api, prefix: fileState.prefix, mx: fileState.mxV4 ? 'roll' : 'keep' }).catch(() => null);
    if (shape && !fileState.upgrade && shape.release.version !== fileState.release?.version) {
      log(`  ${file} says ${fileState.release?.version}; Fly says ${fileState.prefix} runs ${shape.release.version}. Going by Fly.`);
      const merged = { ...fileState, release: shape.release, peerIp: shape.peerIp, extraEnv: shape.extraEnv };
      store = { name: file, load: async () => merged, save: (s) => fileStore(file).save(s) };
    }
    if (await api.app(app).catch(() => null)) {
      const busy = upgradesUnderWay(await api.machines(app));
      if (busy.length) throw new Error(`An upgrade is already running: machine ${busy[0].id} in ${app} is ${busy[0].state}. Wait for it to finish.`);
      const backendTag = (shape ?? fileState).release.tags.backend;
      lock = await api.createMachine(app, {
        name: `${HERE_LOCK}-${randomBytes(3).toString('hex')}`,
        region: (shape ?? fileState).region,
        skip_launch: true,
        config: { image: `registry.fly.io/${namesFor(fileState.prefix).images}:${backendTag}`, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 }, auto_destroy: true },
      }).catch((error) => { log(`  (no lock taken in ${app}: ${error.message})`); return null; });
    }
  }
  try {
    return await upgrade(options, { ...deps, store });
  } finally {
    if (lock?.id) await api.destroyMachine(app, lock.id).catch((error) => log(`  (the lock ${lock.id} in ${app} was not removed: ${error.message}; it lapses in 2 hours)`));
  }
}

/** Follow one upgrader machine until it is gone: its log lines, then its result. */
export async function followUpgrader({ bin, token, app, machineId, api, log, emit, pollMs = 5000 }) {
  let result = null;
  let buffer = '';
  const child = bin ? spawn(bin, ['logs', '-a', app], { env: { ...process.env, FLY_API_TOKEN: token, FLY_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }) : null;
  const seen = (line) => {
    if (machineId && !line.includes(machineId)) return;
    const text = logLineText(line);
    if (text.startsWith('ACC-EVENT ')) {
      try {
        const event = JSON.parse(text.slice(10));
        if (event.event === 'result' && 'upgrade' in event) { result = event; return; }
        if (event.event === 'step') emit(event);
      } catch { /* a cut line */ }
      return;
    }
    if (text.trim()) log(`  │ ${text}`);
  };
  child?.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(seen);
  });
  try {
    for (;;) {
      await sleep(pollMs);
      const machine = await api.machine(app, machineId).catch(() => undefined);
      if (result) break;
      if (machine === null || machine?.state === 'destroyed') { await sleep(Math.min(pollMs * 2, 10_000)); break; }
    }
  } finally {
    child?.kill();
  }
  if (result) emit({ ...result });
  return result;
}

/** The install's steps, in order, as its state file records them. */
export const INSTALL_STEPS = ['apps', 'release', 'buckets', 'keys', 'secrets', 'addresses', 'deploy', 'certificates', 'dns', 'smoke'];

const usd = (value) => (value === null ? 'by use' : `$${value.toFixed(2)}`);

/**
 * What `install` would do, changing nothing: the checks it makes before it
 * creates anything, everything it would create with Fly's list price, and
 * the DNS records it will ask for. It only reads (flyctl's sign-in, the
 * organization and its bill, the release the update key opens, the apps
 * already there) and writes no file, not even its state or a log. Every
 * problem says who fixes it: "you" (whoever runs this) or "person" (the one
 * who owns the Fly organization, the domain and the agreement with us).
 */
export async function plan(options, deps = {}) {
  const log = deps.say ?? say;
  const emit = eventSink(options, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const domain = String(options.domain ?? '').toLowerCase().replace(/\.$/, '');
  const org = typeof options.org === 'string' ? options.org : '';
  const checks = [];
  const check = async (key, run) => {
    try {
      checks.push({ key, ok: true, detail: await run() });
      return true;
    } catch (error) {
      const person = error instanceof PersonNeeded;
      checks.push({ key, ok: false, who: person ? 'person' : 'you', reason: error.reason ?? null, detail: error.message, ...(error.details ?? {}) });
      return false;
    }
  };

  await check('node', async () => {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(`Node ${process.versions.node} is too old; the installer needs 20 or newer.`);
    return `Node ${process.versions.node}`;
  });
  const domainOk = await check('domain', async () => {
    if (!DOMAIN_SHAPE.test(domain)) throw new PersonNeeded('domain', DOMAIN_NEEDED);
    return domain;
  });
  let updateKey = null;
  await check('update-key', async () => {
    if (licensingOn()) {
      const read = readKeyFile(options['key-file']);
      if (domainOk && read.domain !== domain) throw new PersonNeeded('update-key', keyForAnotherDomain(read, domain));
      updateKey = read;
      return `for ${read.customer} at ${read.domain}, releases until ${read.until}`;
    }
    if (!domainOk && !options.name) throw new UsageError(PREFIX_NEEDED);
    updateKey = releaseAccess(options, domain);
    return 'not needed: licensing is off, the product is free for now';
  });
  const prefix = String(options.name ?? updateKey?.customer ?? '').toLowerCase();
  const names = PREFIX_SHAPE.test(prefix) ? namesFor(prefix) : null;
  const stateFile = path.resolve(options.state ?? `${prefix || 'install'}-copy.json`);
  const state = names && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  if (updateKey || options.name) {
    await check('name', async () => {
      if (!names) throw new UsageError(PREFIX_NEEDED);
      return `every app is named ${prefix}-*`;
    });
  }
  if (domainOk) await check('licence', async () => readLicence(options, domain, { resuming: Boolean(state) }).detail);
  await check('mail', async () => { refuseMailFlags(options); return 'not part of the install: an admin sets it up later in the Workspace, under Mail'; });

  const bin = deps.flyctl ?? findFlyctl();
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  // No log file: a plan leaves nothing behind.
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token })(args, opts));
  const flyOk = await check('flyctl', async () => {
    if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
    return bin;
  });
  const signedIn = flyOk && await check('fly-sign-in', async () => {
    const fromEnv = Boolean(token);
    if (!token) token = (await fly(['auth', 'token'], { quiet: true }).catch(() => '')).trim();
    if (!token) throw new PersonNeeded('fly-sign-in', `${NO_TOKEN} The sign-in opens a browser, so the person signs in.`);
    return fromEnv ? 'a Fly token is set' : 'flyctl is signed in';
  });
  let orgOk = false;
  if (signedIn) {
    orgOk = await check('fly-organization', async () => {
      if (!org) {
        let organizations = [];
        try {
          const listed = JSON.parse(await fly(['orgs', 'list', '--json']) || '{}');
          organizations = Array.isArray(listed) ? listed.map((entry) => entry.slug ?? entry.Slug).filter(Boolean) : Object.keys(listed);
        } catch { /* the person knows */ }
        throw new PersonNeeded('fly-organization', ORG_NEEDED, { organizations });
      }
      const facts = await checkOrganization(token, org, fetchImpl);
      return `${facts.name}: card on file, billing current`;
    });
  }
  let release = null;
  if (updateKey) {
    await check('release', async () => {
      const source = (deps.updatesSource ?? updatesSource)({ customer: updateKey.customer, key: updateKey.key, url: options.updates || UPDATES_URL, fetchImpl });
      release = await source.release(options.release || 'latest');
      return updateKey.key ? `release ${release.version}, which this update key opens` : `release ${release.version}`;
    });
  }
  let existing = [];
  if (names && orgOk) {
    await check('apps', async () => {
      const listed = jsonList(await fly(['apps', 'list', '-o', org, '--json'])).map((app) => app.Name ?? app.name);
      existing = [names.images, names.backend, names.git, names.router].filter((app) => listed.includes(app));
      return existing.length ? `already in ${org}, and kept as they are: ${existing.join(', ')}` : `none of the four names is in ${org} yet`;
    });
  }

  const disk = (gb) => cents(gb * PRICE.diskGb);
  const creates = names ? [
    { kind: 'app', name: names.images, what: 'your own image registry, holding the release', monthlyUsd: 0 },
    { kind: 'app', name: names.backend, what: `the Workspace and its database: one ${SHAPES.backend.size} machine with ${SHAPES.backend.mb / 1024} GB of memory, always on`, monthlyUsd: machineMonthlyUsd(SHAPES.backend) },
    { kind: 'app', name: names.git, what: 'the code host: one machine that sleeps when nobody uses it (the price is if it never slept)', monthlyUsd: machineMonthlyUsd(SHAPES.git) },
    { kind: 'app', name: names.router, what: 'the router for previews and sites, always on', monthlyUsd: machineMonthlyUsd(SHAPES.router) },
    { kind: 'disk', name: `backend_data on ${names.backend}`, what: `${SHAPES.backend.diskGb} GB for the database, with daily snapshots`, monthlyUsd: disk(SHAPES.backend.diskGb) },
    { kind: 'disk', name: `git_data on ${names.git}`, what: `${SHAPES.git.diskGb} GB for the code`, monthlyUsd: disk(SHAPES.git.diskGb) },
    { kind: 'bucket', name: names.media, what: 'files people and agents attach', monthlyUsd: null },
    { kind: 'bucket', name: names.backups, what: 'database backups', monthlyUsd: null },
    { kind: 'address', name: `shared IPv4 and IPv6 on ${names.backend}, ${names.git} and ${names.router}`, what: 'no charge', monthlyUsd: 0 },
    { kind: 'certificate', name: domainOk ? `${domain}, git.${domain} and *.${domain}` : 'the domain, git. and *.', what: 'from Let\'s Encrypt, through Fly', monthlyUsd: 0 },
    { kind: 'token', name: `${names.backend} (your own Agentic Cloud)`, what: 'an organization token the backend starts agent machines with', monthlyUsd: 0 },
    { kind: 'secrets', name: `Fly secrets on ${names.backend} and ${names.git}`, what: 'keys made on this computer: an SSH key, the master key, shared secrets, the first-admin code', monthlyUsd: 0 },
  ].map((item) => ({ ...item, exists: existing.includes(item.name) })) : [];
  const monthlyUsd = cents(creates.reduce((sum, item) => sum + (item.exists ? 0 : item.monthlyUsd ?? 0), 0));
  // What email adds once an admin sets it up: the receiver's machine, its
  // certificate disk and the dedicated IPv4 mail needs.
  const mailMonthlyUsd = cents(machineMonthlyUsd(SHAPES.mx) + disk(SHAPES.mx.diskGb) + PRICE.ipv4);
  const unknown = '(given once the install has it)';
  const records = names && domainOk
    ? dnsRecords({
      domain, names, backendV4: unknown, backendV6: unknown, acmeTarget: '(given by Fly with the certificate)', gitAcmeTarget: '(given by Fly with the certificate)',
    }).map(publicRecord)
    : [];

  const problems = checks.filter((item) => !item.ok);
  const forPerson = problems.filter((item) => item.who === 'person');
  const forYou = problems.filter((item) => item.who === 'you');
  const outcome = forYou.length ? 'failed' : forPerson.length ? 'needs-person' : 'ready';
  const exitCode = forYou.length ? EXIT.failed : forPerson.length ? EXIT.person : EXIT.done;
  const person = [
    ...forPerson.map((item) => item.detail),
    'Read what the install will create and what it costs, and say yes before it runs.',
    `Add the DNS records the install prints${records.length ? ` (${records.length})` : ''} at the domain's DNS provider, unless whoever runs it can edit that DNS.`,
    'At the end, keep the master key offline and open the first-admin link.',
  ];

  log(`Plan for your own Agentic Cloud${domainOk ? ` at ${domain}` : ''}${org ? `, in the Fly organization ${org}` : ''}. Nothing has been created or changed.\n`);
  log('Checks:');
  for (const item of checks) log(`  ${item.ok ? 'ok    ' : item.who === 'person' ? 'PERSON' : 'FIX   '}  ${item.key.padEnd(17)} ${item.detail}`);
  if (creates.length) {
    log(`\nIt would create${org ? ` in ${org}` : ''}:`);
    for (const item of creates) log(`  ${usd(item.monthlyUsd).padStart(7)}  ${item.name}: ${item.what}${item.exists ? ' (already there)' : ''}`);
    log(`\n  About $${monthlyUsd.toFixed(2)} a month at Fly's published prices before any agent, plus the buckets' storage by use.`);
    log(`  Each agent machine: about $${PRICE.agentHour.toFixed(2)} an hour while it is awake, plus its disk. Fly's dashboard has the real bill.`);
    log(`  Email is not in this: ${MAIL_LATER} About $${mailMonthlyUsd.toFixed(2)} a month more once it is on.`);
  }
  if (records.length) log(`\nThe DNS records it will ask for:\n${formatRecords(records)}`);
  if (state) log(`\nAn earlier run is recorded in ${stateFile}: ${INSTALL_STEPS.filter((key) => state.steps?.[key]).join(', ') || 'nothing'} done.`);
  log(`\n${outcome === 'ready' ? 'Ready: run the same command without --plan.' : outcome === 'needs-person' ? 'A person is needed first (PERSON above).' : 'Fix the FIX lines above, then plan again.'}`);

  const result = {
    event: 'result', outcome, exitCode, command: 'plan', reason: forPerson[0]?.reason ?? null, domain: domainOk ? domain : null, org: org || null,
    release: release?.version ?? null, checks, creates, monthlyUsd, agentHourlyUsd: PRICE.agentHour, records,
    mail: { included: false, laterMonthlyUsd: mailMonthlyUsd, how: MAIL_LATER },
    stepsDone: state ? INSTALL_STEPS.filter((key) => state.steps?.[key]) : [], person,
  };
  emit(result);
  return result;
}

/** The state file a command was pointed at, or the one the installer left here. */
function findStateFile(options) {
  if (options.state) return path.resolve(options.state);
  if (options.name) return path.resolve(`${String(options.name).toLowerCase()}-copy.json`);
  if (options['key-file'] && licensingOn()) return path.resolve(`${readKeyFile(options['key-file']).customer}-copy.json`);
  const here = readdirSync(process.cwd()).filter((file) => file.endsWith('-copy.json'));
  if (here.length === 1) return path.resolve(here[0]);
  throw new UsageError(here.length ? `Several installs are recorded here (${here.join(', ')}): say which with --state <file>.` : 'There is no <prefix>-copy.json here. Run this where the installer left it, or give --state <file>.');
}

/**
 * Where an install stands, only looking: the steps done, every DNS record as
 * the domain's own name servers answer it, each certificate as Fly reports
 * it and, once installed, the Workspace's health. It creates, restarts and
 * nudges nothing, so it can be run as often as anyone likes.
 */
export async function status(options, deps = {}) {
  const log = deps.say ?? say;
  const emit = eventSink(options, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stateFile = findStateFile(options);
  if (!existsSync(stateFile)) throw new Error(`There is no ${stateFile}. Run this where the installer left it, or give --state <file>.`);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const names = namesFor(state.prefix);
  const domain = state.domain;
  const stepsDone = INSTALL_STEPS.filter((key) => state.steps?.[key]);
  const nextStep = INSTALL_STEPS.find((key) => !state.steps?.[key]) ?? null;
  const base = { event: 'result', command: 'status', domain, stateFile, release: state.release?.version ?? null, stepsDone, nextStep };
  log(`Your own Agentic Cloud at ${domain} (${stateFile}): ${stepsDone.length} of ${INSTALL_STEPS.length} install steps done${nextStep ? `, next: ${nextStep}` : ''}.`);

  const finish = (outcome, exitCode, message, more = {}) => {
    log(`\n${message}`);
    const result = { ...base, outcome, exitCode, message, ...more };
    emit(result);
    return result;
  };
  if (state.upgrade) {
    return finish('continue', EXIT.done, `An upgrade from ${state.upgrade.from?.version} to ${state.upgrade.toVersion} stopped part-way. Run the same upgrade command again: it carries on from where it stopped.`, { next: 'upgrade' });
  }
  if (!(state.acmeTarget && state.backendV4 && state.backendV6)) {
    return finish('continue', EXIT.done, `Nothing for a person yet: the install has not asked for its DNS records. Run the same install command again: it carries on at "${nextStep}".`, { next: 'install' });
  }

  const bin = deps.flyctl ?? findFlyctl();
  if (!bin) throw new Error('flyctl is not installed. Install it (fly.io/docs/flyctl/install) and run this again.');
  let token = deps.token ?? process.env.FLY_API_TOKEN ?? '';
  const fly = deps.fly ?? ((args, opts) => flyRunner({ bin, token })(args, opts));
  if (!token) token = (await fly(['auth', 'token'], { quiet: true }).catch(() => '')).trim();
  if (!token) throw new PersonNeeded('fly-sign-in', NO_TOKEN);

  const records = dnsRecords({
    domain,
    names,
    backendV4: state.backendV4,
    backendV6: state.backendV6,
    acmeTarget: state.acmeTarget,
    // Read, never written back: status changes nothing, not even its record.
    gitAcmeTarget: state.gitAcmeTarget || await gitAcmeTargetOf(fly, names, domain),
  });
  const { resolver } = await (deps.authoritativeResolver ?? authoritativeResolver)(domain);
  const missing = [];
  for (const record of records) {
    const { ok, seen } = await checkRecord(resolver, record);
    if (!ok) missing.push({ ...publicRecord(record), seen });
  }
  log(`  DNS: ${records.length - missing.length} of ${records.length} records right${missing.length ? `; missing:\n${formatRecords(missing)}` : ''}`);
  const certificates = {};
  for (const [app, host] of [[names.backend, domain], [names.git, `git.${domain}`], [names.router, `*.${domain}`]]) {
    try {
      certificates[host] = JSON.parse(await fly(['certs', 'show', host, '-a', app, '--json'])).status ?? 'unknown';
    } catch (error) {
      certificates[host] = `not readable (${error.message})`;
    }
  }
  const certificatesWaiting = Object.entries(certificates).filter(([, value]) => value !== 'Ready').map(([host]) => host);
  log(`  Certificates: ${certificatesWaiting.length ? `waiting for ${certificatesWaiting.join(', ')}` : 'all issued'}`);
  const found = { records: missing, certificates, certificatesWaiting };

  if (missing.length) {
    return finish('needs-person', EXIT.person, `A person is needed: ${missing.length} of ${records.length} DNS records are not in place at ${domain}'s name servers. Add them exactly as above, all DNS only, then check again.`, { reason: 'dns', ...found });
  }
  if (certificatesWaiting.length) {
    return finish('waiting', EXIT.waiting, `Every DNS record is in. Nobody needs to do anything: ${state.steps?.smoke ? 'Fly renews by itself.' : 'run the same install command again (with --wait 20). While it waits it nudges Fly to ask again, which this check never does.'}`, { reason: 'certificates', next: state.steps?.smoke ? null : 'install', ...found });
  }
  if (!state.steps?.smoke) {
    return finish('continue', EXIT.done, 'Every DNS record and certificate is in. Run the same install command again to finish: the smoke test, then the first-admin link.', { next: 'install', ...found });
  }
  let healthy = false;
  try {
    healthy = (await (await fetchImpl(`https://${domain}/api/health`, { signal: AbortSignal.timeout(20_000) })).json()).status === 'ok';
  } catch { /* below */ }
  if (!healthy) return finish('unhealthy', EXIT.failed, `Installed, but https://${domain}/api/health does not say ok.`, found);
  return finish('installed', EXIT.done, `Installed and healthy at https://${domain}, release ${state.release?.version}.`, found);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    // A flag with no value after it (--drill) is a yes.
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      out[argv[i].slice(2)] = true;
      continue;
    }
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = flags(rest);
  if (command === 'install') {
    if (options.plan) {
      process.exitCode = (await plan(options)).exitCode;
      return;
    }
    if (!options.org || !options.domain) throw new UsageError('--org and --domain are both needed.');
    if (licensingOn() && !options['key-file']) throw new UsageError('--key-file is needed while licensing is on (COPY_LICENCE=on).');
    await install(options);
    return;
  }
  if (command === 'status') {
    process.exitCode = (await status(options)).exitCode;
    return;
  }
  if (command === 'upgrade') {
    if (licensingOn() && !options['key-file']) throw new UsageError('--key-file is needed while licensing is on: the update key your own Agentic Cloud was installed with.');
    await upgradeCommand(options);
    return;
  }
  if (command === 'upgrader') {
    // On the upgrader machine only: the image's own command (note #1008).
    await runUpgrader(process.env);
    return;
  }
  if (command !== 'copy') {
    say('usage: node install.mjs install --org <fly organization> --domain <domain>');
    say('         [--name <prefix>] [--region <code>] [--release <version>] [--wait <minutes>]');
    say('         [--key-file <update key file> --licence-file <licence file> | --no-licence]  (only with COPY_LICENCE=on)');
    say('         [--plan] [--json]');
    say('       node install.mjs status [--state <file>] [--json]');
    say('       node install.mjs upgrade [--release <version|latest>] [--drill [backend]] [--here] [--state <file>] [--json] [--key-file <file>]');
    say('       node install.mjs copy --to-app <images app> [--release <version|latest>] [--customer <id> --key-file <file>]');
    say('exit codes: 0 done, 1 failed, 2 wrong command, 3 a person is needed, 4 still waiting (run it again later)');
    process.exitCode = EXIT.usage;
    return;
  }
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new PersonNeeded('fly-sign-in', 'FLY_API_TOKEN is not set: a Fly token for the organization your own Agentic Cloud is in.');
  if (!options['to-app']) throw new UsageError('--to-app is needed.');
  if (licensingOn() && (!options.customer || !options['key-file'])) throw new UsageError('--customer and --key-file are needed while licensing is on.');
  const key = licensingOn() ? readFileSync(options['key-file'], 'utf8').trim() : null;
  const source = updatesSource({ customer: options.customer, key, url: options.updates || UPDATES_URL });
  const dest = flyRegistry({ app: options['to-app'], token });
  const started = Date.now();
  const { release, copied } = await copyRelease({ source, dest, version: options.release || 'latest' });
  say(`release ${release.version} is in registry.fly.io/${options['to-app']} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  process.stdout.write(`${JSON.stringify({ version: release.version, commit: release.commit, images: copied }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    say(`install: ${error.message}`);
    // With --json the last line is always the result, stopped or not.
    if (process.argv.includes('--json')) jsonLine(resultOf(error));
    // exitCode, not exit(): a pipe on macOS is written asynchronously, and
    // exit() could cut off the line above.
    process.exitCode = exitCodeOf(error);
  });
}
