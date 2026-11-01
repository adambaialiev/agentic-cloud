/**
 * How a builder's page writes its numbers (note #200, when they were the
 * public Leaderboard's too, until note #824).
 */

import { harnessName } from '../../../../src/shared/harness-clis.js';
import type { WorkspaceLeaderboardBuilder } from '../../../../src/shared/workspace-api.js';

/** What a token number is, in one line, for a builder's page. */
export const TOKENS_WRITTEN_HINT = 'Tokens written: what this person’s agents wrote since Monday, not what they read.';

const HOUR = 3_600_000;

/** Units sit on the number, no space (the owner, 2026-10-10): 214h, 24min. */
export function formatHours(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60) return `${Math.round(ms / HOUR)}h`;
  return minutes > 0 ? `${minutes}min` : '0h';
}

/** 96.2M, 512K, 640: the count, short. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(Math.round(count));
}

/** What their agents run on, in words. */
export function runsLine(runs: WorkspaceLeaderboardBuilder['runs']): string {
  const names = runs.map((cli) => harnessName(cli));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

export function agentsLine(agents: number): string {
  return agents === 1 ? '1 agent' : `${agents} agents`;
}

/** A grid day, `YYYY-MM-DD` in UTC, in the reader's words: "Sat, Oct 10,
 *  2026". Read in UTC, as the ledgers count it, wherever the reader is. */
export function dayTitle(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The same day without its weekday: "Oct 10, 2026". */
export function dayWordsUtc(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
