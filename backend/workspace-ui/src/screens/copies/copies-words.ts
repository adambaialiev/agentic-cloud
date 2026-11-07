/**
 * The small words of the Copies screen (note #1058), kept apart from the
 * drawing so a test can read them without a browser.
 */
import type { WorkspaceCopyRow } from '../../../../src/shared/copy-pulse.js';
import { relative } from '../../ui/time.js';

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "Silent 4 days", "Opted out", or nothing for a live copy. */
export function standingWords(row: Pick<WorkspaceCopyRow, 'standing' | 'lastSeenAt'>, now = Date.now()): string {
  if (row.standing === 'opted-out') return 'Opted out';
  if (row.standing === 'silent') return `Silent ${Math.floor((now - Date.parse(row.lastSeenAt)) / 86_400_000)} days`;
  return '';
}

/** "2026.11.06.0 · up to date", "· 2 behind", or the copy's own word when we cannot count. */
export function releaseWords(row: Pick<WorkspaceCopyRow, 'release' | 'releasesBehind' | 'updatesState'>): string {
  if (!row.release) return 'Release unknown';
  if (row.releasesBehind === null) return row.updatesState === 'off' ? `${row.release} · updates off` : row.release;
  if (row.releasesBehind === 0) return `${row.release} · up to date`;
  return `${row.release} · ${row.releasesBehind} behind`;
}

/** "Healthy", "Backup 3 days old · disk 6% free", "Not reported". */
export function healthWords(row: Pick<WorkspaceCopyRow, 'health'>): string {
  if (row.health.state === 'ok') return 'Healthy';
  if (row.health.state === 'unknown') return 'Health not reported';
  const text = row.health.problems.join(' · ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "12 people · 8 agents · 140 turns today" */
export function countsWords(row: Pick<WorkspaceCopyRow, 'people' | 'agents' | 'turns24h'>): string {
  return `${plural(row.people, 'person', 'people')} · ${plural(row.agents, 'agent')} · ${plural(row.turns24h, 'turn')} in 24h`;
}

/** "seen 3h ago · active 20m ago" */
export function seenWords(row: Pick<WorkspaceCopyRow, 'lastSeenAt' | 'lastActivityAt'>, now = Date.now()): string {
  const seen = `seen ${relative(row.lastSeenAt, now) || 'just now'}`;
  const active = row.lastActivityAt ? relative(row.lastActivityAt, now) : '';
  return active ? `${seen} · active ${active}` : `${seen} · no activity yet`;
}

/** "Claude 5 · Codex 2" — only the CLIs a copy uses, in the order we list them. */
export function byCliWords(counts: Record<'claude' | 'codex' | 'opencode', number>): string {
  const names = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' } as const;
  const used = (Object.keys(names) as Array<keyof typeof names>).filter((cli) => counts[cli] > 0);
  return used.length ? used.map((cli) => `${names[cli]} ${counts[cli].toLocaleString('en-US')}`).join(' · ') : 'none';
}

/** The subject the Write-to-contact draft starts with. */
export const contactSubject = (domain: string): string => `Your Agentic Cloud at ${domain}`;

/** "3 copies · 1 needs a look" */
export function copiesSub(rows: WorkspaceCopyRow[]): string {
  if (!rows.length) return 'Private copies';
  const look = rows.filter((row) => row.standing !== 'live' || row.health.state === 'trouble' || (row.releasesBehind ?? 0) >= 2).length;
  return `${plural(rows.length, 'copy', 'copies')}${look ? ` · ${look} ${look === 1 ? 'needs' : 'need'} a look` : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-11-07 → 7 Nov */
export const shortDay = (day: string): string => {
  const [, month, date] = day.split('-').map(Number);
  return `${date} ${MONTHS[(month ?? 1) - 1]}`;
};
