import { describe, expect, it } from 'vitest';
import { planPoolRetirement } from '../../services/pool-retirement.js';
import { newCredentialDocument } from '../../services/platform-credential-pool.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import type { OrgSeatDocument } from '../../types/org.js';
import type { PlatformCredentialDocument } from '../../types/platform-credential.js';

/**
 * The pool-row cleanup after the seat cutover: a pool row is retired only
 * when a LIVE seat carries the same subscription (provider+label) and the
 * row is idle. Anything else stays, with a reason the dry run can print.
 */

async function seat(overrides: Partial<OrgSeatDocument> & { label: string }): Promise<OrgSeatDocument> {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'A', createdByUserId: 'marat' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'marat', role: 'admin' });
  return orgStorage.addSeat({
    orgId: org.orgId, userId: 'marat',
    provider: 'claude', token: 'tok', status: 'active',
    ...overrides,
  } as never);
}

function cred(args: Partial<PlatformCredentialDocument> & { label: string }): PlatformCredentialDocument {
  return {
    ...newCredentialDocument({ provider: 'claude', token: 'tok', label: args.label }),
    ...args,
  };
}

describe('planPoolRetirement', () => {
  it('retires an idle row whose subscription lives on an active seat', async () => {
    const plan = planPoolRetirement([cred({ label: 'max-1' })], [await seat({ label: 'max-1' })]);
    expect(plan.keep).toEqual([]);
    expect(plan.retire).toHaveLength(1);
    expect(plan.retire[0]!.tokenMatches).toBe(true);
  });

  it('a drifted token still retires, flagged — the seat copy is the live one', async () => {
    const plan = planPoolRetirement(
      [cred({ provider: 'codex', label: 'codex-1', token: 'stale' })],
      [await seat({ provider: 'codex', label: 'codex-1', token: 'refreshed' })],
    );
    expect(plan.retire).toHaveLength(1);
    expect(plan.retire[0]!.tokenMatches).toBe(false);
  });

  it('a seat in cooldown is alive — its pool row still retires', async () => {
    const plan = planPoolRetirement(
      [cred({ label: 'max-1' })],
      [await seat({ label: 'max-1', status: 'cooldown', cooldownUntil: '2099-01-01T00:00:00.000Z' })],
    );
    expect(plan.retire).toHaveLength(1);
  });

  it('keeps a row no seat carries', async () => {
    const plan = planPoolRetirement([cred({ label: 'orphan' })], [await seat({ label: 'max-1' })]);
    expect(plan.retire).toEqual([]);
    expect(plan.keep[0]!.reason).toContain('no seat');
  });

  it('keeps a row whose seat copy is dead — retiring it would erase the only working material', async () => {
    const plan = planPoolRetirement(
      [cred({ label: 'max-1' })],
      [await seat({ label: 'max-1', status: 'dead' })],
    );
    expect(plan.retire).toEqual([]);
    expect(plan.keep[0]!.reason).toContain('dead');
  });

  it('keeps a row while the matching seat is payment-blocked', async () => {
    const plan = planPoolRetirement(
      [cred({ label: 'max-1' })],
      [await seat({ label: 'max-1', status: 'payment_required', subscriptionStatus: 'past_due' })],
    );
    expect(plan.retire).toEqual([]);
    expect(plan.keep[0]!.reason).toContain('payment_required');
  });

  it('keeps a row with a lease in flight', async () => {
    const plan = planPoolRetirement(
      [cred({ label: 'max-1', inFlightCount: 1 })],
      [await seat({ label: 'max-1' })],
    );
    expect(plan.retire).toEqual([]);
    expect(plan.keep[0]!.reason).toContain('in flight');
  });

  it('a provider match alone is not a subscription match', async () => {
    const plan = planPoolRetirement(
      [cred({ label: 'max-2' })],
      [await seat({ label: 'max-1' })],
    );
    expect(plan.retire).toEqual([]);
  });
});
