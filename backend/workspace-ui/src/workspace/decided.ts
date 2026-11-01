/**
 * The proposals decided in this tab, and what became of each (note #743).
 *
 * Every "waiting for your decision" list is a READ made before the decision:
 * the agents sheet reads every room's queue when it opens, Home's queue rides
 * the state read, and the Chief of Staff's forwarded cards ride the
 * conversation's. Each was right when it was made, and none of them heard a
 * decision taken on a proposal screen. The owner approved a proposal inside
 * the agents sheet, came Back to the sheet, and found it still waiting: the
 * sheet asks again only when what the state knows about the queues moves,
 * and a room that still had other proposals waiting looked the same before
 * and after.
 *
 * So the decision is written here the moment it lands — before the screen
 * that took it checks it is still standing, because a reader who leaves while
 * the merge runs has decided all the same — and every list leaves out what is
 * written here, at once, without waiting for its next read. Decisions are
 * final, so nothing here is ever taken back for the life of the tab; the next
 * read of each list says the same thing anyway.
 *
 * Kept in the tab's own `sessionStorage` as well (note #745), because the
 * agents sheet now REMEMBERS its list across a reload, and a list remembered
 * from before a decision must not hand the decided proposal back after one.
 * The record and the memory it guards live exactly as long as each other.
 */

import { useSyncExternalStore } from 'react';

export type DecidedKind = 'pr' | 'knowledge';

const KEY = 'agentbuilt.decided';

const shelf = (): Storage | null => {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
};

function load(): Map<string, string> {
  try {
    const kept: unknown = JSON.parse(shelf()?.getItem(KEY) ?? '{}');
    if (!kept || typeof kept !== 'object') return new Map();
    return new Map(Object.entries(kept).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return new Map();
  }
}

function save(): void {
  try { shelf()?.setItem(KEY, JSON.stringify(Object.fromEntries(outcomes))); } catch { /* a full or refused store keeps the tab's own copy */ }
}

const outcomes = load();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (kind: DecidedKind, id: string) => `${kind}:${id}`;

/** A decision that landed: `status` is what the proposal became. An answer
 *  that leaves it open (a refused merge, a stale branch) decides nothing. */
export function markDecided(kind: DecidedKind, id: string, status: string | null | undefined): void {
  if (!status || status === 'open') return;
  outcomes.set(keyOf(kind, id), status);
  save();
  version += 1;
  for (const listener of listeners) listener();
}

/** What became of this proposal in this tab, if it was decided here. */
export function decidedHere(kind: DecidedKind, id: string): string | undefined {
  return outcomes.get(keyOf(kind, id));
}

/** The rows of a waiting list that are still waiting. */
export function stillWaiting<T extends { id: string }>(kind: DecidedKind, rows: T[]): T[] {
  return outcomes.size ? rows.filter((row) => !outcomes.has(keyOf(kind, row.id))) : rows;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Moves with every decision taken in this tab: a list that holds a read of
 *  its own asks again on it, and every list draws again. */
export function useDecided(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** A fresh tab: sign-out, and the tests between themselves. */
export function forgetDecided(): void {
  outcomes.clear();
  try { shelf()?.removeItem(KEY); } catch { /* nothing kept */ }
  version += 1;
  for (const listener of listeners) listener();
}
