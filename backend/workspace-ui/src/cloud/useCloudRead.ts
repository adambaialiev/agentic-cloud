/**
 * One read of the workplace's cloud, served from what this tab already has
 * and refreshed underneath it (note #368: "Cloud details page data should be
 * cached and refetch silently").
 *
 * The Cloud details screen is a route, so leaving it unmounts the screen and
 * coming back rebuilds it from nothing. Both of its reads started empty every
 * single time, and the machine list is a walk of every app in the Fly account
 * — measured from the backend at about two seconds and sixty calls into Fly
 * for an account of thirty apps, and linear in that count. So Back drew the
 * skeleton for two seconds over a bill that had been on the glass a second
 * earlier. That is the same complaint note #354 fixed on the cloud card, and this is
 * the same fix: the answer outlives the screen (`cloud-cache.ts`), the
 * rebuilt screen opens on it, and the read goes out underneath.
 *
 * Three rules, and they are the ones `useCloud` already keeps:
 *
 *  HELD FIRST   what this tab last read is picked up during the render that
 *               needs it, not seeded into state, so a workplace switched
 *               back to draws its own answer on the very next render.
 *  ABSORBED     a refresh NOBODY ASKED FOR that fails for a reason another
 *               attempt could fix leaves the answer standing; the "Checked
 *               at" stamp simply stops advancing, which is the honest report
 *               and needs no words of its own.
 *  REFUSED      a refusal is different, and so is a first read with nothing
 *               behind it. One means what is held is no longer true — an
 *               workplace this person has been removed from — and the
 *               other has nothing to leave standing. Both say so.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT COPY FROM `useCloud`:
 *
 *  - NO POLL. The cloud card re-reads every fifteen seconds because it is three
 *    numbers behind a route with its own ten-second cache. This is a detail
 *    page about a bill, its read has no server-side cache at all, and a timer
 *    on it would spend a Fly walk of the whole account four times a minute
 *    for as long as a tab sits open on it. It refreshes when the screen is
 *    opened and when the tab comes back to the front — which is when somebody
 *    is actually looking.
 *  - NO `readOrSayWhy`. That wrapper abandons an attempt at eight seconds and
 *    makes two more. The machine list is already a two-second read on today's
 *    account and grows with it, so an eight-second axe would eventually start
 *    chopping reads that were about to answer and turning them into three.
 *    What IS borrowed is `worthAskingAgain`, which is the honest half: it is
 *    what tells a hiccup apart from a refusal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../ui/format.js';
import { worthAskingAgain } from '../ui/read.js';
import { useOrgApi } from '../screens/org/useOrgApi.js';
import type { CloudReadStore } from './cloud-cache.js';

/**
 * The shortest gap between two reads of the same answer.
 *
 * The trip this note is about — into an agent from a machine's row and
 * straight back — takes a couple of seconds, and re-walking the whole Fly
 * account for it would spend two seconds and sixty API calls to redraw
 * numbers that cannot have moved. Fifteen seconds is not a new idea of how
 * live the cloud is: it is what the cloud card already refreshes at.
 *
 * Nothing is hidden by it. The screen says when the figures were read, so a
 * held answer wears its own age.
 */
export const CLOUD_READ_AGAIN_MS = 15_000;

export interface CloudRead<T> {
  /** What to draw: this screen's own answer, else what the tab last read. */
  answer: T | null;
  /** When that answer landed by this tab's clock; 0 when there is none. */
  at: number;
  /** Said only when there is nothing to draw — one or the other, never both. */
  error: string;
  refresh: () => Promise<void>;
  /** Fold in an answer this screen already has (the picker's own POST), so
   *  the row underneath says what was just chosen without a second read —
   *  and so Back does not undo that choice on screen. */
  put: (answer: T) => void;
  /**
   * Throw the answer away — what is shown AND what is held (note #372).
   *
   * `forget` on the store alone would not do it: this hook draws its own
   * `result` first and falls back to the store, so a forgotten copy is
   * replaced on screen by the very answer that is being thrown out. The one
   * caller is a REPLACED CLOUD: what is held is a reading of an account this
   * workplace has just stopped using, and refreshing underneath it would
   * leave the old account's machines on the glass under the new account's
   * name for the seconds a Fly walk takes. That is the one kind of stale a
   * money screen must not be, so it goes and the screen waits.
   */
  drop: () => void;
}

export function useCloudRead<T>(orgId: string | null, path: string, store: CloudReadStore<T>): CloudRead<T> {
  const api = useOrgApi();
  const [result, setResult] = useState<{ orgId: string | null; answer: T | null; at: number; error: string } | null>(null);
  const serial = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++serial.current;
    try {
      const answer = await api.api<T>(path);
      if (mine !== serial.current) return;
      // Held and shown together, so what is kept is exactly what was last put
      // on the screen. UNLIKE `useCloud`, an answer that lands after the
      // screen has gone is still held: nothing supersedes it, it is this
      // workplace's freshest reading, and the next visit is the one place
      // it can possibly be of use. Only a NEWER read of this hook's own
      // supersedes it, which is what the serial above is counting.
      if (orgId) store.hold(orgId, answer);
      setResult({ orgId, answer, at: Date.now(), error: '' });
    } catch (failure) {
      if (mine !== serial.current) return;
      if (worthAskingAgain(failure) && orgId && store.held(orgId)) return;
      if (orgId) store.forget(orgId);
      setResult({ orgId, answer: null, at: 0, error: errorMessage(failure) });
    }
  }, [api, orgId, path, store]);

  useEffect(() => {
    // Asked only when what is held has aged past the floor — which is what
    // makes the trip out to an agent and back cost nothing at all.
    const due = () => {
      const kept = orgId ? store.held(orgId) : null;
      return !kept || Date.now() - kept.at >= CLOUD_READ_AGAIN_MS;
    };
    // Started off the effect's own tick, the way `NoteScreen` starts its
    // read: this is a subscription to an external system rather than a state
    // write, and calling into one synchronously here is a cascading render.
    if (due()) void Promise.resolve().then(refresh);
    const onVisible = () => { if (!document.hidden && due()) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, orgId, store]);

  const put = useCallback((answer: T) => {
    // Newer than anything in flight: a read that has already gone out was
    // asked before this was true, and must not land on top of it.
    serial.current += 1;
    if (orgId) store.hold(orgId, answer);
    setResult({ orgId, answer, at: Date.now(), error: '' });
  }, [orgId, store]);

  const drop = useCallback(() => {
    // Newer than anything in flight, for the same reason `put` is: a read
    // already out was asked of the account that has just been replaced.
    serial.current += 1;
    if (orgId) store.forget(orgId);
    setResult(null);
  }, [orgId, store]);

  // Read HERE rather than seeded into state, so the copy this tab holds is
  // picked up on the render that needs it — including the one straight after
  // `orgId` changes under a hook that is not being remounted.
  //
  // A read made before the shell knew which workplace it was standing in —
  // `?org=` missing from a hand-typed address, workspace state not yet landed
  // — was a read of THIS one all the same: the server resolved the reader's
  // active workplace, which is exactly what has now resolved here. So it
  // is kept. Only a real SWITCH, one named workplace to another, takes an
  // answer off the screen.
  const current = result && (result.orgId === orgId || result.orgId === null) ? result : null;
  const kept = orgId ? store.held(orgId) : null;
  const answer = current?.answer ?? kept?.answer ?? null;
  return {
    answer,
    at: current?.answer ? current.at : kept?.at ?? 0,
    error: answer ? '' : current?.error ?? '',
    refresh,
    put,
    drop,
  };
}
