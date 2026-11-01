#!/usr/bin/env node
/**
 * Carry one published image into our private release registry unchanged
 * (note #811): the agent and site images a copy runs are the ones our own
 * fleet runs, byte for byte, so their digests in a release are production's.
 *
 *   FLY_API_TOKEN=… node infra/copy-release/carry.mjs <source ref> <release repo> <tag>
 *
 * The source is any registry that serves public images (ghcr.io today);
 * prints the digest of what landed. Uses the installer's own copy, so the
 * code that moves images into a customer's registry is the code tested here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { copyImage, flyRegistry } from '../copy-installer/install.mjs';

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** A public image's registry, signed in the way it asks: an anonymous bearer
 *  token for the one repository. */
export function publicSource(ref, fetchImpl = fetch) {
  const match = /^([^/]+)\/(.+):([^:/]+)$/.exec(ref);
  if (!match) throw new Error(`not an image reference with a tag: ${ref}`);
  const [, host, repo, tag] = match;
  let auth = null;
  const get = async (pathname, headers = {}) => {
    const url = `https://${host}/v2/${repo}/${pathname}`;
    let answer = await fetchImpl(url, { headers: { ...headers, ...(auth ? { authorization: auth } : {}) } });
    const challenge = answer.headers.get('www-authenticate') ?? '';
    if (answer.status === 401 && challenge.startsWith('Bearer ')) {
      const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      const tokenUrl = `${fields.realm}?service=${encodeURIComponent(fields.service ?? '')}&scope=${encodeURIComponent(`repository:${repo}:pull`)}`;
      const token = await (await fetchImpl(tokenUrl)).json();
      auth = `Bearer ${token.token ?? token.access_token}`;
      answer = await fetchImpl(url, { headers: { ...headers, authorization: auth } });
    }
    return answer;
  };
  return {
    tag,
    async manifest(reference) {
      const answer = await get(`manifests/${reference === tag ? tag : reference}`, { accept: MANIFEST_TYPES });
      if (!answer.ok) throw new Error(`${ref}: ${answer.status}`);
      return { bytes: Buffer.from(await answer.arrayBuffer()), type: answer.headers.get('content-type') };
    },
    async blobTo(digest, file) {
      const answer = await get(`blobs/${digest}`);
      if (!answer.ok || !answer.body) throw new Error(`${ref} layer ${digest}: ${answer.status}`);
      await pipeline(Readable.fromWeb(answer.body), createWriteStream(file));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [source, repo, destTag] = process.argv.slice(2);
  if (!source || !repo || !destTag || !process.env.FLY_API_TOKEN) {
    console.error('usage: FLY_API_TOKEN=… carry.mjs <source ref> <release repo> <tag>');
    process.exit(2);
  }
  const from = publicSource(source);
  // copyImage asks the source for the destination tag's name; answer with the
  // source's own tag instead.
  const sourceForTag = { ...from, manifest: (reference) => from.manifest(reference === destTag ? from.tag : reference) };
  const workdir = mkdtempSync(path.join(tmpdir(), 'acc-carry-'));
  copyImage(sourceForTag, flyRegistry({ app: repo, token: process.env.FLY_API_TOKEN }), destTag, workdir)
    .then(({ digest, moved }) => {
      console.error(`carried ${source} → registry.fly.io/${repo}:${destTag} (${(moved / 1e6).toFixed(0)} MB moved)`);
      process.stdout.write(`${digest}\n`);
    })
    .catch((error) => { console.error(`carry: ${error.message}`); process.exitCode = 1; })
    .finally(() => rmSync(workdir, { recursive: true, force: true }));
}
