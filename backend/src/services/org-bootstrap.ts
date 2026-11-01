import type { PlatformCredentialDocument } from '../types/platform-credential.js';
import type { OrgSeatDocument } from '../types/org.js';
import type { OrgStorage } from './org-storage.js';

/**
 * Org #0 — turning the admin's account into the first workplace
 * (org-layer-design: "bootstrap, not migration"). Run once by the operator
 * script (backend/scripts/bootstrap-org0.mjs), checked by hand, then done:
 * every other org is born on the schema directly.
 *
 * The seats are COPIES of the admin's pool credentials, not moves: turns keep
 * running on the pool until the cutover slice switches the turn path to
 * seats, so at no moment does a turn have nothing to run on. Consequence to
 * carry into the cutover: a Codex credential's auth.json refreshes in place
 * on the POOL row between copy and cutover, so the cutover re-copies token
 * material one final time before the pool retires.
 */

export interface OrgBootstrapInput {
  /** The admin's platform userId — the founder and first admin of org #0. */
  adminUserId: string;
  orgName: string;
  /** Every pool credential, healthy or not — labels and history come along. */
  credentials: PlatformCredentialDocument[];
}

export interface PlannedSeat {
  provider: PlatformCredentialDocument['provider'];
  label: string;
  status: PlatformCredentialDocument['status'];
  /** Whether the selection pass will leave the pick on this seat. */
  selected: boolean;
  /** From the source credential, for the operator's report. Never the token. */
  sourceCredentialId: string;
}

export type OrgBootstrapPlan =
  | { action: 'already-bootstrapped'; orgId: string }
  | { action: 'create'; orgName: string; adminUserId: string; seats: PlannedSeat[] };

/**
 * Which credential should hold the member's pick for one provider: the
 * operator's routing pin when it is healthy, else the newest healthy one
 * (active beats cooldown — cooldown heals itself, but not this minute), else
 * the newest of whatever there is. Deterministic, so the plan the operator
 * reads is exactly what apply writes.
 */
export function pickSelected(credentials: PlatformCredentialDocument[]): string | null {
  if (credentials.length === 0) return null;
  const newestFirst = [...credentials].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.credentialId.localeCompare(b.credentialId),
  );
  const healthyPin = newestFirst.find((c) => c.routingPin && (c.status === 'active' || c.status === 'cooldown'));
  if (healthyPin) return healthyPin.credentialId;
  return (
    newestFirst.find((c) => c.status === 'active')
    ?? newestFirst.find((c) => c.status === 'cooldown')
    ?? newestFirst[0]!
  ).credentialId;
}

export async function planOrgBootstrap(
  orgStorage: OrgStorage,
  input: OrgBootstrapInput,
): Promise<OrgBootstrapPlan> {
  const existing = await orgStorage.getMembershipByUser(input.adminUserId);
  if (existing) {
    return { action: 'already-bootstrapped', orgId: existing.orgId };
  }
  const seats: PlannedSeat[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const ofProvider = input.credentials.filter((c) => c.provider === provider);
    const selectedId = pickSelected(ofProvider);
    for (const credential of ofProvider) {
      seats.push({
        provider,
        label: credential.label,
        status: credential.status,
        selected: credential.credentialId === selectedId,
        sourceCredentialId: credential.credentialId,
      });
    }
  }
  return { action: 'create', orgName: input.orgName, adminUserId: input.adminUserId, seats };
}

export interface OrgBootstrapResult {
  orgId: string;
  seats: OrgSeatDocument[];
}

/**
 * Executes exactly the plan `planOrgBootstrap` returned for the same input.
 * Seats are added oldest-credential-first so creation order mirrors history,
 * then the selection pass moves each provider's pick to the planned seat
 * (addSeat alone would leave it on whichever happened to be added last).
 */
export async function applyOrgBootstrap(
  orgStorage: OrgStorage,
  input: OrgBootstrapInput,
): Promise<OrgBootstrapResult> {
  const plan = await planOrgBootstrap(orgStorage, input);
  if (plan.action === 'already-bootstrapped') {
    throw new Error(`user ${input.adminUserId} already belongs to org ${plan.orgId} — nothing to do`);
  }
  const org = await orgStorage.createOrg({ name: input.orgName, createdByUserId: input.adminUserId });
  await orgStorage.addMember({ orgId: org.orgId, userId: input.adminUserId, role: 'admin' });

  const oldestFirst = [...input.credentials].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.credentialId.localeCompare(b.credentialId),
  );
  const seatByCredential = new Map<string, OrgSeatDocument>();
  for (const credential of oldestFirst) {
    const seat = await orgStorage.addSeat({
      orgId: org.orgId,
      userId: input.adminUserId,
      provider: credential.provider,
      token: credential.token,
      label: credential.label,
      status: credential.status,
      ...(credential.cooldownUntil ? { cooldownUntil: credential.cooldownUntil } : {}),
    });
    seatByCredential.set(credential.credentialId, seat);
  }
  for (const planned of plan.seats) {
    if (!planned.selected) continue;
    const seat = seatByCredential.get(planned.sourceCredentialId);
    if (seat) await orgStorage.selectSeat(seat.seatId);
  }
  const seats = await orgStorage.listSeatsByMember(org.orgId, input.adminUserId);
  return { orgId: org.orgId, seats };
}
