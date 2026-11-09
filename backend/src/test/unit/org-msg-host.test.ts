import { describe, expect, it } from 'vitest';
import { ORG_MSG_IDLE_MS, ORG_MSG_WAKE_WINDOW_MS, OrgMsgHostOpening, OrgMsgHostService, OrgMsgHostUnavailable, isOrgMsgAppName, orgMsgAppName, type OrgMsgHostServiceDeps } from '../../services/org-msg-host.js';
import type { FlyMachine } from '../../services/fly-client.js';
import type { OrgDocument } from '../../types/org.js';

const ORG = 'ec4c119f-94f4-4880-affa-07828b90291c';
const PEER = 'fdaa:9:1:a7b:1::5';

function harness(options: {
  org?: Partial<OrgDocument> | null; image?: string | null; healthy?: () => boolean; platformPeer?: string;
  /** The account that hosts a workplace with no cloud of its own (ours, or a
   *  private copy's), as OrgFlyService.resolveHostingContext answers; null =
   *  this backend has none. */
  hosting?: string | null;
} = {}) {
  let org = options.org === null ? null : {
    orgId: ORG, name: 'Studio', fly: { orgSlug: 'studio', wireguard: { peerName: 'p', peerIp: PEER, endpoint: 'e', gatewayPubkey: 'k' } }, ...options.org,
  } as OrgDocument;
  const secrets = new Map<string, string>();
  const log: string[] = [];
  const machines: FlyMachine[] = [];
  /** Which account each app was made in. */
  const accounts: string[] = [];
  const volumes: { id: string; name: string; region: string }[] = [];
  let clock = 0;
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  let down = false;
  const deps: OrgMsgHostServiceDeps = {
    orgStorage: {
      getOrg: async () => org,
      updateOrg: async (_id, updates) => { org = { ...org!, ...updates } as OrgDocument; log.push('pointer'); return true; },
    },
    orgSecrets: {
      getOrgSecret: async (_id, name) => secrets.get(name) ?? null,
      setOrgSecret: async (_id, name, value) => { secrets.set(name, value); log.push('secret'); },
    },
    orgFly: {
      resolveHostingContext: async () => {
        if (org?.fly) return { source: 'org', orgSlug: org.fly.orgSlug, apiToken: 't' };
        const hosting = options.hosting === undefined ? 'acc-platform' : options.hosting;
        if (!hosting) throw new Error(`org ${ORG} has no Fly org of its own and this backend has no platform Fly account to host it`);
        return { source: 'platform', orgSlug: hosting, apiToken: 'p' };
      },
    },
    orgWireGuard: { ensureUpIfMissing: async () => { log.push('tunnel'); return { status: 'up', interfaceName: 'i', peerIp: PEER }; } },
    ...(options.image === null ? {} : { msgHostImage: options.image ?? 'ghcr.io/x/ia-machine-images:msg-host-sha-1' }),
    ...(options.platformPeer ? { platformBackendPeerIp: options.platformPeer } : {}),
    region: 'ams',
    now: () => clock,
    // The clock is fake; the yield is real, so the opening wait (8 s) and the
    // health poll (1 s) keep their order without the test taking that long.
    sleep: async (ms) => { clock += ms; await new Promise((r) => { setTimeout(r, ms >= 8_000 ? 25 : 1); }); },
    makeFlyClient: () => ({
      createApp: async ({ appName, orgSlug }) => { log.push(`app ${appName}`); accounts.push(orgSlug); },
      listVolumes: async () => [...volumes],
      createVolume: async (_app, args) => {
        log.push(`volume ${args.name} ${args.sizeGb}GB`);
        const volume = { id: 'vol_1', name: args.name, region: 'ams' };
        volumes.push(volume);
        return volume;
      },
      listMachines: async () => machines,
      createMachine: async (_app, args) => {
        log.push('machine');
        const machine = { id: 'm1', state: 'started', private_ip: 'fdaa:9:1:a7b:2::2', config: { image: args.image, guest: args.guest, env: args.env, mounts: args.mounts, services: args.services, restart: args.restart } } as FlyMachine;
        machines.push(machine);
        return machine;
      },
      getMachine: async () => machines[0]!,
      startMachine: async () => { log.push('start'); machines[0]!.state = 'started'; down = false; },
      // As Fly did on production (9 Nov 2026): the update is applied and a
      // stopped machine STAYS stopped.
      updateMachine: async (_app, _id, config) => { log.push(`update idle=${config.env?.MSG_HOST_IDLE_MS}`); machines[0]!.config = config; return machines[0]!; },
      waitForMachineState: async () => undefined,
      deleteMachine: async (_app, id) => { log.push(`destroy ${id}`); machines.splice(0, machines.length); },
      deleteVolume: async (_app, id) => { log.push(`delete ${id}`); volumes.splice(0, volumes.length); },
      deleteApp: async (app) => { log.push(`delete app ${app}`); },
    }) as ReturnType<NonNullable<OrgMsgHostServiceDeps['makeFlyClient']>>,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (down) throw new TypeError('fetch failed');
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ ok: options.healthy ? options.healthy() : true }), { status: 200 });
      }
      requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ unread: 3 }), { status: 200 });
    }) as typeof fetch,
  };
  return {
    service: new OrgMsgHostService(deps), log, machines, requests, secrets, accounts,
    org: () => org, advance: (ms: number) => { clock += ms; },
    sleepMachine: () => { machines[0]!.state = 'stopped'; down = true; },
  };
}

