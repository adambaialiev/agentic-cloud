import { handleProblem } from '../shared/handles.js';
import {
  LEADERBOARD_DAYS_FROM,
  leaderboardDayAt,
  leaderboardGridLevels,
  leaderboardGridStart,
  leaderboardWeekStart,
  rankLeaderboard,
  type LeaderboardAllTime,
  type LeaderboardDay,
} from '../shared/leaderboard.js';
import type {
  WorkspaceLeaderboardAnswer,
  WorkspaceLeaderboardBuilder,
  WorkspacePublicPersonBoard,
} from '../shared/workspace-api.js';
import type { GitPullRequestDocument } from '../types/git-pr.js';
import { personDisplayName, type UserProfileDocument } from '../types/user.js';
import type { AgentWorkDay } from './agent-work-ledger.js';
import type { TokenOutputDay } from './agent-token-ledger.js';

/** How long one read of the board is served before it is read again. */
export const LEADERBOARD_FRESH_MS = 30_000;

const DAY_MS = 86_400_000;

/** What the board reads, each from the store that already keeps it. */
export interface LeaderboardSources {
  /** Every account; the board keeps the ones that have not turned it off. */
  users(): Promise<UserProfileDocument[]>;
  /** Every owner's working time per UTC day from `sinceDay` on (AgentWorkLedger). */
  workDays(sinceDay: string): AgentWorkDay[];
  /** Every owner's output tokens per provider and UTC day from `sinceDay` on (AgentTokenLedger). */
  tokenDays(sinceDay: string): TokenOutputDay[];
  /** Proposals merged at or after this instant. */
  mergedSince(sinceIso: string): Promise<GitPullRequestDocument[]>;
  /** Their address's word, if they chose one. */
  handleOf(userId: string): Promise<string | undefined>;
  /** A URL a stranger's browser can open for their picture. */
  photoUrl(storagePath: string | undefined): Promise<string | undefined>;
  /** Whether this agent is in a turn right now. */
  isWorking(userId: string, agentId: string): boolean;
  now?: () => number;
}

/** One read of the board, and who is where on it. */
export interface LeaderboardSnapshot {
  answer: WorkspaceLeaderboardAnswer;
  /** Each builder's row, by account, for their own page. */
  byUser: ReadonlyMap<string, WorkspaceLeaderboardBuilder>;
  /** Their place by agent hours, by account. */
  places: ReadonlyMap<string, number>;
  /** Each square's counts, by account, for their own page (note #208). */
  days: ReadonlyMap<string, LeaderboardDay[]>;
  /** Their totals since the ledgers kept days, by account (note #209). */
  allTime: ReadonlyMap<string, LeaderboardAllTime>;
}

/**
 * A username that starts with "test" — `testonboarding`, `testjohnjones7` —
 * is one of ours, whether or not anybody ran mark-team-account.mjs on it
 * (the owner, 2026-10-10: "if username starts with the word test, don't
 * show it"). Read off their address and the legacy username alike.
 */
export function testAccountName(word: string | undefined): boolean {
  return Boolean(word && /^test/i.test(word.trim()));
}

/**
 * Whose a merged proposal is: the owner it recorded, or, on one older than
 * that field, the person whose agent proposed it. One rule for a builder's
 * page and a workplace's people cards (note #925), so the two never credit
 * the same change to different people.
 */
export function proposalOwner(
  doc: Pick<GitPullRequestDocument, 'createdByUserId' | 'createdByAgentId'>,
  agentOwner: ReadonlyMap<string, string>,
): string | undefined {
  return doc.createdByUserId ?? agentOwner.get(doc.createdByAgentId);
}

/** Every agent's person, from their profiles' agent records. */
export function agentOwners(users: ReadonlyArray<UserProfileDocument | null | undefined>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const user of users) {
    if (!user) continue;
    for (const agentId of Object.keys(user.telegram?.agents ?? {})) owners.set(agentId, user.userId);
  }
  return owners;
}

/**
 * Whose builder page carries numbers: every account but the team's own.
 * Until note #824 (Adam, 28 Oct 2026) this was who may be on the public
 * Leaderboard, with a Settings switch to leave it; the board is gone, a
 * person's numbers are shown only to them (and the founder's to anyone,
 * routes/workspace.ts), so there is nothing left to turn off.
 */
export function hasBuilderPage(profile: UserProfileDocument | null | undefined): boolean {
  return Boolean(profile) && !profile?.roles?.internal;
}

