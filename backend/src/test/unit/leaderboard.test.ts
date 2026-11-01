import { describe, expect, it } from 'vitest';
import {
  LEADERBOARD_DAYS_FROM,
  isLeaderboardWeek,
  leaderboardDayAt,
  leaderboardFirstWeek,
  leaderboardGridLevels,
  leaderboardGridStart,
  leaderboardWeekStart,
  normalizeXHandle,
  rankLeaderboard,
  type LeaderboardWeekNumbers,
} from '../../shared/leaderboard.js';
import { LEADERBOARD_FRESH_MS, Leaderboard, testAccountName, type LeaderboardSources } from '../../services/leaderboard.js';
import type { AgentWorkDay } from '../../services/agent-work-ledger.js';
import type { TokenOutputDay } from '../../services/agent-token-ledger.js';
import type { GitPullRequestDocument } from '../../types/git-pr.js';
import type { UserProfileDocument } from '../../types/user.js';

/**
 * The builders' numbers (the owner, 2026-10-10; note #200): everyone whose
 * agents worked, real accounts only, counts only, ranked by the measure
 * picked. They were the public Leaderboard's until note #824 (Adam, 28 Oct
 * 2026); now they are each builder's own page's.
 */
describe('the Leaderboard’s rules', () => {
  const week = (workingMs: number, merged = 0, tokens: { claude?: number; codex?: number } = {}): LeaderboardWeekNumbers => (
    { workingMs, merged, ...tokens }
  );

  it('ranks highest first, shares a place on a tie, and leaves the unranked last', () => {
    const rows = [
      { name: 'a', week: week(10, 0, { claude: 5 }) },
      { name: 'b', week: week(30, 0, { codex: 9 }) },
      { name: 'c', week: week(10, 0, { claude: 7 }) },
      { name: 'd', week: week(5) },
    ];
    const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);
    expect(rankLeaderboard(rows, 'hours', byName).map(({ row, place }) => [row.name, place]))
      .toEqual([['b', 1], ['a', 2], ['c', 2], ['d', 4]]);
    // Claude Code and Codex are each their own ranking: nobody is ranked last
    // on a provider they never ran.
    expect(rankLeaderboard(rows, 'claude', byName).map(({ row, place }) => [row.name, place]))
      .toEqual([['c', 1], ['a', 2], ['b', 0], ['d', 0]]);
  });

  it('resets on Monday 00:00 UTC and draws thirteen whole weeks', () => {
    const saturday = Date.UTC(2026, 9, 10, 15, 0, 0);
    expect(leaderboardWeekStart(saturday)).toBe('2026-10-05');
    expect(leaderboardWeekStart(Date.UTC(2026, 9, 12, 0, 0, 0))).toBe('2026-10-12');
    expect(leaderboardWeekStart(Date.UTC(2026, 9, 11, 23, 59, 59))).toBe('2026-10-05');
    expect(leaderboardGridStart(saturday)).toBe('2026-07-13');
    expect(new Date('2026-07-13T00:00:00Z').getUTCDay()).toBe(1);
  });

  it('keeps every week from the first the ledgers kept days in, to this one (note #209)', () => {
    const wednesday = Date.UTC(2026, 9, 21, 9, 0, 0);
    expect(leaderboardFirstWeek()).toBe('2026-10-05');
    for (const week of ['2026-10-05', '2026-10-12', '2026-10-19']) expect(isLeaderboardWeek(week, wednesday), week).toBe(true);
    // Before the first, after this one, not a Monday, not a date.
    for (const week of ['2026-09-28', '2026-10-26', '2026-10-13', '2026-10-5', 'last', '2026-02-30']) {
      expect(isLeaderboardWeek(week, wednesday), week).toBe(false);
    }
  });

  it('shades each day against the person’s own busiest one', () => {
    expect(leaderboardGridLevels([0, 100, 25, 26, 50, 75, 1])).toEqual([0, 4, 1, 2, 2, 3, 1]);
    expect(leaderboardGridLevels([0, 0])).toEqual([0, 0]);
  });

  it('reads a username starting with "test" as one of ours', () => {
    for (const word of ['testonboarding', 'test', 'TestJones', ' test1']) expect(testAccountName(word), word).toBe(true);
    for (const word of ['adam', 'contest', 'tes', '', undefined]) expect(testAccountName(word), String(word)).toBe(false);
  });

  it('reads an X handle however it was pasted, and refuses what cannot be one', () => {
    for (const typed of ['adam_b', '@adam_b', ' x.com/adam_b ', 'https://x.com/adam_b', 'https://twitter.com/adam_b/', 'https://www.x.com/adam_b?s=21']) {
      expect(normalizeXHandle(typed), typed).toBe('adam_b');
    }
    expect(normalizeXHandle('')).toBe('');
    expect(normalizeXHandle('   ')).toBe('');
    for (const bad of ['adam b', 'a-dam', 'sixteen_letters_', 'example.com/adam', 42]) {
      expect(normalizeXHandle(bad), String(bad)).toBeNull();
    }
  });
});

