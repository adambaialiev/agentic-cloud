import { describe, expect, it } from 'vitest';
import { createCopyUpgrade, runView, stepLabel, type UpgradeBucket } from '../../services/copy-upgrade.js';
import type { FlyMachine } from '../../services/fly-client.js';

/**
 * The Upgrade button's backend (note #1008): it reads the upgrader's run
 * record back from the bucket, refuses in words while an upgrade may not
 * start, and otherwise copies the upgrader image in and starts the machine.
 */
const NOW = new Date('2026-11-10T15:05:00Z');
const ev = (title: string, status: 'running' | 'done', seconds?: number) => ({ event: 'step', title, status, ...(seconds ? { seconds } : {}) });

function bucket(objects: Record<string, unknown> = {}): UpgradeBucket & { objects: Record<string, string> } {
  const store: Record<string, string> = Object.fromEntries(Object.entries(objects).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { objects: store, getText: async (key) => store[key] ?? null, putText: async (key, text) => { store[key] = text; } };
}

function service(over: Partial<Parameters<typeof createCopyUpgrade>[0]> = {}, machines: Record<string, Partial<FlyMachine>[]> = {}) {
  const created: Array<{ app: string; args: Record<string, unknown> }> = [];
  const copied: string[] = [];
  const b = bucket();
  const upgrade = createCopyUpgrade({
    prefix: 'theirco', region: 'fra', token: 'FlyV1 org', updatesUrl: 'https://acc-updates.test', bucket: b,
    fly: {
      listMachines: async (app: string) => (machines[app] ?? []) as FlyMachine[],
      createMachine: async (app: string, args: Record<string, unknown>) => { created.push({ app, args }); return { id: 'up1' } as FlyMachine; },
    } as never,
    releases: async () => ({ running: '2026.11.01.1', latest: '2026.11.10.0', latestDate: '2026-11-10' }),
    upgraderReady: () => true,
    signInOpenSince: () => null,
    agentsWorking: () => 3,
    rollMx: false,
    installer: async () => ({
      updatesSource: () => ({ release: async (version: string) => ({ version, images: { upgrader: { tag: `upgrader-${version}` } } }) }),
      flyRegistry: () => ({}),
      copyImage: async (_s: unknown, _d: unknown, tag: string) => { copied.push(tag); },
    }),
    now: () => NOW,
    log: () => {},
    ...over,
  });
  return { upgrade, created, copied, bucket: b };
}

describe('the run as the admin reads it (note #1008)', () => {
  it('names each step in plain words', () => {
    expect(stepLabel('Copying release 2026.11.10.0 into registry.fly.io/theirco-images', 'theirco').label).toBe('Release copied into your registry');
    expect(stepLabel('theirco-backend to 2026.11.10.0', 'theirco').label).toBe('Workspace → 2026.11.10.0');
    expect(stepLabel('theirco-backend to 2026.11.10.0 (made not to start, for the drill)', 'theirco').label).toBe('Workspace → 2026.11.10.0 (made not to start)');
    expect(stepLabel('theirco-git back to 2026.11.01.1', 'theirco')).toEqual({ key: 'back-theirco-git', label: 'Code host back to 2026.11.01.1', back: true });
    expect(stepLabel('database back to the snapshot', 'theirco', '2026-11-10T15:02:50Z').label).toBe('Database back to 15:02 UTC');
  });

  it('while going forward: what is done, what runs, and what is still to come', () => {
    const view = runView(
      { id: 'r1', requestedBy: 'Dana Rivera', toVersion: '2026.11.10.0', startedAt: '2026-11-10T15:02:00Z', upgrade: { from: { version: '2026.11.01.1' } } },
      [ev('Copying release 2026.11.10.0 into registry.fly.io/theirco-images', 'running'), ev('Copying release 2026.11.10.0 into registry.fly.io/theirco-images', 'done', 41), ev('Snapshotting the database', 'done', 9), ev('theirco-backend to 2026.11.10.0', 'running')],
      '2026-11-10T15:04:55Z', 'theirco', NOW, true,
    );
    expect(view.phase).toBe('running');
    expect(view.heardSecondsAgo).toBe(5);
    expect(view.steps.map((s) => `${s.label}:${s.state}`)).toEqual([
      'Release copied into your registry:done', 'Database backed up, disks snapshotted:done',
      'Workspace → 2026.11.10.0:now', 'Code host → 2026.11.10.0:wait', 'Previews and sites → 2026.11.10.0:wait', 'Final check:wait',
    ]);
  });

  it('when a step failed: that step is marked, and the way back follows it', () => {
    const view = runView(
      { id: 'r1', toVersion: '2026.11.10.0', outcome: 'put-back', message: 'The upgrade to 2026.11.10.0 failed', upgrade: null, shape: { release: { version: '2026.11.01.1' } } },
      [ev('theirco-backend to 2026.11.10.0', 'done', 58), ev('theirco-git to 2026.11.10.0', 'running'), ev('theirco-backend back to 2026.11.01.1', 'done', 52), ev('database back to the snapshot', 'done', 9)],
      '2026-11-10T15:04:55Z', 'theirco', NOW, false,
    );
    expect(view.phase).toBe('put-back');
    expect(view.from).toBe('2026.11.01.1');
    expect(view.steps.map((s) => s.state)).toEqual(['done', 'fail', 'done', 'done']);
  });

  it('a run nobody has heard from for two minutes has stopped part-way', () => {
    const view = runView({ id: 'r1', toVersion: '2026.11.10.0' }, [ev('Snapshotting the database', 'done', 9)], '2026-11-10T15:02:00Z', 'theirco', NOW, true);
    expect(view.phase).toBe('stopped');
  });
});

describe('starting an upgrade (note #1008)', () => {
  it('offers the newest release, with how many agents are working', async () => {
    const { upgrade } = service();
    const state = await upgrade.state();
    expect(state.offer).toEqual({ version: '2026.11.10.0', date: '2026-11-10', agentsWorking: 3, minutes: 3 });
    expect(state.refusal).toBeNull();
  });

  it('copies the upgrader image in, records who asked, and starts the one-shot machine with no key in its env', async () => {
    const { upgrade, created, copied, bucket: b } = service();
    const started = await upgrade.start({ version: '2026.11.10.0', by: 'Dana Rivera' });
    expect(copied).toEqual(['upgrader-2026.11.10.0']);
    expect(created).toHaveLength(1);
    expect(created[0]!.app).toBe('theirco-upgrader');
    expect(created[0]!.args).toMatchObject({
      region: 'fra', image: 'registry.fly.io/theirco-images:upgrader-2026.11.10.0', autoDestroy: true, restart: { policy: 'on-failure' },
      env: { ACC_PREFIX: 'theirco', ACC_RUN_ID: started.id, ACC_RELEASE: '2026.11.10.0', ACC_REQUESTED_BY: 'Dana Rivera', ACC_UPDATES_URL: 'https://acc-updates.test', ACC_DRILL: '', ACC_MX: 'keep' },
    });
    expect(JSON.stringify(created[0]!.args)).not.toContain('FlyV1');
    expect(JSON.parse(b.objects['upgrades/last-started.json']!)).toMatchObject({ id: started.id, by: 'Dana Rivera', version: '2026.11.10.0' });
    // Read back before the upgrader has written: it is starting.
    expect((await upgrade.state()).run?.phase).toBe('starting');
  });

  it('starts only the newest release; a drill may also name the running one', async () => {
    const { upgrade } = service();
    await expect(upgrade.start({ version: '2026.10.29.0', by: 'Dana' })).rejects.toThrow('Release 2026.10.29.0 is not the one to upgrade to here: the newest is 2026.11.10.0.');
    await expect(upgrade.start({ version: '2026.11.01.1', drill: 'rollback', by: 'Dana' })).resolves.toMatchObject({ machine: 'up1' });
  });

  it('refuses in words: a run open, a machine mid-deploy, a Claude sign-in, no upgrader, no bucket', async () => {
    const open = service({}, { 'theirco-upgrader': [{ id: 'm', state: 'started', name: 'upgrader' }] });
    expect((await open.upgrade.state()).refusal).toBe('An upgrade is already running (started from the command line).');
    await expect(open.upgrade.start({ version: '2026.11.10.0', by: 'Dana' })).rejects.toThrow('An upgrade is already running');
    expect(open.created).toEqual([]);

    const staleLock = service({}, { 'theirco-upgrader': [{ id: 'm', state: 'created', name: 'here-lock-1', created_at: '2026-11-10T10:00:00Z' } as Partial<FlyMachine>] });
    expect((await staleLock.upgrade.state()).refusal).toBeNull();

    const deploying = service({}, { 'theirco-git': [{ id: 'g', state: 'replacing' }] });
    expect((await deploying.upgrade.state()).refusal).toBe('The code host is being changed right now (replacing). Try again in a few minutes.');

    const signingIn = service({ signInOpenSince: () => NOW.getTime() - 5 * 60_000 });
    expect((await signingIn.upgrade.state()).refusal).toContain('Someone is signing in to Claude');
    expect((await signingIn.upgrade.state()).refusal).toContain('Try again in 10 min.');

    expect((await service({ upgraderReady: () => false }).upgrade.state()).refusal).toContain('Your engineer runs node install.mjs upgrade once');
    expect((await service({ bucket: null }).upgrade.state()).refusal).toContain('no backup bucket');
  });

  it('refuses a release with no upgrader image, in words', async () => {
    const { upgrade, created } = service({
      installer: async () => ({ updatesSource: () => ({ release: async (version: string) => ({ version, images: {} }) }), flyRegistry: () => ({}), copyImage: async () => {} }),
    });
    await expect(upgrade.start({ version: '2026.11.10.0', by: 'Dana' })).rejects.toThrow('it has no upgrader. Your engineer runs node install.mjs upgrade once.');
    expect(created).toEqual([]);
  });

  it('carries on a stopped run with a new upgrader for the same run', async () => {
    const { upgrade, created, bucket: b } = service();
    b.objects['upgrades/current.json'] = JSON.stringify({ id: 'r9' });
    b.objects['upgrades/r9/run.json'] = JSON.stringify({ id: 'r9', toVersion: '2026.11.10.0' });
    b.objects['upgrades/r9/heartbeat.json'] = JSON.stringify({ at: '2026-11-10T14:50:00Z' });
    expect((await upgrade.state()).run?.phase).toBe('stopped');
    await upgrade.carryOn('Dana');
    expect(created[0]!.args).toMatchObject({ image: 'registry.fly.io/theirco-images:upgrader-2026.11.10.0', env: { ACC_RUN_ID: 'r9' } });
  });
});
