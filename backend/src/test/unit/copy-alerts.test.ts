import { describe, expect, it } from 'vitest';
import { CopyAlertSweep, type CopyAlertRecipient } from '../../services/copy-alerts.js';
import { InMemoryCopyPulseStore, type CopyPulseStore } from '../../services/copy-pulse-storage.js';
import { SqliteCopyPulseStore } from '../../services/sqlite/sqlite-copy-pulse-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { fixturePulse } from '../../shared/copy-pulse-fixtures.js';
import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-proactive.js';

const OFFERED = ['2026.11.01.1', '2026.11.03.0', '2026.11.05.0', '2026.11.06.0'];
const ADAM: CopyAlertRecipient = { userId: 'adam', orgId: 'acc' };

function harness(store: CopyPulseStore = new InMemoryCopyPulseStore(), opts: { recipients?: CopyAlertRecipient[]; offered?: string[] | null } = {}) {
  let now = new Date('2026-11-07T06:00:00.000Z');
  const delivered: Array<{ to: CopyAlertRecipient; events: WorkspaceAgentEvent[] }> = [];
  const sweep = new CopyAlertSweep({
    store,
    offered: async () => (opts.offered === undefined ? OFFERED : opts.offered),
    recipients: async () => opts.recipients ?? [ADAM],
    deliver: async (to, events) => { delivered.push({ to, events }); return true; },
    now: () => now,
  });
  return {
    store, sweep, delivered,
    at: (iso: string) => { now = new Date(iso); },
    said: () => delivered.flatMap((d) => d.events.map((e) => `${e.kind}:${e.key.split(':')[1]}`)),
  };
}

describe('the copies\' alert sweep (note #1058)', () => {
  it('says a new copy once, as rows that open the copy', async () => {
    const h = harness();
    await h.store.record(fixturePulse(), '2026-11-07T06:00:00.000Z');
    expect(await h.sweep.sweep()).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.to).toEqual(ADAM);
    expect(h.delivered[0]!.events[0]).toMatchObject({ kind: 'copy-new', href: '/copies/fixture-acme-0001' });
    h.at('2026-11-07T07:00:00.000Z');
    await h.store.record(fixturePulse(), '2026-11-07T06:30:00.000Z');
    expect(await h.sweep.sweep()).toBe(0);
  });

  it('one alert per condition per copy, not a daily repeat; again only after it cleared', async () => {
    const h = harness();
    await h.store.record(fixturePulse({ health: { backupAgeHours: 60, diskFreePercent: 50, state: 'ok' } }), '2026-10-01T06:00:00.000Z');
    await h.store.record(fixturePulse({ health: { backupAgeHours: 60, diskFreePercent: 50, state: 'ok' } }), '2026-11-07T05:00:00.000Z');
    await h.sweep.sweep();
    expect(h.said()).toEqual(['copy-trouble:fixture-acme-0001']);
    for (const day of ['2026-11-08', '2026-11-09']) {
      h.at(`${day}T06:00:00.000Z`);
      await h.store.record(fixturePulse({ health: { backupAgeHours: 80, diskFreePercent: 50, state: 'ok' } }), `${day}T05:00:00.000Z`);
      expect(await h.sweep.sweep()).toBe(0);
    }
    // Fixed: forgotten. Broken again: said again.
    h.at('2026-11-10T06:00:00.000Z');
    await h.store.record(fixturePulse(), '2026-11-10T05:00:00.000Z');
    await h.sweep.sweep();
    expect(await h.store.alerts('fixture-acme-0001')).toEqual({});
    h.at('2026-11-12T06:00:00.000Z');
    await h.store.record(fixturePulse({ health: { backupAgeHours: 50, diskFreePercent: 50, state: 'ok' } }), '2026-11-12T05:00:00.000Z');
    await h.sweep.sweep();
    expect(h.said()).toEqual(['copy-trouble:fixture-acme-0001', 'copy-trouble:fixture-acme-0001']);
  });

  it('silence: said once on the third day, and a pulse ends it', async () => {
    const h = harness();
    await h.store.record(fixturePulse(), '2026-10-01T06:00:00.000Z');
    await h.store.record(fixturePulse(), '2026-11-01T06:00:00.000Z');
    h.at('2026-11-03T06:00:00.000Z');
    expect(await h.sweep.sweep()).toBe(0);
    h.at('2026-11-04T06:00:00.000Z');
    expect(await h.sweep.sweep()).toBe(1);
    h.at('2026-11-05T06:00:00.000Z');
    expect(await h.sweep.sweep()).toBe(0);
    expect(h.said()).toEqual(['copy-silent:fixture-acme-0001']);
    await h.store.record(fixturePulse(), '2026-11-05T06:00:00.000Z');
    await h.sweep.sweep();
    expect(await h.store.alerts('fixture-acme-0001')).toEqual({});
  });

  it('two releases behind and an opted-out copy, together in one delivery', async () => {
    const h = harness();
    await h.store.record(fixturePulse({ release: '2026.11.03.0' }), '2026-10-01T06:00:00.000Z');
    await h.store.record(fixturePulse({ release: '2026.11.03.0' }), '2026-11-07T05:00:00.000Z');
    await h.store.record(fixturePulse({ copyId: 'fixture-initech-04', domain: 'agents.initech.example', pulseEnabled: false }), '2026-10-01T06:00:00.000Z');
    await h.sweep.sweep();
    expect(h.delivered).toHaveLength(1);
    expect(h.said().sort()).toEqual(['copy-behind:fixture-acme-0001', 'copy-opted-out:fixture-initech-04']);
  });

  it('does not count releases it cannot see, nor forget a "behind" it said', async () => {
    const store = new InMemoryCopyPulseStore();
    const seeing = harness(store);
    await store.record(fixturePulse({ release: '2026.11.03.0' }), '2026-10-01T06:00:00.000Z');
    await store.record(fixturePulse({ release: '2026.11.03.0' }), '2026-11-07T05:00:00.000Z');
    await seeing.sweep.sweep();
    const blind = harness(store, { offered: null });
    expect(await blind.sweep.sweep()).toBe(0);
    expect(Object.keys(await store.alerts('fixture-acme-0001'))).toEqual(['behind']);
  });

  it('keeps an alert for later when nobody can hear it yet', async () => {
    const store = new InMemoryCopyPulseStore();
    const nobody = harness(store, { recipients: [] });
    await store.record(fixturePulse(), '2026-11-07T06:00:00.000Z');
    expect(await nobody.sweep.sweep()).toBe(0);
    expect(await store.alerts('fixture-acme-0001')).toEqual({});
    const adam = harness(store);
    expect(await adam.sweep.sweep()).toBe(1);
  });
});

