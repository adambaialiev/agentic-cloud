import { describe, expect, it } from 'vitest';
import {
  BackupStalenessMonitor,
  InMemoryBackupHeartbeatStore,
  createOpsNotifier,
} from '../../services/backup-monitor.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * This class exists to notice silence, which means every test here is about
 * something NOT happening. The failure mode it guards against is the one that
 * looks fine from the outside: backups stopped, nobody was told, and the first
 * anyone knows is when they reach for one.
 *
 * A clock is injected rather than faked globally so each case can state its
 * timeline in one place.
 */
function build(options: {
  jobs?: string[];
  staleAfterMs?: number;
  reAlertEveryMs?: number;
  start?: number;
} = {}) {
  let clock = options.start ?? Date.parse('2026-08-12T00:00:00Z');
  const sent: string[] = [];
  const store = new InMemoryBackupHeartbeatStore();
  const monitor = new BackupStalenessMonitor({
    store,
    jobs: options.jobs ?? ['git', 'db'],
    notify: (text) => { sent.push(text); },
    staleAfterMs: options.staleAfterMs ?? 48 * HOUR,
    ...(options.reAlertEveryMs !== undefined ? { reAlertEveryMs: options.reAlertEveryMs } : {}),
    now: () => new Date(clock),
  });
  return {
    monitor,
    store,
    sent,
    advance: (ms: number) => { clock += ms; },
    at: () => new Date(clock).toISOString(),
  };
}

