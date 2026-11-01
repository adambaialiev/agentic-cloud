/**
 * The Leaderboard (the owner, 2026-10-10; approved look on note #200):
 * `agenticcloudcomputer.com/leaderboard`, this week's builders, ranked by
 * the measure the reader picks. Everyone is on it unless they turn it off in
 * Settings (on by default, the owner, 2026-10-10; sign-up says so). Counts
 * only — never what an agent works on — and real accounts only: the team's
 * own accounts (`roles.internal`) never appear, and the owner's is a row
 * like any other.
 *
 * Shared on purpose: the server ranks a person for the "#N on the
 * Leaderboard" pill on their page, and the board ranks the same rows by
 * whichever tab is open, so both read one rule.
 *
 * Pure: no DOM, no framework, importable from Node and the browser alike.
 */

/** What the board can rank by. Sites are not a contribution to the board
 *  (the owner, 2026-10-10), so they are not here. */
export type LeaderboardMetric = 'hours' | 'merged' | 'claude' | 'codex';

/** The tabs, in their order; the first is the default. */
export const LEADERBOARD_METRICS: readonly LeaderboardMetric[] = ['hours', 'merged', 'claude', 'codex'];

/** How many weeks the activity grid shows: 13, so 91 days, Monday-aligned. */
export const LEADERBOARD_GRID_WEEKS = 13;

/** The grid's darkest level; 0 is a day with no work. */
export const LEADERBOARD_GRID_TOP = 4;

/**
 * The first UTC day the ledgers keep by day: agent hours and tokens written
 * are counted per day from 2026-10-10 (PR #1311; the token ledger began the
 * same day). Before it the working-time ledger kept only months, which
 * cannot be split back into days, so an earlier square has no hours to show:
 * no data, never zero. Merges carry their own date and go back further.
 */
export const LEADERBOARD_DAYS_FROM = '2026-10-10';

/**
 * A builder's totals over every day the ledgers kept (note #209): agent
 * hours and tokens written per provider, never added together; each provider
 * absent when it never wrote. They count from LEADERBOARD_DAYS_FROM.
 */
export interface LeaderboardAllTime {
  workingMs: number;
  claude?: number;
  codex?: number;
}

/**
 * One square of a builder's grid, in counts (note #208): what tapping a day
 * on their page shows. The same sources as the week's numbers, cut by UTC
 * day, so a week's days add up to its row.
 */
export interface LeaderboardDay {
  /** Agent working time that day; null before LEADERBOARD_DAYS_FROM, when
   *  the ledger kept no days. */
  workingMs: number | null;
  /** Proposals merged that day whose proposing agent is theirs. */
  merged: number;
  /** Output tokens that day, per provider; absent when that provider wrote
   *  none, as on the board. */
  claude?: number;
  codex?: number;
}

/** The numbers one builder's row ranks on. */
export interface LeaderboardWeekNumbers {
  /** Agent working time since Monday 00:00 UTC, in milliseconds. */
  workingMs: number;
  /** Proposals merged this week whose proposing agent is theirs. */
  merged: number;
  /** Output tokens this week, per provider. Absent when that provider wrote
   *  none: the two count differently, so they are never added together. */
  claude?: number;
  codex?: number;
}

export function leaderboardValue(week: LeaderboardWeekNumbers, metric: LeaderboardMetric): number | undefined {
  switch (metric) {
    case 'hours': return week.workingMs;
    case 'merged': return week.merged;
    case 'claude': return week.claude;
    case 'codex': return week.codex;
  }
}

/**
 * Ranked by one measure, highest first; equal numbers share a place (1, 2,
 * 2, 4). Someone with nothing on a provider's tab is listed after the ranked
 * rows with place 0, unranked, rather than ranked last on a number they do
 * not have. `tiebreak` orders rows within a place, so a reload never
 * reshuffles them.
 */