describe('the stored tables (agreed on note #1057)', () => {
  it('keep the newest pulse, the first and last seen, and one row per day', async () => {
    const store = new SqliteCopyPulseStore(openSqliteDb(':memory:'));
    await store.record(fixturePulse({ people: 10 }), '2026-11-06T06:00:00.000Z');
    await store.record(fixturePulse({ people: 11, reason: 'boot' }), '2026-11-07T01:00:00.000Z');
    const last = await store.record(fixturePulse({ people: 12 }), '2026-11-07T06:00:00.000Z');
    expect(last).toMatchObject({ copyId: 'fixture-acme-0001', firstSeenAt: '2026-11-06T06:00:00.000Z', lastSeenAt: '2026-11-07T06:00:00.000Z' });
    expect(last.pulse).toEqual({ ...fixturePulse({ people: 12 }), receivedAt: '2026-11-07T06:00:00.000Z' });
    expect((await store.list()).map((r) => r.copyId)).toEqual(['fixture-acme-0001']);
    const days = await store.days('fixture-acme-0001');
    expect(days.map((d) => [d.day, d.pulse.people])).toEqual([['2026-11-07', 12], ['2026-11-06', 10]]);
    expect(await store.get('nope')).toBeNull();
    await store.setAlert('fixture-acme-0001', 'silent', '2026-11-07T06:00:00.000Z');
    expect(await store.alerts('fixture-acme-0001')).toEqual({ silent: '2026-11-07T06:00:00.000Z' });
    await store.setAlert('fixture-acme-0001', 'silent', null);
    expect(await store.alerts('fixture-acme-0001')).toEqual({});
  });
});
