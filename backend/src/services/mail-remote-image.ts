/**
 * A picture a letter points AT, fetched by us and not by the reader's browser
 * (note #509, slice 10).
 *
 * The whole point of the door is who makes the request. A remote image drawn
 * straight by the browser hands the sender the reader's address, their
 * device, the hour they opened the letter and — with a per-reader URL, which
 * is how tracking actually works — the fact that it was this reader and no
 * other. Fetched here instead, the sender sees one of OUR servers asking for
 * a picture. They still learn the message was opened by somebody, and the
 * screen says so out loud in the button: this is not anonymity, it is the
 * difference between a postmark and a home address.
 *
 * Which makes this the one place in the app that will go out to the internet
 * on a URL a stranger chose, so every rule below is about what that may
 * reach. The caller has already checked that the letter really names this
 * picture (`mailHtmlNamesImage`); these are the rules for the fetch itself:
 *
 *  - http and https only, and no credentials in the URL;
 *  - every hop resolved first and refused unless every address it answers is
 *    a PUBLIC one — no loopback, no private range, no link-local, nothing
 *    inside this network;
 *  - THE CONNECTION IS PINNED to the addresses that check passed, because a
 *    check is worth nothing if the socket resolves the name again (below);
 *  - redirects followed by hand, capped, each one checked and pinned by that
 *    same rule, because a public address that redirects to `127.0.0.1` is the
 *    oldest trick there is;
 *  - one short timeout and a hard byte ceiling, enforced as the bytes arrive
 *    rather than trusting the length a server claims;
 *  - and the bytes must SNIFF as a raster image. SVG is refused whatever the
 *    server calls it: it is a document that can carry script, and this one
 *    would be served from our own origin.
 */

import { PUBLIC_HOST } from '../shared/public-host.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { sniffImageType } from './site-favicon.js';

/** Bigger than any picture a sane letter carries, small enough that a reader
 *  who taps Load pictures is never holding a download. */
export const MAIL_REMOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 2;

export type MailRemoteImageRefusal =
  /** Not an http(s) URL, or one carrying credentials. */
  | 'not_a_url'
  /** The name answers with an address inside a network, not out on the internet. */
  | 'not_public'
  | 'too_many_redirects'
  /** The other end refused, failed or took too long. */
  | 'unreachable'
  | 'too_large'
  /** The bytes are not a picture we will serve — SVG among them. */
  | 'not_an_image';

export type MailRemoteImageOutcome =
  | { body: Buffer; contentType: string }
  | { refused: MailRemoteImageRefusal };

/** How a host name is turned into addresses. Injected so a test can say what
 *  a name answers without asking a real resolver. */
export type MailAddressLookup = (hostname: string) => Promise<string[]>;

/**
 * One request, made to addresses THIS CALLER has already checked.
 *
 * The seam is the whole request rather than a bare `fetch` on purpose: what
 * makes this safe is that the socket goes to one of `addresses` and nowhere
 * else, so anything standing in for it has to be handed them too — and
 * `release` is how the socket it opened is let go of once the body has been
 * read or given up on.
 */
export interface MailImageConnection {
  response: Response;
  release(): void;
}
export type MailImageTransport = (
  url: string,
  options: { addresses: readonly string[]; signal: AbortSignal },
) => Promise<MailImageConnection>;

const defaultLookup: MailAddressLookup = async (hostname) => (
  (await lookup(hostname, { all: true })).map((entry) => entry.address)
);

const octets = (ip: string): number[] | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  return numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? numbers : null;
};

/**
 * Whether an address is out on the internet rather than inside something.
 *
 * Written as a list of what is NOT public, because that is the list that can
 * be checked against RFCs: everything else is allowed. An address this cannot
 * parse is refused — a guard that shrugs at what it does not understand is
 * not a guard.
 */
