import type { OrgSeatDocument, OrgSeatProvider } from '../types/org.js';
import type { OrgStorage } from './org-storage.js';
import { subscriptionName } from '../shared/harness-clis.js';

/**
 * Seat sign-in (org-layer-design, workstream 2): the storage half of the
 * self-serve ceremony. The interactive flow lives in OrgSeatSignInFlow —
 * Claude as our own OAuth mint (the seat then carries a refreshing grant),
 * Codex as our own device login (the seat carries the CLI's auth.json); what
 * changed with the org layer is where the resulting secret material LIVES — a member-owned seat row, which the turn path leases
 * through OrgSeatCredentialSource, instead of per-user secret storage.
 *
 * Two rules live here so every door into sign-in gets them for free:
 *
 *  - **A fresh sign-in replaces the member's dead assignments here.**
 *    The one reason a member re-runs the ceremony is a seat that died (token
 *    revoked, auth failures); leaving the corpse assigned here would make
 *    every re-auth grow this org's seats screen by one grave. The underlying
 *    private sign-in and its assignments in every OTHER org stay intact: a
 *    new sign-in is usable only in the org where it was started, and only the
 *    explicit "delete everywhere" verb may disturb another org. Live seats
 *    are never touched — several subscriptions per member is a designed-for
 *    shape, and adding one must not disturb the others.
 *  - **The new seat is the selection.** `addSeat` already auto-selects, which
 *    is the design's "default: most recently added" — restated here because
 *    callers rely on it: the seat just signed in is the one the next turn
 *    runs on, with no extra step.
 */

/** Seat states a turn can still lease (cooldown auto-restores; dead/disabled need a human). */
export function isLiveSeatStatus(status: OrgSeatDocument['status']): boolean {
  return status === 'active' || status === 'cooldown';
}

/**
 * Does this member hold a seat the given provider's turns could run on?
 * False for a human in no org — callers use that to fall back to the
 * pre-org (dev/self-hosted) sign-in paths.
 */
export async function memberHasLiveSeat(
  orgStorage: OrgStorage,
  userId: string,
  provider: OrgSeatProvider,
  orgId?: string | null,
): Promise<boolean> {
  const membership = orgId
    ? await orgStorage.getMembership(orgId, userId)
    : await orgStorage.getMembershipByUser(userId);
  if (!membership) return false;
  const seats = await orgStorage.listSeatsByMember(membership.orgId, userId);
  return seats.some((seat) => seat.provider === provider && isLiveSeatStatus(seat.status));
}

/** "Claude · 22 Aug 2026" — the seats screen shows provider-shaped rows, so the
 * label carries what distinguishes THIS seat: when it was signed in. */
export function signInSeatLabel(provider: OrgSeatProvider, now: Date = new Date()): string {
  const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${subscriptionName(provider)} · ${day}`;
}

export type AddMemberSeatResult =
  | { outcome: 'added'; seat: OrgSeatDocument; replacedDeadSeats: number }
  | { outcome: 'no_org' };

/**
 * Store a completed sign-in as the member's newest (and selected) seat.
 * `token` is provider-shaped exactly as the seat contract says: Claude — the
 * current OAuth access token backed by the stored refresh grant; Codex — the
 * full `auth.json` contents as a JSON string. Verification is the CALLER's job (the Claude token is
 * live-probed before this, the Codex file is only read after `codex login
 * status` succeeds); this function only places trusted material.
 */
export async function addMemberSeat(args: {
  orgStorage: OrgStorage;
  userId: string;
  orgId: string;
  provider: OrgSeatProvider;
  token: string;
  /** Defaults to active; a verified but provider-paused grant can land blocked without lying about OAuth. */
  status?: OrgSeatDocument['status'];
  /** The Workspace mint's grant — what keeps a short-lived `token` alive. */
  oauth?: OrgSeatDocument['oauth'];
  subscriptionStatus?: string;
  subscriptionStatusReadAt?: string;
  /** First usage reading, when the sign-in's own verification produced one. */
  usage?: OrgSeatDocument['usage'];
  modelWindows?: OrgSeatDocument['modelWindows'];
  now?: Date;
}): Promise<AddMemberSeatResult> {
  const { orgStorage, userId, provider } = args;
  const membership = await orgStorage.getMembership(args.orgId, userId);
  if (!membership) return { outcome: 'no_org' };

  const seats = await orgStorage.listSeatsByMember(membership.orgId, userId);
  const deadSeats = seats.filter((seat) => seat.provider === provider && seat.status === 'dead');
  for (const seat of deadSeats) {
    await orgStorage.unassignSeat(membership.orgId, userId, seat.seatId);
  }

  const now = args.now ?? new Date();
  const seat = await orgStorage.addSeat({
    orgId: membership.orgId,
    userId,
    provider,
    token: args.token,
    label: signInSeatLabel(provider, now),
    status: args.status ?? 'active',
    ...(args.oauth ? { oauth: args.oauth } : {}),
    ...(args.subscriptionStatus ? { subscriptionStatus: args.subscriptionStatus } : {}),
    ...(args.subscriptionStatusReadAt ? { subscriptionStatusReadAt: args.subscriptionStatusReadAt } : {}),
    ...(args.usage ? { usage: args.usage, usageRefreshedAt: now.toISOString() } : {}),
    ...(args.modelWindows ? { modelWindows: args.modelWindows, modelWindowsReadAt: now.toISOString() } : {}),
  });
  return { outcome: 'added', seat, replacedDeadSeats: deadSeats.length };
}
