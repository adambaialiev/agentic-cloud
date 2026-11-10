/**
 * How a visitor arrived, for the guest agent (note #1139): the utm tags on the
 * link that opened this tab and the site that sent it, noted from the FIRST
 * page of the visit and kept in this tab's sessionStorage only (no cookie,
 * gone when the tab closes). It leaves the browser only inside Start guest
 * agent (makeGuest), and the backend keeps it, cleaned, with that guest's
 * conversation for the owner to read. The guest's agent never sees it.
 *
 * Separate from the first-visit record (backend/src/shared/first-visit.ts),
 * which is this browser's first visit ever, for sign-ups; this one is this
 * visit, for a guest.
 */
import { GUEST_UTM_KEYS, GUEST_UTM_MAX_CHARS, type GuestArrivalInput } from '../../backend/src/shared/guest-agent';

export const GUEST_ARRIVAL_KEY = 'acc.guestArrival';

/** The slice of `window` this needs, structural so tests can hand in their own. */
export interface ArrivalBrowser {
  sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  document: { referrer: string };
  location: { search: string; hostname: string };
}

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, '');

/** What one page load says: the utm tags of its address, and the referring site's host when it is not ours. */
export function arrivalOf(search: string, referrer: string, ownHost: string): GuestArrivalInput {
  const utm: NonNullable<GuestArrivalInput['utm']> = {};
  try {
    const params = new URLSearchParams(search);
    for (const key of GUEST_UTM_KEYS) {
      const value = params.get(key)?.trim();
      if (value) utm[key] = value.slice(0, GUEST_UTM_MAX_CHARS);
    }
  } catch {
    // Not a query string: no tags.
  }
  let referrerHost: string | null = null;
  try {
    const host = bareHost(new URL(referrer).hostname);
    if (host && host !== bareHost(ownHost)) referrerHost = host;
  } catch {
    // No referrer, or not an address.
  }
  return { utm, referrerHost };
}

/** Note this tab's arrival on its first page load, and never again in this tab. */
export function rememberArrival(browser: ArrivalBrowser): void {
  try {
    if (browser.sessionStorage.getItem(GUEST_ARRIVAL_KEY)) return;
    browser.sessionStorage.setItem(GUEST_ARRIVAL_KEY, JSON.stringify(arrivalOf(browser.location.search, browser.document.referrer, browser.location.hostname)));
  } catch {
    // Storage blocked: nothing is noted, and nothing else is affected.
  }
}

/** This tab's arrival, for Start guest agent; undefined when none was noted. The backend cleans it again. */
export function readArrival(browser: Pick<ArrivalBrowser, 'sessionStorage'>): GuestArrivalInput | undefined {
  try {
    const raw = JSON.parse(browser.sessionStorage.getItem(GUEST_ARRIVAL_KEY) ?? 'null') as GuestArrivalInput | null;
    return raw && typeof raw === 'object' ? { utm: raw.utm ?? {}, referrerHost: raw.referrerHost ?? null } : undefined;
  } catch {
    return undefined;
  }
}
