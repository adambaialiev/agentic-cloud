/**
 * A deep link's first read, started the moment the page opens rather than
 * after the shell has booted (follow-up to note #825).
 *
 * Opening a proposal or a knowledge proposal from a link — a
 * notification, a tab the phone reloaded, a link pasted into a chat — used
 * to wait for the whole shell first: its script (≈300 KB compressed, fetched
 * afresh after every deploy, because every deploy renames it), then the
 * session read, and only then the screen's own read. Measured at phone size
 * on Fast 4G, the proposal's read started 0.7 s after the page on a reload
 * and 2.9 s on a first visit after a deploy, though nothing in it depends on
 * any of that: it is a GET carried by the session cookie, for an id the
 * address already names.
 *
 * So this tiny file — its own script, loaded ahead of the shell, with no
 * imports — reads the address, starts that one read, and leaves the promise
 * where the API client finds it (`takeEarlyRead` in api/client.ts). The
 * screen then asks exactly as it always did; the client hands it the answer
 * already in flight instead of starting a second request. Nothing else
 * changes: an answer that is not a success is thrown away and the screen's
 * own request goes out as before, a read nobody claims within a minute is
 * dropped, and a request built any differently (another workplace after the
 * session moved the tab) simply does not match and is made normally. It is a separate file, not inline, because the shell's CSP
 * allows scripts from its own origin only.
 *
 * It also warms the connection to the picture store a proposal's pictures
 * come from, remembered from the last proposal that carried one, so the
 * first picture does not pay a fresh TLS handshake after the words land.
 *
 * Kept free of imports on purpose: anything it imported would become a
 * shared chunk the browser must fetch before this can run. The addresses and
 * the request it builds are pinned against the route registry, the screens
 * and the client by early-read.test.ts.
 */

export const EARLY_READS_KEY = '__accEarlyReads';
export const MEDIA_ORIGIN_KEY = 'acc.mediaOrigin';
/** The Workspace's mount; the same constant the client defaults to. */
const BASE = '/workspace';
/** The tab's standing workplace, as standing-workplace.ts keeps it. */
const STANDING_WORKPLACE_KEY = 'acc.standingWorkplace';

export interface EarlyRead { url: string; at: number; response: Promise<Response> }

/**
 * The read a deep link's screen makes first, as `path` and workplace — or
 * null for an address with no such read. Mirrors the screens: the proposal
 * screen reads `api/prs/:id`, the knowledge proposal screen
 * `api/knowledge/proposals/:id`.
 */
export function earlyReadFor(pathname: string, search: string): { path: string; org: string | null } | null {
  const query = new URLSearchParams(search);
  const org = (query.get('org') ?? '').trim() || null;
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  // Production's addresses stand at the root (`/decisions/pr/:id`); the old
  // `/workspace` prefix still opens the same screen, so both are read — the
  // registry's own rule (stripWorkspaceLegacyBase). The first version read
  // only the prefixed form and so never fired on a real link.
  const tail = parts[0] === 'workspace' ? parts.slice(1) : parts;
  const [one, two, three] = tail;
  const rest = tail.length;
  // A proposal is addressed by id alone. (It went without a room while
  // screens still sent one, and the client matched it ignoring the room;
  // since note #843 no request names a room at all.)
  //
  // Notes are left out on purpose. A note's answer depends on the workplace
  // the session settles on, which this file cannot know before the session
  // read — the first version read notes too, and a pasted note link in a tab
  // whose workplace the session then changed drew a refused read and a
  // console error beside a screen that loaded fine (verify-workspace-react-home).
  if (rest === 3 && one === 'decisions' && two === 'pr' && three) return { path: `api/prs/${encodeURIComponent(decodeURIComponent(three))}`, org };
  if (rest === 3 && one === 'decisions' && two === 'knowledge' && three) return { path: `api/knowledge/proposals/${encodeURIComponent(decodeURIComponent(three))}`, org };
  return null;
}

/** The URL the API client would build for this read: the path, then the
 *  workplace the call rides (the address's, else the one this tab stands in). */
export function earlyReadUrl(read: { path: string; org: string | null }, standing: string | null): string {
  const org = read.org ?? standing;
  const extra: string[] = [];
  if (org) extra.push(`org=${encodeURIComponent(org)}`);
  return `${BASE}/${read.path}${extra.length ? `?${extra.join('&')}` : ''}`;
}

function csrf(): string {
  for (const name of ['__Host-acc_csrf', 'acc_csrf']) {
    const pair = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
    if (pair) { try { return decodeURIComponent(pair.slice(name.length + 1)); } catch { return ''; } }
  }
  return '';
}

function warmMediaConnection(): void {
  let origin = '';
  try { origin = window.localStorage.getItem(MEDIA_ORIGIN_KEY) ?? ''; } catch { return; }
  if (!/^https:\/\/[^/]+$/.test(origin)) return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  document.head.appendChild(link);
}

/** Start the read for this page's address, if it has one. */
export function startEarlyRead(): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  const read = earlyReadFor(window.location.pathname, window.location.search);
  if (!read) return;
  let standing: string | null = null;
  try { standing = window.sessionStorage.getItem(STANDING_WORKPLACE_KEY)?.trim() || null; } catch { standing = null; }
  const url = earlyReadUrl(read, standing);
  const token = csrf();
  // Read whole, at once, into a finished copy: a read nobody ends up
  // claiming (the screen asked in another workplace) would otherwise leave its
  // body unread and its request open for as long as the page lives — which
  // a browser counts as the page still loading.
  const response = fetch(url, { credentials: 'same-origin', ...(token ? { headers: { 'X-CSRF-Token': token } } : {}) })
    .then(async (answer) => new Response(await answer.arrayBuffer(), {
      status: answer.status, statusText: answer.statusText, headers: answer.headers,
    }));
  // A failure here is the screen's own request's business, not this one's.
  response.catch(() => {});
  const held = ((window as unknown as Record<string, EarlyRead[]>)[EARLY_READS_KEY] ??= []);
  held.push({ url, at: Date.now(), response });
  if (read.path.startsWith('api/prs/')) warmMediaConnection();
}

startEarlyRead();
