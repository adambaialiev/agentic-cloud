/**
 * The words of the Subscriptions screen's token section (TokenUsage.tsx):
 * which week a row is, and one line per provider. Pure, so the arithmetic is
 * tested without a browser.
 */
import type { WorkspaceTokenUsageAnswer } from '../../../../src/shared/workspace-api.js';
import { compactTokens } from '../../ui/file-kind.js';
import { providerLabel } from '../home/agent-words.js';

export type TokenWeekRow = WorkspaceTokenUsageAnswer['weeks'][number];
export type TokenProviderRow = TokenWeekRow['providers'][number];

/** The Monday (UTC) of the week `atMs` falls in — the server's week. */
export function weekStartOf(atMs: number): string {
  const at = new Date(atMs);
  at.setUTCHours(0, 0, 0, 0);
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return at.toISOString().slice(0, 10);
}

/** "This week", "Last week", or "Week of 29 Sep". */
export function tokenWeekLabel(start: string, nowMs: number): string {
  const thisWeek = weekStartOf(nowMs);
  if (start === thisWeek) return 'This week';
  if (start === weekStartOf(Date.parse(`${thisWeek}T00:00:00Z`) - 86_400_000)) return 'Last week';
  const at = new Date(`${start}T00:00:00Z`);
  return `Week of ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
}

/**
 * "Claude Code · 1.2M output · 340k input · 45M cache". Output leads — it is
 * the number people compare, cache excluded; Codex's reasoning is shown as
 * the part of output it is, never added to it.
 */
export function tokenProviderLine(row: TokenProviderRow): string {
  // Each figure holds together with a no-break space, so a phone wraps the
  // line between figures and never between a number and what it counts.
  const figure = (value: number, what: string) => `${compactTokens(value)}\u00a0${what}`;
  const output = `${figure(row.output, 'output')}${row.reasoning > 0 ? `\u00a0(${figure(row.reasoning, 'reasoning')})` : ''}`;
  const cache = row.cacheRead + row.cacheWrite;
  return [
    providerLabel(row.provider).replace(/ /g, '\u00a0'),
    output,
    figure(row.input, 'input'),
    ...(cache > 0 ? [figure(cache, 'cache')] : []),
  ].join(' · ');
}
