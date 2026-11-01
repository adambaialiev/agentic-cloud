import { describe, expect, it, vi } from 'vitest';
import { OrgSpendError, OrgSpendService } from '../../services/org-spend.js';
import { estimateGuestHourlyUsd, estimateGuestMonthlyUsd, estimateVolumeMonthlyUsd } from '../../config/fly-cost-estimates.js';

describe('fly cost estimates', () => {
  it('prices the shapes the fleet actually runs', () => {
    // performance-4x 8GB: 4 cores, RAM within the included 2GB/core.
    expect(estimateGuestMonthlyUsd({ cpu_kind: 'performance', cpus: 4, memory_mb: 8192 })).toBe(124);
    expect(estimateGuestHourlyUsd({ cpu_kind: 'performance', cpus: 4, memory_mb: 8192 })).toBe(0.1722);
    // shared-1x 256MB: the static-site machine.
    expect(estimateGuestMonthlyUsd({ cpu_kind: 'shared', cpus: 1, memory_mb: 256 })).toBe(1.94);
    // shared-1x 1GB: service-pro — 0.75GB beyond the included 0.25.
    expect(estimateGuestMonthlyUsd({ cpu_kind: 'shared', cpus: 1, memory_mb: 1024 })).toBe(5.69);
    expect(estimateVolumeMonthlyUsd(5)).toBe(0.75);
  });
});

