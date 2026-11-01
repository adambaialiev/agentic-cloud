import type { WorkspaceCloudMachines } from '../shared/workspace-api.js';
import { FlyClient, type FlyMachine, type FlyMachineGuest } from './fly-client.js';
import type { OrgFlyService } from './org-fly.js';
import type { OrgStorage } from './org-storage.js';
import type { GitRepoStorage } from './git-repo-storage.js';
import type { GitCommitStatusStorage } from './git-commit-status-storage.js';
import type { GitCommitStatusDocument } from '../types/git-commit-status.js';
import type { DeploymentStorage } from './deployment-storage.js';
import { isDeploymentAppName } from './deployment-service.js';
import {
  COST_ESTIMATE_DISCLAIMER,
  estimateGuestHourlyUsd,
  estimateGuestMonthlyUsd,
  estimateVolumeMonthlyUsd,
} from '../config/fly-cost-estimates.js';
import { runtimeMonthKey } from './machine-runtime-meter.js';
import { parseFlyServerRecordTarget } from './fly-sandbox-id.js';
import type { UserStorage } from './user-storage.js';
import { personDisplayName, type UserProfileDocument } from '../types/user.js';

/**
 * The org spend view (byo-fly-design slice 6): every machine and volume in
 * the org's Fly account, with an honest monthly figure. Agents sleep after
 * about three idle minutes and compute bills only while running, so the
 * running/stopped split IS the story; the disclaimer rides every response.
 *
 * FACTS BEFORE PROJECTIONS (note #319). A row says what its machine has cost
 * so far this month wherever the awake time is known, and only projects
 * where nothing measures it:
 *  - an agent's machine: awake time observed by the five-minute sweep;
 *  - a site's machine: awake since Fly last started it (production sites are
 *    always-on, so that is the whole month or the span since they went up);
 *  - the check lane: the month's check runs, each priced for its own length
 *    at the shape its job machine was created with. A check machine lives
 *    only for its run, so "per month if left on" was a number nobody would
 *    ever be billed, and it was the largest number on the screen.
 *
 * The walk is intentionally whole-org (listApps), not record-scoped: this is
 * a READ for the bill-payer, and an app we did not create still lands on
 * their invoice — hiding it would make the view lie exactly where it matters.
 * Unrecognized apps are marked as such rather than skipped.
 *
 * ONE KIND OF ROW IS COUNTED AND NOT LISTED (note #635): a machine a record
 * gives to ANOTHER workplace. Two workplaces can connect the same Fly
 * account, and a site can move to another workplace while its app stays where
 * it was built — so an account's inventory can hold another workplace's
 * agents, named, with the people they work for. That is not this workplace's
 * to read. Those rows are left out of the list and the totals and only their
 * number is returned (`machinesElsewhere`), which keeps the rule above: the
 * reader is still told the account holds more than they see. A machine no
 * record attributes at all — a leftover, an app we did not create — has no
 * other workplace to belong to, and stays listed exactly as before.
 */

export interface OrgSpendMachineRow {
  app: string;
  machineId: string;
  /** `'ci'` is the lane app whose machines live only while a check runs. */
  kind: 'agent' | 'site' | 'ci' | 'other';
  state: string;
  size: string;
  /** $/mo if it keeps its current state: full compute+volume running, volume-only stopped. */
  estimatedMonthlyUsd: number;
  /** $/mo if it ran the whole month — the ceiling, shown beside the current burn. */
  runningMonthlyUsd: number;
  /** Compute-only price for this machine shape while it is awake. */
  hourlyUsd: number;
  /** Agent occupying this exact Fly machine, when one is recorded, and the
   *  human it works for (note #336) — an org runs one machine per agent, so
   *  "whose is this?" is the question a bill-payer asks of every row. */
  agent?: { id: string; name: string; driver?: string };
  /** The agent named above has not recorded this machine yet: its setup chose
   *  the app and the machine is already billing (note #375). Nothing meters
   *  it, so it carries a name and no month-to-date figure. */
  settingUp?: boolean;
  /** Awake time this month, where something measures it (see the module doc). */
  activeMs?: number;
  /** That awake time at the hourly rate, plus this month's provisioned storage. */
  totalMonthlyUsd?: number;
  /** A check lane: how many runs this month `activeMs` is summed over. */
  runs?: number;
  /** A running site: when Fly last started it. */
  awakeSince?: string;
}