/**
 * The Leaderboard's numbers (shared/leaderboard.ts), read from the ledgers
 * that already count them and nothing else:
 * - agent hours: the working-time ledger's DAYS, from Monday 00:00 UTC
 *   (or the Monday of the past week asked for, to the next, note #209);
 * - merged: proposals merged that week whose proposing agent is theirs —
 *   the owner the proposal recorded, or, on one older than that field, the
 *   person whose agent it is;
 * - tokens: OUTPUT per provider from the token ledger, never added together;
 * - each day of the grid: the same three, cut by UTC day, for the square a
 *   reader taps on a builder's page (note #208) — so a week's days add up
 *   to its row. Hours and tokens are kept by day only from
 *   LEADERBOARD_DAYS_FROM; an earlier day's hours are null, not zero;
 * - all time, on a builder's page (note #209): every day of hours and of
 *   tokens the ledgers hold, which begins at LEADERBOARD_DAYS_FROM. Never
 *   backfilled from machine awake time, which overstates;
 * - agents and working: their room agents. The Workspace Agent is the
 *   platform's per-workplace helper, not one they made, so it is not counted
 *   as one of theirs — its hours and tokens are still their agents' work.
 *
 * A row is a BUILDER: someone whose agents did something in the grid's 90
 * days or this week, and whose username does not start with "test". Everyone is on by default, so without that the board
 * would list every account that signed up and never ran an agent, in rows
 * of zeros. A past week is finished, so its rows are the builders who did
 * something THAT week.
 *
 * Read whole at most every half minute (LEADERBOARD_FRESH_MS) per week and
 * shared by every reader in between: the page is public and anonymous, so
 * its cost must not grow with its readers. Settings forgets every read when
 * someone turns it off or on, so their row goes and comes back at once.
 */
export class Leaderboard {
  private readonly cached = new Map<string, { at: number; snapshot: Promise<LeaderboardSnapshot> }>();

  constructor(private readonly sources: LeaderboardSources) {}

  /** This week's board, or a past week's (`week`, a Monday the caller has
   *  checked with isLeaderboardWeek). */
  read(week?: string): Promise<LeaderboardSnapshot> {
    const now = this.now();
    const key = week ?? leaderboardWeekStart(now);
    const kept = this.cached.get(key);
    if (kept && now - kept.at < LEADERBOARD_FRESH_MS) return kept.snapshot;
    // Only the weeks read in the last half minute stay.
    for (const [old, entry] of this.cached) if (now - entry.at >= LEADERBOARD_FRESH_MS) this.cached.delete(old);
    const snapshot = this.build(now, key);
    this.cached.set(key, { at: now, snapshot });
    // A failed read is not kept: the next reader tries again.
    snapshot.catch(() => { if (this.cached.get(key)?.snapshot === snapshot) this.cached.delete(key); });
    return snapshot;
  }

  /** One person's builder page: their row, days and all-time totals. */
  async forPerson(userId: string): Promise<WorkspacePublicPersonBoard | null> {
    const snapshot = await this.read();
    const row = snapshot.byUser.get(userId);
    if (!row) return null;
    const { handle: _handle, name: _name, photoUrl: _photoUrl, ...rest } = row;
    return {
      ...rest,
      gridStart: snapshot.answer.gridStart,
      days: snapshot.days.get(userId) ?? [],
      allTime: snapshot.allTime.get(userId) ?? { workingMs: 0 },
    };
  }

