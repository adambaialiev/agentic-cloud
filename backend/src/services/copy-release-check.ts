/**
 * Whether a newer release exists, for a private copy's health page (note
 * #1005, own cloud piece 1). The copy asks our update service's public list,
 * GET <COPY_UPDATES_URL>/releases, about once an hour, and again when an
 * admin opens the health page if the last answer is older than that.
 *
 * The question carries nothing about the copy: a plain GET with no sign-in,
 * no version, no domain, no cookie. The last good answer and when it came are
 * kept in memory only; a failed ask keeps that answer and records when the
 * service was last reached. A company can point COPY_UPDATES_URL at its own
 * mirror, or set it to `off` and the copy never asks anyone.
 */

export const DEFAULT_UPDATES_URL = 'https://acc-updates.fly.dev';
const HOUR_MS = 3_600_000;
/** After a failed ask, a page open does not ask again sooner than this. */
const RETRY_AFTER_FAILURE_MS = 60_000;
/** A release is named by the day it was cut and a counter: 2026.11.01.1. */
export const RELEASE_VERSION_SHAPE = /^\d{4}\.\d{2}\.\d{2}\.\d{1,3}$/;

export interface ReleaseListEntry {
  version: string;
  date: string | null;
  /** The one-line title of the release's notes, when the service gives one. */
  summary?: string;
}

export interface ReleaseCheckState {
  /** False when COPY_UPDATES_URL is `off`: nothing is ever asked. */
  on: boolean;
  /** Where it asks, or null when off. */
  url: string | null;
  latest: string | null;
  releases: ReleaseListEntry[];
  /** When the update service last answered well. */
  reachedAt: string | null;
  /** When it was last asked, well or not. */
  triedAt: string | null;
  /** Why the last ask failed, in words; null when it answered. */
  lastError: string | null;
}

/** COPY_UPDATES_URL: unset means ours; off, none, false or 0 turn it off. */
export function updatesUrlFrom(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return DEFAULT_UPDATES_URL;
  if (['off', 'none', 'false', '0', 'no'].includes(raw.toLowerCase())) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Newer first is positive: 2026.11.03.0 vs 2026.11.01.1 → > 0. */
export function compareReleases(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export interface ReleaseCheckOptions {
  /** The update service's base address; null turns the check off. */
  url: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  everyMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

function parseAnswer(body: unknown): { latest: string | null; releases: ReleaseListEntry[] } | null {
  if (!body || typeof body !== 'object') return null;
  const doc = body as { latest?: unknown; releases?: unknown };
  if (doc.latest !== null && (typeof doc.latest !== 'string' || !RELEASE_VERSION_SHAPE.test(doc.latest))) return null;
  if (!Array.isArray(doc.releases)) return null;
  const releases: ReleaseListEntry[] = [];
  for (const entry of doc.releases) {
    const item = entry as { version?: unknown; date?: unknown; summary?: unknown };
    if (typeof item?.version !== 'string' || !RELEASE_VERSION_SHAPE.test(item.version)) continue;
    releases.push({
      version: item.version,
      date: typeof item.date === 'string' ? item.date : null,
      ...(typeof item.summary === 'string' && item.summary.trim() ? { summary: item.summary.trim().slice(0, 200) } : {}),
    });
  }
  releases.sort((a, b) => compareReleases(a.version, b.version));
  return { latest: doc.latest, releases };
}

export function createReleaseCheck(options: ReleaseCheckOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const everyMs = options.everyMs ?? HOUR_MS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const state: ReleaseCheckState = {
    on: Boolean(options.url), url: options.url, latest: null, releases: [], reachedAt: null, triedAt: null, lastError: null,
  };
  let inFlight: Promise<ReleaseCheckState> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const snapshot = (): ReleaseCheckState => ({ ...state, releases: [...state.releases] });

  /** Ask now (one ask at a time); the state after it, good or not. */
  function refresh(): Promise<ReleaseCheckState> {
    if (!options.url) return Promise.resolve(snapshot());
    if (inFlight) return inFlight;
    const url = `${options.url}/releases`;
    inFlight = (async () => {
      state.triedAt = now().toISOString();
      try {
        // Nothing about this copy goes with it: no sign-in, no query, no cookie.
        const answer = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!answer.ok) throw new Error(`answered ${answer.status}`);
        const parsed = parseAnswer(await answer.json().catch(() => null));
        if (!parsed) throw new Error('answered with something that is not a release list');
        state.latest = parsed.latest;
        state.releases = parsed.releases;
        state.reachedAt = now().toISOString();
        state.lastError = null;
      } catch (error) {
        const words = error instanceof Error && error.name === 'TimeoutError'
          ? `no answer in ${Math.round(timeoutMs / 1000)} s`
          : error instanceof Error && error.message.startsWith('answered') ? error.message : 'not reachable';
        if (state.lastError !== words) options.log?.(`[copy-updates] ${url}: ${words}`);
        state.lastError = words;
      } finally {
        inFlight = null;
      }
      return snapshot();
    })();
    return inFlight;
  }

  /** Whether the last good answer is older than the interval (and a failed
   *  ask is not so recent that asking again would only repeat it). */
  function stale(): boolean {
    if (!options.url) return false;
    const at = now().getTime();
    const reached = state.reachedAt ? new Date(state.reachedAt).getTime() : 0;
    if (at - reached < everyMs) return false;
    const tried = state.triedAt ? new Date(state.triedAt).getTime() : 0;
    return state.lastError === null || at - tried >= RETRY_AFTER_FAILURE_MS;
  }

  /** For the health page: ask first when the answer is stale, but wait at
   *  most `waitMs` for it; the page never hangs on the update service. */
  async function current(waitMs = 5_000): Promise<ReleaseCheckState> {
    if (!stale()) return snapshot();
    const asked = refresh();
    let waited: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ReleaseCheckState>((resolve) => { waited = setTimeout(() => resolve(snapshot()), waitMs); });
    try {
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(waited);
    }
  }

  function start() {
    if (!options.url || timer) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, everyMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refresh, current, start, stop, state: snapshot };
}

export type ReleaseCheck = ReturnType<typeof createReleaseCheck>;