/**
 * The CI lane's Fly apps: the platform's own (`infra/ci-runner`, `LANE_A_APP`)
 * and an org's own (`org-ci.ts`, `iaci-<org>`). A machine in one is not
 * anybody's agent: it is created for one check and destroyed when the check
 * ends, minutes later. It wears the `ia-` prefix agents wear, so without this
 * it was reported as an agent machine no agent claimed — which is what note
 * #319 asked about ("whose agent is this $124 machine?").
 */
const CI_LANE_APPS = new Set(['ia-ci-jobs']);
const isCiLaneApp = (appName: string) => CI_LANE_APPS.has(appName) || appName.startsWith('ia-ci-') || appName.startsWith('iaci-');

/**
 * A workplace's own apps — its check lane, git host, mail host and media
 * store — are all `<prefix>-` and the first twelve hex of its id
 * (`org-ci.ts`, `org-git-host.ts`, `org-msg-host.ts`, `org-media.ts`), so
 * the name alone says whose one is (note #635).
 */
const ORG_SCOPED_APP = /^ia(?:ci|git|msg|media)-([0-9a-f]{12})$/;
const orgAppKey = (orgId: string) => orgId.replace(/-/g, '').slice(0, 12);

/** The status context the check lane files under; deploy jobs run on the runner host, not on a machine of their own. */
const CI_CHECK_CONTEXT = 'ci/checks';

export interface OrgSpendReport {
  orgSlug: string;
  machines: OrgSpendMachineRow[];
  totals: {
    estimatedMonthlyUsd: number;
    runningMonthlyUsd: number;
    /**
     * The month so far, added up: every row's `totalMonthlyUsd` and nothing
     * else (note #342, "the accumulative sum of all listed per machine
     * costs"). It is a sum of FACTS, which is the whole reason it can stand
     * at the top of the screen where the projection was not allowed to: a
     * row nothing meters contributes nothing here rather than contributing
     * `estimatedMonthlyUsd`, because one running machine's projection is a
     * full month of compute and would swamp the real month beside it.
     */
    spentThisMonthUsd: number;
    /** Rows the sum above therefore leaves out, so the screen can say so. */
    unmeasured: number;
    running: number;
    stopped: number;
  };
  /**
   * Whether the agent records were actually read (note #375).
   *
   * Every name on this screen comes from that one walk, and it is caught
   * rather than fatal: an inventory of the account is still worth reading
   * when the records behind it are unavailable. But EVERY row then looks
   * unclaimed, which is exactly the state the screen offers to delete — so
   * the answer says whether it knows whose machines these are, and the
   * screen offers nothing destructive when it does not.
   */
  namesRead: boolean;
  /**
   * Machines in this account that belong to another workplace (note #635):
   * counted here, never listed, and in none of the totals above. It counts
   * the rows the list would have drawn for them, so it is a machine count in
   * the same sense the list is.
   */
  machinesElsewhere: number;
  disclaimer: string;
}

export interface OrgSpendServiceDeps {
  orgFly: Pick<OrgFlyService, 'resolveOrgFlyContext' | 'resolveHostingContext'>;
  /**
   * A private copy (note #804): every workplace runs on the copy's own Fly
   * account, which is the customer's, so that account's bill IS theirs to see.
   */
  privateCopy?: boolean;
  userStorage?: Pick<UserStorage, 'getAllUsers'>;
  /** The org's rooms name its git namespaces, which name its repositories, whose check runs are the lane's month. */
  orgStorage?: Pick<OrgStorage, 'getOrg'>;
  gitRepoStorage?: Pick<GitRepoStorage, 'listByUser'>;
  gitCommitStatusStorage?: Pick<GitCommitStatusStorage, 'listByReposSince'>;
  /** Which workplace owns each site's app, so another's is counted, not listed (note #635). */
  deploymentStorage?: Pick<DeploymentStorage, 'listAll'>;
  makeFlyClient?: (apiToken: string) => Pick<
    FlyClient,
    'listApps' | 'listMachines' | 'listVolumes' | 'deleteMachine' | 'deleteVolume' | 'deleteApp'
  >;
  now?: () => Date;
}

