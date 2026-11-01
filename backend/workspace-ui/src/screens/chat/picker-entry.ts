/**
 * The agents picker in the browser's history (note #722).
 *
 * The picker writes where it stands into the browser entry under it: that
 * it is open, and the pages it has open (`WindowNavigation`). A reader who
 * walks out of it — into another conversation — comes Back to the
 * conversation with the picker standing as it was, pages and all, as the
 * Workplace window does (`home-sheet.ts`).
 *
 * Every page is an entry of its own, pushed by hand with the SAME address and
 * the router's own key and index (`history.pushState`), so the browser's —
 * or the phone's — Back closes the page on top, and the router,
 * `ScrollMemory` and `BackProvider` see no navigation at all. The picker
 * itself is not an entry: the entry under it carries it, and Back with no
 * page open is what it always was.
 *
 * In the entry's state, never its address: none of it can be shared or
 * bookmarked, which the Workplace window accepted first.
 *
 * The entry named a room tab, a room's shelf and the room that led the tabs
 * too, and a page could be a leaf one of a room's shelves opened (writing a
 * note, adding a secret, the briefing's model), until rooms left the product
 * (note #843): the picker is one list of every agent, and has none of them.
 * An entry an older build wrote is read for what of it still makes sense.
 */

import type { WindowPage } from '../../chrome/window-pages.js';

/** A page of the picker: an address, drawn over the picker's own list. */
export type PickerPage = WindowPage;

/** What the entry under the picker says about it. The overview's old
 *  address writes an empty one (`App.tsx`, `overviewArrival`): open the
 *  picker. The picker writes `standing` while it stands — it was open when
 *  the reader last stood on this entry — and its pages. */
export interface PickerEntry {
  standing?: true;
  pages?: PickerPage[];
}

function pageOf(value: unknown): PickerPage | null {
  if (!value || typeof value !== 'object') return null;
  const { key, pathname, search, hash, state, leaf } = value as Record<string, unknown>;
  if (typeof key !== 'string' || typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  // A leaf a room's shelf opened (an older build's entry) has no address of
  // its own to draw: it is no page now.
  if (leaf) return null;
  return {
    key,
    pathname,
    search: typeof search === 'string' ? search : '',
    hash: typeof hash === 'string' ? hash : '',
    state: state ?? null,
  };
}

/** The picker an entry's state names, or none. Anything malformed — an
 *  entry written by an older build, a hand-edited state — is read for what
 *  of it still makes sense. */
export function pickerEntryOf(state: unknown): PickerEntry | null {
  const named = (state as { agentSwitch?: unknown } | null | undefined)?.agentSwitch;
  if (!named || typeof named !== 'object') return null;
  const { standing, pages } = named as Record<string, unknown>;
  const read = Array.isArray(pages) ? pages.map(pageOf) : [];
  // One unreadable page and the ones over it mean nothing: they were opened
  // FROM it.
  const cut = read.indexOf(null);
  const kept = (cut === -1 ? read : read.slice(0, cut)) as PickerPage[];
  return {
    ...(standing === true ? { standing } : {}),
    ...(kept.length ? { pages: kept } : {}),
  };
}

/** The browser entry's own state: React Router's key and index, and its
 *  `usr` — the slot `useLocation().state` is read from. */
interface BrowserEntry { usr?: unknown; key?: string; [other: string]: unknown }

function browserEntry(): BrowserEntry {
  const raw: unknown = window.history.state;
  return raw && typeof raw === 'object' ? { ...(raw as BrowserEntry) } : {};
}

/** The picker the CURRENT browser entry carries. */
export function currentPickerEntry(): PickerEntry | null {
  return pickerEntryOf(browserEntry().usr);
}

function withPicker(entry: BrowserEntry, picker: PickerEntry | null): BrowserEntry {
  const usr = entry.usr && typeof entry.usr === 'object' ? { ...(entry.usr as Record<string, unknown>) } : {};
  delete usr.agentSwitch;
  if (picker) usr.agentSwitch = picker;
  return { ...entry, usr: Object.keys(usr).length ? usr : null };
}

/** The entry standing now says this about the picker (`null`: nothing). */
export function writePickerEntry(picker: PickerEntry | null): void {
  window.history.replaceState(withPicker(browserEntry(), picker), '');
}

/** A page opened: a new entry of the same address, saying so. */
export function pushPickerEntry(picker: PickerEntry): void {
  window.history.pushState(withPicker(browserEntry(), picker), '');
}