describe('BackupStalenessMonitor', () => {
  it('says nothing while both jobs keep reporting', async () => {
    const h = build();

    for (let day = 0; day < 5; day += 1) {
      h.monitor.record('git', 'ok', '11 repos, 0 failures');
      h.monitor.record('db', 'ok', '14 tables · 124K uploaded');
      h.advance(DAY);
      await h.monitor.sweep();
    }

    expect(h.sent).toEqual([]);
  });

  it('alerts when a job goes quiet for 48h', async () => {
    const h = build();
    h.monitor.record('git', 'ok', '11 repos, 0 failures');
    h.monitor.record('db', 'ok', 'fine');

    // db keeps reporting; git stops dead.
    h.advance(DAY);
    h.monitor.record('db', 'ok', 'fine');
    await h.monitor.sweep();
    expect(h.sent).toEqual([]);

    h.advance(DAY + HOUR);
    h.monitor.record('db', 'ok', 'fine');
    await h.monitor.sweep();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/BACKUP STALE — git/);
    // Past two days the age reads in days: "49h" is arithmetic, "2d 1h" is
    // how long it has actually been since anything was backed up.
    expect(h.sent[0]).toMatch(/No successful run in 2d 1h/);
    expect(h.sent[0]).toMatch(/last: 2026-08-12T00:00:00\.000Z/);
  });

  it('does not treat a newly watched job as infinitely stale', async () => {
    const h = build();

    // Nothing has ever reported. A naive "no record = never backed up" would
    // fire on the very first sweep after deploy, which is how a monitor gets
    // muted in week one.
    await h.monitor.sweep();
    expect(h.sent).toEqual([]);

    h.advance(DAY);
    await h.monitor.sweep();
    expect(h.sent).toEqual([]);
  });

  it('still catches a job that never once worked', async () => {
    const h = build();
    await h.monitor.sweep();   // starts the clock

    h.advance(2 * DAY + HOUR);
    await h.monitor.sweep();

    // Both expected jobs are silent, so both get named.
    expect(h.sent).toHaveLength(2);
    expect(h.sent.join('\n')).toMatch(/Never reported a successful run/);
    expect(h.sent.join('\n')).toMatch(/never checked in at all/);
  });

  it('does not let a FAILED run pass for a backup', async () => {
    const h = build({ jobs: ['db'] });
    h.monitor.record('db', 'ok', 'good one');

    // The job keeps running and keeps failing. It shouts about each failure
    // itself — but the thing that matters here is that no BACKUP has happened,
    // and a failure must not reset that clock.
    for (let i = 0; i < 3; i += 1) {
      h.advance(DAY);
      h.monitor.record('db', 'fail', 'upload to the Storage Box failed');
    }
    await h.monitor.sweep();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/BACKUP STALE — db/);
    expect(h.sent[0]).toMatch(/last report was a FAILURE: upload to the Storage Box failed/);
  });

  it('repeats at most once a day while a job stays broken', async () => {
    const h = build({ jobs: ['db'] });
    h.monitor.record('db', 'ok', 'fine');
    h.advance(2 * DAY + HOUR);

    await h.monitor.sweep();
    expect(h.sent).toHaveLength(1);

    // Hourly sweeps for most of a day must not produce hourly alerts —
    // that is how an alert channel becomes something people mute.
    for (let i = 0; i < 20; i += 1) {
      h.advance(HOUR);
      await h.monitor.sweep();
    }
    expect(h.sent).toHaveLength(1);

    h.advance(5 * HOUR);
    await h.monitor.sweep();
    expect(h.sent).toHaveLength(2);
  });

  it('announces recovery so the alert closes itself out', async () => {
    const h = build({ jobs: ['git'] });
    h.monitor.record('git', 'ok', 'fine');
    h.advance(2 * DAY + HOUR);
    await h.monitor.sweep();
    expect(h.sent).toHaveLength(1);

    h.monitor.record('git', 'ok', '11 repos, 0 failures');
    await h.monitor.sweep();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatch(/backup recovered — git/);
  });

  it('alerts again if it breaks a second time', async () => {
    const h = build({ jobs: ['git'] });
    h.monitor.record('git', 'ok', 'fine');
    h.advance(2 * DAY + HOUR);
    await h.monitor.sweep();
    h.monitor.record('git', 'ok', 'back');
    await h.monitor.sweep();
    expect(h.sent).toHaveLength(2);

    // The rate limiter must not swallow a NEW episode just because it fired
    // recently for the previous one.
    h.advance(2 * DAY + HOUR);
    await h.monitor.sweep();

    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]).toMatch(/BACKUP STALE — git/);
  });

  it('remembers across a restart', async () => {
    const h = build({ jobs: ['db'] });
    h.monitor.record('db', 'ok', 'fine');
    h.advance(2 * DAY + HOUR);

    // A fresh monitor over the SAME store — what a deploy looks like. If state
    // were in memory this would reset the clock and never alert.
    const restarted = new BackupStalenessMonitor({
      store: h.store,
      jobs: ['db'],
      notify: (text) => { h.sent.push(text); },
      now: () => new Date(Date.parse(h.at())),
    });
    await restarted.sweep();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/BACKUP STALE — db/);
  });

  it('keeps sweeping when the notifier throws', async () => {
    const store = new InMemoryBackupHeartbeatStore();
    const clock = Date.parse('2026-08-12T00:00:00Z');
    let calls = 0;
    const monitor = new BackupStalenessMonitor({
      store,
      jobs: ['git', 'db'],
      notify: () => { calls += 1; throw new Error('Telegram is down'); },
      now: () => new Date(clock + 3 * DAY),
    });
    store.put({ job: 'git', watchingSince: new Date(clock).toISOString() });
    store.put({ job: 'db', watchingSince: new Date(clock).toISOString() });

    // A dead notifier is not a reason to stop checking the second job, nor to
    // take the interval timer down with it.
    await expect(monitor.sweep()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe('createOpsNotifier', () => {
  it('posts the alert to the ops bot', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const notify = createOpsNotifier({
      botToken: 'bot-token',
      chatId: '10000001',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });

    await notify('🔴 BACKUP STALE — git');

    expect(calls[0]?.url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(calls[0]?.body).toMatchObject({ chat_id: '10000001', text: '🔴 BACKUP STALE — git' });
  });

  it('never throws, whatever Telegram does', async () => {
    const rejecting = createOpsNotifier({
      botToken: 't', chatId: 'c',
      fetchImpl: (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch,
    });
    const refusing = createOpsNotifier({
      botToken: 't', chatId: 'c',
      fetchImpl: (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch,
    });

    // An undeliverable alert must not become a second outage.
    await expect(rejecting('x')).resolves.toBeUndefined();
    await expect(refusing('x')).resolves.toBeUndefined();
  });
});
