import type { WorkspaceSeatUsage } from '../shared/workspace-api.js';
import { windowPace } from '../shared/usage-pace.js';
import { PLATFORM_CREDENTIAL_USAGE_REFRESH_MS } from './platform-credential-pool.js';
import type { OrgSeatDocument } from '../types/org.js';
import type { ProviderUsageWindow } from '../types/user.js';
import {
  formatUsagePercent,
  formatUsagePlan,
  formatUsageTrackLabel,
  formatUsageWindowLabel,
  sortUsageWindows,
} from './agent-service.js';

/**
 * Whether any live seat's reading is older than the refresher's cadence, so a
 * read that is about to describe the seats refreshes them first (the seats
 * read, the state read, and `agentbuilt usage`).
 */
export function seatUsageCacheIsStale(seats: OrgSeatDocument[], now = Date.now()): boolean {
  return seats.some((seat) => {
    if (seat.status !== 'active' && seat.status !== 'cooldown') return false;
    const refreshedAt = Date.parse(seat.usageRefreshedAt ?? '');
    return !Number.isFinite(refreshedAt)
      || now - refreshedAt >= PLATFORM_CREDENTIAL_USAGE_REFRESH_MS;
  });
}

/**
 * One window's reading in the words every screen draws it with: the share,
 * the track's short name for a compact line, the full name for the
 * subscription's own page, the window's length and its reset. The state
 * read's rows and the seats read's records both take a window from HERE
 * (note #697), so Home's plate and the page it opens can never name or
 * measure the same reading two ways. `gating` is every window of the seat
 * that can stop a turn — the set a track's short name is told apart within.
 */
export function seatWindowReading(window: ProviderUsageWindow, gating: ProviderUsageWindow[]): {
  label: string;
  usedPercent: number;
  percentText: string;
  trackText?: string;
  windowMins?: number;
  resetAt?: string;
} {
  const trackText = formatUsageTrackLabel(window, gating);
  return {
    label: window.id === 'seven_day' && trackText === 'other models'
      ? '7 days · other models'
      : formatUsageWindowLabel(window),
    usedPercent: window.usedPercent,
    percentText: formatUsagePercent(window.usedPercent),
    ...(trackText ? { trackText } : {}),
    // The window's own length, so the browser can say where an even spend
    // would stand by now (note #279). Useless without `resetAt`, and the
    // provider does not always send either.
    ...(window.windowDurationMins ? { windowMins: window.windowDurationMins } : {}),
    ...(window.resetsAt ? { resetAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
  };
}

/**
 * The compact subscription items shared by Home and every other screen that
 * carries the seat strip. Keep this projection in one place: the recap uses
 * these exact non-secret facts too, so its account of capacity cannot drift
 * from the percentages the person is looking at.
 */
export function workspaceSeatUsageRows(
  seats: OrgSeatDocument[],
  now = Date.now(),
): WorkspaceSeatUsage[] {
  return seats
    .filter((seat) => seat.status !== 'disabled')
    .map((seat) => {
      // A dead or payment-paused seat keeps its name and plan, but an old
      // percentage must not look like current capacity. Cooldown is live
      // state: its window reading explains why the seat is resting.
      const live = seat.status === 'active' || seat.status === 'cooldown';
      const all = live && seat.usage
        ? [...Object.values(seat.usage.windows), ...Object.values(seat.modelWindows ?? {})]
        : [];
      // Extra usage is a spend cap, not a window that stops a turn. It stays
      // on the seat detail screen instead of becoming a capacity warning on
      // the compact item or in the Workspace recap.
      const gating = all.filter((window) => window.id !== 'overage');
      return {
        seatId: seat.seatId,
        provider: seat.provider,
        label: seat.label,
        // The plan is identity rather than a live reading, so it survives a
        // dead seat and still distinguishes two otherwise identical items.
        ...(seat.usage?.planType ? { planText: formatUsagePlan(seat.usage.planType) } : {}),
        ...(seat.status !== 'active' ? { status: seat.status } : {}),
        ...(seat.status === 'payment_required' ? { attention: 'payment_required' as const } : {}),
        // Primary belongs to this item, never to the section as a whole.
        selected: seat.selected,
        windows: sortUsageWindows(gating).map((window) => {
          const reading = seatWindowReading(window, gating);
          const pace = windowPace(reading, now);
          return {
            ...reading,
            ...(pace ? { pace: pace.verdict, ...(pace.early ? { paceEarly: true as const } : {}) } : {}),
          };
        }),
        ...(seat.usageRefreshedAt ? { usageRefreshedAt: seat.usageRefreshedAt } : {}),
        // The stamp the seats read carries too: the browser keeps whichever
        // copy of this subscription is newer and re-reads the other (note #697).
        updatedAt: seat.updatedAt,
      };
    });
}