describe('OrgSpendService', () => {
  it('reports every machine with running/stopped estimates and honest totals', async () => {
    const fly = {
      listApps: vi.fn().mockResolvedValue([
        { name: 'ia-agent00000001' },
        { name: 'iapp-site0000001' },
        { name: 'clients-own-app' },
        { name: 'ia-machine-images' },
        { name: 'ia-ci-jobs' },
      ]),
      listMachines: vi.fn(async (app: string) => {
        if (app === 'ia-agent00000001') {
          return [{ id: 'abc1', state: 'stopped', config: { guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } } }];
        }
        if (app === 'iapp-site0000001') {
          // Up since 7 August: Fly's newest `start` event is where its awake time counts from.
          return [{
            id: 'm2', state: 'started', created_at: '2026-08-07T08:29:16Z',
            events: [{ type: 'start', status: 'started', timestamp: Date.parse('2026-08-07T08:29:26Z') }, { type: 'launch', status: 'created', timestamp: Date.parse('2026-08-07T08:29:16Z') }],
            config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 } },
          }];
        }
        if (app === 'ia-ci-jobs') {
          return [{ id: 'j1', state: 'started', config: { guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } } }];
        }
        return [];
      }),
      listVolumes: vi.fn(async (app: string) => (app === 'ia-agent00000001'
        ? [{ id: 'v1', size_gb: 5 }]
        : app === 'iapp-site0000001' ? [{ id: 'v2', size_gb: 1 }] : [])),
    };
    const perf4 = { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 };
    const shared2 = { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 };
    const listRuns = vi.fn().mockResolvedValue([
      // Six minutes on the shape it recorded.
      { repoId: 'repo-a', sha: 'a'.repeat(40), context: 'ci/checks', state: 'success', startedAt: '2026-09-02T10:00:00Z', completedAt: '2026-09-02T10:06:00Z', machine: { cpuKind: 'performance', cpus: 4, memoryMb: 8192 } },
      // Three minutes on a smaller shape — priced at ITS shape, not the lane's.
      { repoId: 'repo-b', sha: 'b'.repeat(40), context: 'ci/checks', state: 'failure', startedAt: '2026-09-02T11:00:00Z', completedAt: '2026-09-02T11:03:00Z', machine: { cpuKind: 'shared', cpus: 2, memoryMb: 2048 } },
      // Filed before shapes travelled: priced at the machine up now.
      { repoId: 'repo-a', sha: 'c'.repeat(40), context: 'ci/checks', state: 'success', startedAt: '2026-09-01T09:00:00Z', completedAt: '2026-09-01T09:12:00Z' },
      // Still running: counted up to now (one minute so far).
      { repoId: 'repo-a', sha: 'd'.repeat(40), context: 'ci/checks', state: 'pending', startedAt: '2026-09-03T09:59:00Z' },
      // A deploy runs on the runner host, not on a lane machine: not the lane's money.
      { repoId: 'repo-a', sha: 'a'.repeat(40), context: 'deploy/prod', state: 'success', startedAt: '2026-09-02T10:07:00Z', completedAt: '2026-09-02T10:10:00Z' },
    ]);
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_x' }) },
      userStorage: {
        getAllUsers: vi.fn().mockResolvedValue([{
          telegram: { agents: { a1: {
            id: 'a1', name: 'Ada', cli: 'codex', serverId: 'fly_ia-agent00000001.abc1',
            machineRuntimeMs: { '2026-09': 10 * 3_600_000 },
          } } },
        }]),
      } as never,
      // The org's repositories, at its own namespace and its old rooms' (the
      // first room adopted the base; note #843); and this month's check runs.
      orgStorage: {
        getOrg: vi.fn().mockResolvedValue({
          orgId: 'org-1', createdByUserId: 'user-1', git: { namespaceId: 'ns-base' },
          roomsMerged: { mergedAt: '2026-08-30T00:00:00Z', namespaces: ['ns-base', 'ns-room2'] },
        }),
      } as never,
      gitRepoStorage: {
        listByUser: vi.fn(async (ns: string) => (ns === 'ns-base' ? [{ id: 'repo-a' }] : ns === 'ns-room2' ? [{ id: 'repo-b' }] : [])),
      } as never,
      gitCommitStatusStorage: { listByReposSince: listRuns } as never,
      makeFlyClient: () => fly as never,
      now: () => new Date('2026-09-03T10:00:00Z'),
    });

    const report = await service.report('org-1');

    // Repos were found through BOTH namespaces, and only this month was read.
    expect(listRuns).toHaveBeenCalledWith(['repo-a', 'repo-b'], '2026-09-01T00:00:00.000Z');

    expect(report.orgSlug).toBe('acme-agents');
    // The image registry app is skipped; the client's own app is walked and
    // labelled — the bill-payer's view must not hide what bills them.
    expect(fly.listMachines).not.toHaveBeenCalledWith('ia-machine-images');
    expect(report.machines).toHaveLength(3);
    // The CI lane wears the agent prefix but is nobody's agent (note #319):
    // its row is the month's check runs, each priced for its own length at
    // the shape that ran it — a fact, where "$124/mo if left on" was not.
    const check = report.machines.find((m) => m.app === 'ia-ci-jobs')!;
    expect(check.kind).toBe('ci');
    expect(check.agent).toBeUndefined();
    expect(check.state).toBe('started');
    expect(check.machineId).toBe('j1');
    expect(check.runs).toBe(4);
    expect(check.activeMs).toBe((6 + 3 + 12 + 1) * 60_000);
    const h = (minutes: number) => minutes / 60;
    const expectedCi = h(6) * estimateGuestHourlyUsd(perf4) + h(3) * estimateGuestHourlyUsd(shared2)
      + h(12) * estimateGuestHourlyUsd(perf4) + h(1) * estimateGuestHourlyUsd(perf4);
    expect(check.totalMonthlyUsd).toBeCloseTo(expectedCi, 2);
    // The lane's share of "at current usage" is its month so far, not a
    // machine that never stays running all month.
    expect(check.estimatedMonthlyUsd).toBe(check.totalMonthlyUsd);
    expect(check.runningMonthlyUsd).toBe(124);
    const agent = report.machines.find((m) => m.kind === 'agent')!;
    // Asleep: volume only. Running column shows the ceiling.
    expect(agent.estimatedMonthlyUsd).toBe(0.75);
    expect(agent.runningMonthlyUsd).toBe(124.75);
    expect(agent.hourlyUsd).toBe(0.1722);
    expect(agent.agent).toEqual({ id: 'a1', name: 'Ada' });
    expect(agent.activeMs).toBe(10 * 3_600_000);
    expect(agent.totalMonthlyUsd).toBe(2.47);
    const site = report.machines.find((m) => m.kind === 'site')!;
    expect(site.estimatedMonthlyUsd).toBe(2.09);
    // Up since 7 August, so this month it has been awake since the 1st:
    // 2 days 10 hours at the hourly rate, plus its volume.
    expect(site.awakeSince).toBe('2026-08-07T08:29:26.000Z');
    expect(site.activeMs).toBe(58 * 3_600_000);
    expect(site.totalMonthlyUsd).toBeCloseTo(58 * estimateGuestHourlyUsd({ cpu_kind: 'shared', cpus: 1, memory_mb: 256 }) + estimateVolumeMonthlyUsd(1), 2);
    expect(report.totals).toEqual({
      estimatedMonthlyUsd: Math.round((0.75 + 2.09 + check.totalMonthlyUsd!) * 100) / 100,
      runningMonthlyUsd: 250.84,
      // The month so far is the rows' own figures added up and nothing else
      // (note #342). Every machine in this account states a fact, so the sum
      // covers the whole list.
      spentThisMonthUsd: Math.round((agent.totalMonthlyUsd! + site.totalMonthlyUsd! + check.totalMonthlyUsd!) * 100) / 100,
      unmeasured: 0,
      running: 2,
      stopped: 1,
    });
    expect(report.disclaimer).toMatch(/estimate/i);
  });

  /**
   * The rule the total at the top lives by: it adds up FACTS. A machine
   * nothing meters — no agent record, and not a site Fly can date — carries
   * only a projection, and a RUNNING one projects a whole month of compute.
   * Letting that into the sum would put back the very number the owner had
   * taken off the top of the screen, so it is counted as unmeasured instead
   * and its own row keeps saying what a month would cost (note #342).
   */
  it("a private copy reads the copy's own account for a workplace with no cloud of its own (note #804)", async () => {
    const resolveOrgFlyContext = vi.fn().mockRejectedValue(new Error('org has no Fly org connected'));
    const resolveHostingContext = vi.fn().mockResolvedValue({ source: 'platform', orgSlug: 'theirco-fly', apiToken: 'their' });
    const listApps = vi.fn().mockResolvedValue([{ name: 'copy-backend' }]);
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext, resolveHostingContext },
      privateCopy: true,
      makeFlyClient: () => ({
        listApps,
        listMachines: vi.fn().mockResolvedValue([{ id: 'm1', state: 'started', config: { guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 } } }]),
        listVolumes: vi.fn().mockResolvedValue([]),
        deleteMachine: vi.fn(), deleteVolume: vi.fn(), deleteApp: vi.fn(),
      }) as never,
    });
    const report = await service.report('org-1');
    expect(resolveHostingContext).toHaveBeenCalledWith('org-1');
    expect(resolveOrgFlyContext).not.toHaveBeenCalled();
    expect(listApps.mock.calls[0][0]).toBe('theirco-fly');
    expect(report.machines.map((row) => row.app)).toEqual(['copy-backend']);
  });

  it('leaves a machine nothing meters out of the month’s total, and says how many', async () => {
    const perf4 = { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 };
    const fly = {
      listApps: vi.fn().mockResolvedValue([{ name: 'ia-agent00000001' }, { name: 'ia-agent00000002' }]),
      listMachines: vi.fn(async (app: string) => [{
        id: app === 'ia-agent00000001' ? 'abc1' : 'abc2',
        state: 'started',
        config: { guest: perf4 },
      }]),
      listVolumes: vi.fn(async () => []),
    };
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_x' }) },
      userStorage: {
        getAllUsers: vi.fn().mockResolvedValue([{
          telegram: { agents: { a1: {
            id: 'a1', name: 'Ada', cli: 'codex', serverId: 'fly_ia-agent00000001.abc1',
            machineRuntimeMs: { '2026-09': 10 * 3_600_000 },
          } } },
        }]),
      } as never,
      makeFlyClient: () => fly as never,
      now: () => new Date('2026-09-03T10:00:00Z'),
    });

    const report = await service.report('org-1');

    const metered = report.machines.find((m) => m.agent)!;
    const stray = report.machines.find((m) => !m.agent)!;
    expect(metered.totalMonthlyUsd).toBe(1.72);
    expect(stray.totalMonthlyUsd).toBeUndefined();
    // The projection stays the biggest number on the screen and stays on its
    // own row: the sum at the top is what has been spent, not what might be.
    expect(stray.estimatedMonthlyUsd).toBe(124);
    expect(report.totals.spentThisMonthUsd).toBe(1.72);
    expect(report.totals.unmeasured).toBe(1);
  });

  /**
   * A machine can be real, running and billed before any record names it: the
   * app is stamped on the agent (`provisioningAppName`) BEFORE it is created,
   * and `serverId` is written only once the machine is up. In that window the
   * row was indistinguishable from a machine nobody owns — which the screen
   * now calls a leftover (note #375), so leaving it unattributed would label
   * a machine being born as the one thing it is not.
   *
   * It is named and NOT metered: the agent's awake time belongs to whatever
   * machine it actually ran on, and spending it here as well would count the
   * same minutes twice in the month's total.
   */
  it('names a machine its agent’s setup has not finished claiming, and meters it to nobody', async () => {
    const perf1 = { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 };
    const fly = {
      listApps: vi.fn().mockResolvedValue([
        { name: 'ia-agent00000001' },
        { name: 'ia-agent00000002' },
        { name: 'ia-agent00000003' },
      ]),
      // Machine ids are hex, which is what `serverId` is parsed against.
      listMachines: vi.fn(async (app: string) => [{
        id: `abc${app.slice(-1)}`,
        state: 'started',
        config: { guest: perf1 },
      }]),
      listVolumes: vi.fn(async () => []),
    };
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_x' }) },
      userStorage: {
        getAllUsers: vi.fn().mockResolvedValue([{
          telegram: { agents: {
            a1: {
              id: 'a1', name: 'Ada', cli: 'codex', serverId: 'fly_ia-agent00000001.abc1',
              machineRuntimeMs: { '2026-09': 10 * 3_600_000 },
            },
            // Mid-setup: the app is on the record, the machine is not yet.
            a2: {
              id: 'a2', name: 'Bo', cli: 'claude', provisioningAppName: 'ia-agent00000002',
              machineRuntimeMs: { '2026-09': 4 * 3_600_000 },
            },
          } },
        }]),
      } as never,
      makeFlyClient: () => fly as never,
      now: () => new Date('2026-09-03T10:00:00Z'),
    });

    const report = await service.report('org-1');

    const settled = report.machines.find((m) => m.app === 'ia-agent00000001')!;
    expect(settled.agent).toEqual({ id: 'a1', name: 'Ada' });
    expect(settled.settingUp).toBeUndefined();
    expect(settled.totalMonthlyUsd).toBe(0.43);

    // Named for the agent whose setup made it — and carrying no month of its
    // own, so Bo's four hours are counted once, on Bo's real machine.
    const born = report.machines.find((m) => m.app === 'ia-agent00000002')!;
    expect(born.agent).toEqual({ id: 'a2', name: 'Bo' });
    expect(born.settingUp).toBe(true);
    expect(born.activeMs).toBeUndefined();
    expect(born.totalMonthlyUsd).toBeUndefined();

    // The third app is what a leftover actually is: no record names it at all.
    const leftover = report.machines.find((m) => m.app === 'ia-agent00000003')!;
    expect(leftover.agent).toBeUndefined();
    expect(leftover.settingUp).toBeUndefined();

    // Only the metered row is in the month; the other two say so as unmeasured.
    expect(report.totals.spentThisMonthUsd).toBe(0.43);
    expect(report.totals.unmeasured).toBe(2);
  });

  /**
   * One Fly account can hold two workplaces' machines — two workplaces that
   * connected the same account, or a site that moved to another workplace and
   * kept its app where it was built (note #635). What a record gives to the
   * OTHER workplace is counted and not listed: not its agents' names, not the
   * people they work for, and not in this workplace's totals. What no record
   * attributes at all has nobody else to belong to, and stays listed.
   */
  describe('machines of another workplace in the same account', () => {
    const here = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    const other = '11111111-2222-3333-4444-555555555555';
    const perf1 = { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 };
    const fly = () => ({
      listApps: vi.fn().mockResolvedValue([
        { name: 'ia-agent00000001' }, // Ada, this workplace's
        { name: 'ia-agent00000002' }, // Hazel, the other workplace's
        { name: 'ia-agent00000003' }, // the other workplace's agent, mid-setup
        { name: 'ia-agent00000004' }, // nobody's: a leftover
        { name: 'ia-agent00000005' }, // a record from before workplaces
        { name: 'iapp-site0000001' }, // this workplace's site
        { name: 'iapp-site0000002' }, // moved to the other workplace, app left here
        { name: 'iapp-site0000003' }, // a site app no record names
        { name: 'iamsg-0f1e2d3c4b5a' },
        { name: 'iamsg-111111112222' },
        // The other workplace's lane comes FIRST, where it used to be handed
        // this workplace's check runs.
        { name: 'iaci-111111112222' },
        { name: 'iaci-0f1e2d3c4b5a' },
        { name: 'iagit-111111112222' }, // volumes and no machine
      ]),
      listMachines: vi.fn(async (app: string) => (app.startsWith('iagit-')
        ? []
        : [{ id: `abc${app.slice(-1)}`, state: 'started', config: { guest: perf1 } }])),
      listVolumes: vi.fn(async (app: string) => (app.startsWith('iagit-') ? [{ id: 'vg', size_gb: 10 }] : [])),
    });
    const users = [{
      firstName: 'Saddam',
      telegram: { agents: {
        a1: { id: 'a1', name: 'Ada', cli: 'claude', orgId: here, serverId: 'fly_ia-agent00000001.abc1', machineRuntimeMs: { '2026-09': 3_600_000 } },
        a5: { id: 'a5', name: 'Old', cli: 'claude', serverId: 'fly_ia-agent00000005.abc5' },
      } },
    }, {
      firstName: 'Mia',
      telegram: { agents: {
        h1: { id: 'h1', name: 'Hazel', cli: 'claude', orgId: other, serverId: 'fly_ia-agent00000002.abc2', machineRuntimeMs: { '2026-09': 9 * 3_600_000 } },
        h2: { id: 'h2', name: 'Iris', cli: 'claude', orgId: other, provisioningAppName: 'ia-agent00000003' },
      } },
    }];
    const sites = [
      { id: 's1', orgId: here, flyApp: 'iapp-site0000001', status: 'live' },
      { id: 's2', orgId: other, flyOrgId: here, flyApp: 'iapp-site0000002', status: 'live' },
    ];
    const run = { repoId: 'repo-a', sha: 'a'.repeat(40), context: 'ci/checks', state: 'success', startedAt: '2026-09-02T10:00:00Z', completedAt: '2026-09-02T10:06:00Z' };
    const serviceWith = (client: ReturnType<typeof fly>, listAll: () => Promise<unknown[]>) => new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-trading', apiToken: 'fo1_x' }) },
      userStorage: { getAllUsers: vi.fn().mockResolvedValue(users) } as never,
      orgStorage: {
        getOrg: vi.fn().mockResolvedValue({ orgId: here, createdByUserId: 'u1', git: { namespaceId: 'ns-base' } }),
      } as never,
      gitRepoStorage: { listByUser: vi.fn(async () => [{ id: 'repo-a' }]) } as never,
      gitCommitStatusStorage: { listByReposSince: vi.fn().mockResolvedValue([run]) } as never,
      deploymentStorage: { listAll: vi.fn(listAll) } as never,
      makeFlyClient: () => client as never,
      now: () => new Date('2026-09-03T10:00:00Z'),
    });

    it('counts them without listing them, and leaves them out of every total', async () => {
      const report = await serviceWith(fly(), async () => sites).report(here);

      expect(report.machines.map((m) => m.app).sort()).toEqual([
        'ia-agent00000001', 'ia-agent00000004', 'ia-agent00000005',
        'iaci-0f1e2d3c4b5a', 'iamsg-0f1e2d3c4b5a', 'iapp-site0000001', 'iapp-site0000003',
      ]);
      // Hazel, Iris's machine being born, the moved site, the other
      // workplace's mail host, its lane and its volume-only git host.
      expect(report.machinesElsewhere).toBe(6);
      // Nothing of theirs rides the answer, not even the names.
      expect(JSON.stringify(report)).not.toMatch(/Hazel|Iris|Mia|111111112222|site0000002/);
      // Every figure is this workplace's rows and nothing else: Hazel's nine
      // hours are not in the month, and her running machine is not counted.
      expect(report.totals.running).toBe(7);
      const ada = report.machines.find((m) => m.app === 'ia-agent00000001')!;
      const lane = report.machines.find((m) => m.kind === 'ci')!;
      expect(report.totals.spentThisMonthUsd).toBe(Math.round((ada.totalMonthlyUsd! + lane.totalMonthlyUsd!) * 100) / 100);
      // This workplace's own lane has its runs, although the other's came first.
      expect(lane.runs).toBe(1);
    });

    it('lists a site it cannot place when the site records cannot be read', async () => {
      const report = await serviceWith(fly(), async () => { throw new Error('db down'); }).report(here);

      // The moved site is listed again, as it was before this could be told;
      // the agents and the named apps are still placed by their own records.
      expect(report.machines.some((m) => m.app === 'iapp-site0000002')).toBe(true);
      expect(report.machinesElsewhere).toBe(5);
    });
  });

  /**
   * Removing a machine nobody is on (note #375) — the button the Cloud screen
   * grew once it could say what a leftover is.
   *
   * The gates are the test: what is destroyed here is a real machine and a
   * real disk, and the only thing standing between the right app and an
   * agent's own is this walk. Each refusal below is a way the wrong app could
   * be named — by a caller, by a stale screen, or by a records read that came
   * back empty because it failed.
   */
  describe('removing a leftover machine', () => {
    const perf4 = { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 };
    const flyStub = () => ({
      listApps: vi.fn().mockResolvedValue([{ name: 'ia-agent00000001' }, { name: 'ia-agent00000002' }, { name: 'ia-ci-jobs' }]),
      listMachines: vi.fn(async () => [{ id: 'abc2', state: 'stopped', config: { guest: perf4 } }]),
      listVolumes: vi.fn(async () => [{ id: 'vol2', size_gb: 5 }]),
      deleteMachine: vi.fn(async () => {}),
      deleteVolume: vi.fn(async () => {}),
      deleteApp: vi.fn(async () => {}),
    });
    const serviceWith = (fly: ReturnType<typeof flyStub>, getAllUsers: () => Promise<unknown[]>) => new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_x' }) },
      userStorage: { getAllUsers: vi.fn(getAllUsers) } as never,
      makeFlyClient: () => fly as never,
      now: () => new Date('2026-09-03T10:00:00Z'),
    });
    const ada = [{
      telegram: { agents: { a1: { id: 'a1', name: 'Ada', cli: 'codex', serverId: 'fly_ia-agent00000001.abc1' } } },
    }];

    it('destroys the machine, its volume and its app — in that order', async () => {
      const fly = flyStub();
      const removed = await serviceWith(fly, async () => ada).removeLeftoverMachine('org-1', 'ia-agent00000002');

      expect(removed).toEqual({ app: 'ia-agent00000002', machines: 1 });
      expect(fly.deleteMachine).toHaveBeenCalledWith('ia-agent00000002', 'abc2', { force: true });
      // The volume is what keeps billing after the machine is gone, and the
      // app cannot be dropped until nothing is in it.
      expect(fly.deleteVolume).toHaveBeenCalledWith('ia-agent00000002', 'vol2');
      expect(fly.deleteApp).toHaveBeenCalledWith('ia-agent00000002');
      expect(fly.deleteMachine.mock.invocationCallOrder[0]!)
        .toBeLessThan(fly.deleteApp.mock.invocationCallOrder[0]!);
    });

    it('refuses an app an agent is on, by its record or by a setup in flight', async () => {
      const fly = flyStub();
      await expect(serviceWith(fly, async () => ada).removeLeftoverMachine('org-1', 'ia-agent00000001'))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining('Ada') });
      const setup = [{ telegram: { agents: { a2: { id: 'a2', name: 'Bo', provisioningAppName: 'ia-agent00000002' } } } }];
      await expect(serviceWith(fly, async () => setup).removeLeftoverMachine('org-1', 'ia-agent00000002'))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining('Bo') });
      expect(fly.deleteMachine).not.toHaveBeenCalled();
      expect(fly.deleteApp).not.toHaveBeenCalled();
    });

    it('refuses an app this workplace’s account does not hold', async () => {
      const fly = flyStub();
      await expect(serviceWith(fly, async () => ada).removeLeftoverMachine('org-1', 'ia-somebody-elses'))
        .rejects.toMatchObject({ status: 404 });
      expect(fly.deleteApp).not.toHaveBeenCalled();
    });

    it('refuses anything that is not an agent machine’s app', async () => {
      const fly = flyStub();
      const service = serviceWith(fly, async () => ada);
      // The check lane wears the agent prefix and is not an agent's (note #319).
      await expect(service.removeLeftoverMachine('org-1', 'ia-ci-jobs')).rejects.toMatchObject({ status: 400 });
      await expect(service.removeLeftoverMachine('org-1', 'iapp-site0000001')).rejects.toMatchObject({ status: 400 });
      await expect(service.removeLeftoverMachine('org-1', '')).rejects.toBeInstanceOf(OrgSpendError);
      expect(fly.listApps).not.toHaveBeenCalled();
      expect(fly.deleteApp).not.toHaveBeenCalled();
    });

    it('refuses when the agent records cannot be read at all', async () => {
      const fly = flyStub();
      const service = serviceWith(fly, async () => { throw new Error('storage is down'); });
      // NOT caught, unlike the report's own walk: an empty answer from a
      // failed read makes every machine in the account look unclaimed.
      await expect(service.removeLeftoverMachine('org-1', 'ia-agent00000002')).rejects.toThrow('storage is down');
      expect(fly.deleteApp).not.toHaveBeenCalled();
    });

    it('and the report says whether it read those records at all', async () => {
      const fly = flyStub();
      expect((await serviceWith(fly, async () => ada).report('org-1')).namesRead).toBe(true);
      const blind = serviceWith(flyStub(), async () => { throw new Error('storage is down'); });
      const report = await blind.report('org-1');
      // The inventory still answers — it is worth reading — but every row in
      // it is unnamed, so the screen is told not to offer the removal.
      expect(report.namesRead).toBe(false);
      expect(report.machines.every((row) => row.agent === undefined)).toBe(true);
    });
  });

  it('leads with the biggest spender and names each agent’s human driver (note #336)', async () => {
    // Walked in the order Fly happens to list the account's apps, which is
    // nobody's idea of an order: the cheapest thing first, the month's
    // biggest spender fourth.
    const fly = {
      listApps: vi.fn().mockResolvedValue([
        { name: 'iapp-site0000001' },
        { name: 'zz-other-app' },
        { name: 'ia-agent00000002' },
        { name: 'ia-agent00000001' },
        { name: 'clients-own-app' },
      ]),
      listMachines: vi.fn(async (app: string) => {
        if (app === 'ia-agent00000001') {
          return [{ id: 'abc1', state: 'started', config: { guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } } }];
        }
        if (app === 'ia-agent00000002') {
          return [{ id: 'abc2', state: 'stopped', config: { guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 } } }];
        }
        if (app === 'iapp-site0000001') {
          // Up since 7 August, so 58 hours of this month at $0.0027.
          return [{
            id: 'm2', state: 'started', created_at: '2026-08-07T08:29:16Z',
            config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 } },
          }];
        }
        // Two machines nothing meters and nothing is spending on.
        return [{ id: `${app}-1`, state: 'stopped', config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 } } }];
      }),
      listVolumes: vi.fn(async (app: string) => (app === 'ia-agent00000001' ? [{ id: 'v1', size_gb: 5 }] : [])),
    };
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_x' }) },
      userStorage: {
        getAllUsers: vi.fn().mockResolvedValue([{
          person: { firstName: 'Mira', lastName: 'Vale' },
          telegram: { agents: { a1: {
            id: 'a1', name: 'Ada', serverId: 'fly_ia-agent00000001.abc1',
            machineRuntimeMs: { '2026-09': 10 * 3_600_000 },
          } } },
        }, {
          // A profile that has never said who its human is.
          telegram: { agents: { a2: {
            id: 'a2', name: 'Bea', serverId: 'fly_ia-agent00000002.abc2',
            machineRuntimeMs: { '2026-09': 2 * 3_600_000 },
          } } },
        }]),
      } as never,
      makeFlyClient: () => fly as never,
      now: () => new Date('2026-09-03T10:00:00Z'),
    });

    const report = await service.report('org-1');

    // Biggest spender first, by the figure each row SHOWS. Ada's machine is
    // the account's most expensive shape and it is running — but this ranks
    // what has been spent, not what could be: $2.47 of month, not $124.75 of
    // projection. Below her, a machine nothing has spent on holds its place
    // by app name rather than by whatever order the account was walked in.
    expect(report.machines.map((m) => m.app)).toEqual([
      'ia-agent00000001',
      'ia-agent00000002',
      'iapp-site0000001',
      'clients-own-app',
      'zz-other-app',
    ]);
    expect(report.machines.map((m) => m.totalMonthlyUsd ?? m.estimatedMonthlyUsd)).toEqual([2.47, 0.34, 0.16, 0, 0]);
    expect(report.machines[0]!.estimatedMonthlyUsd).toBe(124.75);

    // Whose agent it is, from the profile the agent is recorded under — and
    // no empty brackets for a profile that has never named its human.
    expect(report.machines[0]!.agent).toEqual({ id: 'a1', name: 'Ada', driver: 'Mira Vale' });
    expect(report.machines[1]!.agent).toEqual({ id: 'a2', name: 'Bea' });
  });

  it('the check lane is one row even with no machine up, priced at the lane default when no run recorded a shape', async () => {
    const fly = {
      listApps: vi.fn().mockResolvedValue([{ name: 'ia-ci-jobs' }]),
      listMachines: vi.fn(async () => []),
      listVolumes: vi.fn(async () => []),
    };
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_x' }) },
      orgStorage: {
        getOrg: vi.fn().mockResolvedValue({ orgId: 'org-1', createdByUserId: 'user-1' }),
      } as never,
      gitRepoStorage: { listByUser: vi.fn(async () => [{ id: 'repo-a' }]) } as never,
      gitCommitStatusStorage: {
        listByReposSince: vi.fn().mockResolvedValue([
          { repoId: 'repo-a', sha: 'a'.repeat(40), context: 'ci/checks', state: 'success', startedAt: '2026-09-02T10:00:00Z', completedAt: '2026-09-02T10:30:00Z' },
        ]),
      } as never,
      makeFlyClient: () => fly as never,
      now: () => new Date('2026-09-03T10:00:00Z'),
    });
    const report = await service.report('org-1');
    expect(report.machines).toHaveLength(1);
    const lane = report.machines[0]!;
    expect(lane.kind).toBe('ci');
    expect(lane.state).toBe('idle');
    expect(lane.machineId).toBe('(none)');
    expect(lane.size).toBe('shared-4x 4GB');
    expect(lane.runs).toBe(1);
    expect(lane.activeMs).toBe(30 * 60_000);
    expect(lane.totalMonthlyUsd).toBeCloseTo(0.5 * estimateGuestHourlyUsd({ cpu_kind: 'shared', cpus: 4, memory_mb: 4096 }), 2);
    // An unstamped org's ground is its founder's namespace.
    expect(report.totals.running).toBe(0);
  });

  it('a spend read survives a ledger it cannot read', async () => {
    const fly = {
      listApps: vi.fn().mockResolvedValue([{ name: 'ia-ci-jobs' }]),
      listMachines: vi.fn(async () => []),
      listVolumes: vi.fn(async () => []),
    };
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn().mockResolvedValue({ source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_x' }) },
      orgStorage: { getOrg: vi.fn().mockRejectedValue(new Error('db gone')) } as never,
      gitRepoStorage: { listByUser: vi.fn() } as never,
      gitCommitStatusStorage: { listByReposSince: vi.fn() } as never,
      makeFlyClient: () => fly as never,
    });
    const report = await service.report('org-1');
    expect(report.machines[0]!.runs).toBe(0);
    expect(report.machines[0]!.totalMonthlyUsd).toBe(0);
  });
});

