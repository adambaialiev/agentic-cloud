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
