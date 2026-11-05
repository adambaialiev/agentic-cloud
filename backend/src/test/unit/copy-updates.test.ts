/**
 * Private copy stage 3, piece 1 (note #811): one release in our private
 * registry, opened per customer by a signed update key, and copied into the
 * copy's own registry by its installer. A fake registry stands in for
 * registry.fly.io on both sides.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const INFRA = path.resolve(__dirname, '../../../../infra');
type Signed = {
  signPayload: (payload: object, pem: string) => string;
  verifySigned: (text: string, key: unknown) => Record<string, unknown> | null;
  publicKeyFrom: (x: string) => unknown;
  publicKeyX: (key: unknown) => string;
};
let signed: Signed;
let updates: {
  createUpdateService: (opts: Record<string, unknown>) => (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  fileFromTar: (archive: Buffer, name: string) => Buffer | null;
};
let offer: {
  offerRelease: (opts: Record<string, unknown>) => Promise<{ already?: boolean; offer?: Record<string, string> }>;
  offerLine: (offer: Record<string, string>) => string;
};
let installer: {
  updatesSource: (opts: Record<string, unknown>) => unknown;
  flyRegistry: (opts: Record<string, unknown>) => unknown;
  copyRelease: (opts: Record<string, unknown>) => Promise<{ release: { version: string }; copied: Record<string, { tag: string; digest: string }> }>;
};

const digestOf = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** A ustar archive of the given files, as a builder's COPY layer is. */
function tar(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** registry.fly.io as far as these two need it: one repository per name,
 *  Basic x:<token>, manifests by tag or digest, monolithic uploads. */
function fakeRegistry(token: string) {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, Map<string, { bytes: Buffer; type: string }>>();
  const repo = (name: string) => manifests.get(name) ?? manifests.set(name, new Map()).get(name)!;
  const addImage = (name: string, tag: string, layers: Buffer[]) => {
    const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', tag }));
    for (const blob of [config, ...layers]) blobs.set(digestOf(blob), blob);
    const doc = {
      schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digestOf(config), size: config.length },
      layers: layers.map((layer) => ({ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: digestOf(layer), size: layer.length })),
    };
    const bytes = Buffer.from(JSON.stringify(doc));
    const entry = { bytes, type: doc.mediaType };
    repo(name).set(tag, entry);
    repo(name).set(digestOf(bytes), entry);
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`x:${token}`).toString('base64')}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url!, 'http://x');
    const [, , name, kind, ref] = url.pathname.split('/');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (kind === 'tags') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          name, tags: [...repo(name!).keys()].filter((t) => !t.startsWith('sha256:')),
        }));
      } else if (kind === 'manifests' && req.method === 'PUT') {
        const entry = { bytes: body, type: String(req.headers['content-type']) };
        repo(name!).set(ref!, entry);
        repo(name!).set(digestOf(body), entry);
        res.writeHead(201, { 'docker-content-digest': digestOf(body) }).end();
      } else if (kind === 'manifests') {
        const entry = repo(name!).get(decodeURIComponent(ref!));
        if (!entry) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': entry.type, 'docker-content-digest': digestOf(entry.bytes), 'content-length': entry.bytes.length });
        res.end(req.method === 'HEAD' ? undefined : entry.bytes);
      } else if (kind === 'blobs' && ref === 'uploads') {
        if (req.method === 'POST') {
          res.writeHead(202, { location: `/v2/${name}/blobs/uploads/session-1?state=x` }).end();
        } else {
          const digest = url.searchParams.get('digest')!;
          if (digestOf(body) !== digest) { res.writeHead(400).end(); return; }
          blobs.set(digest, body);
          res.writeHead(201).end();
        }
      } else if (kind === 'blobs') {
        const blob = blobs.get(decodeURIComponent(ref!));
        if (!blob) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-length': blob.length }).end(req.method === 'HEAD' ? undefined : blob);
      } else {
        res.writeHead(404).end();
      }
    });
  };
  return { handler, addImage, blobs, manifests };
}

