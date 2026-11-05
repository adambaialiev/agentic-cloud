import { describe, expect, it, vi } from 'vitest';
import { SiteCostReader, siteCostFrom } from '../../services/site-costs.js';
import {
  COST_ESTIMATE_DISCLAIMER,
  estimateGuestMonthlyUsd,
  estimateVolumeMonthlyUsd,
} from '../../config/fly-cost-estimates.js';
import type { DeploymentDocument } from '../../types/deployment.js';
import type { FlyMachine, FlyVolume } from '../../services/fly-client.js';

const site = (over: Partial<DeploymentDocument> = {}): DeploymentDocument => ({
  id: 'd1', userId: 'u1', orgId: 'o1', agentId: 'a1', name: 'launches', preset: 'service',
  flyApp: 'iapp-aaaaaaaaaaaa', machineId: 'm1', volumeId: 'v1', status: 'live',
  createdAt: '2026-10-01T00:00:00Z', ...over,
} as DeploymentDocument);

const machine = (over: Partial<FlyMachine> = {}, guest = { cpu_kind: 'shared', cpus: 1, memory_mb: 512 }): FlyMachine => ({
  id: 'm1', state: 'started', config: { guest, mounts: [{ volume: 'v1', path: '/data' }] }, ...over,
});
const volume = (id: string, sizeGb: number, over: Partial<FlyVolume> = {}): FlyVolume => ({ id, size_gb: sizeGb, state: 'created', ...over });

describe('site costs (note #993): priced from the spend view\'s table', () => {
  it('a running site is a full month of its machine plus its disk', () => {
    const cost = siteCostFrom(site(), { machines: [machine()], volumes: [volume('v1', 3, { attached_machine_id: 'm1' })] });
    const shape = estimateGuestMonthlyUsd({ cpu_kind: 'shared', cpus: 1, memory_mb: 512 });
    expect(cost).toMatchObject({
      read: true, preset: 'service',
      machine: { cpuKind: 'shared', cpus: 1, memoryMb: 512, running: true, monthlyUsd: shape },
      disks: [{ sizeGb: 3, monthlyUsd: estimateVolumeMonthlyUsd(3) }],
      spareDisks: [],
    });
    expect(cost.monthlyUsd).toBeCloseTo(shape + estimateVolumeMonthlyUsd(3), 2);
  });

  it('spare disks no machine mounts are listed and billed, and gone ones are not', () => {
    const cost = siteCostFrom(site(), {
      machines: [machine()],
      volumes: [volume('v1', 3), volume('v2', 3), volume('v3', 3), volume('v4', 3, { state: 'destroyed' })],
    });
    expect(cost.disks).toHaveLength(1);
    expect(cost.spareDisks).toEqual([
      { sizeGb: 3, monthlyUsd: estimateVolumeMonthlyUsd(3) },
      { sizeGb: 3, monthlyUsd: estimateVolumeMonthlyUsd(3) },
    ]);
    expect(cost.disksMonthlyUsd).toBeCloseTo(estimateVolumeMonthlyUsd(9), 2);
  });

  it('prices the machine Fly reports, not the preset the record names', () => {
    const cost = siteCostFrom(site({ preset: 'service' }), {
      machines: [machine({}, { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 })], volumes: [volume('v1', 3)],
    });
    expect(cost.machine?.memoryMb).toBe(1024);
    expect(cost.machine?.monthlyUsd).toBe(estimateGuestMonthlyUsd({ cpu_kind: 'shared', cpus: 1, memory_mb: 1024 }));
  });

  it('a stopped machine bills only its disks, and says what it costs when back', () => {
    const cost = siteCostFrom(site({ status: 'payment-lapsed' }), { machines: [machine({ state: 'stopped' })], volumes: [volume('v1', 1)] });
    expect(cost.machine).toMatchObject({ running: false, monthlyUsd: 0 });
    expect(cost.machine?.runningMonthlyUsd).toBeGreaterThan(0);
    expect(cost.monthlyUsd).toBe(estimateVolumeMonthlyUsd(1));
  });

  it('no machine is no figure, never a guess', () => {
    const cost = siteCostFrom(site(), { machines: [], volumes: [volume('v1', 3)] });
    expect(cost).toEqual({ name: 'launches', preset: 'service', read: false, reason: 'no-machine' });
  });
});

describe('site costs: the workplace\'s total', () => {
  it('sums what was read, counts what was not, and remembers a read for a minute', async () => {
    let now = 0;
    const read = vi.fn(async (doc: DeploymentDocument) => {
      if (doc.name === 'broken') throw new Error('fly is down');
      return { machines: [machine()], volumes: [volume('v1', 3)] };
    });
    const reader = new SiteCostReader({ read, now: () => now });
    const docs = [
      site({ name: 'launches' }),
      site({ id: 'd2', name: 'broken', flyApp: 'iapp-bbbbbbbbbbbb' }),
      site({ id: 'd3', name: 'reserved', flyApp: undefined, status: 'pending-payment' }),
      site({ id: 'd4', name: 'old', status: 'destroyed' }),
    ];
    const answer = await reader.forSites(docs, false);
    expect(answer.sites.map((entry) => [entry.name, entry.read])).toEqual([['launches', true], ['broken', false], ['reserved', true]]);
    expect(answer.sites[1]).toMatchObject({ reason: 'unreadable' });
    expect(answer.sites[2]).toMatchObject({ built: false, monthlyUsd: 0 });
    expect(answer.unread).toBe(1);
    expect(answer.monthlyUsd).toBe(answer.sites[0]!.monthlyUsd);
    expect(answer.disclaimer).toBe(COST_ESTIMATE_DISCLAIMER);
    expect(read).toHaveBeenCalledTimes(2);

    now = 30_000;
    await reader.forSites(docs, false);
    // The read site is remembered; the failed one is asked again.
    expect(read).toHaveBeenCalledTimes(3);
    now = 120_000;
    await reader.forSites(docs, true);
    expect(read).toHaveBeenCalledTimes(5);
  });
});
