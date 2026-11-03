/**
 * What each row of the Workplace window's index says under its name (note
 * #960): one line, a count or a state, never a sentence explaining the row.
 * Pure, so the words are tested without a screen.
 */

import type { WorkspaceSeatUsage, WorkspaceSeatUsageWindow } from '../../../../src/shared/workspace-api.js';
import { bytes } from '../../ui/file-kind.js';
import { seatHasCurrentUsage, seatStatusWords, subscriptionName } from '../../ui/seat-words.js';

/** "1 note", "3 notes". */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Notes: how many, and how many nobody has picked up. */
export function notesLine(total: number, unclaimed: number): string {
  if (total === 0) return 'No notes yet';
  return unclaimed ? `${counted(total, 'note')} · ${unclaimed} unclaimed` : counted(total, 'note');
}

/** Repositories: how many, and the shelf's storage. */
export function repositoriesLine(count: number | null, quota?: { userUsedBytes: number; userMaxBytes: number } | null): string {
  if (count === null) return 'Not available right now';
  if (count === 0) return 'None yet';
  const used = quota ? ` · ${bytes(quota.userUsedBytes)} of ${bytes(quota.userMaxBytes)}` : '';
  return `${counted(count, 'repository', 'repositories')}${used}`;
}

/** Sites: how many, and the domain every one of them is a name on. */
export function sitesLine(urls: string[]): string {
  const domain = urls.map((url) => url.replace(/^https?:\/\/[^.]+\./, '').replace(/\/.*$/, '')).find(Boolean);
  return `${counted(urls.length, 'site')}${domain ? ` on ${domain}` : ''}`;
}

/** Storage: how many buckets, and whether anyone can read one by its link. */
export function storageLine(buckets: Array<{ public?: boolean }>): string {
  const open = buckets.filter((bucket) => bucket.public).length;
  return `${counted(buckets.length, 'bucket')} · ${open ? `${open} public` : 'private'}`;
}

/** Which of a reading's windows a person asks about first: the week's. */
function weekly(windows: WorkspaceSeatUsageWindow[]): WorkspaceSeatUsageWindow | null {
  return windows.find((w) => /week/i.test(w.trackText ?? '')) ?? windows[0] ?? null;
}

/** A reading's window in plain words: "this week's limit", "the 5-hour limit". */
export function limitWords(window: WorkspaceSeatUsageWindow): string {
  const track = (window.trackText ?? '').trim();
  if (!track || track === 'usage') return 'its limit';
  if (/week/i.test(track)) return 'this week’s limit';
  const hours = /^(\d+)\s*hours?$/i.exec(track);
  if (hours) return `the ${hours[1]}-hour limit`;
  return `the ${track} limit`;
}

/** One subscription as a sentence a teammate can read (finding 10 of note
 *  #960): "Claude Max: 7% of this week’s limit used, 0% of the 5-hour limit". */
export function seatSentence(seat: WorkspaceSeatUsage): string {
  const name = `${subscriptionName(seat.provider)}${seat.planText ? ` ${seat.planText}` : ''}`;
  const windows = seatHasCurrentUsage(seat) ? seat.windows ?? [] : [];
  if (!windows.length) {
    if (seat.provider === 'opencode' && seat.status === 'active') return `${name}: usage is shown in OpenCode`;
    if (seatHasCurrentUsage(seat)) return `${name}: no reading yet`;
    return `${name}: ${seatStatusWords(seat).text.toLowerCase()}`;
  }
  const first = weekly(windows)!;
  const rest = windows.filter((w) => w !== first);
  return `${name}: ${first.percentText}% of ${limitWords(first)} used${rest.map((w) => `, ${w.percentText}% of ${limitWords(w)}`).join('')}`;
}

/** The Subscriptions row: the one subscription in words, or how many. */
export function subscriptionsLine(seats: WorkspaceSeatUsage[]): string {
  if (seats.length === 0) return 'None signed in yet';
  if (seats.length === 1) {
    const seat = seats[0]!;
    const windows = seatHasCurrentUsage(seat) ? seat.windows ?? [] : [];
    const first = weekly(windows);
    const name = `${subscriptionName(seat.provider)}${seat.planText ? ` ${seat.planText}` : ''}`;
    return first ? `${name} · ${first.percentText}% of ${limitWords(first)} used` : seatSentence(seat);
  }
  return `${seats.length} subscriptions · ${seats.map((seat) => subscriptionName(seat.provider)).join(', ')}`;
}
