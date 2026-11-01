import { describe, expect, it } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { applyOrgBootstrap, pickSelected, planOrgBootstrap } from '../../services/org-bootstrap.js';
import type { PlatformCredentialDocument } from '../../types/platform-credential.js';

function credential(overrides: Partial<PlatformCredentialDocument> = {}): PlatformCredentialDocument {
  return {
    credentialId: `cred-${overrides.label ?? 'x'}`,
    provider: 'claude',
    token: 'sk-ant-oat-test',
    label: 'max-1',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as PlatformCredentialDocument;
}

describe('pickSelected', () => {
  it('prefers a healthy routing pin over everything, including newer credentials', () => {
    const picked = pickSelected([
      credential({ label: 'old-pinned', routingPin: true, createdAt: '2026-08-01T00:00:00.000Z' }),
      credential({ label: 'newer', createdAt: '2026-08-10T00:00:00.000Z' }),
    ]);
    expect(picked).toBe('cred-old-pinned');
  });

  it('ignores a dead pin — the pick must be a seat turns can actually run on', () => {
    const picked = pickSelected([
      credential({ label: 'dead-pinned', routingPin: true, status: 'dead' }),
      credential({ label: 'alive', createdAt: '2026-08-05T00:00:00.000Z' }),
    ]);
    expect(picked).toBe('cred-alive');
  });

  it('takes newest active, then newest cooldown, then whatever exists', () => {
    expect(pickSelected([
      credential({ label: 'a', status: 'cooldown', createdAt: '2026-08-09T00:00:00.000Z' }),
      credential({ label: 'b', status: 'active', createdAt: '2026-08-02T00:00:00.000Z' }),
    ])).toBe('cred-b');
    expect(pickSelected([
      credential({ label: 'c', status: 'disabled', createdAt: '2026-08-09T00:00:00.000Z' }),
      credential({ label: 'd', status: 'cooldown', createdAt: '2026-08-02T00:00:00.000Z' }),
    ])).toBe('cred-d');
    expect(pickSelected([credential({ label: 'e', status: 'dead' })])).toBe('cred-e');
    expect(pickSelected([])).toBeNull();
  });
});

describe('org #0 bootstrap', () => {
  const input = () => ({
    adminUserId: 'tg_admin',
    orgName: 'Org #0',
    credentials: [
      credential({ label: 'max-1', createdAt: '2026-08-01T00:00:00.000Z' }),
      credential({ label: 'max-2', createdAt: '2026-08-10T00:00:00.000Z' }),
      credential({
        label: 'codex-1', provider: 'codex', token: '{"tokens":{}}',
        status: 'cooldown', cooldownUntil: '2026-08-22T12:00:00.000Z',
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    ] as PlatformCredentialDocument[],
  });

  it('plans exactly what apply writes: one org, one admin, one seat per credential', async () => {
    const storage = new InMemoryOrgStorage();
    const plan = await planOrgBootstrap(storage, input());
    expect(plan.action).toBe('create');
    if (plan.action !== 'create') return;
    expect(plan.seats.map((s) => [s.label, s.selected])).toEqual([
      ['max-1', false], ['max-2', true], ['codex-1', true],
    ]);

    const result = await applyOrgBootstrap(storage, input());
    expect(result.seats).toHaveLength(3);
    const byLabel = new Map(result.seats.map((s) => [s.label, s]));
    // The plan's selection survived apply, even though max-2 was not the
    // last seat added (codex-1 was — addSeat's own default would differ).
    expect(byLabel.get('max-2')).toMatchObject({ provider: 'claude', selected: true, status: 'active' });
    expect(byLabel.get('max-1')).toMatchObject({ selected: false });
    expect(byLabel.get('codex-1')).toMatchObject({
      provider: 'codex', selected: true, status: 'cooldown',
      cooldownUntil: '2026-08-22T12:00:00.000Z', token: '{"tokens":{}}',
    });

    const membership = await storage.getMembershipByUser('tg_admin');
    expect(membership?.role).toBe('admin');
    expect((await storage.getOrg(membership!.orgId))?.name).toBe('Org #0');
  });

  it('is refused the second time — bootstrap is run-once, not idempotent-and-silent', async () => {
    const storage = new InMemoryOrgStorage();
    await applyOrgBootstrap(storage, input());
    const plan = await planOrgBootstrap(storage, input());
    expect(plan.action).toBe('already-bootstrapped');
    await expect(applyOrgBootstrap(storage, input())).rejects.toThrow(/already belongs to org/);
    // And nothing was doubled by the refused attempt.
    const membership = await storage.getMembershipByUser('tg_admin');
    expect(await storage.listSeatsByMember(membership!.orgId, 'tg_admin')).toHaveLength(3);
  });

  it('bootstraps an empty pool into an org with zero seats, plainly', async () => {
    const storage = new InMemoryOrgStorage();
    const result = await applyOrgBootstrap(storage, {
      adminUserId: 'tg_admin', orgName: 'Org #0', credentials: [],
    });
    expect(result.seats).toEqual([]);
    expect((await storage.getMembershipByUser('tg_admin'))?.role).toBe('admin');
  });
});
