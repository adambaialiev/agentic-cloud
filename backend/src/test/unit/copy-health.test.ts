/**
 * A private copy's health page and diagnostics bundle (note #813): one live
 * line per part, flagged when it needs a look, and a bundle that names which
 * keys are set without ever holding one.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCopyHealth } from '../../services/copy-health.js';

const NOW = new Date('2026-10-27T18:00:00.000Z');
const dir = mkdtempSync(path.join(tmpdir(), 'copy-health-'));
const dbPath = path.join(dir, 'backend.db');
writeFileSync(dbPath, Buffer.alloc(3_000_000));

function answers(map: Record<string, unknown>) {
  return (async (url: string) => {
    const found = map[url];
    if (found === undefined) throw new TypeError('fetch failed');
    if (typeof found === 'number') return new Response('no', { status: found });
    return new Response(JSON.stringify(found));
  }) as typeof fetch;
}

const base = {
  release: '2026.10.27.1',
  commit: '8cc9f94bb2cc02d9487bd5bd2e8392ca1efea9f3',
  startedAt: new Date('2026-10-27T15:00:00.000Z'),
  dbPath,
  dataDir: dir,
  backupEveryHours: 24,
  gitHealthUrl: 'https://theirco-git.fly.dev/health',
  routerHealthUrl: 'https://health-check.agents.theirco.test/__router/health',
  mailHealthUrl: 'http://theirco-mx.internal:8080/health',
  now: () => NOW,
};

describe('a copy\'s health (note #813)', () => {
  it('says how every part is doing, in words', async () => {
    const health = createCopyHealth({
      ...base,
      lastDbBackup: () => ({ at: '2026-10-27T15:10:00.000Z', ok: true }),
      env: {},
      fetchImpl: answers({
        [base.gitHealthUrl]: { ok: true, diskUsedPercent: 6 },
        [base.routerHealthUrl]: { ok: true, domain: 'agents.theirco.test' },
        [base.mailHealthUrl]: { ok: true, starttls: true },
      }),
    });
    const report = await health.report();
    expect(report.release).toBe('2026.10.27.1');
    expect(report.parts.map((part) => [part.key, part.ok, part.line])).toEqual([
      ['workspace', true, 'Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b)'],
      ['database', true, '3 MB · backed up 3 h ago · every 24 h'],
      ['disk', true, expect.stringMatching(/^\d+% of .+ used$/)],
      ['code-host', true, 'answering · disk 6% used'],
      ['previews', true, 'answering, certificate good'],
      ['mail-in', true, 'answering, encryption on'],
    ]);
  });

  it('flags what needs a look: a failed backup, a silent part, mail without a certificate', async () => {
    const health = createCopyHealth({
      ...base,
      lastDbBackup: () => ({ at: '2026-10-27T17:00:00.000Z', ok: false, detail: 'bucket refused the key' }),
      env: {},
      fetchImpl: answers({
        [base.gitHealthUrl]: 503,
        [base.mailHealthUrl]: { ok: true, starttls: false },
      }),
    });
    const parts = Object.fromEntries((await health.report()).parts.map((part) => [part.key, part]));
    expect(parts.database).toMatchObject({ ok: false, line: '3 MB · last backup failed 1 h ago: bucket refused the key' });
    expect(parts['code-host']).toMatchObject({ ok: false, line: 'not answering (answered 503)' });
    expect(parts.previews).toMatchObject({ ok: false, line: 'not answering (not reachable)' });
    expect(parts['mail-in']).toMatchObject({ ok: false, line: 'answering, but no certificate yet: mail arrives unencrypted' });
  });

  it('says plainly when backups are not set up, or overdue', async () => {
    const none = createCopyHealth({ ...base, env: {}, fetchImpl: answers({}) });
    expect((await none.report()).parts.find((part) => part.key === 'database')).toMatchObject({ ok: false, line: '3 MB · no backups: the backup bucket is not set up' });
    const old = createCopyHealth({ ...base, lastDbBackup: () => ({ at: '2026-10-24T18:00:00.000Z', ok: true }), env: {}, fetchImpl: answers({}) });
    expect((await old.report()).parts.find((part) => part.key === 'database')).toMatchObject({ ok: false, line: '3 MB · backed up 3 days ago · every 24 h' });
  });

  it('puts the licence first after the Workspace, and its usage in the bundle (note #814)', async () => {
    const health = createCopyHealth({
      ...base, env: {}, fetchImpl: answers({}),
      licence: async () => ({
        state: 'ending', overLimit: false, licence: { kind: 'licence', id: 'l1', customer: 'theirco', domain: 'agents.theirco.test', people: 50, starts: '2026-10-27', ends: '2027-10-26', updatesUntil: '2027-10-26', issuedAt: '' },
        people: 12, peakPeople: 14, daysLeft: 10, graceEnds: '2027-11-25', growthStopped: false, line: 'The licence ends in 10 days.', short: 'Ends in 10 days · 12 of 50 people',
      }),
    });
    const report = await health.report();
    expect(report.parts[1]).toEqual({ key: 'licence', name: 'Licence', ok: false, line: 'Ends in 10 days · 12 of 50 people' });
    expect((await health.diagnostics()).licence).toEqual({ id: 'l1', state: 'ending', licensedPeople: 50, people: 12, peakPeople: 14, ends: '2027-10-26' });
  });

  it('bundles the report and the settings, with keys only as set or not set', async () => {
    const env = {
      WORKSPACE_URL: 'https://agents.theirco.test',
      FLY_MACHINE_IMAGE: 'registry.fly.io/theirco-images:machine-2026.10.27.1',
      FLY_API_TOKEN: 'FlyV1 a-real-token-value',
      SECRETS_MASTER_KEY: 'bWFzdGVyLWtleS12YWx1ZQ==',
    };
    const health = createCopyHealth({ ...base, env, fetchImpl: answers({}) });
    const bundle = await health.diagnostics();
    expect(bundle.kind).toBe('acc-copy-diagnostics');
    expect(bundle.health.parts.length).toBe(6);
    expect(bundle.settings).toMatchObject({
      WORKSPACE_URL: 'https://agents.theirco.test',
      FLY_MACHINE_IMAGE: 'registry.fly.io/theirco-images:machine-2026.10.27.1',
      FLY_API_TOKEN: 'set',
      SECRETS_MASTER_KEY: 'set',
      RESEND_API_KEY: 'not set',
    });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('a-real-token-value');
    expect(text).not.toContain('bWFzdGVyLWtleS12YWx1ZQ==');
  });
});
