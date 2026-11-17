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
 * Note #1188: a reply's words and its UI, apart. The words the reply OPENS
 * with — every top-level node before the first one that runs or asks — are
 * drawn natively, outside the card; from that node on, everything is the UI
 * the agent sent, and runs in the locked frame inside the card. Parsed inert
 * (DOMParser runs nothing). Anything the parser lifts into <head> — a
 * leading <style>, <script>, <meta> or <link> — belongs to the whole page, so
 * then nothing is split off and the whole reply is the UI.
 */
export function splitHtmlReply(html: string, needsFrame: (part: string) => boolean): { words: string; ui: string } {
  if (!needsFrame(html)) return { words: html, ui: '' };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.head.childNodes.length) return { words: '', ui: html };
  const nodes = Array.from(doc.body.childNodes);
  const serialize = (node: ChildNode): string => {
    if (node.nodeType === Node.ELEMENT_NODE) return (node as Element).outerHTML;
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '';
  };
  let at = 0;
  for (; at < nodes.length; at += 1) {
    if (needsFrame(serialize(nodes[at]!))) break;
  }
  const words = nodes.slice(0, at).map(serialize).join('').trim();
  // Nothing found to split at (the asking part was in an attribute the
  // walk serialised away, say): the whole reply stays the UI, as before.
  if (at >= nodes.length) return { words: '', ui: html };
  return { words, ui: nodes.slice(at).map(serialize).join('').trim() };
}

/**
 * Which replies' UI the person closed (note #1188), on this device: closing
 * only hides it — nothing is sent and no turn starts — and the reply keeps a
 * quiet way to show it again. Keyed by the UI's own words, so the same
 * reply is the same key whatever its place in the list; the newest 200 kept.
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
