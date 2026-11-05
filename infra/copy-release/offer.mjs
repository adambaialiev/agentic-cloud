#!/usr/bin/env node
/**
 * Offer a release to companies (note #1008). The update service lists a
 * release, and names it latest, only once it holds `offered-<version>` beside
 * its `release-<version>` tag (infra/copy-updates/server.mjs). That tag is a
 * tiny image whose one file, offer.json, says how it got there:
 *
 *   FLY_API_TOKEN=… node infra/copy-release/offer.mjs <version> --gate passed [--run <id>]
 *       what the copy-release job runs once the standing test copy upgraded
 *       to <version> and passed both drills (infra/copy-release/gate.sh);
 *   FLY_API_TOKEN=… node infra/copy-release/offer.mjs <version> --override --by <who> --reason "<why>"
 *       an operator letting a release through without the gate. Refused
 *       without both. The reason is kept in the tag for good, and printed.
 *
 * RELEASE_REPO names the registry app (acc-copy-releases by default).
 * Offering twice changes nothing: the first offer stands.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { flyRegistry } from '../copy-installer/install.mjs';

export const VERSION_SHAPE = /^\d{4}\.\d{2}\.\d{2}\.\d{1,3}$/;
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** A one-file ustar archive, as a registry layer carries it. */
export function tarOf(name, bytes) {
  const header = Buffer.alloc(512);
  const put = (text, at, length) => header.write(String(text).slice(0, length), at, length, 'utf8');
  const octal = (n, length) => `${n.toString(8).padStart(length - 1, '0')}\0`;
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(bytes.length, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  header.fill(' ', 148, 156);
  put('0', 156, 1);
  put('ustar\x0000', 257, 8);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, pad, Buffer.alloc(1024)]);
}

/** The offered-<version> image: its offer.json, its config and its manifest. */
export function offerImage(offer) {
  const file = Buffer.from(`${JSON.stringify(offer, null, 2)}\n`);
  const tar = tarOf('offer.json', file);
  const layer = gzipSync(tar);
  const config = Buffer.from(JSON.stringify({
    architecture: 'amd64', os: 'linux',
    config: { Labels: { 'org.opencontainers.image.version': offer.version, 'acc.offer.gate': offer.gate } },
    rootfs: { type: 'layers', diff_ids: [sha(tar)] },
  }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha(config), size: config.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: sha(layer), size: layer.length }],
  }));
  return { file, layer, config, manifest };
}

/** The words a person reads about one offer. */
export const offerLine = (offer) => (offer.gate === 'passed'
  ? `offered ${offer.version}: the standing test copy upgraded to it and passed both drills${offer.run ? ` (run ${offer.run})` : ''}`
  : `offered ${offer.version} WITHOUT the gate, by ${offer.by}: ${offer.reason}`);

export async function offerRelease({ version, gate, by, reason, run, repo, token, base = 'https://registry.fly.io', fetchImpl = fetch, now = () => new Date(), log = (line) => process.stderr.write(`${line}\n`) }) {
  if (!VERSION_SHAPE.test(String(version))) throw new Error(`not a release version: ${version}`);
  if (gate !== 'passed' && gate !== 'override') throw new Error('say --gate passed (the test copy passed) or --override');
  if (gate === 'override' && (!String(by ?? '').trim() || !String(reason ?? '').trim())) {
    throw new Error('An override needs --by <who> and --reason "<why>": both are kept with the release for good.');
  }
  const auth = { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` };
  const head = (tag) => fetchImpl(`${base}/v2/${repo}/manifests/${tag}`, {
    method: 'HEAD', headers: { ...auth, accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
  });
  if (!(await head(`release-${version}`)).ok) throw new Error(`There is no release ${version} in ${repo}.`);
  if ((await head(`offered-${version}`)).ok) {
    log(`${version} is already offered; the first offer stands.`);
    return { already: true };
  }
  const offer = {
    version, gate, at: now().toISOString(),
    ...(gate === 'override' ? { by: String(by).trim(), reason: String(reason).trim() } : {}),
    ...(run ? { run: String(run) } : {}),
  };
  const image = offerImage(offer);
  const registry = flyRegistry({ app: repo, token, base, fetchImpl });
  const dir = mkdtempSync(path.join(tmpdir(), 'acc-offer-'));
  try {
    for (const blob of [image.config, image.layer]) {
      const digest = sha(blob);
      if (await registry.hasBlob(digest)) continue;
      const file = path.join(dir, digest.replace(':', '-'));
      writeFileSync(file, blob);
      await registry.putBlob(digest, file);
    }
    await registry.putManifest(`offered-${version}`, image.manifest, 'application/vnd.oci.image.manifest.v1+json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  log(offerLine(offer));
  return { offer };
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) { out[argv[i].slice(2)] = true; continue; }
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = flags(process.argv.slice(2));
  const token = process.env.FLY_API_TOKEN;
  if (!token) {
    process.stderr.write('offer: FLY_API_TOKEN is not set (a token that can push to the release registry)\n');
    process.exit(2);
  }
  offerRelease({
    version: options._[0],
    gate: options.override ? 'override' : options.gate,
    by: options.by,
    reason: options.reason,
    run: options.run,
    repo: process.env.RELEASE_REPO || 'acc-copy-releases',
    token,
  }).catch((error) => {
    process.stderr.write(`offer: ${error.message}\n`);
    process.exitCode = 1;
  });
}