/** A refusal with the status the route should answer — the `DriveError` shape. */
export class OrgSpendError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Home promises two stable answers, even while Fly is between them.
 *
 * The directional states keep counting under the state they are leaving:
 * `starting` comes from stopped/suspended, while stop, suspend and restart all
 * begin on a started machine. States with no knowable origin (creation,
 * replacement, deletion, failures, and future Fly states) are omitted until
 * the next short snapshot sees a stable answer; inventing one would be worse
 * than briefly counting neither.
 *
 * See https://fly.io/docs/machines/machine-states/
 */
function liveMachineBucket(machine: FlyMachine): 'active' | 'sleeping' | undefined {
  switch (machine.state) {
    case 'started':
    case 'stopping':
    case 'suspending':
    case 'restarting':
      return 'active';
    case 'stopped':
    case 'suspended':
    case 'starting':
      return 'sleeping';
    default:
      return undefined;
  }
}

export class OrgSpendService {
  constructor(private readonly deps: OrgSpendServiceDeps) {}

  // Home is read by every member. Coalesce simultaneous readers and reuse a
  // short snapshot per workplace, without walking billing records or volumes.
  private readonly machineCounts = new Map<string, { until: number; value: Promise<WorkspaceCloudMachines> }>();

  async liveMachines(orgId: string): Promise<WorkspaceCloudMachines> {
    const now = () => (this.deps.now?.() ?? new Date()).getTime();
    const existing = this.machineCounts.get(orgId);
    if (existing && existing.until > now()) return existing.value;
    const entry = { until: Infinity, value: Promise.resolve(null as unknown as WorkspaceCloudMachines) };
    entry.value = (async () => {
      const context = await this.deps.orgFly.resolveOrgFlyContext(orgId);
      const fly = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(context.apiToken);
      const stop = new AbortController();
      const timeout = setTimeout(() => stop.abort(), 6500);
      try {
        const apps = await fly.listApps(context.orgSlug, { signal: stop.signal });
        const counts = { active: 0, sleeping: 0, checkedAt: '' };
        // Bound the fan-out. Failed reads fail the snapshot, never look like zero.
        for (let start = 0; start < apps.length; start += 6) {
          const groups = await Promise.all(apps.slice(start, start + 6).map((app) => fly.listMachines(app.name, { signal: stop.signal })));
          for (const machines of groups) for (const machine of machines) {
            const bucket = liveMachineBucket(machine);
            if (bucket) counts[bucket] += 1;
          }
        }
        counts.checkedAt = new Date(now()).toISOString();
        entry.until = now() + 10_000;
        return counts;
      } finally {
        clearTimeout(timeout);
        stop.abort();
      }
    })().catch((error) => {
      this.machineCounts.delete(orgId);
      throw error;
    });
    // Also prune snapshots of workplaces nobody is viewing any more.
    for (const [id, cached] of this.machineCounts) if (cached.until <= now()) this.machineCounts.delete(id);
    this.machineCounts.set(orgId, entry);
    return entry.value;
  }

