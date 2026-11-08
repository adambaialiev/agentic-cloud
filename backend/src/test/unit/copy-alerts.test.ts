import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { CopyAlertSweep, newCopyOpsMessage, type CopyAlertRecipient } from '../../services/copy-alerts.js';
import { copyPulseHandler } from '../../routes/copy-pulse.js';
import { InMemoryCopyPulseKeyStore } from '../../services/copy-pulse-keys.js';
import { newCopyIdentity, signPulseBody, COPY_PULSE_KEY_HEADER, COPY_PULSE_SIGNATURE_HEADER } from '../../shared/copy-pulse-signing.js';
import { InMemoryCopyPulseStore, type CopyPulseStore } from '../../services/copy-pulse-storage.js';
import { SqliteCopyPulseStore } from '../../services/sqlite/sqlite-copy-pulse-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { fixturePulse } from '../../shared/copy-pulse-fixtures.js';
import type { WorkspaceAgentEvent } from '../../shared/workspace-agent-proactive.js';

const OFFERED = ['2026.11.01.1', '2026.11.03.0', '2026.11.05.0', '2026.11.06.0'];
const ADAM: CopyAlertRecipient = { userId: 'adam', orgId: 'acc' };

function harness(store: CopyPulseStore = new InMemoryCopyPulseStore(), opts: { recipients?: CopyAlertRecipient[]; offered?: string[] | null; telegram?: 'ok' | 'rejects' } = {}) {
  let now = new Date('2026-11-07T06:00:00.000Z');
  const delivered: Array<{ to: CopyAlertRecipient; events: WorkspaceAgentEvent[] }> = [];
  const telegram: string[] = [];
  const logs: string[] = [];
  const sweep = new CopyAlertSweep({
    store,
    offered: async () => (opts.offered === undefined ? OFFERED : opts.offered),
    recipients: async () => opts.recipients ?? [ADAM],
    deliver: async (to, events) => { delivered.push({ to, events }); return true; },
    ...(opts.telegram ? {
      notifyOps: async (text: string) => {
        telegram.push(text);
        if (opts.telegram === 'rejects') throw new Error('Telegram is down');
      },
    } : {}),
    now: () => now,
    log: (line) => logs.push(line),
  });
  return {
    store, sweep, delivered, telegram, logs,
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

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => { s.close(resolve); })));
});