const servers: Server[] = [];
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const { privateKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const stranger = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const IMAGES = ['backend', 'git-host', 'router'];
let upstream: ReturnType<typeof fakeRegistry>;
let serviceUrl = '';
let openUrl = '';
let keyFor: (payload: Record<string, unknown>, pem?: string) => string;

beforeAll(async () => {
  signed = await import(/* @vite-ignore */ pathToFileURL(path.join(INFRA, 'copy-release/signed.mjs')).href);
  updates = await import(/* @vite-ignore */ pathToFileURL(path.join(INFRA, 'copy-updates/server.mjs')).href);
  installer = await import(/* @vite-ignore */ pathToFileURL(path.join(INFRA, 'copy-installer/install.mjs')).href);
  offer = await import(/* @vite-ignore */ pathToFileURL(path.join(INFRA, 'copy-release/offer.mjs')).href);
  keyFor = (payload, pem = PEM) => signed.signPayload({ kind: 'update', id: 'k1', customer: 'theirco', domain: 'agents.theirco.test', updatesUntil: '2026-12-31', ...payload }, pem);
  upstream = fakeRegistry('our-token');
  for (const version of ['2026.10.27.1', '2027.02.01.1']) {
    for (const image of IMAGES) upstream.addImage('acc-copy-releases', `${image}-${version}`, [gzipSync(Buffer.from(`${image} ${version} layer`))]);
    const release = {
      version, commit: 'abc123', images: Object.fromEntries(IMAGES.map((image) => [image, { tag: `${image}-${version}` }])),
    };
    upstream.addImage('acc-copy-releases', `release-${version}`, [gzipSync(tar({
      'copy-release.json': JSON.stringify(release), 'install.mjs': `// installer of ${version}\n`,
    }))]);
  }
  const upstreamUrl = await listen(upstream.handler);
  const handle = updates.createUpdateService({
    // Every release counts as from before the offer gate (note #1008): these tests are about other things.
    gateFrom: '9999.12.31.999',
    upstream: upstreamUrl, upstreamRepo: 'acc-copy-releases', upstreamToken: 'our-token',
    publicKey: signed.publicKeyFrom(signed.publicKeyX(privateKey)), revoked: new Set(['revoked-id']), requireKey: true,
  });
  serviceUrl = await listen((req, res) => { void handle(req, res); });
  // Licensing off (note #935), the shipped default: no key asked, none read.
  const open = updates.createUpdateService({
    // Every release counts as from before the offer gate (note #1008): these tests are about other things.
    gateFrom: '9999.12.31.999',
    upstream: upstreamUrl, upstreamRepo: 'acc-copy-releases', upstreamToken: 'our-token',
    publicKey: signed.publicKeyFrom(signed.publicKeyX(privateKey)),
  });
  openUrl = await listen((req, res) => { void open(req, res); });
});
afterAll(() => { for (const server of servers) server.close(); });

const as = (customer: string, key: string) => ({ authorization: `Basic ${Buffer.from(`${customer}:${key}`).toString('base64')}` });

describe('the update service (note #811)', () => {
  it('answers nobody without a live update key of ours, for the customer it names', async () => {
    expect((await fetch(`${serviceUrl}/health`)).status).toBe(200);
    const bare = await fetch(`${serviceUrl}/v2/`);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toContain('Basic');
    expect((await fetch(`${serviceUrl}/v2/`, { headers: as('theirco', keyFor({})) })).status).toBe(200);
    expect((await fetch(`${serviceUrl}/v2/`, { headers: as('otherco', keyFor({})) })).status).toBe(401);
    expect((await fetch(`${serviceUrl}/v2/`, { headers: as('theirco', keyFor({}, stranger)) })).status).toBe(401);
    expect((await fetch(`${serviceUrl}/v2/`, { headers: as('theirco', keyFor({ id: 'revoked-id' })) })).status).toBe(401);
    expect((await fetch(`${serviceUrl}/v2/`, { headers: as('theirco', keyFor({ kind: 'licence' })) })).status).toBe(401);
    const tampered = keyFor({}).replace(/\.([^.]+)\./, (_, body: string) => `.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), updatesUntil: '2099-01-01' })).toString('base64url')}.`);
    expect((await fetch(`${serviceUrl}/v2/`, { headers: as('theirco', tampered) })).status).toBe(401);
  });

  it('covers the releases dated on or before the key\'s end, and says so about a newer one', async () => {
    const headers = as('theirco', keyFor({}));
    const releases = await (await fetch(`${serviceUrl}/releases`, { headers })).json();
    expect(releases).toMatchObject({ latest: '2026.10.27.1', releases: [{ version: '2026.10.27.1', date: '2026-10-27' }] });
    const tags = (await (await fetch(`${serviceUrl}/v2/acc-copy/tags/list`, { headers })).json()).tags;
    expect(tags).toContain('backend-2026.10.27.1');
    expect(tags.some((tag: string) => tag.includes('2027'))).toBe(false);
    const newer = await fetch(`${serviceUrl}/v2/acc-copy/manifests/backend-2027.02.01.1`, { headers });
    expect(newer.status).toBe(403);
    expect(JSON.stringify(await newer.json())).toContain('until 2026-12-31');
    expect((await fetch(`${serviceUrl}/releases/2027.02.01.1/install.mjs`, { headers })).status).toBe(403);
    // A longer key sees the newer release as the latest.
    const later = as('theirco', keyFor({ updatesUntil: '2027-12-31' }));
    expect((await (await fetch(`${serviceUrl}/releases`, { headers: later })).json()).latest).toBe('2027.02.01.1');
  });

  it('hands out a release\'s own files, and the images as a registry would', async () => {
    const headers = as('theirco', keyFor({}));
    const release = await (await fetch(`${serviceUrl}/releases/latest/copy-release.json`, { headers })).json();
    expect(release).toMatchObject({ version: '2026.10.27.1', commit: 'abc123' });
    expect(await (await fetch(`${serviceUrl}/releases/2026.10.27.1/install.mjs`, { headers })).text()).toBe('// installer of 2026.10.27.1\n');
    const manifest = await fetch(`${serviceUrl}/v2/acc-copy/manifests/backend-2026.10.27.1`, { headers });
    expect(manifest.status).toBe(200);
    const layer = (await manifest.json()).layers[0];
    const blob = Buffer.from(await (await fetch(`${serviceUrl}/v2/acc-copy/blobs/${layer.digest}`, { headers })).arrayBuffer());
    expect(digestOf(blob)).toBe(layer.digest);
    expect((await fetch(`${serviceUrl}/v2/acc-copy/manifests/not-a-release`, { headers })).status).toBe(404);
    expect((await fetch(`${serviceUrl}/v2/acc-copy/blobs/${layer.digest}`, { method: 'POST', headers })).status).toBe(405);
  });
});

describe('the installer\'s copy (note #811)', () => {
  it('copies every image of a release into the copy\'s own registry, byte for byte', async () => {
    const theirs = fakeRegistry('their-token');
    const theirsUrl = await listen(theirs.handler);
    const source = installer.updatesSource({ url: serviceUrl, customer: 'theirco', key: keyFor({}) });
    const dest = installer.flyRegistry({ app: 'theirco-images', token: 'their-token', base: theirsUrl });
    const lines: string[] = [];
    const { release, copied } = await installer.copyRelease({ source, dest, log: (line: string) => lines.push(line) });
    expect(release.version).toBe('2026.10.27.1');
    expect(Object.keys(copied)).toEqual(IMAGES);
    for (const image of IMAGES) {
      const ours = upstream.manifests.get('acc-copy-releases')!.get(`${image}-2026.10.27.1`)!;
      const copy = theirs.manifests.get('theirco-images')!.get(`${image}-2026.10.27.1`)!;
      expect(copy.bytes.equals(ours.bytes)).toBe(true);
      expect(copied[image]!.digest).toBe(digestOf(ours.bytes));
      for (const entry of JSON.parse(ours.bytes.toString()).layers) expect(theirs.blobs.has(entry.digest)).toBe(true);
    }
    expect(lines).toHaveLength(3);
    // A second run moves nothing it already has.
    const again: string[] = [];
    await installer.copyRelease({ source, dest, log: (line: string) => again.push(line) });
    expect(again.every((line) => line.includes(' 0 MB moved'))).toBe(true);
  });

  it('stops on a key the service refuses, in words', async () => {
    const source = installer.updatesSource({ url: serviceUrl, customer: 'theirco', key: 'acc1.bogus.bogus' });
    const dest = installer.flyRegistry({ app: 'x', token: 'y', base: serviceUrl });
    await expect(installer.copyRelease({ source, dest, log: () => undefined })).rejects.toThrow('did not accept');
  });
});

describe('licensing off: the update service hands releases to anyone (note #935)', () => {
  it('answers with no sign-in, offers every release, and the installer copies the latest with no key', async () => {
    expect((await fetch(`${openUrl}/v2/`)).status).toBe(200);
    const listed = await (await fetch(`${openUrl}/releases`)).json();
    expect(listed.latest).toBe('2027.02.01.1');
    const theirs = fakeRegistry('their-token');
    const theirsUrl = await listen(theirs.handler);
    const source = installer.updatesSource({ url: openUrl, customer: 'agents-theirco', key: null });
    const dest = installer.flyRegistry({ app: 'theirco-images', token: 'their-token', base: theirsUrl });
    const { release, copied } = await installer.copyRelease({ source, dest, log: () => undefined });
    expect(release.version).toBe('2027.02.01.1');
    expect(Object.keys(copied)).toEqual(IMAGES);
  });
});

describe('release notes: written per release, refused when missing, served by the update service (note #1006)', () => {
  type Notes = {
    notesProblem: (text: string) => string | null;
    notesTitle: (text: string) => string;
    readNotes: (version: string, dir?: string) => { file?: string; title?: string; problem?: string };
    NOTES_DIR: string;
  };
  let notes: Notes;
  let notesUrl = '';
  const GOOD = "# Release notes on every upgrade\n\n## What's new\n\n- A What's new screen.\n\n## Fixed\n\n- Nothing.\n\n## Needs you\n\n- Nothing.\n";
  beforeAll(async () => {
    notes = await import(/* @vite-ignore */ pathToFileURL(path.join(INFRA, 'copy-release/notes.mjs')).href);
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    // This deploy's own notes: one release cut before notes rode in images.
    const deployed = mkdtempSync(path.join(tmpdir(), 'deployed-notes-'));
    writeFileSync(path.join(deployed, '2026.11.01.1.md'), GOOD.replace('Release notes on every upgrade', 'Email set up from the Workspace'));
    const registry = fakeRegistry('our-token');
    const release = (version: string, files: Record<string, string>) => {
      registry.addImage('acc-copy-releases', `backend-${version}`, [gzipSync(Buffer.from(`backend ${version}`))]);
      registry.addImage('acc-copy-releases', `release-${version}`, [gzipSync(tar({ 'copy-release.json': JSON.stringify({ version }), 'install.mjs': '//\n', ...files }))]);
    };
    release('2026.10.27.4', {}); // a hand-built test release: no notes anywhere
    release('2026.11.01.1', {}); // before notes rode in the image
    release('2026.11.09.0', { 'notes.md': GOOD }); // after: its notes are in its image
    const handle = updates.createUpdateService({
    // Every release counts as from before the offer gate (note #1008): these tests are about other things.
    gateFrom: '9999.12.31.999',
      upstream: await listen(registry.handler), upstreamRepo: 'acc-copy-releases', upstreamToken: 'our-token',
      publicKey: signed.publicKeyFrom(signed.publicKeyX(privateKey)), notesDir: deployed,
    });
    notesUrl = await listen((req, res) => { void handle(req, res); });
  });

  it('checks a notes file\'s shape: a title, then What\'s new, Fixed and Needs you, none empty', () => {
    expect(notes.notesProblem(GOOD)).toBeNull();
    expect(notes.notesTitle(GOOD)).toBe('Release notes on every upgrade');
    expect(notes.notesProblem("## What's new\n- x\n")).toContain('first line must be the title');
    expect(notes.notesProblem("# T\n## What's new\n- x\n## Needs you\n- x\n")).toContain('in that order');
    expect(notes.notesProblem("# T\n## What's new\n- x\n## Fixed\n\n## Needs you\n- x\n")).toContain('"## Fixed" is empty');
  });

  it('refuses to cut a release whose notes are missing, before anything is built', async () => {
    const { spawnSync } = await import('node:child_process');
    expect(notes.readNotes('2099.01.01.0').problem).toContain('no release notes for 2099.01.01.0');
    const cli = spawnSync('node', [path.join(INFRA, 'copy-release/notes.mjs'), 'check', '2099.01.01.0'], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('refusing to cut 2099.01.01.0');
    // build.sh itself stops there: no docker, no registry, exit 1.
    const build = spawnSync('bash', [path.join(INFRA, 'copy-release/build.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH, VERSION: '2099.01.01.0', SHA: 'abc', RELEASE_REPO: 'none', MACHINE_IMAGE: 'x', APP_RUNTIME_IMAGE: 'y', FLY_API_TOKEN: 'z' },
    });
    expect(build.status).toBe(1);
    expect(build.stderr).toContain('refusing to cut 2099.01.01.0: no release notes');
    expect(build.stdout).not.toContain('== backend');
  });

  it('has notes for the release in VERSION and for every release companies were offered', async () => {
    const { readFileSync } = await import('node:fs');
    const version = readFileSync(path.join(INFRA, 'copy-release/VERSION'), 'utf8').trim();
    for (const v of [version, '2026.10.27.9', '2026.10.28.0', '2026.10.28.1', '2026.10.29.0', '2026.11.01.0', '2026.11.01.1']) {
      const read = notes.readNotes(v);
      expect(read.problem, v).toBeUndefined();
      // Words for an admin: no file names, no proposal numbers.
      const text = readFileSync(read.file!, 'utf8');
      expect(text, v).not.toMatch(/#\d{2,}|PR \d|\.(ts|tsx|mjs|sh)\b/);
    }
  });

  it('lists each release with its notes\' title, and serves the notes from the deploy or the image', async () => {
    const listed = await (await fetch(`${notesUrl}/releases`)).json();
    expect(listed.latest).toBe('2026.11.09.0');
    expect(listed.releases).toEqual([
      { version: '2026.10.27.4', date: '2026-10-27' },
      { version: '2026.11.01.1', date: '2026-11-01', summary: 'Email set up from the Workspace' },
      { version: '2026.11.09.0', date: '2026-11-09', summary: 'Release notes on every upgrade' },
    ]);
    const old = await fetch(`${notesUrl}/releases/2026.11.01.1/notes.md`);
    expect(old.status).toBe(200);
    expect(old.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await old.text()).toContain('# Email set up from the Workspace');
    const latest = await fetch(`${notesUrl}/releases/latest/notes.md`);
    expect(latest.headers.get('x-release')).toBe('2026.11.09.0');
    expect(await latest.text()).toBe(GOOD);
    const none = await fetch(`${notesUrl}/releases/2026.10.27.4/notes.md`);
    expect(none.status).toBe(404);
    expect(await none.text()).toBe('That release has no notes.');
    expect((await fetch(`${notesUrl}/releases/2026.12.01.0/notes.md`)).status).toBe(404);
  });

  it('ships the backfilled notes in its own deploy', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path.join(INFRA, 'copy-updates/Dockerfile'), 'utf8')).toContain('COPY copy-release/notes copy-release/notes');
    expect(readFileSync(path.join(INFRA, 'copy-updates/stage.sh'), 'utf8')).toContain('infra/copy-release/notes');
    expect(readFileSync(path.join(INFRA, 'copy-release/build.sh'), 'utf8')).toContain('COPY copy-release.json install.mjs notes.md /');
  });
});

describe('the offer gate: companies are offered a release only after the standing test copy passed it (note #1008)', () => {
  let gated = '';
  let registryUrl = '';
  let registry: ReturnType<typeof fakeRegistry>;
  const VERSIONS = ['2026.11.01.1', '2026.11.10.0', '2026.11.17.0'];
  beforeAll(async () => {
    registry = fakeRegistry('our-token');
    for (const version of VERSIONS) {
      registry.addImage('acc-copy-releases', `release-${version}`, [gzipSync(tar({
        'copy-release.json': JSON.stringify({ version, commit: 'abc', images: {} }), 'install.mjs': `// ${version}\n`,
      }))]);
    }
    registryUrl = await listen(registry.handler);
    const handle = updates.createUpdateService({
      upstream: registryUrl, upstreamRepo: 'acc-copy-releases', upstreamToken: 'our-token',
      publicKey: signed.publicKeyFrom(signed.publicKeyX(privateKey)),
    });
    gated = await listen((req, res) => { void handle(req, res); });
  });
  const offerIt = (extra: Record<string, unknown>) => offer.offerRelease({
    repo: 'acc-copy-releases', token: 'our-token', base: registryUrl, log: () => {}, now: () => new Date('2026-11-10T09:30:00Z'), ...extra,
  });

  it('keeps every release from before the gate offered, and holds back a new one, which its exact version still reaches', async () => {
    const listed = await (await fetch(`${gated}/releases`)).json();
    expect(listed.latest).toBe('2026.11.01.1');
    expect(listed.releases.map((r: { version: string }) => r.version)).toEqual(['2026.11.01.1']);
    expect((await fetch(`${gated}/releases/latest/copy-release.json`)).headers.get('x-release')).toBe('2026.11.01.1');
    // The test copy upgrades to it by name before anyone is offered it.
    const exact = await fetch(`${gated}/releases/2026.11.10.0/copy-release.json`);
    expect(exact.status).toBe(200);
    expect((await exact.json()).version).toBe('2026.11.10.0');
  });

  it('offers it once the gate passed, and names it latest', async () => {
    const done = await offerIt({ version: '2026.11.10.0', gate: 'passed', run: 'j1' });
    expect(offer.offerLine(done.offer!)).toBe('offered 2026.11.10.0: the standing test copy upgraded to it and passed both drills (run j1)');
    const listed = await (await fetch(`${gated}/releases`)).json();
    expect(listed.latest).toBe('2026.11.10.0');
    expect(listed.releases.map((r: { version: string }) => r.version)).toEqual(['2026.11.01.1', '2026.11.10.0']);
    expect((await offerIt({ version: '2026.11.10.0', gate: 'passed' })).already).toBe(true);
  });

  it('lets an operator through only with who and why, and keeps both in the release for good', async () => {
    await expect(offerIt({ version: '2026.11.17.0', gate: 'override', by: 'Ada' })).rejects.toThrow('An override needs --by <who> and --reason');
    expect((await (await fetch(`${gated}/releases`)).json()).latest).toBe('2026.11.10.0');
    await offerIt({ version: '2026.11.17.0', gate: 'override', by: 'Ada', reason: 'test copy down for a Fly outage; drill passed by hand' });
    expect((await (await fetch(`${gated}/releases`)).json()).latest).toBe('2026.11.17.0');
    // The offer's own file, as anyone reading the registry finds it.
    const doc = JSON.parse(registry.manifests.get('acc-copy-releases')!.get('offered-2026.11.17.0')!.bytes.toString());
    const layer = registry.blobs.get(doc.layers[0].digest)!;
    const kept = JSON.parse(updates.fileFromTar(layer, 'offer.json')!.toString());
    expect(kept).toEqual({ version: '2026.11.17.0', gate: 'override', at: '2026-11-10T09:30:00.000Z', by: 'Ada', reason: 'test copy down for a Fly outage; drill passed by hand' });
  });

  it('refuses a version with no release', async () => {
    await expect(offerIt({ version: '2026.12.01.0', gate: 'passed' })).rejects.toThrow('There is no release 2026.12.01.0 in acc-copy-releases.');
  });
});