  async report(orgId: string): Promise<OrgSpendReport> {
    const context = this.deps.privateCopy
      ? await this.deps.orgFly.resolveHostingContext(orgId)
      : await this.deps.orgFly.resolveOrgFlyContext(orgId);
    const fly = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(context.apiToken);

    const machines: OrgSpendMachineRow[] = [];
    const now = this.deps.now?.() ?? new Date();
    const monthKey = runtimeMonthKey(now);
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const agentsByMachine = new Map<string, { id: string; name: string; driver?: string; activeMs: number; orgId?: string }>();
    /**
     * The workplace of the agent that claims each app — by its `serverId` or
     * by a setup still in flight — so a machine of another workplace's agent
     * is counted rather than listed (note #635). Keyed by app as well as by
     * machine, because an agent's app can hold a machine its record no longer
     * names, and that machine is still that workplace's.
     */
    const agentOrgByApp = new Map<string, string>();
    /**
     * Apps an agent's setup has claimed but not yet finished (note #375).
     *
     * `provisioningAppName` is written BEFORE the app exists and cleared in
     * the same write that saves `serverId`, so between those two moments a
     * real machine is billing that no `serverId` names. Keyed by app, because
     * the machine's own id is exactly what the record does not have yet —
     * which is also why this cannot displace the machine-keyed map above.
     *
     * It is only ever a NAME here: an agent's awake time is metered per agent,
     * so spending it on this row as well would count the same minutes twice
     * in the total at the top.
     */
    const settingUpByApp = new Map<string, { id: string; name: string; driver?: string }>();
    // Whether the walk below actually happened. A screen that cannot name
    // anybody must not offer to delete anything (note #375).
    let namesRead = false;
    if (this.deps.userStorage) {
      const profiles = await this.deps.userStorage.getAllUsers().then((read) => {
        namesRead = true;
        return read;
      }).catch((error) => {
        console.warn('[OrgSpend] could not load agent names and runtime totals', error);
        return [];
      });
      for (const profile of profiles) {
        // The profile an agent is recorded under IS its human driver, so
        // naming them costs nothing beyond the read this walk already does.
        const driver = driverName(profile);
        for (const agent of Object.values(profile.telegram?.agents ?? {})) {
          const provisioning = agent.provisioningAppName?.trim();
          if (provisioning) {
            settingUpByApp.set(provisioning, { id: agent.id, name: agent.name, ...(driver ? { driver } : {}) });
            if (agent.orgId) agentOrgByApp.set(provisioning, agent.orgId);
          }
          const target = parseFlyServerRecordTarget(agent.serverId);
          if (!target) continue;
          if (agent.orgId) agentOrgByApp.set(target.appName, agent.orgId);
          agentsByMachine.set(`${target.appName}.${target.machineId}`, {
            id: agent.id,
            name: agent.name,
            ...(driver ? { driver } : {}),
            activeMs: agent.machineRuntimeMs?.[monthKey] ?? 0,
            ...(agent.orgId ? { orgId: agent.orgId } : {}),
          });
        }
      }
    }
    const siteOrgByApp = await this.siteOwnersByApp();
    // Rows another workplace's records claim: counted, never listed (note #635).
    let machinesElsewhere = 0;
    const hereKey = orgAppKey(orgId);
    // Read once, attributed to the first check lane app the account holds.
    let checkRuns: GitCommitStatusDocument[] | null = null;
    const apps = await fly.listApps(context.orgSlug);
    for (const app of apps) {
      const appName = app.name?.trim();
      if (!appName || appName.includes('machine-images')) continue;
      const kind = isCiLaneApp(appName)
        ? 'ci'
        : appName.startsWith('ia-') ? 'agent' : isDeploymentAppName(appName) ? 'site' : 'other';
      // Whose app this is, where its name or a record says. An org-scoped app
      // carries its workplace in its name; a site's and an agent's are on
      // their records. Nothing saying so is not "someone else's".
      const scopedTo = ORG_SCOPED_APP.exec(appName)?.[1];
      const appElsewhere = scopedTo !== undefined
        ? scopedTo !== hereKey
        : [siteOrgByApp.get(appName), agentOrgByApp.get(appName)].some((owner) => owner !== undefined && owner !== orgId);
      const [appMachines, volumes] = await Promise.all([
        fly.listMachines(appName).catch(() => []),
        fly.listVolumes(appName).catch(() => []),
      ]);
      const volumeUsd = volumes.reduce((sum, volume) => sum + estimateVolumeMonthlyUsd(volume.size_gb ?? 0), 0);
      if (kind === 'ci') {
        // Another workplace's lane is one row of theirs, and must not be
        // handed this workplace's runs by being first in the account.
        if (appElsewhere) {
          machinesElsewhere += 1;
          continue;
        }
        if (checkRuns === null) {
          checkRuns = await this.checkRunsThisMonth(orgId, new Date(monthStart).toISOString());
          machines.push(checkLaneRow(appName, appMachines, checkRuns, volumeUsd, now));
        } else {
          // A second lane app in one account: its machines are listed, the
          // month's runs are not counted twice.
          machines.push(checkLaneRow(appName, appMachines, [], volumeUsd, now));
        }
        continue;
      }
      for (const machine of appMachines) {
        const running = machine.state === 'started';
        const computeUsd = estimateGuestMonthlyUsd(machine.config?.guest);
        const hourlyUsd = estimateGuestHourlyUsd(machine.config?.guest);
        const occupant = agentsByMachine.get(`${appName}.${machine.id}`);
        // The machine-keyed match decides whose it is wherever it names a
        // workplace, for the reason it decides the name below.
        if (occupant?.orgId ? occupant.orgId !== orgId : appElsewhere) {
          machinesElsewhere += 1;
          continue;
        }
        // Nobody on the machine itself, but an agent's setup owns the app it
        // sits in: this is that agent's machine being born, not a leftover
        // (note #375). The machine-keyed match wins wherever both exist — a
        // record whose setup finished names its machine exactly.
        const settingUp = occupant ? undefined : settingUpByApp.get(appName);
        // A site is up from when Fly last started it. Production sites are
        // always-on (the reaper never touches an iapp-* machine), so the span
        // since that start, clipped to this month, is its awake time.
        const awakeSince = kind === 'site' && running ? lastStartedAt(machine) : undefined;
        const siteActiveMs = awakeSince !== undefined
          ? Math.max(0, now.getTime() - Math.max(monthStart, awakeSince))
          : undefined;
        machines.push({
          app: appName,
          machineId: machine.id,
          kind,
          state: machine.state ?? 'unknown',
          size: guestSize(machine.config?.guest),
          estimatedMonthlyUsd: round2((running ? computeUsd : 0) + volumeUsd),
          runningMonthlyUsd: round2(computeUsd + volumeUsd),
          hourlyUsd,
          ...(occupant
            ? {
              agent: { id: occupant.id, name: occupant.name, ...(occupant.driver ? { driver: occupant.driver } : {}) },
              activeMs: occupant.activeMs,
              totalMonthlyUsd: round2((occupant.activeMs / 3_600_000) * hourlyUsd + volumeUsd),
            }
            : {}),
          ...(settingUp ? { agent: settingUp, settingUp: true } : {}),
          ...(siteActiveMs !== undefined && awakeSince !== undefined
            ? {
              activeMs: siteActiveMs,
              totalMonthlyUsd: round2((siteActiveMs / 3_600_000) * hourlyUsd + volumeUsd),
              awakeSince: new Date(awakeSince).toISOString(),
            }
            : {}),
        });
      }
      // An app with volumes but no machines still bills its volumes.
      if (appMachines.length === 0 && volumeUsd > 0) {
        if (appElsewhere) {
          machinesElsewhere += 1;
          continue;
        }
        machines.push({
          app: appName,
          machineId: '(none)',
          kind,
          state: 'no-machine',
          size: 'volumes only',
          estimatedMonthlyUsd: round2(volumeUsd),
          runningMonthlyUsd: round2(volumeUsd),
          hourlyUsd: 0,
        });
      }
    }

    machines.sort(bySpendDescending);
    return {
      orgSlug: context.orgSlug,
      machines,
      totals: {
        estimatedMonthlyUsd: round2(machines.reduce((sum, row) => sum + row.estimatedMonthlyUsd, 0)),
        runningMonthlyUsd: round2(machines.reduce((sum, row) => sum + row.runningMonthlyUsd, 0)),
        spentThisMonthUsd: round2(machines.reduce((sum, row) => sum + (row.totalMonthlyUsd ?? 0), 0)),
        unmeasured: machines.filter((row) => row.totalMonthlyUsd === undefined).length,
        running: machines.filter((row) => row.state === 'started').length,
        stopped: machines.filter((row) => row.state === 'stopped').length,
      },
      namesRead,
      machinesElsewhere,
      disclaimer: COST_ESTIMATE_DISCLAIMER,
    };
  }