export function isPublicAddress(ip: string): boolean {
  const address = String(ip || '').trim().toLowerCase();
  const kind = isIP(address);
  if (kind === 4) {
    const parts = octets(address);
    if (!parts) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;                 // this network, private, loopback
    if (a === 169 && b === 254) return false;                            // link-local, and the cloud metadata door
    if (a === 172 && b >= 16 && b <= 31) return false;                   // private
    if (a === 192 && b === 168) return false;                            // private
    if (a === 100 && b >= 64 && b <= 127) return false;                  // carrier-grade NAT
    if (a === 192 && b === 0 && parts[2] === 0) return false;            // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false;               // benchmarking
    if (a >= 224) return false;                                          // multicast, reserved, broadcast
    return true;
  }
  if (kind !== 6) return false;
  // An IPv4 address wearing an IPv6 coat is still that address.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (address === '::' || address === '::1') return false;
  const head = address.split(':')[0] ?? '';
  const first = Number.parseInt(head.padStart(4, '0').slice(0, 4), 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false;                         // unique local
  if ((first & 0xffc0) === 0xfe80) return false;                         // link-local
  if ((first & 0xff00) === 0xff00) return false;                         // multicast
  return true;
}

/** The URL, if it is one we will ever ask for. */
function readable(src: string): URL | null {
  let url: URL;
  try { url = new URL(String(src || '').trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Credentials in a URL are for reaching something that asked for them;
  // nothing a letter points at needs to log us in.
  if (url.username || url.password) return null;
  return url.hostname ? url : null;
}

/**
 * The addresses this hop may reach, or null when it may not be reached at all.
 * One private answer is enough to refuse the lot: a name that resolves to both
 * is a name aiming inside.
 */
async function checkedAddresses(url: URL, resolve: MailAddressLookup): Promise<string[] | null> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicAddress(host) ? [host] : null;
  const addresses = await resolve(host).catch(() => []);
  if (!addresses.length || !addresses.every((address) => isPublicAddress(address))) return null;
  return addresses;
}

/**
 * THE PIN, and the reason this file has a transport at all.
 *
 * Checking a name and then handing that NAME to an HTTP client resolves it a
 * second time, and the second answer is the one the socket uses. A sender who
 * controls their own DNS answers a public address to our check and
 * `127.0.0.1` — or an address on this platform's private network — a moment
 * later, with a one-second TTL. The check would pass and the connection would
 * go somewhere else entirely; the whole guard above would be decoration.
 *
 * So the socket is given the addresses we already checked and is never
 * allowed to ask again: `net.connect`'s own `lookup` is the one thing that
 * decides which machine it reaches, and this one answers from a fixed list.
 * The URL is untouched, so TLS still validates the certificate against the
 * NAME (undici takes its SNI servername from the URL's host), and the Host
 * header is still the sender's own.
 */
export function pinnedAddressLookup(addresses: readonly string[]) {
  // EXACTLY what it was given, and nothing else — that is the whole job of a
  // pin. Whether those addresses may be reached at all is decided by
  // `checkedAddresses` before every hop, which is the one place that rule
  // lives; answering a different question here would only hide a caller that
  // skipped it.
  const pinned = addresses.filter((address) => isIP(address) !== 0);
  return (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (error: Error | null, address: never, family?: never) => void,
  ): void => {
    if (!pinned.length) {
      callback(new Error('No checked address for this host.'), '' as never);
      return;
    }
    const answers = pinned.map((address) => ({ address, family: isIP(address) }));
    if (options?.all) callback(null, answers as never);
    else callback(null, answers[0]!.address as never, answers[0]!.family as never);
  };
}

/** One request's own agent: pinned, and let go of as soon as the body is. */
function pinnedAgent(addresses: readonly string[]): Agent {
  return new Agent({
    connect: { lookup: pinnedAddressLookup(addresses) as never },
    // Nothing here is worth keeping a socket alive for: one picture, one
    // stranger's server, and an agent that outlives the request would hold a
    // connection open to it.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connectTimeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * The real request. Nothing of the reader goes with it: no cookies, no
 * referrer, no forwarded headers — our own name, and an Accept that says a
 * picture is all we want.
 */
export const mailImageTransport: MailImageTransport = async (url, { addresses, signal }) => {
  const agent = pinnedAgent(addresses);
  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      // Says what we are and where to complain — the shape a CDN expects from
      // something that is not a browser. Not a disguise: a host that refuses
      // non-browser clients still refuses us (Wikimedia's does, measured, with
      // or without this), and that is their call to make.
      headers: {
        accept: 'image/*',
        'user-agent': `Mozilla/5.0 (compatible; agenticcloudcomputer-mail-images/1.0; +https://${PUBLIC_HOST})`,
      },
      dispatcher: agent,
    });
    return {
      response: response as unknown as Response,
      release: () => { void agent.close().catch(() => agent.destroy()); },
    };
  } catch (error) {
    void agent.destroy();
    throw error;
  }
};

/** The body, up to the ceiling, refusing the moment it is past it rather than
 *  after a server has finished sending a gigabyte. */
async function readCapped(response: Response): Promise<Buffer | null> {
  const claimed = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(claimed) && claimed > MAIL_REMOTE_IMAGE_MAX_BYTES) return null;
  const stream = response.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAIL_REMOTE_IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Fetch one picture a letter points at, under every rule at the top. */
export async function fetchMailRemoteImage(
  src: string,
  options: { transport?: MailImageTransport; resolve?: MailAddressLookup } = {},
): Promise<MailRemoteImageOutcome> {
  const transport = options.transport ?? mailImageTransport;
  const resolve = options.resolve ?? defaultLookup;
  let url = readable(src);
  if (!url) return { refused: 'not_a_url' };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Resolved and checked HERE, and handed to the transport, which connects
    // to these and asks no name server anything.
    const addresses = await checkedAddresses(url, resolve);
    if (!addresses) return { refused: 'not_public' };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let connection: MailImageConnection;
    try {
      connection = await transport(url.toString(), { addresses, signal: abort.signal });
    } catch {
      return { refused: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
    try {
      const { response } = connection;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { refused: 'unreachable' };
        let next: URL;
        try { next = new URL(location, url); } catch { return { refused: 'not_a_url' }; }
        const checked = readable(next.toString());
        if (!checked) return { refused: 'not_a_url' };
        url = checked;
        continue;
      }
      if (!response.ok) return { refused: 'unreachable' };
      const body = await readCapped(response).catch(() => null);
      if (!body) return { refused: 'too_large' };
      const contentType = sniffImageType(body, response.headers.get('content-type') ?? undefined);
      // Sniffed, not taken on the server's word — and never SVG, which would be
      // a script-carrying document served from our own origin.
      if (!contentType || contentType === 'image/svg+xml') return { refused: 'not_an_image' };
      return { body, contentType };
    } finally {
      // Whatever is left on the wire is let go of rather than left half-read:
      // the body of a redirect nobody reads, or of a refusal.
      try { void connection.response.body?.cancel().catch(() => {}); } catch { /* already read, or locked */ }
      connection.release();
    }
  }
  return { refused: 'too_many_redirects' };
}
