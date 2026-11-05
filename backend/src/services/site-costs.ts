import type { FlyMachine, FlyVolume } from './fly-client.js';
import type { DeploymentDocument } from '../types/deployment.js';
import type { WorkspaceSiteCost, WorkspaceSiteCostsAnswer } from '../shared/workspace-api.js';
import {
  COST_ESTIMATE_DISCLAIMER,
  estimateGuestMonthlyUsd,
  estimateVolumeMonthlyUsd,
} from '../config/fly-cost-estimates.js';

/**
 * What each site of a workplace costs to keep up, for the Sites screen
 * (note #993, Adam, 2026-11-05: "we should show this information in the UI").
 *
 * A site is a machine that never sleeps, by design (deployment.ts: "one
 * always-on Fly machine"), so its estimate is a FULL month of its machine
 * plus every disk its app holds — including spare ones no machine mounts,
 * which bill exactly the same and are otherwise invisible.
 *
 * ONE PRICE SOURCE: every dollar here comes from `config/fly-cost-estimates.ts`,
 * the table the spend view prices with (`org-spend.ts`). Nothing in the UI
 * knows a price; it prints what this module answers.
 *
 * FACTS, NOT GUESSES: the shape priced is the machine Fly reports, not the
 * preset the record names (a resize may not have landed, an operator may have
 * changed it). When the machine or the disks cannot be read, the site says
 * so and contributes nothing to the total — it is counted in `unread`
 * instead, so the screen can say the total leaves it out.
 */

export interface SiteInfrastructure {
  machines: FlyMachine[];
  volumes: FlyVolume[];
}

/** Reads one site app's machines and volumes in the account it lives in. */
export type SiteInfrastructureReader = (deployment: DeploymentDocument) => Promise<SiteInfrastructure>;

/** Volume states Fly no longer bills. */
const GONE_VOLUME_STATES = new Set(['destroyed', 'destroying', 'pending_destroy', 'deleted']);
/** Machine states in which no compute is billed. */
const IDLE_MACHINE_STATES = new Set(['stopped', 'suspended', 'destroyed', 'destroying']);

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Price one site from what Fly says its app holds. Pure; exported for tests. */
export function siteCostFrom(deployment: DeploymentDocument, infra: SiteInfrastructure): WorkspaceSiteCost {
  const machine = (deployment.machineId
    ? infra.machines.find((entry) => entry.id === deployment.machineId)
    : undefined) ?? infra.machines[0];
  if (!machine) {
    return { name: deployment.name, preset: deployment.preset, read: false, reason: 'no-machine' };
  }
  const guest = machine.config?.guest;
  const mountedIds = new Set((machine.config?.mounts ?? []).map((mount) => mount.volume).filter(Boolean) as string[]);
  const volumes = infra.volumes.filter((volume) => !GONE_VOLUME_STATES.has(String(volume.state ?? '')));
  const isMounted = (volume: FlyVolume) => mountedIds.has(volume.id)
    || volume.attached_machine_id === machine.id
    || (mountedIds.size === 0 && volume.id === deployment.volumeId);
  const disk = (volume: FlyVolume) => ({
    sizeGb: volume.size_gb ?? 0,
    monthlyUsd: estimateVolumeMonthlyUsd(volume.size_gb ?? 0),
  });
  const mounted = volumes.filter(isMounted).map(disk);
  const spare = volumes.filter((volume) => !isMounted(volume)).map(disk);
  const running = !IDLE_MACHINE_STATES.has(String(machine.state ?? ''));
  const shapeMonthlyUsd = estimateGuestMonthlyUsd(guest);
  const machineMonthlyUsd = running ? shapeMonthlyUsd : 0;
  const disksMonthlyUsd = round2([...mounted, ...spare].reduce((sum, entry) => sum + entry.monthlyUsd, 0));
  return {
    name: deployment.name,
    preset: deployment.preset,
    read: true,
    machine: {
      cpuKind: guest?.cpu_kind === 'performance' ? 'performance' : 'shared',
      cpus: guest?.cpus ?? 1,
      memoryMb: guest?.memory_mb ?? 256,
      running,
      monthlyUsd: machineMonthlyUsd,
      ...(running ? {} : { runningMonthlyUsd: shapeMonthlyUsd }),
    },
    disks: mounted,
    spareDisks: spare,
    disksMonthlyUsd,
    monthlyUsd: round2(machineMonthlyUsd + disksMonthlyUsd),
  };
}

/**
 * The workplace's sites priced, with a short memory per site app: the screen
 * reads this every time it opens, and an always-on machine's shape does not
 * change between two taps. A failed read is not remembered as long, so a
 * passing Fly hiccup clears itself.
 */
export class SiteCostReader {
  private readonly cache = new Map<string, { at: number; cost: WorkspaceSiteCost }>();

  constructor(private readonly opts: {
    read: SiteInfrastructureReader;
    ttlMs?: number;
    failedTtlMs?: number;
    now?: () => number;
  }) {}

  async forSites(deployments: DeploymentDocument[], hosted: boolean): Promise<WorkspaceSiteCostsAnswer> {
    const now = this.opts.now ?? Date.now;
    const ttl = this.opts.ttlMs ?? 60_000;
    const failedTtl = this.opts.failedTtlMs ?? 15_000;
    const sites = await Promise.all(deployments
      .filter((deployment) => deployment.status !== 'destroyed')
      .map(async (deployment): Promise<WorkspaceSiteCost> => {
        // Nothing built (a reserved name, a rolled-back first deploy): no
        // machine and no disk exist, so it costs nothing — a fact, not a gap.
        if (!deployment.flyApp) {
          return { name: deployment.name, preset: deployment.preset, read: true, built: false, disks: [], spareDisks: [], disksMonthlyUsd: 0, monthlyUsd: 0 };
        }
        const key = `${deployment.flyApp}|${deployment.machineId ?? ''}|${deployment.name}|${deployment.preset}`;
        const kept = this.cache.get(key);
        if (kept && now() - kept.at < (kept.cost.read ? ttl : failedTtl)) return kept.cost;
        let cost: WorkspaceSiteCost;
        try {
          cost = siteCostFrom(deployment, await this.opts.read(deployment));
        } catch (error) {
          console.warn('[site-costs] could not read a site\'s machine', { site: deployment.name, error: (error as Error).message });
          cost = { name: deployment.name, preset: deployment.preset, read: false, reason: 'unreadable' };
        }
        this.cache.set(key, { at: now(), cost });
        return cost;
      }));
    const priced = sites.filter((site) => site.read);
    return {
      hosted,
      sites,
      monthlyUsd: round2(priced.reduce((sum, site) => sum + (site.monthlyUsd ?? 0), 0)),
      unread: sites.length - priced.length,
      disclaimer: COST_ESTIMATE_DISCLAIMER,
    };
  }
}
