import { describe, expect, it, vi } from 'vitest';
import {
  OrgWireGuardService,
  OrgWireGuardError,
  ORG_WIREGUARD_PRIVATE_KEY_SECRET,
  mintWireGuardKeypair,
  orgWireGuardInterfaceName,
  renderWireGuardConfig,
  sixPnNetworkOf,
  type ExecResult,
} from '../../services/org-wireguard.js';
import { OrgSecretsService } from '../../services/org-secrets.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';

const PEER = {
  peerIp: 'fdaa:33:4455:a7b:16a9:1111:2222:3',
  endpoint: 'ams1.gateway.6pn.dev',
  gatewayPubkey: 'GATEWAY_PUB_KEY=',
};

/** Argv-recording exec whose per-command behavior tests can override. */
function makeExec(overrides: { linkExists?: boolean; foreignRoute?: string } = {}) {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const exec = vi.fn(async (argv: string[], opts?: { stdin?: string }): Promise<ExecResult> => {
    calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    if (argv[0] === 'ip' && argv[2] === 'route') {
      return { stdout: overrides.foreignRoute ?? '', stderr: '', code: 0 };
    }
    if (argv[0] === 'ip' && argv[1] === 'link') {
      return { stdout: '', stderr: '', code: overrides.linkExists ? 0 : 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  return { exec, calls };
}

async function makeWorld(args: {
  linkExists?: boolean;
  foreignRoute?: string;
  contextSource?: 'org' | 'platform-env';
  platformOrgSlug?: string;
} = {}) {
  const orgStorage = new InMemoryOrgStorage();
  const orgSecrets = new OrgSecretsService(new InMemorySecretStorage());
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'u1' });
  await orgStorage.updateOrg(org.orgId, { fly: { orgSlug: 'acme-agents', tokenSecretName: 'FLY_ORG_TOKEN' } });
  const { exec, calls } = makeExec(args);
  const flyClient = {
    resolveOrganizationId: vi.fn().mockResolvedValue('graphql-org-id'),
    addWireGuardPeer: vi.fn().mockResolvedValue(PEER),
    removeWireGuardPeer: vi.fn().mockResolvedValue(undefined),
  };
  const service = new OrgWireGuardService({
    orgStorage,
    orgSecrets,
    orgFly: {
      resolveOrgFlyContext: vi.fn().mockResolvedValue(
        args.contextSource === 'platform-env'
          ? { source: 'platform-env', orgSlug: 'infinite-agents', apiToken: 'fo1_platform' }
          : { source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_client' },
      ),
    },
    exec,
    makeFlyClient: () => flyClient,
    region: 'ams',
    ...(args.platformOrgSlug ? { platformOrgSlug: args.platformOrgSlug } : {}),
  });
  return { service, orgStorage, orgSecrets, org, exec, calls, flyClient };
}

describe('building blocks', () => {
  it('mints distinct 32-byte base64 keypairs', () => {
    const a = mintWireGuardKeypair();
    const b = mintWireGuardKeypair();
    for (const key of [a.privateKey, a.publicKey, b.privateKey, b.publicKey]) {
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
    }
    expect(a.privateKey).not.toBe(b.privateKey);
    // Cross-checked once against wireguard-tools on 2026-08-23:
    // `wg pubkey < privateKey` derives exactly this publicKey.
  });

  it('derives the 6PN /48 and refuses non-6PN addresses', () => {
    expect(sixPnNetworkOf('fdaa:99:600e:a7b:1:2:3:4')).toBe('fdaa:99:600e::/48');
    expect(() => sixPnNetworkOf('2001:db8::1')).toThrow(OrgWireGuardError);
  });

  it('interface names are stable, prefixed, and within IFNAMSIZ', () => {
    const name = orgWireGuardInterfaceName('org-abc');
    expect(name).toBe(orgWireGuardInterfaceName('org-abc'));
    expect(name).toMatch(/^iaorg-[0-9a-f]{8}$/);
    expect(name.length).toBeLessThanOrEqual(15);
    expect(orgWireGuardInterfaceName('org-xyz')).not.toBe(name);
  });

  it('renders the config shape the live rehearsal proved', () => {
    const conf = renderWireGuardConfig({
      privateKey: 'PRIV=',
      peerIp: PEER.peerIp,
      gatewayPubkey: PEER.gatewayPubkey,
      endpoint: PEER.endpoint,
      network: 'fdaa:33:4455::/48',
    });
    expect(conf).toContain(`Address = ${PEER.peerIp}/120`);
    expect(conf).toContain(`Endpoint = ${PEER.endpoint}:51820`);
    expect(conf).toContain('AllowedIPs = fdaa:33:4455::/48');
    expect(conf).toContain('PersistentKeepalive = 15');
  });
});

describe('OrgWireGuardService.ensureOrgWireGuard', () => {
  it('first run: registers, persists, writes conf, brings up, enables at boot', async () => {
    const { service, orgStorage, orgSecrets, org, calls, flyClient } = await makeWorld();

    const result = await service.ensureOrgWireGuard(org.orgId);

    expect(result.status).toBe('up');
    expect(flyClient.addWireGuardPeer).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'graphql-org-id',
      region: 'ams',
    }));
    // Private key persisted as an org secret, never on the doc.
    const privateKey = await orgSecrets.getOrgSecret(org.orgId, ORG_WIREGUARD_PRIVATE_KEY_SECRET);
    expect(privateKey).toBeTruthy();
    const stored = (await orgStorage.getOrg(org.orgId))!.fly!.wireguard!;
    expect(stored.peerIp).toBe(PEER.peerIp);
    expect(JSON.stringify(stored)).not.toContain(privateKey);
    // The conf file is created 0600 BEFORE content arrives, and the content
    // rides dd's stdin — the key is never in argv, never on disk world-readable.
    const confPath = `/etc/wireguard/${orgWireGuardInterfaceName(org.orgId)}.conf`;
    const install = calls.find((c) => c.argv[0] === 'install');
    expect(install!.argv).toEqual(['install', '-m', '600', '/dev/null', confPath]);
    const write = calls.find((c) => c.argv[0] === 'dd');
    expect(write!.argv).toEqual(['dd', `of=${confPath}`, 'status=none']);
    expect(write!.stdin).toContain(`PrivateKey = ${privateKey}`);
    expect(write!.stdin).toContain('AllowedIPs = fdaa:33:4455::/48');
    expect(calls.indexOf(install!)).toBeLessThan(calls.indexOf(write!));
    // Up (no prior down — link did not exist), then enabled for reboots.
    const argvHeads = calls.map((c) => c.argv.join(' '));
    expect(argvHeads).toContain(`wg-quick up ${orgWireGuardInterfaceName(org.orgId)}`);
    expect(argvHeads).not.toContain(`wg-quick down ${orgWireGuardInterfaceName(org.orgId)}`);
    expect(argvHeads).toContain(`systemctl enable wg-quick@${orgWireGuardInterfaceName(org.orgId)}`);
  });

  it('second run converges without re-registering, cycling a live interface', async () => {
    const { service, org, calls, flyClient } = await makeWorld({ linkExists: true });
    await service.ensureOrgWireGuard(org.orgId);
    flyClient.addWireGuardPeer.mockClear();
    calls.length = 0;

    const result = await service.ensureOrgWireGuard(org.orgId);

    expect(result.status).toBe('up');
    expect(flyClient.addWireGuardPeer).not.toHaveBeenCalled();
    const argvHeads = calls.map((c) => c.argv.join(' '));
    const iface = orgWireGuardInterfaceName(org.orgId);
    // wg-quick has no converge verb: a live interface is cycled down → up.
    expect(argvHeads.indexOf(`wg-quick down ${iface}`)).toBeGreaterThan(-1);
    expect(argvHeads.indexOf(`wg-quick up ${iface}`)).toBeGreaterThan(argvHeads.indexOf(`wg-quick down ${iface}`));
  });

  it('rolls back the registration on a route conflict and touches nothing on the host', async () => {
    const { service, orgStorage, orgSecrets, org, calls, flyClient } = await makeWorld({
      foreignRoute: 'fdaa:33:4455::/48 dev wg-legacy metric 1024',
    });

    const result = await service.ensureOrgWireGuard(org.orgId);

    expect(result).toEqual({
      status: 'route-conflict',
      network: 'fdaa:33:4455::/48',
      detail: 'fdaa:33:4455::/48 dev wg-legacy metric 1024',
    });
    // The just-registered peer was removed again; nothing persisted anywhere.
    expect(flyClient.removeWireGuardPeer).toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringContaining('ia-backend-') }));
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_WIREGUARD_PRIVATE_KEY_SECRET)).toBeNull();
    expect((await orgStorage.getOrg(org.orgId))!.fly!.wireguard).toBeUndefined();
    expect(calls.some((c) => c.argv[0] === 'install' || c.argv[0] === 'wg-quick')).toBe(false);
  });

  it('replaces a peer whose private key secret is gone', async () => {
    const { service, orgSecrets, org, flyClient } = await makeWorld();
    await service.ensureOrgWireGuard(org.orgId);
    await orgSecrets.deleteOrgSecret(org.orgId, ORG_WIREGUARD_PRIVATE_KEY_SECRET);
    flyClient.addWireGuardPeer.mockClear();

    const result = await service.ensureOrgWireGuard(org.orgId);

    expect(result.status).toBe('up');
    // Old peer removed, new one registered — a peer without its key is dead weight.
    expect(flyClient.removeWireGuardPeer).toHaveBeenCalled();
    expect(flyClient.addWireGuardPeer).toHaveBeenCalledTimes(1);
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_WIREGUARD_PRIVATE_KEY_SECRET)).toBeTruthy();
  });

  it('refuses an org still on the platform-env fallback', async () => {
    const { service, org } = await makeWorld({ contextSource: 'platform-env' });
    await expect(service.ensureOrgWireGuard(org.orgId)).rejects.toThrow(/no Fly org of its own/);
  });
});

