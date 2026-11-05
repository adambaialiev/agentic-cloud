/**
 * Our update service for private copies (note #811): the one place a
 * customer's installer and upgrades fetch our releases from. It is a
 * read-only container registry in front of our private one
 * (registry.fly.io/<UPSTREAM_REPO>, in our own Fly organization), opened per
 * customer by an UPDATE KEY we sign (infra/copy-release/issue.mjs).
 *
 * A copy never runs from here: its installer and its upgrade command copy a
 * release's images into the copy's own registry, and everything it runs
 * comes from there. This service only answers while those commands run.
 *
 * Licensing is OFF (the product is free for now): the service hands every
 * release to anyone, with no sign-in, and reads no key. With COPY_LICENCE=on
 * (the same switch as the installer's and the installed backend's) it asks
 * for a key again, as below.
 *
 * Sign in as  <customer>:<update key>  (HTTP Basic, the way every registry
 * client already speaks). A key covers every release dated on or before its
 * `updatesUntil`, for good: a customer who stops paying keeps the versions
 * they had and can still reinstall them, and gets no newer ones (note #810).
 *
 *   GET  /v2/                                 registry ping
 *   GET  /v2/acc-copy/tags/list               the release tags the key covers
 *   GET|HEAD /v2/acc-copy/manifests/<ref>     <image>-<version>, or a digest
 *   GET|HEAD /v2/acc-copy/blobs/<digest>
 *   GET  /releases                            {latest, releases:[{version, date, summary?}]}
 *   GET  /releases/<version|latest>/<file>    copy-release.json, install.mjs, notes.md
 *
 * Release notes (note #1006): a release cut since notes existed carries its
 * notes.md in its release image, beside copy-release.json. Releases cut
 * before that (2026.10.27.9 to 2026.11.01.1) are immutable and hold none, so
 * this service also ships infra/copy-release/notes/ in its own deploy and
 * reads a release's notes from there first, from the image otherwise. A
 * release's summary in /releases is its notes' title line.
 *   GET  /health                              no sign-in
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { publicKeyFrom, verifySigned } from '../copy-release/signed.mjs';
import { notesTitle } from '../copy-release/notes.mjs';

export const REPO_NAME = 'acc-copy';
/** A release is named by the day it was cut and a counter: 2026.10.27.1. */
export const VERSION_SHAPE = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d{1,3})$/;
const TAG_SHAPE = /^([a-z][a-z0-9-]*?)-(\d{4}\.\d{2}\.\d{2}\.\d{1,3})$/;
const DIGEST_SHAPE = /^sha256:[a-f0-9]{64}$/;
const RELEASE_FILES = new Set(['copy-release.json', 'install.mjs', 'notes.md']);
const CONTENT_TYPES = {
  'copy-release.json': 'application/json',
  'install.mjs': 'text/javascript; charset=utf-8',
  'notes.md': 'text/markdown; charset=utf-8',
};
/** The notes this deploy ships, for releases whose image holds none. */
export const DEPLOYED_NOTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../copy-release/notes');
/** A release image found without notes is not asked again sooner than this. */
const MISSING_NOTES_RETRY_MS = 3_600_000;
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export const releaseDate = (version) => {
  const match = VERSION_SHAPE.exec(version);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

/** The file named `name` in an (optionally gzipped) tar archive, or null. */
export function fileFromTar(archive, name) {
  const tar = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive) : archive;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) return null;
    const field = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '').trim();
    const entry = (field(345, 500) ? `${field(345, 500)}/` : '') + field(0, 100);
    const size = parseInt(field(124, 136) || '0', 8);
    if (entry.replace(/^\.?\//, '') === name) return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

export function createUpdateService({
  upstream = 'https://registry.fly.io',
  upstreamRepo,
  upstreamToken,
  publicKey,
  revoked = new Set(),
  requireKey = false,
  now = () => new Date(),
  fetchImpl = fetch,
  notesDir = DEPLOYED_NOTES_DIR,
}) {
  const upstreamAuth = `Basic ${Buffer.from(`x:${upstreamToken}`).toString('base64')}`;
  const releaseFiles = new Map();

  /** The key's payload when the Basic sign-in is a live update key of ours
   *  for the customer it names; null otherwise. */
  const keyOf = (req) => {
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 1) return null;
    const payload = verifySigned(decoded.slice(colon + 1), publicKey);
    if (!payload || payload.kind !== 'update' || payload.customer !== decoded.slice(0, colon)) return null;
    if (revoked.has(payload.id) || !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.updatesUntil))) return null;
    return payload;
  };
  const covers = (key, version) => {
    const date = releaseDate(version);
    return Boolean(date) && date <= key.updatesUntil;
  };

  const up = (path, init = {}) => fetchImpl(`${upstream}/v2/${upstreamRepo}/${path}`, {
    ...init, headers: { authorization: upstreamAuth, ...(init.headers ?? {}) },
  });

  const allTags = async () => {
    const answer = await up('tags/list?n=10000');
    if (!answer.ok) throw new Error(`upstream tags ${answer.status}`);
    return (await answer.json()).tags ?? [];
  };
  const releasesFor = async (key) => (await allTags())
    .map((tag) => /^release-(.+)$/.exec(tag)?.[1])
    .filter((version) => version && VERSION_SHAPE.test(version) && covers(key, version))
    .sort(compareVersions);

  const readReleaseFile = async (version, name) => {
    const cacheKey = `${version}/${name}`;
    if (releaseFiles.has(cacheKey)) return releaseFiles.get(cacheKey);
    const manifest = await up(`manifests/release-${version}`, { headers: { accept: MANIFEST_TYPES } });
    if (!manifest.ok) return null;
    let doc = await manifest.json();
    // A builder that adds attestations pushes an index: the release's files
    // are in its one real (non-attestation) image.
    if (Array.isArray(doc.manifests)) {
      const image = doc.manifests.find((entry) => entry.platform?.os !== 'unknown');
      const inner = image ? await up(`manifests/${image.digest}`, { headers: { accept: MANIFEST_TYPES } }) : null;
      if (!inner?.ok) return null;
      doc = await inner.json();
    }
    const layer = doc.layers?.[0];
    if (!layer?.digest) return null;
    const blob = await up(`blobs/${layer.digest}`);
    if (!blob.ok) return null;
    const file = fileFromTar(Buffer.from(await blob.arrayBuffer()), name);
    if (file) releaseFiles.set(cacheKey, file);
    return file;
  };

  /** A release's notes: this deploy's copy first (releases that predate
   *  notes in the image), then the release image's own notes.md. */
  const missingNotes = new Map();
  const notesFor = async (version) => {
    const deployed = path.join(notesDir, `${version}.md`);
    if (VERSION_SHAPE.test(version) && existsSync(deployed)) return readFileSync(deployed);
    const missingSince = missingNotes.get(version);
    if (missingSince !== undefined && now().getTime() - missingSince < MISSING_NOTES_RETRY_MS) return null;
    const bytes = await readReleaseFile(version, 'notes.md');
    if (bytes) missingNotes.delete(version);
    else missingNotes.set(version, now().getTime());
    return bytes;
  };

  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
    res.end(text);
  };
  const registryError = (res, status, code, message, headers = {}) =>
    send(res, status, { errors: [{ code, message }] }, { 'docker-distribution-api-version': 'registry/2.0', ...headers });

  /** An upstream answer handed on as it is: status, the headers a registry
   *  client reads, and the body streamed rather than held. */
  const relay = async (res, answer, head) => {
    const headers = { 'docker-distribution-api-version': 'registry/2.0' };
    for (const name of ['content-type', 'content-length', 'docker-content-digest', 'etag']) {
      const value = answer.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(answer.status, headers);
    if (head || !answer.body) { res.end(); return; }
    Readable.fromWeb(answer.body).on('error', () => res.destroy()).pipe(res);
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://updates.invalid');
    const path = url.pathname;
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return send(res, 405, 'This service only reads.');
    if (path === '/health') return send(res, 200, 'ok');

    // Open: everyone may read every release, as if their key had no end.
    const key = requireKey ? keyOf(req) : { customer: 'anyone', updatesUntil: '9999-12-31' };
    const challenge = { 'www-authenticate': 'Basic realm="acc-copy-updates"' };
    if (!key) {
      return path.startsWith('/v2')
        ? registryError(res, 401, 'UNAUTHORIZED', 'Sign in with your customer id and update key.', challenge)
        : send(res, 401, 'Sign in with your customer id and update key.', challenge);
    }
    try {
      if (path === '/v2/' || path === '/v2') {
        return send(res, 200, {}, { 'docker-distribution-api-version': 'registry/2.0' });
      }
      if (path === `/v2/${REPO_NAME}/tags/list`) {
        const tags = (await allTags()).filter((tag) => {
          const match = TAG_SHAPE.exec(tag);
          return match ? covers(key, match[2]) : false;
        }).sort();
        return send(res, 200, { name: REPO_NAME, tags });
      }
      const manifest = new RegExp(`^/v2/${REPO_NAME}/manifests/([^/]+)$`).exec(path);
      if (manifest) {
        const ref = decodeURIComponent(manifest[1]);
        const tag = TAG_SHAPE.exec(ref);
        if (!DIGEST_SHAPE.test(ref) && !tag) return registryError(res, 404, 'MANIFEST_UNKNOWN', 'No such release image.');
        if (tag && !covers(key, tag[2])) {
          return registryError(res, 403, 'DENIED', `Your update key covers releases until ${key.updatesUntil}; ${tag[2]} is newer.`);
        }
        return relay(res, await up(`manifests/${ref}`, {
          method: req.method, headers: { accept: String(req.headers.accept || MANIFEST_TYPES) },
        }), head);
      }
      const blob = new RegExp(`^/v2/${REPO_NAME}/blobs/([^/]+)$`).exec(path);
      if (blob) {
        const digest = decodeURIComponent(blob[1]);
        if (!DIGEST_SHAPE.test(digest)) return registryError(res, 404, 'BLOB_UNKNOWN', 'No such blob.');
        return relay(res, await up(`blobs/${digest}`, { method: req.method }), head);
      }
      if (path === '/releases') {
        const versions = await releasesFor(key);
        // A summary only where notes exist; a list is never held up by one.
        const summaries = await Promise.all(versions.map((version) => notesFor(version)
          .then((bytes) => (bytes ? notesTitle(bytes.toString('utf8')) : null)).catch(() => null)));
        return send(res, 200, {
          customer: key.customer, updatesUntil: key.updatesUntil, latest: versions.at(-1) ?? null,
          releases: versions.map((version, i) => ({
            version, date: releaseDate(version), ...(summaries[i] ? { summary: summaries[i] } : {}),
          })),
        });
      }
      const file = /^\/releases\/([^/]+)\/([^/]+)$/.exec(path);
      if (file) {
        const name = file[2];
        if (!RELEASE_FILES.has(name)) return send(res, 404, 'No such file in a release.');
        const versions = await releasesFor(key);
        const version = file[1] === 'latest' ? versions.at(-1) : file[1];
        if (!version || !versions.includes(version)) {
          return send(res, VERSION_SHAPE.test(file[1]) && !covers(key, file[1]) ? 403 : 404,
            VERSION_SHAPE.test(file[1]) && !covers(key, file[1])
              ? `Your update key covers releases until ${key.updatesUntil}.`
              : 'No such release.');
        }
        const bytes = name === 'notes.md' ? await notesFor(version) : await readReleaseFile(version, name);
        if (!bytes) return send(res, 404, name === 'notes.md' ? 'That release has no notes.' : 'No such file in that release.');
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[name],
          'content-length': bytes.length, 'x-release': version,
        });
        return res.end(head ? undefined : bytes);
      }
      return send(res, 404, 'Not here.');
    } catch (error) {
      console.error('[copy-updates]', error);
      return send(res, 502, 'Our release store did not answer. Try again in a minute.');
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const required = ['UPSTREAM_REPO', 'UPSTREAM_TOKEN'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    console.error(`[copy-updates] missing ${missing.join(', ')}`);
    process.exit(1);
  }
  const handle = createUpdateService({
    upstream: process.env.UPSTREAM_REGISTRY || 'https://registry.fly.io',
    upstreamRepo: process.env.UPSTREAM_REPO,
    upstreamToken: process.env.UPSTREAM_TOKEN,
    // The committed public half, shipped beside this file; an env value only
    // when a key is being rotated.
    publicKey: publicKeyFrom(process.env.COPY_SIGNING_PUBLIC_KEY?.trim()
      || readFileSync(new URL('../copy-release/signing-key.pub', import.meta.url), 'utf8')),
    revoked: new Set((process.env.REVOKED_KEY_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)),
    requireKey: String(process.env.COPY_LICENCE ?? '').trim().toLowerCase() === 'on',
  });
  const port = Number(process.env.PORT || 8080);
  createHttpServer((req, res) => { void handle(req, res); }).listen(port, '::', () => {
    console.log(`[copy-updates] listening on ${port}, releases from ${process.env.UPSTREAM_REPO}`);
  });
}
