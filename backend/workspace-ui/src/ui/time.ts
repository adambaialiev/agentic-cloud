/**
 * The three ways Home says WHEN, ported word for word from the legacy page so
 * the two shells never disagree about the same timestamp.
 */

import { useState, useSyncExternalStore } from 'react';

/** "just now", "5m ago", "3h ago", "2d ago" — or '' for a bad or future time. */
export function relative(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "in 4m", "in 1h" — the same shape as `relative`, pointing the other way
 *  (note #510). Empty when the moment is past or less than a minute out, so a
 *  caller can fall back to whatever it says while a run is imminent. */
export function countdown(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms < 60000) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.round(mins / 60)}h`;
}

/** "today", "yesterday", "3d ago" — calendar days, not 24-hour blocks: 23:50
 *  and 00:10 are an hour apart and "yesterday" is what a person means. */
export function coarseActive(iso: string, now = Date.now()): string {
  const then = new Date(iso);
  const ms = now - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(then)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/**
 * A quantity of time rather than a moment: "3d 4h", "2h 15m", "12m" — the
 * Cloud screen's awake-time wording, so working time and awake time read
 * alike. Under a minute says so, in words, rather than "0m".
 */
export function durationWords(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'under a minute';
}

/** A stopwatch since `iso`: "0:42", "12:05", "1:03:09". */
export function elapsed(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  return stopwatch(ms / 1000);
}

/** A number of seconds as a stopwatch reads it: "0:42", "12:05", "1:03:09". */
export function stopwatch(seconds: number): string {
  const secs = Math.max(0, Math.floor(seconds));
  const ss = String(secs % 60).padStart(2, '0');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}:${ss}`;
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}:${ss}`;
}

/**
 * A clock that ticks while `running`, so seconds move on screen without a
 * request (the legacy `runningClock`/`tickRunningClocks` pair). One shared
 * interval serves every subscriber and stops when the last one leaves; a
 * component that is not running reads the moment it mounted and stays put.
 *
 * The reading is never older than the moment the component mounted, and that
 * floor is load-bearing. `useSyncExternalStore` asks for a snapshot during
 * the FIRST render, before any subscribe can refresh the shared one — so that
 * render sees whenever the clock last ticked, which on a quiet page is when
 * this module was imported. A stamp measured against a clock from page load
 * is older than the timestamp it describes, and both `relative` and
 * `coarseActive` read a future instant as no reading at all: a row that
 * should say "Active today" says "Ready" until the subscribe lands and a
 * second render corrects it. Usually invisible; under test it is a flake.
 */
const listeners = new Set<() => void>();
let snapshot = Date.now();
let ticker: ReturnType<typeof setInterval> | undefined;

function subscribeTicking(listener: () => void): () => void {
  snapshot = Date.now();
  listeners.add(listener);
  if (!ticker) {
    ticker = setInterval(() => {
      snapshot = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker) { clearInterval(ticker); ticker = undefined; }
  };
}

function subscribeStill(): () => void {
  return () => {};
}

const readNow = () => snapshot;

export function useNow(running: boolean): number {
  const [mounted] = useState(() => Date.now());
  const shared = useSyncExternalStore(running ? subscribeTicking : subscribeStill, readNow, readNow);
  // A component that is NOT ticking reads the clock once, at mount, and keeps
  // that reading: sharing the store's snapshot would hand it whatever moment
  // some other component last subscribed at, which can be before this one
  // existed. A TICKING one follows the shared clock, floored at its own mount
  // for the same reason — `getSnapshot` has to be stable within a render, so
  // the floor is applied here rather than by reading the clock again.
  return running ? Math.max(mounted, shared) : mounted;
}