describe('OrgWireGuardService.ensureUpIfMissing (the pre-provisioning converge)', () => {
  it('a live interface is left exactly as it is — probed, never flapped', async () => {
    const { service, orgStorage, org, calls, flyClient } = await makeWorld({ linkExists: true });
    await orgStorage.updateOrg(org.orgId, {
      fly: {
        orgSlug: 'acme-agents',
        tokenSecretName: 'FLY_ORG_TOKEN',
        wireguard: { peerName: 'p', peerIp: PEER.peerIp, endpoint: 'e.gateway', gatewayPubkey: 'G=' },
      },
    });
    const result = await service.ensureUpIfMissing(org.orgId);
    expect(result).toEqual({
      status: 'up',
      interfaceName: expect.stringMatching(/^iaorg-/),
      peerIp: PEER.peerIp,
    });
    // ONE probe and nothing else: a full ensure here would down/up the
    // tunnel under other machines' live SSH.
    expect(calls.map((call) => call.argv.slice(0, 3))).toEqual([['ip', 'link', 'show']]);
    expect(flyClient.addWireGuardPeer).not.toHaveBeenCalled();
  });

  it('a missing interface falls through to the full ensure and comes up', async () => {
    const { service, org, calls } = await makeWorld({ linkExists: false });
    const result = await service.ensureUpIfMissing(org.orgId);
    expect(result.status).toBe('up');
    expect(calls.some((call) => call.argv[0] === 'wg-quick' && call.argv[1] === 'up')).toBe(true);
  });
});

