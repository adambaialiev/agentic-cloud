import type { PlatformCredentialDocument } from '../types/platform-credential.js';
import type { OrgSeatDocument } from '../types/org.js';

/**
 * Which pool rows the org cutover made redundant (org-layer-design: "no
 * pool"). After the cutover a member's turns lease only that member's own
 * seats — a pool row whose subscription was copied into a seat serves no
 * turn any more and only goes stale, so it is deleted rather than left to
 * drift out of truth.
 *
 * A row is retirable when a LIVE seat carries the same provider+label (the
 * copy linkage the org #0 bootstrap wrote) and nothing is in flight on the
 * row. Everything else is kept, with the reason, so the operator script's
 * dry run reads as a complete account of the pool.
 */
export interface PoolRetirementPlan {
  retire: Array<{
    credential: PlatformCredentialDocument;
    seat: OrgSeatDocument;
    /**
     * Informational: false means the seat's copy has drifted from the pool's
     * — expected for Codex, whose CLI refreshes auth.json in place on
     * whichever row turns run on (the seat, since the cutover).
     */
    tokenMatches: boolean;
  }>;
  keep: Array<{ credential: PlatformCredentialDocument; reason: string }>;
}

export function planPoolRetirement(
  credentials: PlatformCredentialDocument[],
  seats: OrgSeatDocument[],
): PoolRetirementPlan {
  const plan: PoolRetirementPlan = { retire: [], keep: [] };
  for (const credential of credentials) {
    const seat = seats.find(
      (s) => s.provider === credential.provider && s.label === credential.label,
    );
    if (!seat) {
      plan.keep.push({ credential, reason: 'no seat carries this subscription' });
      continue;
    }
    if (seat.status !== 'active' && seat.status !== 'cooldown') {
      plan.keep.push({ credential, reason: `the seat copy is ${seat.status}` });
      continue;
    }
    if (credential.inFlightCount > 0) {
      plan.keep.push({
        credential,
        reason: `${credential.inFlightCount} lease(s) in flight — re-run when idle`,
      });
      continue;
    }
    plan.retire.push({ credential, seat, tokenMatches: credential.token === seat.token });
  }
  return plan;
}
