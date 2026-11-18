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

/** A short, stable key for a reply's own HTML: the same reply is the same
 *  key whatever its place in the list. */
export function htmlUiKey(ui: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ui.length; i += 1) { hash ^= ui.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return `${(hash >>> 0).toString(36)}${ui.length.toString(36)}`;
}

/** Where a device remembered which cards its person had closed (note
 *  #1188). The close left with note #1193, so nothing reads it; it is
 *  taken off the device the first time the heights below are read. */
const CLOSED_KEY = 'acc.htmlReplyClosed';

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
  try { window.localStorage.removeItem(CLOSED_KEY); } catch { /* nothing to tidy */ }
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
