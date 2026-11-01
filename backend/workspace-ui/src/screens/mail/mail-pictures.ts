/**
 * The pictures in a letter, and which of them may be drawn (note #509, slice 10).
 *
 * Slice 3 drew none at all, and the reason stands: a remote image is a read
 * receipt. Asking a sender's server for a picture tells them the letter was
 * opened, when, and — through a URL minted for one recipient — that it was
 * this reader. So the default is unchanged, and this module is the two doors
 * through it, plus the one thing that is refused on both sides of them.
 *
 * INLINE — a picture that travelled inside the message, which the body points
 * at with `cid:`. Its bytes are in our own storage already, so drawing it asks
 * nobody anything and it needs no tap.
 *
 * REMOTE — a picture at somebody's address, drawn only after the reader taps,
 * and then fetched by our SERVER rather than their browser.
 *
 * A TRACKING PIXEL is refused either way: an image one pixel across, or one
 * the markup hides, is not a picture anybody is being shown, and the only
 * thing drawing it could achieve is the report back to whoever sent it.
 *
 * The counting below and the drawing below are the same two functions asked
 * twice, deliberately — the trap note #534 left on this screen: a line that
 * says pictures were left out has to be decided by the build that left them
 * out, or the two disagree and the reader is told about a gap that is not
 * there.
 */

import { WORKSPACE_API_BASE } from '../../../../src/shared/workspace-routes.js';
import type { SafeHtmlImages } from '../../render/SafeHtml.js';
import type { WorkspaceMailFile } from '../../../../src/shared/workspace-mail.js';

/** A picture that arrived as bytes rather than as an address: no network, so
 *  it costs its reader nothing. SVG is not among them — it is a document that
 *  can carry script, and nothing here will draw one. */
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i;

/** `cid:header-crop` → `header-crop`, and null for anything else. The angle
 *  brackets a Content-ID wears in a header are not in the reference. */
export function mailCid(src: string): string | null {
  const raw = String(src || '').trim();
  if (!/^cid:/i.test(raw)) return null;
  let id = raw.slice(4).replace(/^<|>$/g, '');
  try { id = decodeURIComponent(id); } catch { /* a cid is rarely escaped; keep it as written */ }
  return id.trim() || null;
}

/** Our own address for a picture that came with the message. Same shape as
 *  the files route beside it, and read with the reader's own session. */
export function mailInlineImageUrl(messageId: string, fileId: string): string {
  return `${WORKSPACE_API_BASE}/api/mail/messages/${encodeURIComponent(messageId)}/inline/${encodeURIComponent(fileId)}`;
}

/** Our own address for a picture the letter points AT: the proxy fetches it,
 *  so the sender's server sees us and never the reader. */
export function mailRemoteImageUrl(messageId: string, src: string): string {
  return `${WORKSPACE_API_BASE}/api/mail/messages/${encodeURIComponent(messageId)}/remote-image?src=${encodeURIComponent(src.trim())}`;
}

const smallSide = (value: string | null): boolean => {
  const size = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(size) && size <= 1;
};

/**
 * A picture that is not there to be looked at.
 *
 * The three shapes a tracker actually takes: a side of one pixel (or zero),
 * `display:none`, and a transparent or invisible box. The `style` attribute
 * is read HERE even though the allowlist refuses to copy it — what it says is
 * evidence about the sender's intent, and throwing it away before reading it
 * is how a hidden pixel would come to be drawn.
 */
export function mailHiddenImage(element: Element): boolean {
  if (smallSide(element.getAttribute('width')) || smallSide(element.getAttribute('height'))) return true;
  const style = (element.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  if (!style) return false;
  if (style.includes('display:none') || style.includes('visibility:hidden') || style.includes('opacity:0')) return true;
  const sized = /(?:^|;)(?:width|height):([0-9.]+)px/g;
  for (const match of style.matchAll(sized)) if (Number.parseFloat(match[1]!) <= 1) return true;
  return false;
}

/** What one `<img>` in a letter IS. */
export type MailPictureKind =
  /** It came with the message and we hold the bytes. */
  | 'inline'
  /** The bytes are in the markup itself; nothing is fetched to draw it. */
  | 'data'
  /** It lives at somebody's address, and drawing it is a request to them. */
  | 'remote'
  /** One pixel, or hidden: a report back, not a picture. */
  | 'hidden'
  /** A `cid:` naming a part this message does not carry, or an address this
   *  app will not follow. Nothing to draw and nothing to ask for. */
  | 'missing';

/** Which pictures a message holds, by the reference each one carries. `held`
 *  answers whether a `cid:` names a part of THIS message. */
export function mailPictureKind(element: Element, held: (cid: string) => boolean): MailPictureKind {
  if (mailHiddenImage(element)) return 'hidden';
  const src = (element.getAttribute('src') ?? '').trim();
  const cid = mailCid(src);
  if (cid) return held(cid) ? 'inline' : 'missing';
  if (DATA_IMAGE.test(src)) return 'data';
  return /^https?:\/\//i.test(src) ? 'remote' : 'missing';
}

export interface MailPictureCounts {
  /** Drawn with no tap: they cost the reader nothing. */
  drawn: number;
  /** At somebody's address: drawn only when the reader asks. */
  remote: number;
  /** Refused whatever the reader asks, and never counted as a picture that
   *  was "left out" — nobody was going to see it. */
  hidden: number;
}

/** The `cid:` references this message can actually answer, as cid → our URL. */
export function mailInlinePictures(messageId: string, files: readonly WorkspaceMailFile[]): Record<string, string> {
  const held: Record<string, string> = {};
  for (const file of files) {
    if (!file.contentId || !file.contentType.toLowerCase().startsWith('image/')) continue;
    if (file.contentType.toLowerCase().startsWith('image/svg')) continue;
    held[file.contentId] = mailInlineImageUrl(messageId, file.id);
  }
  return held;
}

/** What is in this body, counted through the same two rules that draw it. */
export function mailPictures(html: string, inline: Record<string, string>): MailPictureCounts {
  const counts: MailPictureCounts = { drawn: 0, remote: 0, hidden: 0 };
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
  for (const element of Array.from(parsed.querySelectorAll('img'))) {
    const kind = mailPictureKind(element, (cid) => Boolean(inline[cid]));
    if (kind === 'inline' || kind === 'data') counts.drawn += 1;
    else if (kind === 'remote') counts.remote += 1;
    else if (kind === 'hidden') counts.hidden += 1;
  }
  return counts;
}

/**
 * The decider the renderer asks about every `<img>` of the sender's.
 *
 * `load` is this reader's answer for THIS letter — the tap, or the standing
 * yes for this sender — and it is the only thing that turns a remote address
 * into a request, which is then made by our server and not by them.
 */
export function mailImageDecider(
  { messageId, inline, load }: { messageId: string; inline: Record<string, string>; load: boolean },
): SafeHtmlImages {
  return (element: Element) => {
    const kind = mailPictureKind(element, (cid) => Boolean(inline[cid]));
    if (kind === 'inline') return inline[mailCid(element.getAttribute('src') ?? '')!] ?? null;
    if (kind === 'data') return (element.getAttribute('src') ?? '').trim();
    if (kind === 'remote' && load) return mailRemoteImageUrl(messageId, element.getAttribute('src') ?? '');
    return null;
  };
}