  /**
   * The workplace that owns each site's Fly app (note #635).
   *
   * OWNS, not hosts: a site moved to another workplace keeps its app in the
   * account it was built in (`flyOrgId`), and it is the new owner's site —
   * so in the old account it is counted, not listed. A failed read is an
   * empty map, logged, and every site is then listed as it was before this
   * screen could tell whose one is: the one direction it may fail in.
   */
  private async siteOwnersByApp(): Promise<Map<string, string>> {
    const owners = new Map<string, string>();
    if (!this.deps.deploymentStorage) return owners;
    try {
      for (const site of await this.deps.deploymentStorage.listAll()) {
        const app = site.flyApp?.trim();
        if (!app || !site.orgId) continue;
        // A tombstone never outranks a live record naming the same app.
        if (site.status === 'destroyed' && owners.has(app)) continue;
        owners.set(app, site.orgId);
      }
    } catch (error) {
      console.warn('[OrgSpend] could not read which workplace owns each site', error);
    }
    return owners;
  }

  /**
   * Destroy a machine nobody is on — the button note #375 asked for after the
   * screen learned to say what a leftover machine is.
   *
   * THE WHOLE APP GOES, not just the machine: an agent's app holds one
   * machine and its volume, and the volume is the part that keeps billing
   * after a machine is destroyed. Anything left of an app whose machine is
   * gone is a row nobody can even see to remove.
   *
   * It does NOT go through `FlySandboxClient.destroyAbandonedApp`, and that
   * is the trap this method exists to avoid. That path resolves the app's
   * workplace by finding the record that names it — and a leftover is
   * precisely an app NO record names, so the lookup returns nothing and the
   * teardown falls back to the platform's own Fly token. Against a client
   * workplace's account every call then answers 404, which that path reads
   * as "already gone" and reports as success: the button would say removed
   * and the machine would keep billing. Here the token is the workplace's
   * own, resolved the same way the report above resolves it.
   *
   * Three gates, all fail-closed, because the cost of being wrong is a live
   * agent's machine and everything on its disk:
   *  1. the name has to be an agent app's, and not the check lane's;
   *  2. the app has to be in THIS workplace's account, so one org's admin
   *     can never name another's app;
   *  3. no agent record anywhere may claim it — by `serverId` or by the
   *     `provisioningAppName` of a setup still in flight. That read is
   *     deliberately NOT caught: a walk that fails refuses the delete, where
   *     the report's own walk is allowed to fail and merely lose the names.
   */
  async removeLeftoverMachine(orgId: string, appName: string): Promise<{ app: string; machines: number }> {
    const app = appName.trim();
    if (!app.startsWith('ia-') || isCiLaneApp(app) || app.includes('machine-images')) {
      throw new OrgSpendError(400, `${app || 'That name'} is not an agent machine's app.`);
    }
    if (!this.deps.userStorage) {
      throw new OrgSpendError(503, 'This backend cannot tell whose machines these are, so it will not remove one.');
    }
    const context = await this.deps.orgFly.resolveOrgFlyContext(orgId);
    const fly = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(context.apiToken);

    const apps = await fly.listApps(context.orgSlug);
    if (!apps.some((candidate) => candidate.name?.trim() === app)) {
      throw new OrgSpendError(404, `There is no machine called ${app} in this workplace's cloud.`);
    }

    const profiles = await this.deps.userStorage.getAllUsers();
    for (const profile of profiles) {
      for (const agent of Object.values(profile.telegram?.agents ?? {})) {
        const claimed = agent.provisioningAppName?.trim() === app
          || parseFlyServerRecordTarget(agent.serverId)?.appName === app;
        if (claimed) {
          throw new OrgSpendError(409, `${agent.name} is on that machine, so it is not a leftover.`);
        }
      }
    }

    // Machines first, then the volumes they held, then the app — the order
    // `FlySandboxClient` tears down in, for the same reason: Fly refuses to
    // drop an app that still has machines, and a volume outlives the machine
    // that mounted it.
    const machines = await fly.listMachines(app);
    for (const machine of machines) {
      await fly.deleteMachine(app, machine.id, { force: true });
    }
    const volumes = await fly.listVolumes(app);
    for (const volume of volumes) {
      await fly.deleteVolume(app, volume.id).catch((error) => {
        console.warn('[OrgSpend] could not delete a volume of a removed leftover', { app, volume: volume.id, error });
      });
    }
    await fly.deleteApp(app);
    // Home counts machines from a short-lived snapshot; one fewer, now.
    this.machineCounts.delete(orgId);
    console.log(`[OrgSpend] removed leftover app ${app} (${machines.length} machine(s)) for org ${orgId}`);
    return { app, machines: machines.length };
  }

