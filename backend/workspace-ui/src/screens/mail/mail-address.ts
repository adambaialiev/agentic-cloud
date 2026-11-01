/**
 * Where a mail list's reads and words live (note #509, slice 7).
 *
 * A search is written into the list's own entry — `/workspace/mail?q=brief`,
 * `/workspace/mail/trash?q=invoice` — IN PLACE, never pushed, the way the
 * notes list keeps its chip (notes-address.ts): Back from a result returns to
 * the results, while Back from the list still leaves the screen rather than
 * walking back through every word typed on it. Pure, and the only place
 * either address is written.
 */

import type { MailListKey } from './mail-cache.js';
import type { MailPlaceName } from './mail-words.js';

/** Where the search words live in the address. */
export const MAIL_SEARCH_PARAM = 'q';

/** The screen's own address, with `words` as its search — and every other
 *  parameter as it arrived. No words writes no parameter. */
export function mailAddressWith(search: URLSearchParams, words: string): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, value] of search) {
    if (key !== MAIL_SEARCH_PARAM) next.append(key, value);
  }
  if (words) next.set(MAIL_SEARCH_PARAM, words);
  return next;
}

/** The read behind one list: a place, or a search of it — and, to page
 *  (note #666), the cursor the page before it answered with. */
export function mailListPath({ view, search }: MailListKey, before?: string): string {
  const params = new URLSearchParams();
  if (view !== 'inbox') params.set('in', view);
  if (search) params.set('q', search);
  if (before) params.set('before', before);
  const query = params.toString();
  return query ? `api/mail/messages?${query}` : 'api/mail/messages';
}

/** The read behind one place's list: its conversations (slice 8). A search
 *  is still `mailListPath` — it finds letters, not conversations. */
export function mailConversationsPath(place: MailPlaceName, before?: string): string {
  const params = new URLSearchParams();
  if (place !== 'inbox') params.set('in', place);
  if (before) params.set('before', before);
  const query = params.toString();
  return query ? `api/mail/conversations?${query}` : 'api/mail/conversations';
}
