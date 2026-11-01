import type { PlatformCredentialDocument, PlatformCredentialLeaseOutcome, PlatformCredentialReleaseExtras, PlatformCredentialProvider } from '../types/platform-credential.js';
import type { OrgSeatDocument } from '../types/org.js';
import type { OrgStorage } from './org-storage.js';
import { applyLeaseOutcome } from './platform-credential-pool.js';

/**
 * Org seats, presented to the credential pool as the member's OWNED
 * credentials (org-layer-design: "an agent runs on its owner's seats").
 *
 * The pool's `leaseForUser` already implements the per-human policy — your
 * own credential, or an honest "out of window", never a quiet hop onto
 * shared capacity. Seats plug into that policy instead of growing a second
 * one: a member's seats are mapped into credential-doc shape (selected seat
 * first, then this org's fallback order), `resolveUserLease` picks the first
 * leasable one, and a
 * released lease routes back here, where the pool's own outcome brain
 * (`applyLeaseOutcome`) decides and the result is translated onto the seat.
 *
 * The id namespace keeps the two worlds apart: a seat-backed lease's
 * credentialId is `seat_<seatId>`, which no pool row can carry (pool ids are
 * `cred_…`), so release-time routing is one prefix check.
 */
export const SEAT_LEASE_PREFIX = 'seat_';

export function seatToCredentialDoc(seat: OrgSeatDocument): PlatformCredentialDocument {
  return {
    credentialId: `${SEAT_LEASE_PREFIX}${seat.seatId}`,
    provider: seat.provider,
    token: seat.token,
    label: seat.label,
    ownerUserId: seat.userId,
    status: seat.status,
    ...(seat.cooldownUntil ? { cooldownUntil: seat.cooldownUntil } : {}),
    ...(seat.modelCooldowns ? { modelCooldowns: seat.modelCooldowns } : {}),
    ...(seat.subscriptionStatus ? { subscriptionStatus: seat.subscriptionStatus } : {}),
    ...(seat.subscriptionStatusReadAt ? { subscriptionStatusReadAt: seat.subscriptionStatusReadAt } : {}),
    ...(seat.deadReason ? { deadReason: seat.deadReason } : {}),
    ...(seat.usage ? { usage: seat.usage } : {}),
    ...(seat.usageRefreshedAt ? { usageRefreshedAt: seat.usageRefreshedAt } : {}),
    // A grant seat's own token IS profile-scoped, so it doubles as the pool's
    // "usage auth" — the refresher's profile path (full windows + renewal)
    // works on seats unchanged, and its authUpdate writes translate back onto
    // the seat below.
    ...(seat.oauth
      ? {
        usageAuth: {
          accessToken: seat.token,
          refreshToken: seat.oauth.refreshToken,
          ...(seat.oauth.expiresAt !== undefined ? { expiresAt: seat.oauth.expiresAt } : {}),
          ...(seat.oauth.scopes ? { scopes: seat.oauth.scopes } : {}),
          ...(seat.oauth.failedAt ? { failedAt: seat.oauth.failedAt } : {}),
          ...(seat.oauth.failedReason ? { failedReason: seat.oauth.failedReason } : {}),
        },
      }
      : {}),
    ...(seat.modelWindows ? { modelWindows: seat.modelWindows } : {}),
    ...(seat.modelWindowsReadAt ? { modelWindowsReadAt: seat.modelWindowsReadAt } : {}),
    authFailureStreak: seat.authFailureStreak ?? 0,
    // Seats are one human's own: selection among them never needs in-flight
    // load spreading, so these stay zero rather than being tracked.
    inFlightCount: 0,
    totalLeases: 0,
    createdAt: seat.createdAt,
    updatedAt: seat.updatedAt,
  };
}

export class OrgSeatCredentialSource {
  constructor(private readonly orgStorage: OrgStorage) {}

  /**
   * The member's seats for one provider, credential-shaped, in lease order:
   * the selected seat first, then this org's chosen fallback order.
   * `resolveUserLease` takes the first leasable, which is exactly the design's "selected seat, falling
   * back only among the member's own". Empty for a human in no org.
   *
   * `pinnedSeatId` is an AGENT's own override (note #129): that seat moves to
   * the front — it replaces the org's selection for this one agent, with the
   * same fallback behind it the selected seat has, so a pinned seat in
   * cooldown degrades exactly like a selected one instead of stranding the
   * agent. A pin naming a seat this member no longer holds here is ignored,
   * not an error: the stale record degrades to the org default.
   */
  async listForUser(
    provider: PlatformCredentialProvider,
    userId: string,
    orgId?: string | null,
    pinnedSeatId?: string,
  ): Promise<PlatformCredentialDocument[]> {
    const membership = orgId
      ? await this.orgStorage.getMembership(orgId, userId)
      : await this.orgStorage.getMembershipByUser(userId);
    if (!membership) return [];
    const seats = (await this.orgStorage.listSeatsByMember(membership.orgId, userId))
      .filter((seat) => seat.provider === provider);
    seats.sort((a, b) => Number(b.selected) - Number(a.selected));
    if (pinnedSeatId) {
      const pinned = seats.findIndex((seat) => seat.seatId === pinnedSeatId);
      if (pinned > 0) seats.unshift(...seats.splice(pinned, 1));
    }
    return seats.map(seatToCredentialDoc);
  }