  /**
   * This month's check runs across every repository the org can see: its
   * base namespace and its old rooms' (note #843). A failure to read any of it is an empty
   * month, logged — the inventory must not fail because the ledger did.
   */
  private async checkRunsThisMonth(orgId: string, sinceIso: string): Promise<GitCommitStatusDocument[]> {
    const { orgStorage, gitRepoStorage, gitCommitStatusStorage } = this.deps;
    if (!orgStorage || !gitRepoStorage || !gitCommitStatusStorage) return [];
    try {
      const org = await orgStorage.getOrg(orgId);
      // The workplace's own namespace and its old rooms' (note #843), where
      // repositories made then still live.
      const namespaces = new Set<string>(org?.roomsMerged?.namespaces ?? []);
      if (org) namespaces.add(org.git?.namespaceId ?? org.createdByUserId);
      const repos = (await Promise.all([...namespaces].map((namespaceId) => gitRepoStorage.listByUser(namespaceId)))).flat();
      const repoIds = [...new Set(repos.map((repo) => repo.id))];
      const runs = await gitCommitStatusStorage.listByReposSince(repoIds, sinceIso);
      return runs.filter((run) => run.context === CI_CHECK_CONTEXT);
    } catch (error) {
      console.warn('[OrgSpend] could not read this month’s check runs', error);
      return [];
    }
  }
}