describe('live machine counts for Home', () => {
  function setup() {
    let now = new Date('2026-09-05T12:00:00Z');
    const fly = {
      listApps: vi.fn(async () => [{ name: 'ia-ci-jobs' }, { name: 'volume-only' }, { name: 'other' }]),
      listMachines: vi.fn(async (app: string) => app === 'volume-only' ? [] : app === 'ia-ci-jobs'
        ? [
            { id: 'ci1', state: 'started' },
            { id: 'ci2', state: 'stopping' },
            { id: 'ci3', state: 'suspending' },
            { id: 'ci4', state: 'restarting' },
          ]
        : [
            { id: 'm1', state: 'stopped' },
            { id: 'm2', state: 'suspended' },
            { id: 'm3', state: 'starting' },
            { id: 'new', state: 'created' },
            { id: 'changing', state: 'replacing' },
            { id: 'leaving', state: 'destroying' },
            { id: 'old', state: 'destroyed' },
            { id: 'mystery', state: 'future-fly-state' },
          ]),
      listVolumes: vi.fn(),
    };
    const service = new OrgSpendService({
      orgFly: { resolveOrgFlyContext: vi.fn(async (id) => ({ orgSlug: id, apiToken: 'fixture', source: 'org' as const })) },
      makeFlyClient: () => fly as never,
      now: () => now,
    });
    return { service, fly, advance: () => { now = new Date(now.getTime() + 11_000); } };
  }
  it('keeps directional transitions under the stable state they leave and omits states with no knowable origin', async () => {
    const { service, fly } = setup();
    expect(await service.liveMachines('one')).toEqual({ active: 4, sleeping: 3, checkedAt: '2026-09-05T12:00:00.000Z' });
    expect(fly.listVolumes).not.toHaveBeenCalled();
  });
  it('coalesces readers, expires snapshots, and keeps workplaces separate', async () => {
    const { service, fly, advance } = setup();
    await Promise.all([service.liveMachines('one'), service.liveMachines('one')]);
    await service.liveMachines('one');
    expect(fly.listApps).toHaveBeenCalledTimes(1);
    await service.liveMachines('two');
    expect(fly.listApps).toHaveBeenCalledTimes(2);
    advance();
    await service.liveMachines('one');
    expect(fly.listApps).toHaveBeenCalledTimes(3);
  });
  it('aborts a stalled Fly read within the UI deadline and permits a fresh attempt', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const service = new OrgSpendService({
        orgFly: { resolveOrgFlyContext: async () => ({ orgSlug: 'acme', apiToken: 'fixture', source: 'org' as const }) },
        makeFlyClient: () => ({
          listApps: async () => [{ name: 'app' }],
          listMachines: async (_app: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
            signals.push(init.signal);
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        }) as never,
      });
      const first = expect(service.liveMachines('one')).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(6500);
      await first;
      expect(signals[0]?.aborted).toBe(true);
      const second = expect(service.liveMachines('one')).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(6500);
      await second;
      expect(signals).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('fails a partial snapshot instead of reporting false zeros, then retries', async () => {
    const { service, fly } = setup();
    fly.listMachines.mockRejectedValueOnce(new Error('Fly unavailable'));
    await expect(service.liveMachines('one')).rejects.toThrow('Fly unavailable');
    expect((await service.liveMachines('one')).active).toBe(4);
  });
});
