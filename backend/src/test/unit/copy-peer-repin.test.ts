import { describe, expect, it } from 'vitest';
import { CopyPeerRepin } from '../../services/copy-peer-repin.js';
import { FlyApiError, type FlyMachine, type FlyMachineConfig } from '../../services/fly-client.js';

const OLD = 'fdaa:e3:fa8c:a7b:32d:a05d:353a:2';
const NEW = 'fdaa:e3:fa8c:a7b:9e1:7c2:4b10:2';

function machine(id: string, state: FlyMachine['state'], pin: string | undefined, extra: Partial<FlyMachineConfig> = {}): FlyMachine {
  return {
    id,
    state,
    config: {
      image: 'registry.fly.io/copy-images:machine-2026.10.27.7',
      env: { AUTHORIZED_KEYS: 'ssh-ed25519 AAAA backend', ...(pin ? { BACKEND_PEER_IP: pin } : {}) },
      guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 },
      ...extra,
    } as FlyMachineConfig,
  };
}

function fakeFly(apps: Record<string, FlyMachine[]>, failures: { list?: Record<string, number>; get?: Record<string, FlyMachine> } = {}) {
  const writes: Array<{ appName: string; machineId: string; config: FlyMachineConfig; skipLaunch: boolean }> = [];
  const client = {
    async listMachines(appName: string) {
      const status = failures.list?.[appName];
      if (status) throw new FlyApiError(`HTTP ${status}`, status);
      return apps[appName] ?? [];
    },
    async getMachine(appName: string, machineId: string) {
      const override = failures.get?.[machineId];
      if (override) return override;
      const found = (apps[appName] ?? []).find((candidate) => candidate.id === machineId);
      if (!found) throw new FlyApiError('not found', 404);
      return found;
    },
    async updateMachine(appName: string, machineId: string, config: FlyMachineConfig, options: { skipLaunch?: boolean } = {}) {
      writes.push({ appName, machineId, config, skipLaunch: Boolean(options.skipLaunch) });
      const list = apps[appName] ?? [];
      const index = list.findIndex((candidate) => candidate.id === machineId);
      const updated = { ...list[index]!, config, state: options.skipLaunch ? list[index]!.state : 'started' as const };
      list[index] = updated;
      return updated;
    },
  };
  return { client, writes };
}

describe('a private copy re-pins its machines to the backend’s new address (note #815)', () => {
  it('moves asleep machines without waking them and restarts awake ones, keeping every other setting', async () => {
    const { client, writes } = fakeFly({
      'ia-agent-1': [machine('m-asleep', 'stopped', OLD)],
      'ia-agent-2': [machine('m-awake', 'started', OLD)],
      'iapp-site': [machine('m-site', 'started', OLD)],
      'ia-agent-3': [machine('m-current', 'stopped', NEW)],
    });
    const lines: string[] = [];
    const repin = new CopyPeerRepin({
      peerIp: NEW,
      flyClient: client,
      listApps: async () => ['ia-agent-1', 'ia-agent-2', 'iapp-site', 'ia-agent-3'],
      log: (line) => lines.push(line),
    });

    const pass = await repin.runPass();

    expect(pass).toEqual({ current: 1, repinnedAsleep: 1, repinnedAwake: 2, left: 0 });
    expect(writes.map((write) => [write.machineId, write.skipLaunch])).toEqual([
      ['m-asleep', true],
      ['m-awake', false],
      ['m-site', false],
    ]);
    for (const write of writes) {
      expect(write.config.env?.BACKEND_PEER_IP).toBe(NEW);
      expect(write.config.env?.AUTHORIZED_KEYS).toBe('ssh-ed25519 AAAA backend');
      expect(write.config.image).toBe('registry.fly.io/copy-images:machine-2026.10.27.7');
      expect(write.config.guest?.memory_mb).toBe(4096);
    }
    expect(lines.join('\n')).toContain(`3 machine(s) moved to ${NEW} (1 asleep, 2 awake, restarted), 1 already on it, 0 left`);

    // The next pass finds nothing to do and writes nothing.
    const again = await repin.runPass();
    expect(again).toEqual({ current: 4, repinnedAsleep: 0, repinnedAwake: 0, left: 0 });
    expect(writes).toHaveLength(3);
  });

  it('leaves a machine mid-change, one with no pin, and one Fly reads back incomplete', async () => {
    const incomplete = { id: 'm-incomplete', state: 'stopped', config: { env: { BACKEND_PEER_IP: OLD } } } as FlyMachine;
    const { client, writes } = fakeFly(
      {
        'ia-agent-1': [machine('m-starting', 'starting', OLD), machine('m-unpinned', 'stopped', undefined)],
        'ia-agent-2': [machine('m-incomplete', 'stopped', OLD)],
      },
      { get: { 'm-incomplete': incomplete } },
    );
    const repin = new CopyPeerRepin({ peerIp: NEW, flyClient: client, listApps: async () => ['ia-agent-1', 'ia-agent-2'], log: () => undefined });

    const pass = await repin.runPass();

    expect(pass).toEqual({ current: 0, repinnedAsleep: 0, repinnedAwake: 0, left: 2 });
    expect(writes).toEqual([]);
  });

  it('skips an app Fly no longer has, and counts one it could not read as left', async () => {
    const { client } = fakeFly({}, { list: { 'ia-gone': 404, 'ia-flaky': 503 } });
    const repin = new CopyPeerRepin({ peerIp: NEW, flyClient: client, listApps: async () => ['ia-gone', 'ia-flaky'], log: () => undefined });
    expect(await repin.runPass()).toEqual({ current: 0, repinnedAsleep: 0, repinnedAwake: 0, left: 1 });
  });

  it('tries again while something is left, then stops for this boot', async () => {
    let listed = 0;
    const { client } = fakeFly({ 'ia-agent-1': [machine('m-starting', 'starting', OLD)] });
    const lines: string[] = [];
    const repin = new CopyPeerRepin({
      peerIp: NEW,
      flyClient: client,
      listApps: async () => { listed += 1; return ['ia-agent-1']; },
      retryMs: 1,
      maxPasses: 3,
      log: (line) => lines.push(line),
    });
    repin.start(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    repin.stop();
    expect(listed).toBe(3);
    expect(lines.at(-1)).toContain('1 machine(s) still left after 3 passes; the next boot tries again');
  });

  it('does nothing without an address of its own', async () => {
    const { client, writes } = fakeFly({ 'ia-agent-1': [machine('m-asleep', 'stopped', OLD)] });
    const repin = new CopyPeerRepin({ peerIp: ' ', flyClient: client, listApps: async () => ['ia-agent-1'], log: () => undefined });
    expect(await repin.runPass()).toEqual({ current: 0, repinnedAsleep: 0, repinnedAwake: 0, left: 0 });
    expect(writes).toEqual([]);
  });
});