/**
 * Biggest spender first (note #336).
 *
 * The key is the figure each row SHOWS: what the machine has cost so far this
 * month wherever something measures its awake time, and the projection only
 * where nothing does. Ordering by anything else would put a smaller number
 * above a larger one in the very column the reader is scanning, which reads
 * as no order at all. It orders the ANSWER rather than the screen, so that
 * `agentbuilt workplace spend` prints the same list in the same order.
 *
 * Ties are broken by app and machine, so a list nobody's spending
 * distinguishes — an account of asleep machines at $0.00 — comes back the
 * same way on every read instead of shuffling with whatever order Fly
 * happened to list the apps in.
 */
function bySpendDescending(a: OrgSpendMachineRow, b: OrgSpendMachineRow): number {
  return (b.totalMonthlyUsd ?? b.estimatedMonthlyUsd) - (a.totalMonthlyUsd ?? a.estimatedMonthlyUsd)
    || a.app.localeCompare(b.app)
    || a.machineId.localeCompare(b.machineId);
}

/**
 * The human a machine's agent works for, when the profile says who that is.
 *
 * `personDisplayName` falls back to the word "Member" for a profile carrying
 * no name at all; "Ada (Member)" on a spend row tells the reader nothing they
 * did not already know, so an unnamed driver leaves the parenthesis off
 * instead of filling it with a placeholder.
 */
