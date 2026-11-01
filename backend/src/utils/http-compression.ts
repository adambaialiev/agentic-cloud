import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Request, RequestHandler, Response } from 'express';

/**
 * Compression for what the Mini App downloads.
 *
 * The page is one self-contained 120 KB file and a repository file or a diff
 * can be another 512 KB of text, all of it served to a phone on mobile data,
 * and nothing in front of the backend compresses (the host's Caddy is a bare
 * `reverse_proxy`). Text like this compresses four to five times over, so this
 * is the difference between a mini app that opens and one that spins.
 *
 * Deliberately not the `compression` package: everything this needs is in
 * `node:zlib`, the responses involved are whole strings rather than streams,
 * and a dependency in the request path of the product's main surface is a
 * dependency worth not having.
 */

export type Encoding = 'br' | 'gzip';

/** Below this a compressed body is not meaningfully smaller than the original. */
const MIN_COMPRESSED_BYTES = 1024;

/** What we are willing to compress: text we generated. Never an image. */
const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|xml)\b)/i;

/**
 * Quality 5 for anything compressed per request — it is within a few percent
 * of brotli's best ratio at a fraction of the cost, which is the trade a
 * response being built right now wants.
 */
const DYNAMIC_BROTLI_QUALITY = 5;

/**
 * The client's preference, or null when it asked for nothing we can do.
 * Brotli first: on this page it is ~20% smaller than gzip, and every client
 * that can open a Telegram Mini App speaks it. `q=0` is a REFUSAL, so an
 * `Accept-Encoding: br;q=0, gzip` must come back gzip, never br.
 */
export function pickEncoding(header: string | string[] | undefined): Encoding | null {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const offered = new Set<string>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';').map((piece) => piece.trim());
    if (!name) continue;
    const q = params.find((piece) => piece.startsWith('q='));
    if (q && Number.parseFloat(q.slice(2)) === 0) continue;
    offered.add(name);
  }
  if (offered.has('br')) return 'br';
  if (offered.has('gzip')) return 'gzip';
  return null;
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * Always the ASYNC compressor, which runs on libuv's thread pool. Brotli over
 * a 350 KB source file is ~35 ms, and 35 ms of a synchronous call is 35 ms in
 * which this backend answers nobody — including the Telegram webhooks it is
 * really here for.
 */
export function compressBody(body: Buffer, encoding: Encoding, quality = DYNAMIC_BROTLI_QUALITY): Promise<Buffer> {
  if (encoding === 'gzip') return gzipAsync(body, { level: 6 });
  return brotliAsync(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      // Brotli picks a smaller window — and so a smaller output — when it is
      // told up front how much is coming.
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  });
}

/**
 * Compress string/Buffer responses on their way out.
 *
 * Wrapping `res.send` catches `res.json` too (it stringifies and calls send),
 * which is every data response this router has. Anything else — a stream, an
 * image, a body already encoded, a body too small to be worth it — is passed
 * through untouched, so the middleware can only ever remove bytes.
 *
 * The ETag is left to Express, which computes it AFTER this runs, i.e. over
 * the compressed bytes: each encoding gets its own validator, which is exactly
 * what `Vary: Accept-Encoding` promises a cache.
 *
 * Compressing is asynchronous, so `res.send` returns before the body is
 * written. Every handler here ends with `return res.json(...)`, which is the
 * shape that stays correct; a compressor that somehow fails sends the original
 * body rather than losing the response.
 */
export function compressResponses(): RequestHandler {
  return (req: Request, res: Response, next) => {
    const encoding = pickEncoding(req.headers['accept-encoding']);
    // HEAD must keep the byte counts of the GET it stands for, and we do not
    // know them without compressing a body we are not allowed to send.
    if (!encoding || req.method === 'HEAD') return next();

    const send = res.send.bind(res);
    res.send = ((body?: unknown) => {
      const raw = typeof body === 'string' ? Buffer.from(body, 'utf8')
        : Buffer.isBuffer(body) ? body : null;
      if (!raw
        || raw.length < MIN_COMPRESSED_BYTES
        || res.getHeader('Content-Encoding')
        || !TEXTUAL.test(String(res.getHeader('Content-Type') ?? ''))) {
        return send(body as never);
      }
      compressBody(raw, encoding).then(
        (compressed) => {
          // Set only once there IS a compressed body: a failed pass must not
          // leave a header claiming an encoding that never happened.
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Vary', 'Accept-Encoding');
          res.removeHeader('Content-Length');
          send(compressed);
        },
        () => { send(body as never); },
      );
      return res;
    }) as Response['send'];

    return next();
  };
}
