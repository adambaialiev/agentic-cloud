/**
 * Pictures in letters (note #509, slice 10) — the rules both routers share.
 *
 * Until this slice no picture in a message was ever fetched, for a reason
 * that has not changed: a remote image is a read receipt. Requesting one
 * tells the sender the letter was opened, when, and from which address — so
 * the DEFAULT is still that nothing is fetched, and everything here is about
 * the two doors through that default.
 *
 * INLINE pictures travelled INSIDE the message and are already in our own
 * media storage, so drawing one asks nobody anything; the body points at them
 * with `cid:` and the screen turns that into a read of our own files. REMOTE
 * pictures are fetched only when the reader asks, by our SERVER rather than
 * their browser, and only for a URL the letter itself names — which is what
 * keeps the proxy from being a fetcher for anything a signed-in caller can
 * type.
 */

import { decodeHtmlText } from '../types/safe-html.js';

/** An address as the allowlist keys it. A mail address is case-insensitive
 *  in the part that matters here, and a list holding two spellings of one
 *  sender would load pictures for one of them and not the other. */
export function mailSenderKey(address: string): string {
  return String(address || '').trim().toLowerCase();
}

/**
 * Every `src` the stored markup names, exactly as the attribute holds it.
 *
 * Read with a regular expression rather than a DOM, because this is not
 * rendering: it is the server asking "did this letter really point at that
 * URL", and the answer has to be about the bytes we stored. Entities are
 * decoded (`&amp;` is one ampersand in the attribute the browser reads), so
 * what the screen asks for and what this finds are the same string.
 */
export function mailImageSources(html: string | undefined): string[] {
  const found: string[] = [];
  const images = String(html || '').match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of images) {
    const match = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value) found.push(decodeHtmlText(value));
  }
  return found;
}

/**
 * Whether this message really points at this picture.
 *
 * The proxy below will go out to the internet on a signed-in person's
 * request, so the URL it may be asked for is not "any URL": it is one of the
 * ones a letter in their own mailbox names. A stranger still chose it — that
 * is what a letter is — which is why the fetch itself is bounded as well; but
 * this check is what stops the door being a general-purpose fetcher for
 * anybody who can sign in.
 */
export function mailHtmlNamesImage(html: string | undefined, src: string): boolean {
  const wanted = String(src || '').trim();
  if (!wanted) return false;
  return mailImageSources(html).includes(wanted);
}
