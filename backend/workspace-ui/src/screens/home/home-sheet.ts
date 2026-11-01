/**
 * Home's Workplace window (note #715), and the browser entry it stands on.
 *
 * Until note #715 the workplace was one of the overview's two tabs — the
 * Workspace Agent's details page, at an address of its own. Now it stands
 * over Home (the Chief of Staff's conversation) in the agents picker's
 * shell, opened by the Chief of Staff's face and name (the owner,
 * 2026-10-11), and what it shows is not written into the address: you
 * cannot bookmark or share it (the owner accepted that cost). Escape, Close,
 * the dim and the browser's (or phone's) Back each close it; Back never
 * leaves Home while the window is open.
 *
 * That last rule is what puts the window into the browser's HISTORY, though
 * never into its address. Back is the browser's: on a phone it is a gesture
 * the page cannot intercept, only answer. So the open window is one history
 * entry of the SAME address, pushed by hand (`history.pushState`) and
 * carrying itself in React Router's state slot (`usr`), with the router's
 * own key and index unchanged — the router, `ScrollMemory` and
 * `BackProvider` all key on those and see no navigation at all. A Back is
 * then a `popstate` whose entry says whether the window stands, and Close
 * spends the entry (`history.back()`), so no dead entry is left for a later
 * Back to land on and do nothing.
 *
 * Because the window is an entry, a reader who walks out of it — a
 * repository, a folder in Drive — comes Back to Home with the window
 * standing. And a reload stands it up again rather than leaving the reader
 * on an entry whose Back visibly does nothing.
 *
 * The stack is kept general — a list of levels — because it was built for
 * two windows with a room level under one of them, and the Rooms side moved
 * into the agents picker (`AgentSwitch`), which since note #843 is one list
 * of every agent. The picker itself is not an entry (Back there closes it,
 * as it always did); the pages it opens inside itself are, by the same
 * hand-pushed same-address trick (`picker-entry.ts`, note #722). The
 * overview's old address (`/overview?half=`) is kept for every link and
 * button that still names it (`overviewArrival`): its workplace half opens
 * Home with this window; its other half opens Home with the agents picker.
 * An entry that arrives carrying a window it did not push itself — that
 * redirect — is rebuilt into a pushed entry on arrival
 * (`settleSheetEntry`), so its Back closes the window instead of leaving
 * Home.
 */

import type { HomeHalf } from './home-half.js';
import { addressHalf, HOME_CONTENT_PARAM, HOME_ROOM_PARAM } from './home-address.js';

/** One level of the window. Only the one window stands today. */
export type HomeSheetLevel = { kind: 'workplace' };

export type HomeSheetStack = HomeSheetLevel[];
/** What rides React Router's state slot (`history.state.usr`). */
export interface HomeSheetEntry {
  homeSheet?: HomeSheetStack;
  /** Set on an entry this module pushed: every level under it is an entry
   *  of its own. An entry that carries a stack WITHOUT it arrived that way
   *  (the overview's redirect) and has nothing of ours under it. */
  homeSheetPushed?: true;
}

function isLevel(value: unknown): value is HomeSheetLevel {
  if (!value || typeof value !== 'object') return false;
  return (value as { kind?: unknown }).kind === 'workplace';
}

/** The stack a router state names, or an empty one. Anything malformed —
 *  an entry written by an older build, a hand-edited state — is no window. */
export function sheetStackOf(state: unknown): HomeSheetStack {
  const stack = (state as HomeSheetEntry | null | undefined)?.homeSheet;
  // One window, one level: a stack written by an older build (Rooms, a
  // room under it) is no window.
  if (!Array.isArray(stack) || stack.length !== 1 || !stack.every(isLevel)) return [];
  return stack;
}

function pushedOf(state: unknown): boolean {
  return (state as HomeSheetEntry | null | undefined)?.homeSheetPushed === true;
}

/** The browser entry's own state: the router's key and index, and its `usr`. */
interface BrowserEntry { usr?: unknown; key?: string; idx?: number; [other: string]: unknown }

function browserEntry(): BrowserEntry {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? { ...(state as BrowserEntry) } : {};
}

function withStack(entry: BrowserEntry, stack: HomeSheetStack, pushed: boolean): BrowserEntry {
  const usr = entry.usr && typeof entry.usr === 'object' ? { ...(entry.usr as Record<string, unknown>) } : {};
  delete usr.homeSheet;
  delete usr.homeSheetPushed;
  if (stack.length) {
    usr.homeSheet = stack;
    if (pushed) usr.homeSheetPushed = true;
  }
  return { ...entry, usr: Object.keys(usr).length ? usr : null };
}

/** The stack the CURRENT browser entry carries. */
export function currentSheetStack(): HomeSheetStack {
  return sheetStackOf(browserEntry().usr);
}

/** One level deeper: a new entry of the same address. */
export function pushSheetLevel(stack: HomeSheetStack): void {
  window.history.pushState(withStack(browserEntry(), stack, true), '');
}

/** The level standing now, changed in place. */
export function replaceSheetLevel(stack: HomeSheetStack): void {
  window.history.replaceState(withStack(browserEntry(), stack, pushedOf(browserEntry().usr)), '');
}

/**
 * An entry that arrived with a stack it did not push — the overview's
 * redirect — is turned into the shape a pushed window has: this entry
 * becomes Home with no window, and every level is pushed above it. Returns
 * the stack now standing. An entry this module pushed (a reload, a Back from
 * a screen the window opened) is already that shape and is left alone.
 *
 * `arrived` is the router's own state for the entry. Under the browser's
 * router it is the same object as the entry's `usr`; under a memory router
 * (the tests) it is the only place the redirect's stack is written, which is
 * why it is asked first.
 */
export function settleSheetEntry(arrived?: unknown): HomeSheetStack {
  const entry = browserEntry();
  if (pushedOf(entry.usr)) return sheetStackOf(entry.usr);
  const named = sheetStackOf(arrived);
  const stack = named.length ? named : sheetStackOf(entry.usr);
  if (!stack.length) return stack;
  window.history.replaceState(withStack(entry, [], false), '');
  for (let depth = 1; depth <= stack.length; depth += 1) pushSheetLevel(stack.slice(0, depth));
  return stack;
}

/** What the overview's old address asks for: the Workplace window, the
 *  agents picker, or — for an old link to a room's notes shelf — the notes,
 *  which are the workplace's own list now (note #843). */
export interface OverviewArrival {
  homeSheet: HomeSheetStack;
  agentSwitch?: Record<string, never>;
  notes?: true;
}

/**
 * The overview's old address, read: its half. An address that names no half
 * opens the agents picker when it names a room or a room's shelf — a copied
 * shelf link was a Rooms destination (note #419) — and Workplace otherwise,
 * which is where the workplace's shelves (repositories, knowledge, secrets,
 * sites) stand. The room it names is not read (note #843): there is one list
 * of agents, and it opens whole. A link to a room's notes shelf opens the
 * notes, the workplace's one list.
 */
export function overviewArrival(search: URLSearchParams): OverviewArrival {
  const named: HomeHalf | null = addressHalf(search);
  const content = search.get(HOME_CONTENT_PARAM);
  const roomShelf = content === 'agents' || content === 'notes';
  const half: HomeHalf = named ?? (search.get(HOME_ROOM_PARAM) || roomShelf ? 'agents' : 'workplace');
  if (half === 'workplace') return { homeSheet: [{ kind: 'workplace' }] };
  if (content === 'notes') return { homeSheet: [], notes: true };
  return { homeSheet: [], agentSwitch: {} };
}