describe('the workplace messaging machine', () => {
  it('names its app after the workplace, in a shape the reaper can recognise', () => {
    expect(orgMsgAppName(ORG)).toBe('iamsg-ec4c119f94f4');
    expect(isOrgMsgAppName('iamsg-ec4c119f94f4')).toBe(true);
    expect(isOrgMsgAppName('ia-ec4c119f')).toBe(false);
    expect(isOrgMsgAppName('iagit-ec4c119f94f4')).toBe(false);
  });

  it('builds once, in the safe order, closed to everything but the backend', async () => {
    const h = harness();
    expect(await h.service.call(ORG, 'unread', { userId: 'a' })).toEqual({ unread: 3 });
    expect(h.log).toEqual(['tunnel', 'app iamsg-ec4c119f94f4', 'volume msgdata 1GB', 'secret', 'machine', 'pointer']);
    const config = h.machines[0]!.config!;
    // Nothing published — not publicly and not on the private network's proxy.
    expect(config.services).toBeUndefined();
    // Always on since note #1109: it never sleeps, and comes back by itself.
    expect(config.restart).toEqual({ policy: 'always' });
    expect(config.env).toMatchObject({ MSG_HOST_IDLE_MS: '0' });
    expect(config.env).toMatchObject({ MSG_HOST_ORG: ORG, BACKEND_PEER_IP: PEER, MSG_HOST_SECRET: h.secrets.get('MSG_HOST_SECRET') });
    expect(h.org()!.messages!.host).toEqual({ app: 'iamsg-ec4c119f94f4', machineId: 'm1', privateIp: 'fdaa:9:1:a7b:2::2', volumeId: 'vol_1', secretName: 'MSG_HOST_SECRET' });
    // The pointer never holds the secret.
    expect(JSON.stringify(h.org())).not.toContain(h.secrets.get('MSG_HOST_SECRET')!);
    expect(h.requests[0]).toMatchObject({
      url: 'http://[fdaa:9:1:a7b:2::2]:8080/v1/unread',
      headers: { 'x-msg-host-secret': h.secrets.get('MSG_HOST_SECRET'), 'x-msg-host-org': ORG },
      body: { userId: 'a' },
    });
    // A second call dials straight in: no Fly, no rebuild.
    h.log.length = 0;
    await h.service.call(ORG, 'unread', { userId: 'a' });
    expect(h.log).toEqual([]);
  });

  it('wakes a machine that put itself to sleep, and repeats the dial that found it asleep', async () => {
    const h = harness();
    await h.service.call(ORG, 'unread', { userId: 'a' });
    h.log.length = 0;
    h.sleepMachine();
    expect(await h.service.call(ORG, 'read', { userId: 'a' })).toEqual({ unread: 3 });
    expect(h.log).toEqual(['tunnel', 'start']);
    // Past the warm window it asks Fly first instead of dialing a dead address.
    h.log.length = 0; h.advance(60 * 60_000); h.sleepMachine();
    await h.service.call(ORG, 'unread', { userId: 'a' });
    expect(h.log).toEqual(['tunnel', 'start']);
  });

  it('says "opening" rather than hanging while a slow build goes on, and shares that one build', async () => {
    let healthy = false;
    const h = harness({ healthy: () => healthy });
    await expect(h.service.call(ORG, 'inbox', { userId: 'a' })).rejects.toBeInstanceOf(OrgMsgHostOpening);
    await expect(h.service.call(ORG, 'inbox', { userId: 'a' })).rejects.toBeInstanceOf(OrgMsgHostOpening);
    healthy = true;
    await expect(h.service.call(ORG, 'inbox', { userId: 'a' })).resolves.toEqual({ unread: 3 });
    expect(h.log.filter((line) => line === 'machine')).toHaveLength(1);
  });

  it('refuses to build a machine it could not close: no backend peer, no machine', async () => {
    const h = harness({ org: { fly: { orgSlug: 'studio' } } });
    await expect(h.service.call(ORG, 'inbox', { userId: 'a' })).rejects.toBeInstanceOf(OrgMsgHostUnavailable);
    expect(h.log).toEqual(['tunnel']);
    // A workplace in the platform's own cloud is reached through the platform's peer.
    const zero = harness({ org: { fly: { orgSlug: 'platform' } }, platformPeer: 'fdaa:0:1:a7b::9' });
    await zero.service.call(ORG, 'inbox', { userId: 'a' });
    expect(zero.machines[0]!.config!.env!.BACKEND_PEER_IP).toBe('fdaa:0:1:a7b::9');
  });

  it('is plainly unavailable with no account to live in or without an image, and builds nothing', async () => {
    const noCloud = harness({ org: { fly: undefined }, hosting: null, platformPeer: 'fdaa:0:1:a7b::9' });
    await expect(noCloud.service.call(ORG, 'inbox', { userId: 'a' })).rejects.toThrow(/cloud account to live in/);
    expect(noCloud.log).toEqual([]);
    const noImage = harness({ image: null });
    await expect(noImage.service.call(ORG, 'inbox', { userId: 'a' })).rejects.toBeInstanceOf(OrgMsgHostUnavailable);
    expect(noImage.log).toEqual(['tunnel']);
  });

  // 29 Oct 2026: messages back on, and a workplace with no cloud of its own —
  // every hosted one, and every one in a private copy — is no longer refused.
  it('builds a hosted workplace\'s machine on the account that hosts it, closed to that account\'s backend address', async () => {
    const h = harness({ org: { fly: undefined }, hosting: 'acc-platform', platformPeer: 'fdaa:0:1:a7b::9' });
    expect(await h.service.call(ORG, 'unread', { userId: 'a' })).toEqual({ unread: 3 });
    expect(h.accounts).toEqual(['acc-platform']);
    // No tunnel: that is a connected account's own peer, and there is none.
    expect(h.log).toEqual(['app iamsg-ec4c119f94f4', 'volume msgdata 1GB', 'secret', 'machine', 'pointer']);
    const config = h.machines[0]!.config!;
    expect(config.env!.BACKEND_PEER_IP).toBe('fdaa:0:1:a7b::9');
    expect(config.env!.MSG_HOST_ORG).toBe(ORG);
    expect(config.env!.MSG_HOST_SECRET).toBe(h.secrets.get('MSG_HOST_SECRET'));
    expect(config.services ?? []).toEqual([]);
    expect(h.requests[0]!.headers['x-msg-host-secret']).toBe(h.secrets.get('MSG_HOST_SECRET'));
  });

  it('in a private copy: the company\'s own account, the backend machine\'s own address, the workplace\'s own secret', async () => {
    // A copy's backend hosts every workplace in the company's Fly org (its
    // FLY_ORG), and the installer sets FLY_BACKEND_PEER_IP to the backend
    // machine's private address — the one caller the image lets in.
    const copy = harness({ org: { fly: undefined }, hosting: 'acme-agents', platformPeer: 'fdaa:3:77:a7b:1c2::2' });
    await copy.service.call(ORG, 'inbox', { userId: 'a' });
    expect(copy.accounts).toEqual(['acme-agents']);
    expect(copy.machines[0]!.config!.env!.BACKEND_PEER_IP).toBe('fdaa:3:77:a7b:1c2::2');
    expect(copy.secrets.get('MSG_HOST_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    // And with no address of its own to admit, nothing is built.
    const unpinned = harness({ org: { fly: undefined }, hosting: 'acme-agents' });
    await expect(unpinned.service.call(ORG, 'inbox', { userId: 'a' })).rejects.toBeInstanceOf(OrgMsgHostUnavailable);
    expect(unpinned.log.filter((line) => line === 'machine')).toHaveLength(0);
  });

  it('a connected workplace still builds in its own account, through its own tunnel', async () => {
    const h = harness();
    await h.service.call(ORG, 'inbox', { userId: 'a' });
    expect(h.accounts).toEqual(['studio']);
    expect(h.log[0]).toBe('tunnel');
  });

  it('deleting a hosted workplace destroys its machine; one in the workplace\'s own cloud stays', async () => {
    const hosted = harness({ org: { fly: undefined }, platformPeer: 'fdaa:0:1:a7b::9' });
    await hosted.service.call(ORG, 'inbox', { userId: 'a' });
    expect(await hosted.service.releaseHostedMachine(ORG)).toBe('iamsg-ec4c119f94f4');
    expect(hosted.log.slice(-3)).toEqual(['destroy m1', 'delete vol_1', 'delete app iamsg-ec4c119f94f4']);
    const own = harness();
    await own.service.call(ORG, 'inbox', { userId: 'a' });
    expect(await own.service.releaseHostedMachine(ORG)).toBeNull();
    expect(own.log.some((line) => line.startsWith('destroy') || line.startsWith('delete'))).toBe(false);
  });

  describe('woken from Home, and asleep after thirty minutes (note #1104)', () => {
    const settle = () => new Promise((r) => { setTimeout(r, 20); });
    it('builds new machines always on (note #1109): no idle stop, restart always', async () => {
      const h = harness();
      await h.service.call(ORG, 'unread', { userId: 'a' });
      expect(ORG_MSG_IDLE_MS).toBe(0);
      expect(h.machines[0]!.config!.env).toMatchObject({ MSG_HOST_IDLE_MS: '0' });
      expect(h.machines[0]!.config!.restart).toEqual({ policy: 'always' });
    });
    it('starts a sleeping machine in the background, reading nothing, at most once a minute', async () => {
      const h = harness();
      await h.service.call(ORG, 'unread', { userId: 'a' });
      h.requests.length = 0; h.log.length = 0;
      h.advance(30 * 60_000); h.sleepMachine();
      expect(await h.service.wake(ORG)).toBe('waking');
      await settle();
      expect(h.log).toEqual(['tunnel', 'start']);
      // Nothing was read from it: no operation reached the machine.
      expect(h.requests).toEqual([]);
      // Up now, so the next read dials straight in with no Fly call.
      h.log.length = 0;
      await h.service.call(ORG, 'unread', { userId: 'a' });
      expect(h.log).toEqual([]);
      // Home redrawn again and again: no second start inside the window.
      h.sleepMachine(); h.advance(27 * 60_000);
      expect(await h.service.wake(ORG)).toBe('waking');
      h.log.length = 0;
      expect(await h.service.wake(ORG)).toBe('recent');
      h.advance(ORG_MSG_WAKE_WINDOW_MS - 1);
      expect(await h.service.wake(ORG)).toBe('recent');
    });
    it('a warm machine is left alone, and a workplace with no machine is never built from Home', async () => {
      const h = harness();
      expect(await h.service.wake(ORG)).toBe('none');
      expect(h.log).toEqual([]);
      await h.service.call(ORG, 'unread', { userId: 'a' });
      h.log.length = 0;
      expect(await h.service.wake(ORG)).toBe('warm');
      expect(h.log).toEqual([]);
    });
    it('a machine built with an idle stop is moved onto always-on when next woken from stopped, and started after the update', async () => {
      const h = harness();
      await h.service.call(ORG, 'unread', { userId: 'a' });
      h.machines[0]!.config = { ...h.machines[0]!.config!, env: { ...h.machines[0]!.config!.env, MSG_HOST_IDLE_MS: String(10 * 60_000) }, restart: { policy: 'no' } } as never;
      h.advance(30 * 60_000); h.sleepMachine(); h.log.length = 0;
      await h.service.wake(ORG); await settle();
      // The update does not boot it, so it is started — once, and it answers.
      expect(h.log).toEqual(['tunnel', 'update idle=0', 'start']);
      expect(h.machines[0]!.config!.restart).toEqual({ policy: 'always' });
      expect(h.machines[0]!.state).toBe('started');
      h.log.length = 0;
      await h.service.call(ORG, 'unread', { userId: 'a' });
      expect(h.log).toEqual([]);
      expect(h.machines[0]!.config!.env).toMatchObject({ MSG_HOST_ORG: ORG, MSG_HOST_IDLE_MS: '0' });
    });
    it('a running machine under the old rule is moved too (one reboot), and the backend start sweeps every workplace', async () => {
      const h = harness();
      await h.service.call(ORG, 'unread', { userId: 'a' });
      h.machines[0]!.config = { ...h.machines[0]!.config!, env: { ...h.machines[0]!.config!.env, MSG_HOST_IDLE_MS: String(30 * 60_000) }, restart: { policy: 'no' } } as never;
      h.log.length = 0;
      await h.service.convergeAll([ORG]);
      expect(h.log).toEqual(['tunnel', 'update idle=0']);
      expect(h.machines[0]!.state).toBe('started');
      // Already current: the next sweep changes nothing.
      h.log.length = 0;
      await h.service.convergeAll([ORG]);
      expect(h.log).toEqual(['tunnel']);
    });
  });
});