describe('Leaderboard', () => {
  // Saturday 10 October 2026, 15:00 UTC: the week began Monday the 5th.
  const NOW = Date.UTC(2026, 9, 10, 15, 0, 0);
  const HOUR = 3_600_000;

  const person = (userId: string, name: string, extra: Partial<UserProfileDocument> = {}, agents: Record<string, unknown> = {}): UserProfileDocument => ({
    userId,
    email: `${userId}@example.com`,
    displayName: name,
    photoURL: '',
    createdAt: 't',
    updatedAt: 't',
    telegram: { agents } as never,
    ...extra,
    person: { firstName: name, ...extra.person },
  });

  const build = (over: Partial<LeaderboardSources> = {}) => {
    let now = NOW;
    const reads = { users: 0 };
    const users: UserProfileDocument[] = [
      person('adam', 'Adam', { person: { photo: { storagePath: 'p/adam', contentType: 'image/jpeg', sizeBytes: 1, updatedAt: 't', source: 'upload' } } }, {
        'a-1': { id: 'a-1', name: 'Ruby', cli: 'claude' },
        'a-2': { id: 'a-2', name: 'Milo', cli: 'codex' },
        'a-ws': { id: 'a-ws', name: 'Workspace Agent', cli: 'codex', purpose: 'workspace-recap' },
      }),
      person('priya', 'Priya S. 🏺', {}, { 'p-1': { id: 'p-1', name: 'Hazel', cli: 'claude' } }),
      // Turned the Leaderboard's old switch off: read by nothing since note
      // #824, so their numbers are kept like anyone's, for their own page.
      person('dana', 'Dana', { person: { leaderboard: false } as UserProfileDocument['person'] }, { 'd-1': { id: 'd-1', name: 'Leo', cli: 'claude' } }),
      person('mo', 'Mo', {}, { 'm-1': { id: 'm-1', name: 'Kai', cli: 'codex' } }),
      // Their agents never worked: no row of zeros for them.
      person('idle', 'Idle Ida', {}, { 'i-1': { id: 'i-1', name: 'Zed', cli: 'claude' } }),
      // Busy, unmarked, but its address starts with "test": one of ours.
      person('tester', 'John Adams', {}, { 'x-1': { id: 'x-1', name: 'Max', cli: 'claude' } }),
      // The same by its legacy username, with no address at all.
      person('legacy', 'Old Test', { username: 'TestJones' }, { 'y-1': { id: 'y-1', name: 'Rex', cli: 'codex' } }),
      // One of the team's own accounts: never on the board, whatever it says.
      person('test', 'Team Test', { roles: { internal: true } }, { 't-1': { id: 't-1', name: 'T', cli: 'claude' } }),
    ];
    const workDays: AgentWorkDay[] = [
      { userId: 'adam', day: '2026-10-04', ms: 8 * HOUR }, // last week: grid only
      { userId: 'adam', day: '2026-10-05', ms: 10 * HOUR },
      { userId: 'adam', day: '2026-10-10', ms: 4 * HOUR },
      { userId: 'adam', day: '2026-07-12', ms: 99 * HOUR }, // before the grid
      { userId: 'priya', day: '2026-10-10', ms: 0.5 * HOUR },
      { userId: 'mo', day: '2026-08-03', ms: 2 * HOUR }, // in the grid, not this week
      { userId: 'dana', day: '2026-10-10', ms: 50 * HOUR },
      { userId: 'test', day: '2026-10-10', ms: 50 * HOUR },
      { userId: 'tester', day: '2026-10-10', ms: 9 * HOUR },
      { userId: 'legacy', day: '2026-10-10', ms: 9 * HOUR },
    ];
    const tokens: TokenOutputDay[] = [
      { userId: 'adam', day: '2026-10-05', provider: 'claude', output: 200_000 },
      { userId: 'adam', day: '2026-10-10', provider: 'claude', output: 1_000_000 },
      { userId: 'adam', day: '2026-10-10', provider: 'codex', output: 300_000 },
      { userId: 'adam', day: '2026-10-04', provider: 'claude', output: 7_000 }, // last week: its day only
      { userId: 'priya', day: '2026-10-10', provider: 'claude', output: 4_000 },
      { userId: 'dana', day: '2026-10-10', provider: 'codex', output: 9_000_000 },
    ];
    const merged = [
      { createdByUserId: 'adam', createdByAgentId: 'a-1', decidedAt: '2026-10-06T10:00:00.000Z' },
      // Before the week, and before the ledgers kept days: its day only.
      { createdByUserId: 'adam', createdByAgentId: 'a-1', decidedAt: '2026-09-14T23:59:00.000Z' },
      // Older proposals said no owner: the agent's owner is theirs.
      { createdByAgentId: 'a-2', decidedAt: '2026-10-07T10:00:00.000Z' },
      { createdByAgentId: 'p-1', decidedAt: '2026-10-08T10:00:00.000Z' },
      { createdByAgentId: 'd-1', decidedAt: '2026-10-08T10:00:00.000Z' },
      // An agent nobody has any more: nobody's.
      { createdByAgentId: 'gone', decidedAt: '2026-10-08T10:00:00.000Z' },
    ] as GitPullRequestDocument[];
    const asked: { workDays?: string; tokens?: string; merged?: string } = {};
    const sources: LeaderboardSources = {
      users: async () => { reads.users += 1; return users; },
      workDays: (since) => { asked.workDays = since; return workDays.filter((row) => row.day >= since); },
      tokenDays: (since) => { asked.tokens = since; return tokens.filter((row) => row.day >= since); },
      mergedSince: async (since) => { asked.merged = since; return merged; },
      handleOf: async (userId) => ({ adam: 'adam', priya: 'priya', mo: 'mo', tester: 'testonboarding' } as Record<string, string>)[userId],
      photoUrl: async (path) => (path ? `https://media.test/${path}` : undefined),
      isWorking: (_userId, agentId) => agentId === 'a-1' || agentId === 'a-ws',
      now: () => now,
      ...over,
    };
    return { board: new Leaderboard(sources), users, reads, asked, setNow: (at: number) => { now = at; } };
  };

  it('lists everyone whose agents worked, by agent hours, counts only', async () => {
    const { board, asked } = build();
    const { answer } = await board.read();
    // The week is read off the grid's days, so every source reaches back to its first.
    expect(asked).toEqual({ workDays: '2026-07-13', tokens: '2026-07-13', merged: '2026-07-13T00:00:00.000Z' });
    expect(answer.weekStart).toBe('2026-10-05');
    expect(answer.gridStart).toBe('2026-07-13');
    // Mo worked in August, so is listed with nothing this week. Dana's old
    // "off" is read by nothing now (note #824); Ida never ran an agent, and
    // the team account never shows.
    expect(answer.builders.map((builder) => builder.name)).toEqual(['Dana', 'Adam', 'Priya S. 🏺', 'Mo']);
    expect(answer.builders[3]).toMatchObject({ week: { workingMs: 0, merged: 0 } });
    const [, adam, priya] = answer.builders;
    expect(adam).toMatchObject({
      handle: 'adam',
      photoUrl: 'https://media.test/p/adam',
      agents: 2,
      working: 1,
      runs: ['claude', 'codex'],
      week: { workingMs: 14 * HOUR, merged: 2, claude: 1_200_000, codex: 300_000 },
    });
    expect(priya).toEqual({
      handle: 'priya',
      name: 'Priya S. 🏺',
      agents: 1,
      working: 0,
      runs: ['claude'],
      week: { workingMs: 0.5 * HOUR, merged: 1, claude: 4_000 },
      grid: expect.any(Array),
    });
    // One square per day from the grid's Monday to today, today last.
    expect(adam!.grid).toHaveLength(90);
    expect(adam!.grid.slice(-7)).toEqual([4, 4, 0, 0, 0, 0, 2]);
    expect(adam!.grid.slice(0, -7).every((level) => level === 0)).toBe(true);
    // The board's rows carry no days: only a person's own page opens them.
    expect(adam).not.toHaveProperty('days');
    const text = JSON.stringify(answer);
    expect(text).not.toMatch(/Team Test|Idle Ida|John Adams|Old Test|testonboarding|example\.com|a-1|Ruby/);
  });

  it('gives a person their numbers and no place, and nothing for an account with no builder page', async () => {
    const { board } = build();
    expect(await board.forPerson('priya')).toMatchObject({ agents: 1, gridStart: '2026-07-13', week: { merged: 1 } });
    const adam = await board.forPerson('adam');
    expect(adam).not.toHaveProperty('place');
    expect(adam).not.toHaveProperty('name');
    expect(adam).not.toHaveProperty('handle');
    expect(await board.forPerson('test')).toBeNull();
    expect(await board.forPerson('idle')).toBeNull();
    expect(await board.forPerson('tester')).toBeNull();
    expect(await board.forPerson('legacy')).toBeNull();
    expect(await board.forPerson('mo')).toMatchObject({ week: { workingMs: 0 } });
  });

  it('gives each square of a person’s page that day’s counts, from the same ledgers, adding up to the week (note #208)', async () => {
    const { board } = build();
    const adam = (await board.forPerson('adam'))!;
    const on = (day: string) => adam.days[Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${adam.gridStart}T00:00:00Z`)) / 86_400_000)];
    expect(adam.days).toHaveLength(adam.grid.length);
    expect(leaderboardDayAt(adam.gridStart, adam.days.length - 1)).toBe('2026-10-10');
    // Today: the work ledger's day, each provider's output apart, no merge.
    expect(on('2026-10-10')).toEqual({ workingMs: 4 * HOUR, merged: 0, claude: 1_000_000, codex: 300_000 });
    expect(on('2026-10-05')).toEqual({ workingMs: 10 * HOUR, merged: 0, claude: 200_000 });
    // Before the ledgers kept days there are no hours to show: null, not 0.
    // Merges carry their own date, so they still count, on the UTC day each
    // was decided.
    expect(on('2026-10-06')).toEqual({ workingMs: null, merged: 1 });
    expect(on('2026-10-07')).toEqual({ workingMs: null, merged: 1 });
    expect(on('2026-09-14')).toEqual({ workingMs: null, merged: 1 });
    expect(on('2026-07-13')).toEqual({ workingMs: null, merged: 0 });
    expect(LEADERBOARD_DAYS_FROM).toBe('2026-10-10');
    // A day row the ledger does hold is shown, whatever its date.
    expect(on('2026-10-04')).toEqual({ workingMs: 8 * HOUR, merged: 0, claude: 7_000 });
    // The week's numbers are its days, added up.
    const week = adam.days.slice(-6);
    expect(week.reduce((sum, day) => sum + (day.workingMs ?? 0), 0)).toBe(adam.week.workingMs);
    expect(week.reduce((sum, day) => sum + day.merged, 0)).toBe(adam.week.merged);
    expect(week.reduce((sum, day) => sum + (day.claude ?? 0), 0)).toBe(adam.week.claude);
    expect(week.reduce((sum, day) => sum + (day.codex ?? 0), 0)).toBe(adam.week.codex);
    // Counts only, as on the board.
    expect(JSON.stringify(adam.days)).not.toMatch(/a-1|Ruby|Milo|example\.com/);

    // From the first day the ledgers kept, a day nobody worked is a zero.
    const later = build();
    later.setNow(Date.UTC(2026, 9, 11, 12, 0, 0));
    expect((await later.board.forPerson('priya'))!.days.slice(-2)).toEqual([
      { workingMs: 0.5 * HOUR, merged: 0, claude: 4_000 },
      { workingMs: 0, merged: 0 },
    ]);
  });

  it('reads a past week back from the same ledgers, listing who did something that week (note #209)', async () => {
    const { board, asked, setNow } = build();
    // Wednesday 14 October: the week of the 5th is last week now.
    setNow(Date.UTC(2026, 9, 14, 12, 0, 0));
    const { answer } = await board.read('2026-10-05');
    expect(answer).toMatchObject({ weekStart: '2026-10-05', thisWeek: '2026-10-12', gridStart: '2026-07-20' });
    expect(asked.merged).toBe('2026-07-20T00:00:00.000Z');
    // Monday the 5th to Sunday the 11th, as the ledgers hold it: Adam's
    // hours on the 5th and 10th (not the 4th), his two merges, his tokens.
    expect(answer.builders.map((builder) => [builder.name, builder.week])).toEqual([
      ['Dana', { workingMs: 50 * HOUR, merged: 1, codex: 9_000_000 }],
      ['Adam', { workingMs: 14 * HOUR, merged: 2, claude: 1_200_000, codex: 300_000 }],
      ['Priya S. 🏺', { workingMs: 0.5 * HOUR, merged: 1, claude: 4_000 }],
    ]);
    // Mo worked in August, not that week: a finished week lists that week's.
    // This week still lists him, with nothing yet, as it always has.
    const thisWeek = await board.read();
    expect(thisWeek.answer.weekStart).toBe('2026-10-12');
    expect(thisWeek.answer.builders.map((builder) => builder.name)).toEqual(['Adam', 'Dana', 'Mo', 'Priya S. 🏺']);
    expect(thisWeek.answer.builders.every((builder) => builder.week.workingMs === 0)).toBe(true);
    // An older week the ledgers hold a day of: the 4th was a Sunday.
    const before = await board.read('2026-09-28');
    expect(before.answer.builders.map((builder) => [builder.name, builder.week])).toEqual([
      ['Adam', { workingMs: 8 * HOUR, merged: 0, claude: 7_000 }],
    ]);
  });

  it('gives a person their totals over every day the ledgers hold, each provider apart (note #209)', async () => {
    const { board } = build();
    // Every work day of Adam's the ledger holds in the window it reads
    // (the 12 July row is before it), and every token day, per provider.
    expect((await board.forPerson('adam'))!.allTime).toEqual({ workingMs: 22 * HOUR, claude: 1_207_000, codex: 300_000 });
    expect((await board.forPerson('priya'))!.allTime).toEqual({ workingMs: 0.5 * HOUR, claude: 4_000 });
    expect((await board.forPerson('mo'))!.allTime).toEqual({ workingMs: 2 * HOUR });
    // The board's rows carry no totals: only a person's own page shows them.
    expect((await board.read()).answer.builders.every((builder) => !('allTime' in builder))).toBe(true);
  });

  it('keeps each week it read for half a minute', async () => {
    const { board, reads } = build();
    await Promise.all([board.read(), board.read('2026-10-05'), board.read('2026-09-28')]);
    expect(reads.users).toBe(2);
    await Promise.all([board.read(), board.read('2026-09-28')]);
    expect(reads.users).toBe(2);
  });

  it('links nobody whose address is not a public handle', async () => {
    const { board } = build({ handleOf: async (userId) => (userId === 'adam' ? 'adam_old' : undefined) });
    const { answer } = await board.read();
    expect(answer.builders.every((builder) => !('handle' in builder))).toBe(true);
  });

  it('reads once per half minute, whoever asks', async () => {
    const { board, reads, setNow } = build();
    await Promise.all([board.read(), board.read(), board.forPerson('adam')]);
    expect(reads.users).toBe(1);
    setNow(NOW + LEADERBOARD_FRESH_MS - 1);
    await board.read();
    expect(reads.users).toBe(1);
    setNow(NOW + LEADERBOARD_FRESH_MS);
    await board.read();
    expect(reads.users).toBe(2);
  });

  it('does not keep a read that failed', async () => {
    let fail = true;
    const { board } = build({ mergedSince: async () => { if (fail) throw new Error('disk'); return []; } });
    await expect(board.read()).rejects.toThrow('disk');
    fail = false;
    expect((await board.read()).answer.builders).toHaveLength(4);
  });
});