/**
 * What the Workspace reads off the record (note #642).
 *
 * The card said "tunnel coming up" for org #0 forever, because the absence of
 * a peer was the only trace two very different outcomes left: a route
 * conflict (which is benign — the machines are reachable) and a bring-up that
 * threw (which is not). The attempt records itself now, so the card can tell
 * a reader which of them they are looking at.
 */
describe('the outcome of an attempt is recorded', () => {
  const checkOf = async (orgStorage: InMemoryOrgStorage, orgId: string) =>
    (await orgStorage.getOrg(orgId))!.fly!.peerCheck;

  it('a tunnel that comes up is recorded as up, with the moment it was read', async () => {
    const { service, orgStorage, org } = await makeWorld();
    await service.ensureOrgWireGuard(org.orgId);
    const check = await checkOf(orgStorage, org.orgId);
    expect(check?.status).toBe('up');
    expect(Date.parse(check!.at)).toBeGreaterThan(0);
    expect(check?.detail).toBeUndefined();
  });

  it('a route conflict is recorded as routed-elsewhere, naming the route that won', async () => {
    const { service, orgStorage, org } = await makeWorld({
      foreignRoute: 'fdaa:33:4455::/48 dev wg-legacy metric 1024',
    });
    await service.ensureOrgWireGuard(org.orgId);
    // Exactly org #0's case: no peer on the doc, and now a reason for it
    // rather than a silence the card has to guess at.
    expect((await orgStorage.getOrg(org.orgId))!.fly!.wireguard).toBeUndefined();
    expect(await checkOf(orgStorage, org.orgId)).toMatchObject({
      status: 'routed-elsewhere',
      detail: 'fdaa:33:4455::/48 dev wg-legacy metric 1024',
    });
  });

  it('an attempt that throws is recorded as failed, and still throws', async () => {
    const { service, orgStorage, org, flyClient } = await makeWorld();
    // Every time, not once: a single refusal is now met by replacing a stale
    // peer of our name and trying again, so only a PERSISTENT one is final.
    flyClient.addWireGuardPeer.mockRejectedValue(new Error('Fly said no'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(service.ensureOrgWireGuard(org.orgId)).rejects.toThrow('Fly said no');
    expect(await checkOf(orgStorage, org.orgId)).toMatchObject({ status: 'failed', detail: 'Fly said no' });
    warn.mockRestore();
  });

  it('a live interface records up without flapping anything', async () => {
    const { service, orgStorage, org, calls } = await makeWorld({ linkExists: true });
    await service.ensureUpIfMissing(org.orgId);
    expect(await checkOf(orgStorage, org.orgId)).toMatchObject({ status: 'up' });
    expect(calls.map((call) => call.argv.slice(0, 3))).toEqual([['ip', 'link', 'show']]);
  });

  it('an unchanged outcome costs no write — provisioning converges on every machine', async () => {
    const { service, orgStorage, org } = await makeWorld({ linkExists: true });
    await service.ensureUpIfMissing(org.orgId);
    const first = await checkOf(orgStorage, org.orgId);
    const writes = vi.spyOn(orgStorage, 'updateOrg');
    await service.ensureUpIfMissing(org.orgId);
    await service.ensureUpIfMissing(org.orgId);
    expect(writes).not.toHaveBeenCalled();
    // …and the stamp is the first reading's, not a clock that ticks for free.
    expect((await checkOf(orgStorage, org.orgId))!.at).toBe(first!.at);
    writes.mockRestore();
  });

  it('a torn-down tunnel takes its outcome with it', async () => {
    const { service, orgStorage, org } = await makeWorld();
    await service.ensureOrgWireGuard(org.orgId);
    await service.removeOrgWireGuard(org.orgId);
    const fly = (await orgStorage.getOrg(org.orgId))!.fly!;
    expect(fly.wireguard).toBeUndefined();
    // Nothing has been tried since: the reader is owed a silence, not the
    // last answer from a tunnel that no longer exists.
    expect(fly.peerCheck).toBeUndefined();
  });
});

/**
 * Found live on 2026-09-23. Org #0's network is routed by the legacy peer, so
 * every converge for it registered `ia-backend-<hash>` with Fly only to learn
 * that and roll it straight back — on every machine build. One roll-back
 * failed silently, stranding `ia-backend-8d47d7ff` in its Fly org, and from
 * then on every registration collided with that name and threw, which the
 * card (rightly, once outcomes were kept) reported as a tunnel that was down.
 */
describe('a remembered route, and a stale peer of our own name', () => {
  const LEGACY = 'fdaa:33:4455::/48 dev wg-legacy metric 1024';

  it('remembers the network it found routed, so the next converge never asks Fly', async () => {
    const { service, orgStorage, org, flyClient } = await makeWorld({ foreignRoute: LEGACY });
    await service.ensureOrgWireGuard(org.orgId);
    expect((await orgStorage.getOrg(org.orgId))!.fly!.peerCheck).toMatchObject({
      status: 'routed-elsewhere', network: 'fdaa:33:4455::/48',
    });
    flyClient.addWireGuardPeer.mockClear();
    flyClient.removeWireGuardPeer.mockClear();

    const again = await service.ensureOrgWireGuard(org.orgId);
    await service.ensureUpIfMissing(org.orgId);

    expect(again).toMatchObject({ status: 'route-conflict', network: 'fdaa:33:4455::/48' });
    // The whole point: no register-then-roll-back round trip, so no chance
    // to strand a peer on every machine build.
    expect(flyClient.addWireGuardPeer).not.toHaveBeenCalled();
    expect(flyClient.removeWireGuardPeer).not.toHaveBeenCalled();
  });

  it('registers for real once the route it remembered is gone', async () => {
    const { service, org, exec, flyClient } = await makeWorld({ foreignRoute: LEGACY });
    await service.ensureOrgWireGuard(org.orgId);
    flyClient.addWireGuardPeer.mockClear();
    // The legacy peer is retired: nothing routes the network any more.
    const base = exec.getMockImplementation()!;
    exec.mockImplementation(async (argv: string[], opts?: { stdin?: string }) => (
      argv[0] === 'ip' && argv[2] === 'route' ? { stdout: '', stderr: '', code: 0 } : base(argv, opts)
    ));

    const result = await service.ensureOrgWireGuard(org.orgId);

    expect(result.status).toBe('up');
    expect(flyClient.addWireGuardPeer).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale peer holding our name, and comes up', async () => {
    const { service, orgStorage, org, flyClient } = await makeWorld();
    flyClient.addWireGuardPeer.mockRejectedValueOnce(new Error('Fly GraphQL error: name has already been taken'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.ensureOrgWireGuard(org.orgId);

    expect(result.status).toBe('up');
    const name = expect.stringMatching(/^ia-backend-[0-9a-f]{8}$/);
    expect(flyClient.removeWireGuardPeer).toHaveBeenCalledWith(expect.objectContaining({ name }));
    expect(flyClient.addWireGuardPeer).toHaveBeenCalledTimes(2);
    expect((await orgStorage.getOrg(org.orgId))!.fly!.peerCheck?.status).toBe('up');
    warn.mockRestore();
  });

  it('a stale peer that cannot be replaced is a real failure, recorded as one', async () => {
    const { service, orgStorage, org, flyClient } = await makeWorld();
    flyClient.addWireGuardPeer.mockRejectedValue(new Error('name has already been taken'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(service.ensureOrgWireGuard(org.orgId)).rejects.toThrow('name has already been taken');

    // Once, not forever: a heal that does not take is reported, not retried
    // in a loop on every machine build.
    expect(flyClient.addWireGuardPeer).toHaveBeenCalledTimes(2);
    expect((await orgStorage.getOrg(org.orgId))!.fly!.peerCheck).toMatchObject({ status: 'failed' });
    warn.mockRestore();
  });

  it('says so when a roll-back fails, instead of swallowing it', async () => {
    const { service, org, flyClient } = await makeWorld({ foreignRoute: LEGACY });
    flyClient.removeWireGuardPeer.mockRejectedValueOnce(new Error('Fly is down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.ensureOrgWireGuard(org.orgId);

    expect(result.status).toBe('route-conflict');
    expect(warn.mock.calls.some((call) => String(call[0]).includes('stale peer is left'))).toBe(true);
    warn.mockRestore();
  });
});

describe('OrgWireGuardService.removeOrgWireGuard', () => {
  it('tears down interface, conf, Fly peer, secret, and doc entry', async () => {
    const { service, orgStorage, orgSecrets, org, calls, flyClient } = await makeWorld();
    await service.ensureOrgWireGuard(org.orgId);
    const stored = (await orgStorage.getOrg(org.orgId))!.fly!.wireguard!;
    calls.length = 0;

    await service.removeOrgWireGuard(org.orgId);

    const iface = orgWireGuardInterfaceName(org.orgId);
    const argvHeads = calls.map((c) => c.argv.join(' '));
    expect(argvHeads).toContain(`systemctl disable wg-quick@${iface}`);
    expect(argvHeads).toContain(`rm -f /etc/wireguard/${iface}.conf`);
    expect(flyClient.removeWireGuardPeer).toHaveBeenCalledWith({ organizationId: 'graphql-org-id', name: stored.peerName });
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_WIREGUARD_PRIVATE_KEY_SECRET)).toBeNull();
    expect((await orgStorage.getOrg(org.orgId))!.fly!.wireguard).toBeUndefined();
  });

  it('downs a live interface while the conf still exists — the unit was never active', async () => {
    const { service, org, calls } = await makeWorld({ linkExists: true });
    await service.ensureOrgWireGuard(org.orgId);
    calls.length = 0;

    await service.removeOrgWireGuard(org.orgId);

    const iface = orgWireGuardInterfaceName(org.orgId);
    const argvHeads = calls.map((c) => c.argv.join(' '));
    // Down BEFORE rm: wg-quick reads the conf to undo itself. `disable --now`
    // used to stand alone here and stopped nothing — bringUp starts the
    // interface with wg-quick directly, so the unit is inactive and the
    // interface (with the org network's /48 route on it) survived every
    // teardown, tripping the next org's route-conflict check.
    expect(argvHeads.indexOf(`wg-quick down ${iface}`)).toBeGreaterThan(-1);
    expect(argvHeads.indexOf(`wg-quick down ${iface}`))
      .toBeLessThan(argvHeads.indexOf(`rm -f /etc/wireguard/${iface}.conf`));
    expect(argvHeads).not.toContain(`ip link delete ${iface}`);
  });

  it('a failing wg-quick down falls back to deleting the link outright', async () => {
    const { service, org, calls, exec } = await makeWorld({ linkExists: true });
    const base = exec.getMockImplementation()!;
    exec.mockImplementation(async (argv: string[], opts?: { stdin?: string }) => {
      if (argv[0] === 'wg-quick' && argv[1] === 'down') {
        calls.push({ argv });
        return { stdout: '', stderr: `/etc/wireguard/x.conf' does not exist`, code: 1 };
      }
      return base(argv, opts);
    });

    await service.removeOrgWireGuard(org.orgId);

    const iface = orgWireGuardInterfaceName(org.orgId);
    expect(calls.map((c) => c.argv.join(' '))).toContain(`ip link delete ${iface}`);
  });
});

describe('a workplace whose cloud is the backend\'s own Fly organization (note #1032 stage 4)', () => {
  it('never gets a tunnel, even with nothing routing its network: the backend is already in it', async () => {
    // On a Fly machine nothing routes the /48, so the route guard alone let a
    // peer into our own organization come up on 7 Nov 2026.
    const { service, org, orgStorage, calls, flyClient } = await makeWorld({ platformOrgSlug: 'acme-agents' });

    const result = await service.ensureUpIfMissing(org.orgId);

    expect(result.status).toBe('route-conflict');
    expect(flyClient.addWireGuardPeer).not.toHaveBeenCalled();
    expect(calls.some((call) => call.argv[0] === 'wg-quick')).toBe(false);
    expect((await orgStorage.getOrg(org.orgId))?.fly?.peerCheck?.status).toBe('routed-elsewhere');
  });

  it('a workplace in another organization still gets its tunnel', async () => {
    const { service, org, flyClient } = await makeWorld({ platformOrgSlug: 'infinite-agents' });
    expect((await service.ensureOrgWireGuard(org.orgId)).status).toBe('up');
    expect(flyClient.addWireGuardPeer).toHaveBeenCalledTimes(1);
  });
});
