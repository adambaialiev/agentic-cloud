/**
 * The last thing this tab read about the cloud, per organization: the counts
 * behind the workplace screen's card, and the two answers behind the Cloud
 * details screen.
 *
 * Note #354, over a screenshot of Home: "Fly cloud information should be read
 * from cache, so UI should be stable. Silently refetched should be." Note
 * #368, one screen along: "Cloud details page data should be cached and
 * refetch silently." Same complaint, same answer, so the same file holds
 * both — one place where this tab's idea of the cloud lives, and one
 * `forgetClouds()` for the whole of it.
 *
 * The card he is pointing at stood on Home when he wrote that, and stands on
 * the workplace screen since note #642. Either way it is on a ROUTE, which is
 * what made it go BLANK on him, for two different reasons:
 *
 *  - Leaving the screen unmounts the card and coming back rebuilds it from
 *    nothing. The counts he was just looking at are replaced by a line saying
 *    they are being read until a fresh answer lands — the flash of loading UI
 *    note #306 already asked us to stop drawing on the note screen, in almost
 *    the same words.
 *  - The card re-reads every fifteen seconds, and every one of those reads
 *    could put the whole card away and an error panel in its place. On a phone
 *    that is not a rare event, and nobody asked for that read: it is ours, so
 *    its failures are ours to absorb rather than his to look at.
 *
 * Both are the same missing thing — an answer that outlives the screen — so it
 * lives here rather than inside the hook. A read that lands leaves its copy;
 * the next screen on that workplace opens on it and refreshes underneath.
 *
 * Keyed by the workplace AND by whether machine counts were asked for,
 * because those are two different questions with two different answers. The
 * card asks the expensive one (`connected?` plus the counts); the New agent
 * dialog asks only whether the cloud is connected at all, and its answer
 * carries `machines: null` truthfully. Sharing one entry would let the
 * dialog's cheap answer overwrite the counts with a null and blank the very
 * card this file exists to hold still.
 *
 * Per TAB, like the note cache and for the same reason: this is a live
 * reading, not a document, and a reading serialised into `sessionStorage`
 * would come back after a reload older than the fifteen seconds the card
 * promises. It also needs no eviction — the keys are the workplaces this
 * person is a member of, which the org switcher already bounds, and each entry
 * is a connection flag, a slug and four numbers.
 */

import type {
  WorkspaceOrgAgentMachineAnswer, WorkspaceOrgCloudAnswer, WorkspaceOrgSpendAnswer,
} from '../../../src/shared/workspace-api.js';

const held = new Map<string, WorkspaceOrgCloudAnswer>();

const at = (orgId: string, inventory: boolean) => `${inventory ? 'inv' : 'bare'}#${orgId}`;

/** What this tab last read for this workplace, if it has ever read it.
 *  Read synchronously during a render, which is what lets a rebuilt card put
 *  its counts straight back instead of asking again in front of the reader. */
export function heldCloud(orgId: string, inventory: boolean): WorkspaceOrgCloudAnswer | null {
  return held.get(at(orgId, inventory)) ?? null;
}

/** Keep what was just read. */
export function holdCloud(orgId: string, inventory: boolean, answer: WorkspaceOrgCloudAnswer): void {
  held.set(at(orgId, inventory), answer);
}

/** Forget it: the server has REFUSED this read, so the copy here is of a
 *  cloud this person may no longer be allowed to see — a workplace they
 *  have been removed from, or one that is gone. Holding the card up over that
 *  answer would draw a machine count nobody is entitled to any more. */
export function forgetCloud(orgId: string, inventory: boolean): void {
  held.delete(at(orgId, inventory));
}

/** Every workplace, gone. Only sign-out has a reason to ask: the next
 *  person to use this tab is not the one whose cloud this is. */
export function forgetClouds(): void {
  held.clear();
  for (const store of stores) store.clear();
}

/**
 * What the CLOUD DETAILS screen holds, and when it read it (note #368).
 *
 * That screen makes two reads and BOTH of them used to start from nothing on
 * every visit: leaving the screen unmounts it, so Back drew the skeleton over
 * a bill that had been on the glass a second earlier — the same flash note
 * #354 took off the cloud card, one screen back.
 *
 * The answer carries a TIME here, which the card's does not need: `api/org/cloud`
 * stamps its own counts with `checkedAt`, and `api/org/spend` stamps nothing.
 * Without it a held bill has no age on it, and a cache whose staleness cannot
 * be seen is a cache that quietly lies on a screen about money. The stamp is
 * this tab's own clock at the moment the answer landed — within the read's
 * own couple of seconds of the server's, and the only one available without
 * changing the route.
 *
 * It is also what paces the refresh: `useCloudRead` will not ask again inside
 * `CLOUD_READ_AGAIN_MS` of the answer it is already showing.
 */
export interface KeptCloudRead<T> {
  answer: T;
  /** `Date.now()` when this tab took delivery of it. */
  at: number;
}

export interface CloudReadStore<T> {
  held(orgId: string): KeptCloudRead<T> | null;
  hold(orgId: string, answer: T): void;
  /** The server has REFUSED this read: what is held is of a cloud this person
   *  may no longer be allowed to see, so it goes rather than standing. */
  forget(orgId: string): void;
  clear(): void;
}

const stores: CloudReadStore<unknown>[] = [];

function readStore<T>(): CloudReadStore<T> {
  const kept = new Map<string, KeptCloudRead<T>>();
  const store: CloudReadStore<T> = {
    held: (orgId) => kept.get(orgId) ?? null,
    hold: (orgId, answer) => { kept.set(orgId, { answer, at: Date.now() }); },
    forget: (orgId) => { kept.delete(orgId); },
    clear: () => kept.clear(),
  };
  // Registered so that signing out empties this one too, without every new
  // store having to be remembered at the call site.
  stores.push(store as CloudReadStore<unknown>);
  return store;
}

/** `GET api/org/spend` — the machine list and its money. The expensive read:
 *  a walk of every app in the Fly account, measured at about two seconds and
 *  sixty calls into Fly for an account of thirty apps, and linear in that
 *  count. This is the answer the note is about. */
export const cloudMachineList = readStore<WorkspaceOrgSpendAnswer>();

/** `GET api/org/agent-machine` — what new agents are built on. Milliseconds,
 *  from the workplace's own record, and held all the same: its card draws
 *  “Reading what new agents are built on…” until it lands, which on the way
 *  Back is the same flash from a cheaper cause. */
export const cloudNewAgentMachine = readStore<WorkspaceOrgAgentMachineAnswer>();