function driverName(profile: UserProfileDocument): string | undefined {
  const named = personDisplayName(profile);
  // Compared against the name an EMPTY profile is given, so this cannot drift
  // if that fallback word is ever reworded.
  return named === personDisplayName(null) ? undefined : named;
}

/**
 * The check lane as ONE row, whether or not a job machine happens to exist
 * at the moment of reading. The lane's month is its runs, and most of the
 * time no machine is up at all — a row only while one is would show the
 * month's spend for the minutes of a check and nothing the rest of the time.
 *
 * Each run is priced for its own length at the shape it recorded. A run
 * recorded before shapes travelled is priced at the shape of a machine up
 * now, or failing that at the lane's own default — the one `lane-a.mjs`
 * boots with when nothing overrides it.
 */
function checkLaneRow(
  appName: string,
  appMachines: FlyMachine[],
  runs: GitCommitStatusDocument[],
  volumeUsd: number,
  now: Date,
): OrgSpendMachineRow {
  const up = appMachines.find((machine) => machine.state === 'started') ?? appMachines[0];
  const newestRecorded = runs
    .filter((run) => run.machine)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.machine;
  const laneGuest: FlyMachineGuest | undefined = up?.config?.guest
    ?? (newestRecorded ? { cpu_kind: newestRecorded.cpuKind, cpus: newestRecorded.cpus, memory_mb: newestRecorded.memoryMb } : undefined)
    ?? LANE_DEFAULT_GUEST;
  const hourlyUsd = estimateGuestHourlyUsd(laneGuest);
  let activeMs = 0;
  let spentUsd = 0;
  for (const run of runs) {
    const started = Date.parse(run.startedAt);
    const ended = run.completedAt ? Date.parse(run.completedAt) : now.getTime();
    if (!Number.isFinite(started) || !Number.isFinite(ended)) continue;
    const ms = Math.max(0, Math.min(ended, now.getTime()) - started);
    const rate = run.machine
      ? estimateGuestHourlyUsd({ cpu_kind: run.machine.cpuKind, cpus: run.machine.cpus, memory_mb: run.machine.memoryMb })
      : hourlyUsd;
    activeMs += ms;
    spentUsd += (ms / 3_600_000) * rate;
  }
  const running = up?.state === 'started';
  const computeUsd = estimateGuestMonthlyUsd(laneGuest);
  const totalMonthlyUsd = round2(spentUsd + volumeUsd);
  return {
    app: appName,
    machineId: up?.id ?? '(none)',
    kind: 'ci',
    state: running ? 'started' : 'idle',
    size: guestSize(laneGuest),
    // What it has cost, not what a machine that never stays would cost: the
    // lane's contribution to "at current usage" is its month so far.
    estimatedMonthlyUsd: totalMonthlyUsd,
    runningMonthlyUsd: round2(computeUsd + volumeUsd),
    hourlyUsd,
    activeMs,
    totalMonthlyUsd,
    runs: runs.length,
  };
}

/** `lane-a.mjs`'s own default (`LANE_A_GUEST` unset). */
const LANE_DEFAULT_GUEST: FlyMachineGuest = { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 };

/** When Fly last started this machine: the newest `start` event, else its creation. */
function lastStartedAt(machine: FlyMachine): number | undefined {
  const starts = (machine.events ?? [])
    .filter((event) => event.type === 'start' && event.timestamp !== undefined)
    .map((event) => (typeof event.timestamp === 'number' ? event.timestamp : Date.parse(String(event.timestamp))))
    .filter((at) => Number.isFinite(at));
  if (starts.length > 0) return Math.max(...starts);
  const created = machine.created_at ? Date.parse(machine.created_at) : NaN;
  return Number.isFinite(created) ? created : undefined;
}

function guestSize(guest: FlyMachineGuest | undefined): string {
  return guest
    ? `${guest.cpu_kind ?? 'shared'}-${guest.cpus ?? 1}x ${Math.round((guest.memory_mb ?? 0) / 1024 * 10) / 10}GB`
    : 'unknown';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
