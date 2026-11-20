/**
 * A repository's download (note #1199): the host's zip, passed through to the
 * person as it arrives. Shared by the Workspace's Download button and
 * `agentbuilt repo download`, so both say the same things when it cannot be
 * made.
 *
 * The zip holds the default branch's files plus the full `.git` — every
 * branch, every tag, every commit — so unzipping it gives an ordinary git
 * repository, and `git push --mirror <url>` from inside it moves everything
 * to another host. The host builds it (infra/git-host/git-host.mjs); this
 * process never holds more than a chunk of it.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import type { GitHostClient } from './git-host-client.js';

/** What the file is called on the person's computer. Repository names are
 *  `[A-Za-z0-9._-]` already, so nothing needs quoting inside the header. */
export function repoZipFileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]/g, '-')}.zip`;
}

/** The refusals the host can give, in words for a person. */
const HOST_REFUSALS: Record<number, string> = {
  413: 'This repository is too big for one zip — clone it with git instead.',
  429: 'Another download is being prepared — try again in a minute.',
  507: 'The code host is short of disk for this download right now — try again later.',
};

export async function sendRepoZip(
  host: Pick<GitHostClient, 'download'>,
  repo: { userId: string; name: string },
  res: Response,
): Promise<void> {
  // The person cancelling (or closing the tab) stops the host zipping: the
  // abort travels up the fetch, the host sees its reader go, and cleans up.
  const abort = new AbortController();
  const stop = () => abort.abort();
  res.on('close', stop);
  try {
    let upstream: globalThis.Response;
    try {
      upstream = await host.download(repo.userId, repo.name, abort.signal);
    } catch {
      if (!res.headersSent) res.status(502).json({ error: 'The code host did not answer — try again in a moment.' });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      const body = await upstream.json().catch(() => ({})) as { error?: string; code?: string };
      if (upstream.status === 404) {
        // A host from before downloads answers its generic "no such control
        // route"; anything else is a repository the host does not have.
        const older = /control route/.test(String(body.error ?? ''));
        res.status(older ? 503 : 404).json({
          error: older
            ? 'Downloads are not available on this repository\'s code host yet.'
            : 'No such repository here',
        });
        return;
      }
      const words = HOST_REFUSALS[upstream.status];
      res.status(words ? upstream.status : 502).json({
        error: words ?? 'The code host could not make this download — try again in a moment.',
        ...(body.code ? { code: body.code } : {}),
      });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${repoZipFileName(repo.name)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const estimate = upstream.headers.get('x-download-estimate-bytes');
    if (estimate && /^\d+$/.test(estimate)) res.setHeader('X-Download-Estimate-Bytes', estimate);
    try {
      await pipeline(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>), res);
    } catch {
      // Cut mid-way, from either end: the browser marks the download failed
      // rather than finished, which is the truth. Nothing to answer with.
      if (!res.destroyed) res.destroy();
    }
  } finally {
    res.off('close', stop);
  }
}