  async isMember(userId: string, orgId?: string | null): Promise<boolean> {
    return Boolean(orgId
      ? await this.orgStorage.getMembership(orgId, userId)
      : await this.orgStorage.getMembershipByUser(userId));
  }

  owns(credentialId: string): boolean {
    return credentialId.startsWith(SEAT_LEASE_PREFIX);
  }

  /**
   * Every seat of a provider, credential-shaped — the periodic usage
   * refresher's walk. Probing seats is what keeps a model-scoped rate limit
   * benching one model instead of the whole seat: the outcome brain trusts a
   * scoped bench only when the unified windows show headroom.
   */
  async listAllForProbe(provider: PlatformCredentialProvider): Promise<PlatformCredentialDocument[]> {
    const seats = await this.orgStorage.listAllSeats();
    return seats.filter((seat) => seat.provider === provider).map(seatToCredentialDoc);
  }

  /** Translate credential-doc updates (outcome brain or probe) onto the seat. */
  async applyCredentialUpdates(
    credentialId: string,
    updates: Partial<PlatformCredentialDocument>,
  ): Promise<void> {
    const seatId = credentialId.slice(SEAT_LEASE_PREFIX.length);
    const seatUpdates: Parameters<OrgStorage['updateSeat']>[1] = {};
    if (updates.status !== undefined) seatUpdates.status = updates.status;
    if (updates.cooldownUntil !== undefined) seatUpdates.cooldownUntil = updates.cooldownUntil;
    if (updates.modelCooldowns !== undefined) seatUpdates.modelCooldowns = updates.modelCooldowns;
    if (updates.authFailureStreak !== undefined) seatUpdates.authFailureStreak = updates.authFailureStreak;
    if (updates.deadReason !== undefined) seatUpdates.deadReason = updates.deadReason;
    if (updates.subscriptionStatus !== undefined) seatUpdates.subscriptionStatus = updates.subscriptionStatus;
    if (updates.subscriptionStatusReadAt !== undefined) {
      seatUpdates.subscriptionStatusReadAt = updates.subscriptionStatusReadAt;
    }
    if (updates.token !== undefined) seatUpdates.token = updates.token;
    if (updates.usage !== undefined) seatUpdates.usage = updates.usage;
    if (updates.usageRefreshedAt !== undefined) seatUpdates.usageRefreshedAt = updates.usageRefreshedAt;
    if (updates.modelWindows !== undefined) seatUpdates.modelWindows = updates.modelWindows;
    if (updates.modelWindowsReadAt !== undefined) seatUpdates.modelWindowsReadAt = updates.modelWindowsReadAt;
    // The refresher's renewal writes usageAuth; on a grant seat that IS the
    // seat's credential — the fresh access token becomes the turn token, and
    // the rotated refresh token is persisted with it (drop it and the seat
    // strands at the next renewal).
    if (updates.usageAuth !== undefined) {
      const auth = updates.usageAuth;
      seatUpdates.token = auth.accessToken;
      seatUpdates.oauth = {
        refreshToken: auth.refreshToken ?? '',
        ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
        ...(auth.scopes ? { scopes: auth.scopes } : {}),
        ...(auth.failedAt ? { failedAt: auth.failedAt } : {}),
        ...(auth.failedReason ? { failedReason: auth.failedReason } : {}),
      };
    }
    if (Object.keys(seatUpdates).length === 0) return;
    await this.orgStorage.updateSeat(seatId, seatUpdates);
  }

  /**
   * Release of a seat-backed lease: run the pool's outcome brain over the
   * credential view and translate what changed onto the seat — cooldowns,
   * model-scoped cooldowns, death, and refreshed secret material (the Codex
   * auth.json sync-back, which is what keeps a seat's token current once
   * turns run on it).
   */
  async release(
    credentialId: string,
    outcome: PlatformCredentialLeaseOutcome,
    extras?: PlatformCredentialReleaseExtras,
  ): Promise<void> {
    const seatId = credentialId.slice(SEAT_LEASE_PREFIX.length);
    const seat = await this.orgStorage.getSeat(seatId);
    if (!seat) return;
    const updates = applyLeaseOutcome(seatToCredentialDoc(seat), outcome, undefined, extras);
    await this.applyCredentialUpdates(credentialId, updates);
  }
}