describe('a new copy in the ops Telegram chat (note #1083)', () => {
  const DANA = [
    '🆕 New private copy installed: agents.acme.example',
    'Contact: Dana Field <dana@acme.example>',
    'Release 2026.11.06.0 · 12 people · 8 agents',
    'First pulse: 7 Nov 2026, 06:00 UTC',
  ].join('\n');

  it('a first pulse sends one message, beside the chat row, in plain words', async () => {
    const h = harness(undefined, { telegram: 'ok' });
    await h.store.record(fixturePulse(), '2026-11-07T06:00:00.000Z');
    expect(await h.sweep.sweep()).toBe(1);
    expect(h.said()).toEqual(['copy-new:fixture-acme-0001']);
    expect(h.telegram).toEqual([DANA]);
  });

  it('a second pulse, a boot pulse and later sweeps from the same copy send nothing', async () => {
    const h = harness(undefined, { telegram: 'ok' });
    await h.store.record(fixturePulse(), '2026-11-07T06:00:00.000Z');
    await h.sweep.sweep();
    for (const [at, reason] of [['2026-11-07T06:30:00.000Z', 'boot'], ['2026-11-07T07:00:00.000Z', 'daily'], ['2026-11-08T06:00:00.000Z', 'contact-changed']] as const) {
      h.at(at);
      await h.store.record(fixturePulse({ reason, people: 13 }), at);
      expect(await h.sweep.sweep()).toBe(0);
    }
    expect(h.telegram).toHaveLength(1);
  });

  it('only a new copy: silent, behind, trouble and opted-out stay chat-only', async () => {
    const h = harness(undefined, { telegram: 'ok' });
    await h.store.record(fixturePulse({ release: '2026.11.03.0', health: { backupAgeHours: 60, diskFreePercent: 5, state: 'ok' } }), '2026-10-01T06:00:00.000Z');
    await h.store.record(fixturePulse({ release: '2026.11.03.0', health: { backupAgeHours: 60, diskFreePercent: 5, state: 'ok' } }), '2026-11-07T05:00:00.000Z');
    await h.store.record(fixturePulse({ copyId: 'fixture-initech-04', domain: 'agents.initech.example', pulseEnabled: false }), '2026-10-01T06:00:00.000Z');
    expect(await h.sweep.sweep()).toBeGreaterThan(0);
    expect(h.said().some((s) => s.startsWith('copy-new'))).toBe(false);
    expect(h.telegram).toEqual([]);
  });

  it('two new copies in one sweep are two messages, one each', async () => {
    const h = harness(undefined, { telegram: 'ok' });
    await h.store.record(fixturePulse(), '2026-11-07T05:00:00.000Z');
    await h.store.record(fixturePulse({ copyId: 'fixture-globex-02', domain: 'ai.globex.example', contactName: '', contactEmail: 'ops@globex.example', people: 1, agentsByCli: { claude: 1, codex: 0, opencode: 0 }, release: null }), '2026-11-07T05:30:00.000Z');
    await h.sweep.sweep();
    expect(h.telegram).toHaveLength(2);
    expect(h.telegram[1]).toBe([
      '🆕 New private copy installed: ai.globex.example',
      'Contact: ops@globex.example',
      'Release unknown · 1 person · 1 agent',
      'First pulse: 7 Nov 2026, 05:30 UTC',
    ].join('\n'));
  });

  it('waits with the chat row when nobody can hear it yet, then goes once', async () => {
    const store = new InMemoryCopyPulseStore();
    const nobody = harness(store, { recipients: [], telegram: 'ok' });
    await store.record(fixturePulse(), '2026-11-07T06:00:00.000Z');
    await nobody.sweep.sweep();
    expect(nobody.telegram).toEqual([]);
    const adam = harness(store, { telegram: 'ok' });
    await adam.sweep.sweep();
    await adam.sweep.sweep();
    expect(adam.telegram).toEqual([DANA]);
  });

  it('a Telegram failure is logged and dropped: the alert is still recorded and never retried', async () => {
    const h = harness(undefined, { telegram: 'rejects' });
    await h.store.record(fixturePulse(), '2026-11-07T06:00:00.000Z');
    expect(await h.sweep.sweep()).toBe(1);
    expect(Object.keys(await h.store.alerts('fixture-acme-0001'))).toEqual(['first-pulse']);
    expect(h.logs.some((l) => l.includes('ops chat not told about fixture-acme-0001: Telegram is down'))).toBe(true);
    h.at('2026-11-07T07:00:00.000Z');
    expect(await h.sweep.sweep()).toBe(0);
    expect(h.telegram).toHaveLength(1);
  });

  it('a Telegram failure never fails the pulse route', async () => {
    const store = new InMemoryCopyPulseStore();
    const h = harness(store, { telegram: 'rejects' });
    const sweeps: Array<Promise<number>> = [];
    const app = express();
    app.use('/api/copy-pulse', express.raw({ type: () => true, limit: '64kb' }));
    app.post('/api/copy-pulse', copyPulseHandler({
      store, keys: new InMemoryCopyPulseKeyStore(), now: () => new Date('2026-11-07T06:00:00.000Z'),
      onPulse: () => { sweeps.push(h.sweep.sweep()); },
    }));
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const identity = newCopyIdentity();
    const body = JSON.stringify(fixturePulse());
    const answer = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy-pulse`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', [COPY_PULSE_KEY_HEADER]: identity.publicKey, [COPY_PULSE_SIGNATURE_HEADER]: signPulseBody(body, identity.privateKey) },
    });
    expect(answer.status).toBe(200);
    expect(await Promise.all(sweeps)).toEqual([1]);
    expect(h.telegram).toHaveLength(1);
    expect(await store.get('fixture-acme-0001')).not.toBeNull();
  });

  it('formats the time in UTC and survives a date it cannot read', () => {
    const record = { copyId: 'c', firstSeenAt: '2026-11-08T17:47:21.513Z', lastSeenAt: '2026-11-08T17:47:21.513Z', pulse: { ...fixturePulse({ domain: 'pass1108.agentbuilt.app', contactName: 'Ada Acceptance', contactEmail: 'ada@pass1108.agentbuilt.app', release: '2026.11.07.0', people: 2, agentsByCli: { claude: 1, codex: 0, opencode: 0 } }), receivedAt: '2026-11-08T17:47:21.513Z' } };
    expect(newCopyOpsMessage(record)).toBe([
      '🆕 New private copy installed: pass1108.agentbuilt.app',
      'Contact: Ada Acceptance <ada@pass1108.agentbuilt.app>',
      'Release 2026.11.07.0 · 2 people · 1 agent',
      'First pulse: 8 Nov 2026, 17:47 UTC',
    ].join('\n'));
    expect(newCopyOpsMessage({ ...record, firstSeenAt: 'garbled' })).toContain('First pulse: garbled');
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
