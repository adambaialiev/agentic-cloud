/** Note #1186: the locked frame's address, and the links a reply carries as written. See HtmlReply.tsx. */

/** Where the frame is served: the backend, on this same origin. */
export const REPLY_FRAME_SRC = '/workspace/reply-frame';
/** Every link the HTML carries as written, resolved the way the frame
 *  resolves it (against the frame's own address). Parsed inert: a
 *  DOMParser document runs no script and fetches nothing. */
export function linksAsWritten(html: string): Set<string> {
  const out = new Set<string>();
  const base = new URL(REPLY_FRAME_SRC, window.location.origin).href;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    try { out.add(new URL(a.getAttribute('href') ?? '', base).href); } catch { /* not an address */ }
  }
  return out;
}

/**
 * Which framed replies the person closed (note #1188), on this device:
 * closing only hides it — nothing is sent and no turn starts — and the reply
 * keeps a quiet way to show it again. Keyed by the reply's own HTML, so the
 * same reply is the same key whatever its place in the list; the newest 200
 * kept. Since note #1193 the key is of the whole reply, not of the part that
 * used to be split off as its UI, so a card closed before that change shows
 * once more.
 */
const CLOSED_KEY = 'acc.htmlReplyClosed';
const CLOSED_MAX = 200;

export function htmlUiKey(ui: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ui.length; i += 1) { hash ^= ui.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return `${(hash >>> 0).toString(36)}${ui.length.toString(36)}`;
}

function readClosed(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(CLOSED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch { return []; }
}

export function isHtmlUiClosed(key: string): boolean {
  return readClosed().includes(key);
}

export function setHtmlUiClosed(key: string, closed: boolean): void {
  const rest = readClosed().filter((entry) => entry !== key);
  const next = closed ? [...rest, key].slice(-CLOSED_MAX) : rest;
  try { window.localStorage.setItem(CLOSED_KEY, JSON.stringify(next)); } catch { /* private mode: closed for this view only */ }
}

/**
 * A framed reply's last measured height, on this device (note #1193). Since
 * every reply may be a frame, a conversation opened again would otherwise be
 * drawn as a column of small placeholders that each grow as its frame
 * reports in, under the reader's thumb. Keyed by the reply's own HTML and the
 * window's width, because the same page is a different height on a phone
 * and at a desk; the newest 300 kept, written a moment after the last change
 * rather than on every report a resizing page sends.
 */
const HEIGHTS_KEY = 'acc.htmlReplyHeights';
const HEIGHTS_MAX = 300;
let heights: Map<string, number> | null = null;
let heightsSave: number | undefined;

function heightsHeld(): Map<string, number> {
  if (heights) return heights;
  heights = new Map();
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(HEIGHTS_KEY) ?? '[]');
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1])) heights.set(entry[0], entry[1]);
      }
    }
  } catch { /* nothing kept: frames start small, as they did */ }
  return heights;
}

const heightKeyOf = (key: string): string => `${key}@${window.innerWidth}`;

export function rememberedFrameHeight(key: string): number | undefined {
  return heightsHeld().get(heightKeyOf(key));
}

export function rememberFrameHeight(key: string, height: number): void {
  const held = heightsHeld();
  const at = heightKeyOf(key);
  if (held.get(at) === height) return;
  // Newest last, so the oldest are the ones that leave.
  held.delete(at);
  held.set(at, height);
  window.clearTimeout(heightsSave);
  heightsSave = window.setTimeout(() => {
    try { window.localStorage.setItem(HEIGHTS_KEY, JSON.stringify([...held].slice(-HEIGHTS_MAX))); } catch { /* private mode: held for this view only */ }
  }, 400);
}

/** For tests: forget what this page session holds. */
export function forgetFrameHeights(): void {
  window.clearTimeout(heightsSave);
  heights = null;
}