  private async build(now: number, weekStart: string): Promise<LeaderboardSnapshot> {
    const thisWeek = leaderboardWeekStart(now);
    const weekEnd = leaderboardDayAt(weekStart, 7);
    const gridStart = leaderboardGridStart(now);
    /** In the week being read: from its Monday to the next. */
    const inWeek = (day: string) => day >= weekStart && day < weekEnd;
    // Hours and tokens are read from the first day any of the three uses —
    // the grid's, the week's, or the ledgers' first, for all time.
    const ledgerFrom = [gridStart, weekStart, LEADERBOARD_DAYS_FROM].sort()[0]!;
    const mergedFrom = weekStart < gridStart ? weekStart : gridStart;
    const today = new Date(now).toISOString().slice(0, 10);
    const gridDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${gridStart}T00:00:00Z`)) / DAY_MS) + 1;
    /** Which square a UTC day is, or -1 when it is not on the grid. */
    const squareOf = (day: string) => {
      const index = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${gridStart}T00:00:00Z`)) / DAY_MS);
      return index >= 0 && index < gridDays ? index : -1;
    };

    const users = await this.sources.users();
    // Whose agent made a proposal, for the ones recorded before proposals
    // said whose they were — every account's agents, not only the board's.
    const agentOwner = agentOwners(users);
    const builders = users.filter(hasBuilderPage);
    const ids = new Set(builders.map((user) => user.userId));

    // Each builder's squares, filled from the three ledgers in turn; a day
    // nobody touched stays as it was made. The week and all time are added
    // up beside them, from the same rows.
    const days = new Map<string, LeaderboardDay[]>();
    const weeks = new Map<string, WorkspaceLeaderboardBuilder['week']>();
    const weekOf = (userId: string) => {
      let week = weeks.get(userId);
      if (!week) { week = { workingMs: 0, merged: 0 }; weeks.set(userId, week); }
      return week;
    };
    const allTime = new Map<string, LeaderboardAllTime>();
    const totalOf = (userId: string) => {
      let total = allTime.get(userId);
      if (!total) { total = { workingMs: 0 }; allTime.set(userId, total); }
      return total;
    };
    const squares = (userId: string) => {
      let series = days.get(userId);
      if (!series) {
        series = Array.from({ length: gridDays }, (_, index) => ({
          workingMs: leaderboardDayAt(gridStart, index) < LEADERBOARD_DAYS_FROM ? null : 0,
          merged: 0,
        }));
        days.set(userId, series);
      }
      return series;
    };

    for (const row of this.sources.workDays(ledgerFrom)) {
      if (!ids.has(row.userId)) continue;
      totalOf(row.userId).workingMs += row.ms;
      if (inWeek(row.day)) weekOf(row.userId).workingMs += row.ms;
      const index = squareOf(row.day);
      if (index < 0) continue;
      const square = squares(row.userId)[index]!;
      square.workingMs = (square.workingMs ?? 0) + row.ms;
    }

    for (const doc of await this.sources.mergedSince(`${mergedFrom}T00:00:00.000Z`)) {
      const owner = proposalOwner(doc, agentOwner);
      if (!owner || !ids.has(owner) || !doc.decidedAt) continue;
      const day = doc.decidedAt.slice(0, 10);
      if (inWeek(day)) weekOf(owner).merged += 1;
      const index = squareOf(day);
      if (index >= 0) squares(owner)[index]!.merged += 1;
    }

    for (const row of this.sources.tokenDays(ledgerFrom)) {
      if (!ids.has(row.userId) || !(row.output > 0)) continue;
      // The board has a tab per provider it ranks, and an OpenCode tab is the
      // owner's call, not a side effect of the harness arriving (note #780):
      // until then its tokens are on the person's own screen, not here.
      if (row.provider === 'opencode') continue;
      const total = totalOf(row.userId);
      total[row.provider] = (total[row.provider] ?? 0) + row.output;
      if (inWeek(row.day)) {
        const week = weekOf(row.userId);
        week[row.provider] = (week[row.provider] ?? 0) + row.output;
      }
      const index = squareOf(row.day);
      if (index < 0) continue;
      const square = squares(row.userId)[index]!;
      square[row.provider] = (square[row.provider] ?? 0) + row.output;
    }

    const rows = await Promise.all(builders.map(async (user) => {
      const agents = Object.values(user.telegram?.agents ?? {}).filter((agent) => agent && !agent.purpose);
      const series = squares(user.userId);
      const [word, photoUrl] = await Promise.all([
        this.sources.handleOf(user.userId).catch(() => undefined),
        this.sources.photoUrl(user.person?.photo?.storagePath).catch(() => undefined),
      ]);
      const handle = word && !handleProblem(word) ? word : undefined;
      const builder: WorkspaceLeaderboardBuilder = {
        ...(handle ? { handle } : {}),
        name: personDisplayName(user),
        ...(photoUrl ? { photoUrl } : {}),
        agents: agents.length,
        working: agents.filter((agent) => this.sources.isWorking(user.userId, agent.id)).length,
        runs: (['claude', 'codex', 'opencode'] as const).filter((cli) => agents.some((agent) => agent.cli === cli)),
        week: weekOf(user.userId),
        grid: leaderboardGridLevels(series.map((square) => square.workingMs ?? 0)),
      };
      return { userId: user.userId, builder, test: testAccountName(word) || testAccountName(user.username) };
    }));
    // This week also lists whoever worked in the grid's 90 days, so Monday
    // morning is not empty; a past week is finished, and lists that week's.
    const active = rows.filter(({ builder, test }) => !test && (
      (weekStart === thisWeek && builder.grid.some((level) => level > 0))
      || builder.week.workingMs > 0 || builder.week.merged > 0
      || builder.week.claude != null || builder.week.codex != null
    ));

    const byName = (a: { builder: WorkspaceLeaderboardBuilder }, b: { builder: WorkspaceLeaderboardBuilder }) => (
      a.builder.name.localeCompare(b.builder.name)
    );
    const ranked = rankLeaderboard(active.map((row) => ({ ...row, week: row.builder.week })), 'hours', byName);
    return {
      answer: { weekStart, thisWeek, gridStart, builders: ranked.map(({ row }) => row.builder) },
      byUser: new Map(active.map((row) => [row.userId, row.builder])),
      places: new Map(ranked.map(({ row, place }) => [row.userId, place])),
      days: new Map(active.map((row) => [row.userId, days.get(row.userId)!])),
      allTime: new Map(active.map((row) => [row.userId, allTime.get(row.userId) ?? { workingMs: 0 }])),
    };
  }

  private now(): number {
    return this.sources.now?.() ?? Date.now();
  }
}
