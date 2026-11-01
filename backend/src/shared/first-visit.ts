/**
 * Where a person first came from: the site that sent this browser to us on
 * its first visit, and the first page it opened. Growth asked for it
 * because nothing else could say whether a post worked; the owner agreed on
 * 2026-10-08, with two limits: no `?s=` tags on links (parked since 25 Sep)
 * and no question asked of the person.
 *
 * The landing site and the Workspace share one origin, so one record in this
 * browser's own storage covers both: whichever page opens first writes it,
 * and nothing ever overwrites it. It leaves the browser only inside the
 * account-creation request, and the backend keeps it on the new profile.
 *
 * What a browser says is limited on purpose. Browsers send only the origin of
 * the page that linked here (strict-origin-when-cross-origin), so `from` is a
 * host — `t.co` for X, `google.com` — and never the address the person was
 * reading. Many apps' own browsers send nothing at all, so `''` ("direct")
 * means "no site was named", not "they typed it".
 */

export const FIRST_VISIT_KEY = 'acc.firstVisit';

export interface FirstVisit {
  /** The referring site's host without `www.`, or '' when the browser named none. */
  from: string;
  /** Path of the first page opened, without its query. */
  page: string;
  /** ISO. */
  at: string;
}

/** The slice of `window` this needs — kept structural so the backend compiles it without the DOM. */
export interface FirstVisitBrowser {
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  document: { referrer: string };
  location: { pathname: string; hostname: string };
}

const HOST = /^[a-z0-9.-]{1,253}$/;
const PAGE = /^\/[!-~]{0,199}$/;

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, '');

/** The record for one page load. Pure, so both apps and the tests agree on it. */
export function firstVisitOf(referrer: string, pathname: string, ownHost: string, now: Date): FirstVisit {
  let from = '';
  try {
    const host = bareHost(new URL(referrer).hostname);
    // A link from our own pages is not where anyone came from.
    if (host && host !== bareHost(ownHost)) from = host;
  } catch {
    // No referrer, or not an address.
  }
  return { from, page: PAGE.test(pathname) ? pathname : '/', at: now.toISOString() };
}

/** Write this browser's record on its first page load, and never again. */
export function rememberFirstVisit(browser: FirstVisitBrowser, now = new Date()): void {
  try {
    if (browser.localStorage.getItem(FIRST_VISIT_KEY)) return;
    const visit = firstVisitOf(browser.document.referrer, browser.location.pathname, browser.location.hostname, now);
    browser.localStorage.setItem(FIRST_VISIT_KEY, JSON.stringify(visit));
  } catch {
    // Storage blocked: nothing is remembered, and nothing else is affected.
  }
}

/** This browser's record, for the account-creation request; undefined when there is none. */
export function readFirstVisit(browser: Pick<FirstVisitBrowser, 'localStorage'>): FirstVisit | undefined {
  try {
    return cleanFirstVisit(JSON.parse(browser.localStorage.getItem(FIRST_VISIT_KEY) ?? 'null'));
  } catch {
    return undefined;
  }
}

/** What the backend keeps of what a browser sent. Anything malformed is dropped whole. */
export function cleanFirstVisit(raw: unknown): FirstVisit | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { from, page, at } = raw as Record<string, unknown>;
  if (typeof from !== 'string' || (from !== '' && !HOST.test(from))) return undefined;
  if (typeof page !== 'string' || !PAGE.test(page)) return undefined;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  return { from, page, at: new Date(at).toISOString() };
}
