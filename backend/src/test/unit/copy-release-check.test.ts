/**
 * Whether a newer release is out, for a private copy's health page (note
 * #1005): the hourly ask of our update service's public list — fresh, cached,
 * failing, turned off — and the Workspace line's three states beside it.
 */
import { describe, expect, it } from 'vitest';
import { createCopyHealth, HOW_TO_UPGRADE, releaseStanding } from '../../services/copy-health.js';
import { compareReleases, createReleaseCheck, DEFAULT_UPDATES_URL, updatesUrlFrom, type ReleaseCheckState } from '../../services/copy-release-check.js';

const LIST = {
  customer: 'anyone', updatesUntil: '9999-12-31', latest: '2026.11.03.0',
  releases: [
    { version: '2026.11.01.1', date: '2026-11-01' },
    { version: '2026.11.03.0', date: '2026-11-03', summary: 'Release notes on every upgrade' },
    { version: 'not-a-version', date: 'x' },
  ],
};

function clock(start: string) {
  let at = new Date(start).getTime();
  return { now: () => new Date(at), advance: (ms: number) => { at += ms; } };
}

/** A fetch that records what it was asked and answers from a queue. */
function service(...answers: Array<unknown | number | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return new Response('no', { status: next });
    return new Response(JSON.stringify(next));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('the update service address (COPY_UPDATES_URL)', () => {
  it('is ours by default, any address a company gives, and off when it says so', () => {
    expect(updatesUrlFrom(undefined)).toBe(DEFAULT_UPDATES_URL);
    expect(updatesUrlFrom('  ')).toBe(DEFAULT_UPDATES_URL);
    expect(updatesUrlFrom('https://mirror.theirco.test/acc/')).toBe('https://mirror.theirco.test/acc');
    for (const off of ['off', 'OFF', 'none', 'false', '0', 'no']) expect(updatesUrlFrom(off)).toBeNull();
    expect(updatesUrlFrom('ftp://x.test')).toBeNull();
    expect(updatesUrlFrom('not a url')).toBeNull();
  });

  it('orders releases by day, then counter', () => {
    expect(compareReleases('2026.11.03.0', '2026.11.01.1')).toBeGreaterThan(0);
    expect(compareReleases('2026.10.27.10', '2026.10.27.9')).toBeGreaterThan(0);
    expect(compareReleases('2026.11.01.1', '2026.11.01.1')).toBe(0);
  });
});

describe('asking for the latest release (note #1005)', () => {
  it('fresh: asks /releases with nothing about the copy, and keeps the answer', async () => {
    const t = clock('2026-11-05T14:00:00.000Z');
    const { calls, fetchImpl } = service(LIST);
    const check = createReleaseCheck({ url: DEFAULT_UPDATES_URL, fetchImpl, now: t.now });
    const state = await check.current();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://acc-updates.fly.dev/releases');
    // No sign-in, no cookie, no query: only what the answer's shape needs.
    expect(calls[0]!.init?.headers).toEqual({ accept: 'application/json' });
    expect(calls[0]!.url).not.toContain('?');
    expect(state).toMatchObject({
      on: true, latest: '2026.11.03.0', reachedAt: '2026-11-05T14:00:00.000Z', triedAt: '2026-11-05T14:00:00.000Z', lastError: null,
    });
    expect(state.releases).toEqual([
      { version: '2026.11.01.1', date: '2026-11-01' },
      { version: '2026.11.03.0', date: '2026-11-03', summary: 'Release notes on every upgrade' },
    ]);
  });

  it('cached: a page opened within the hour does not ask again; after it, it does', async () => {
    const t = clock('2026-11-05T14:00:00.000Z');
    const { calls, fetchImpl } = service(LIST);
    const check = createReleaseCheck({ url: DEFAULT_UPDATES_URL, fetchImpl, now: t.now });
    await check.current();
    t.advance(59 * 60_000);
    await check.current();
    await check.current();
    expect(calls).toHaveLength(1);
    t.advance(2 * 60_000);
    await check.current();
    expect(calls).toHaveLength(2);
  });

  it('asks once when several pages open at the same moment', async () => {
    const { calls, fetchImpl } = service(LIST);
    const check = createReleaseCheck({ url: DEFAULT_UPDATES_URL, fetchImpl });
    await Promise.all([check.current(), check.current(), check.refresh()]);
    expect(calls).toHaveLength(1);
  });

  it('failing: keeps the last answer, says when the service was last reached and why not now', async () => {
    const t = clock('2026-11-05T14:00:00.000Z');
    const { fetchImpl } = service(LIST, new TypeError('fetch failed'), 503, { nonsense: true });
    const lines: string[] = [];
    const check = createReleaseCheck({ url: DEFAULT_UPDATES_URL, fetchImpl, now: t.now, log: (line) => lines.push(line) });
    await check.refresh();
    t.advance(2 * 3600_000);
    let state = await check.current();
    expect(state).toMatchObject({ latest: '2026.11.03.0', reachedAt: '2026-11-05T14:00:00.000Z', triedAt: '2026-11-05T16:00:00.000Z', lastError: 'not reachable' });
    // A failure is not retried on every page open: a minute first.
    t.advance(30_000);
    expect((await check.current()).triedAt).toBe('2026-11-05T16:00:00.000Z');
    t.advance(60_000);
    state = await check.current();
    expect(state.lastError).toBe('answered 503');
    state = await check.refresh();
    expect(state.lastError).toBe('answered with something that is not a release list');
    expect(state.latest).toBe('2026.11.03.0');
    expect(lines).toHaveLength(3);
  });

  it('never makes the page wait long for a slow service', async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as typeof fetch;
    const check = createReleaseCheck({ url: DEFAULT_UPDATES_URL, fetchImpl });
    const started = Date.now();
    const state = await check.current(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(state.latest).toBeNull();
  });

  it('turned off: asks nobody, ever', async () => {
    const { calls, fetchImpl } = service(LIST);
    const check = createReleaseCheck({ url: null, fetchImpl });
    check.start();
    const state = await check.current();
    await check.refresh();
    check.stop();
    expect(calls).toHaveLength(0);
    expect(state).toMatchObject({ on: false, url: null, latest: null, triedAt: null });
  });
});

describe('the Workspace line beside it: green, amber, unknown (note #1005)', () => {
  const at = new Date('2026-11-05T15:00:00.000Z');
  const startedAt = new Date('2026-11-05T12:00:00.000Z');
  const reached = (latest: string, extra: Partial<ReleaseCheckState> = {}): ReleaseCheckState => ({
    on: true, url: DEFAULT_UPDATES_URL, latest, releases: [], reachedAt: '2026-11-05T14:30:00.000Z', triedAt: '2026-11-05T14:30:00.000Z', lastError: null, ...extra,
  });

  it('green when the copy runs the latest release', () => {
    const { updates, words } = releaseStanding('2026.11.01.1', reached('2026.11.01.1'), at, startedAt);
    expect(updates).toMatchObject({ state: 'current', running: '2026.11.01.1', latest: '2026.11.01.1', howToUpgrade: null });
    expect(words).toBe('latest 2026.11.01.1');
  });

  it('amber when a newer one is out, with how to upgrade today', () => {
    const { updates, words } = releaseStanding('2026.11.01.1', reached('2026.11.03.0'), at, startedAt);
    expect(updates).toMatchObject({ state: 'behind', running: '2026.11.01.1', latest: '2026.11.03.0', howToUpgrade: HOW_TO_UPGRADE });
    expect(words).toBe('latest 2026.11.03.0');
    expect(HOW_TO_UPGRADE).toContain('node install.mjs upgrade');
  });

  it('still amber from the last answer after a failed ask, saying how old it is', () => {
    const { updates, words } = releaseStanding('2026.11.01.1', reached('2026.11.03.0', { triedAt: at.toISOString(), lastError: 'not reachable' }), at, startedAt);
    expect(updates.state).toBe('behind');
    expect(words).toBe('latest 2026.11.03.0 (as of 30 min ago)');
  });

  it('unknown when the service has not answered since the copy started, or for a day', () => {
    const never = releaseStanding('2026.11.01.1', { ...reached('2026.11.01.1'), latest: null, reachedAt: null, lastError: 'not reachable' }, at, startedAt);
    expect(never.updates).toMatchObject({ state: 'unknown', latest: null, lastError: 'not reachable' });
    expect(never.words).toBe('latest unknown, update service not reached since 5 Nov 2026, 12:00 UTC');
    const old = releaseStanding('2026.11.01.1', reached('2026.11.03.0', { reachedAt: '2026-11-04T09:15:00.000Z', lastError: 'answered 502' }), at, startedAt);
    expect(old.updates.state).toBe('unknown');
    expect(old.words).toBe('latest unknown, update service not reached since 4 Nov 2026, 09:15 UTC');
  });

  it('unknown, with the latest named, when this copy\'s own release is not known', () => {
    const { updates, words } = releaseStanding(null, reached('2026.11.03.0'), at, startedAt);
    expect(updates).toMatchObject({ state: 'unknown', latest: '2026.11.03.0' });
    expect(words).toBe('latest 2026.11.03.0');
  });

  it('says so when the company turned the check off', () => {
    const { updates, words } = releaseStanding('2026.11.01.1', { ...reached('x'), on: false, url: null, latest: null, reachedAt: null, triedAt: null }, at, startedAt);
    expect(updates.state).toBe('off');
    expect(words).toBe('update checks are off');
  });
});

describe('the health JSON and the diagnostics bundle carry running and latest', () => {
  it('reads both, in the line and in the fields support looks at', async () => {
    const t = clock('2026-11-05T15:00:00.000Z');
    const { fetchImpl } = service(LIST);
    const updates = createReleaseCheck({ url: DEFAULT_UPDATES_URL, fetchImpl, now: t.now });
    const health = createCopyHealth({
      release: '2026.11.01.1', commit: '0123456789abcdef', startedAt: new Date('2026-11-05T12:00:00.000Z'),
      env: { COPY_UPDATES_URL: 'https://acc-updates.fly.dev' }, updates, now: t.now,
      fetchImpl: (async () => { throw new TypeError('no'); }) as typeof fetch,
    });
    const report = await health.report();
    expect(report.parts[0]).toEqual({ key: 'workspace', name: 'Workspace', ok: true, line: 'Up 3 h 0 min · release 2026.11.01.1 (01234567) · latest 2026.11.03.0' });
    expect(report).toMatchObject({ running: '2026.11.01.1', latest: '2026.11.03.0', updates: { state: 'behind', howToUpgrade: HOW_TO_UPGRADE } });
    const bundle = await health.diagnostics();
    expect(bundle).toMatchObject({ running: '2026.11.01.1', latest: '2026.11.03.0', health: { updates: { state: 'behind' } } });
    expect(bundle.settings).toMatchObject({ COPY_UPDATES_URL: 'https://acc-updates.fly.dev' });
  });
});