export function rankLeaderboard<T extends { week: LeaderboardWeekNumbers }>(
  rows: readonly T[],
  metric: LeaderboardMetric,
  tiebreak: (a: T, b: T) => number = () => 0,
): Array<{ row: T; place: number }> {
  const has = rows.filter((row) => leaderboardValue(row.week, metric) != null)
    .sort((a, b) => leaderboardValue(b.week, metric)! - leaderboardValue(a.week, metric)! || tiebreak(a, b));
  const not = rows.filter((row) => leaderboardValue(row.week, metric) == null).sort(tiebreak);
  let place = 0;
  const ranked = has.map((row, index) => {
    if (index === 0 || leaderboardValue(row.week, metric) !== leaderboardValue(has[index - 1]!.week, metric)) place = index + 1;
    return { row, place };
  });
  return [...ranked, ...not.map((row) => ({ row, place: 0 }))];
}

/** Monday 00:00 UTC of the week `atMs` falls in, as `YYYY-MM-DD`. The board
 *  resets there. */
export function leaderboardWeekStart(atMs: number): string {
  const at = new Date(atMs);
  const monday = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return new Date(monday).toISOString().slice(0, 10);
}

/**
 * The board's first week: the Monday of LEADERBOARD_DAYS_FROM (2026-10-05).
 * Every week from it to this one can be read back (note #209); an earlier
 * week has no hours or tokens to rank.
 */
export function leaderboardFirstWeek(): string {
  return leaderboardWeekStart(Date.parse(`${LEADERBOARD_DAYS_FROM}T00:00:00Z`));
}

/** Whether `week` is a week the board can show at `atMs`: a `YYYY-MM-DD`
 *  Monday from the first week to this one. */
export function isLeaderboardWeek(week: string, atMs: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || Number.isNaN(Date.parse(`${week}T00:00:00Z`))) return false;
  return leaderboardWeekStart(Date.parse(`${week}T00:00:00Z`)) === week
    && week >= leaderboardFirstWeek() && week <= leaderboardWeekStart(atMs);
}

/** The first day of the grid: the Monday twelve weeks before this week's. */
export function leaderboardGridStart(atMs: number): string {
  const monday = Date.parse(`${leaderboardWeekStart(atMs)}T00:00:00Z`);
  return new Date(monday - (LEADERBOARD_GRID_WEEKS - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** The UTC day `index` days after `fromDay`, as `YYYY-MM-DD`: square
 *  `index` of a grid that starts on `fromDay`. */
export function leaderboardDayAt(fromDay: string, index: number): string {
  return new Date(Date.parse(`${fromDay}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One grid square per day, 0 to 4: 0 for a day nobody worked, and the rest
 * measured against the person's own busiest day in the window — as GitHub
 * draws contributions, so a newcomer's grid reads as theirs rather than as
 * a pale copy of the busiest account's.
 */
export function leaderboardGridLevels(dayMs: readonly number[]): number[] {
  const top = Math.max(0, ...dayMs);
  return dayMs.map((ms) => (ms > 0 && top > 0
    ? Math.min(LEADERBOARD_GRID_TOP, Math.max(1, Math.ceil((ms / top) * LEADERBOARD_GRID_TOP)))
    : 0));
}

/** How X writes a handle: letters, digits and underscores, at most 15. */
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Whatever was typed for an X profile, as its bare handle — `@adam`,
 * `x.com/adam` and `https://twitter.com/adam/` all read `adam` — or null
 * when it cannot be one. An empty field is `''`: no X profile.
 */
export function normalizeXHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  candidate = candidate.replace(/^https?:\/\//i, '').replace(/^(?:www\.|mobile\.)?(?:x|twitter)\.com\//i, '');
  candidate = candidate.replace(/^@/, '').replace(/[/?#].*$/, '');
  if (!candidate) return '';
  return X_HANDLE.test(candidate) ? candidate : null;
}

/** Where a handle's profile is. */
export function xProfileUrl(handle: string): string {
  return `https://x.com/${handle}`;
}
