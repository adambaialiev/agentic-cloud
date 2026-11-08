import { describe, expect, it, vi } from 'vitest';
import { FlyAppOrgContextResolver } from '../../services/fly-app-org-context.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';

const APP = 'ia-clientapp0001';
const NOW = Date.parse('2026-08-23T12:00:00Z');

async function makeWorld(args: {
  contextError?: Error;
  wireguard?: boolean;
  provisioningOnly?: boolean;
  /** What the hosting resolver answers, when not the workplace's own account. */
  context?: { source: 'org' | 'platform'; orgSlug: string; apiToken: string };
} = {}) {
  const userStorage = new InMemoryUserStorage();
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'u1' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'u1', role: 'admin' });
  await orgStorage.updateOrg(org.orgId, {
    fly: {
      orgSlug: 'acme-agents',
      tokenSecretName: 'FLY_ORG_TOKEN',
      ...(args.wireguard !== false
        ? { wireguard: { peerName: 'p', peerIp: 'fdaa:77:8899:a7b::2', endpoint: 'ams1.gateway.6pn.dev', gatewayPubkey: 'G=' } }
        : {}),
    },
  });
  await userStorage.createProfile('u1', {
    email: 'u1@x.io',
    telegram: {
      agents: {
        a1: args.provisioningOnly
          ? { id: 'a1', cli: 'claude', name: 'Dev', createdAt: 't', provisioningAppName: APP }
          : { id: 'a1', cli: 'claude', name: 'Dev', createdAt: 't', serverId: `fly_${APP}.9080e6d3a6e389`, connectedAt: 't' },
      },
    } as never,
  });
  const deploymentStorage = { listAll: vi.fn().mockResolvedValue([{ flyApp: 'iapp-dep000001', userId: 'u1' }]) };
  const resolveHostingContext = args.contextError
    ? vi.fn().mockRejectedValue(args.contextError)
    : vi.fn().mockResolvedValue(args.context ?? { source: 'org', orgSlug: 'acme-agents', apiToken: 'fo1_client' });
  const madeClients: string[] = [];
  const resolver = new FlyAppOrgContextResolver({
    userStorage,
    deploymentStorage: deploymentStorage as never,
    orgStorage,
    orgFly: { resolveHostingContext },
    platformOrgSlug: 'infinite-agents',
    platformBackendPeerIp: 'fdaa:99:600e:a7b::4e02',
    makeFlyClient: (token) => { madeClients.push(token); return { token } as never; },
    now: () => NOW,
  });
  return { resolver, userStorage, orgStorage, deploymentStorage, resolveHostingContext, madeClients, org };
}

describe('FlyAppOrgContextResolver', () => {
  it('resolves an agent app to its org context, peer included', async () => {
    const { resolver } = await makeWorld();
    const context = await resolver.resolve(APP);
    expect(context).toMatchObject({ orgSlug: 'acme-agents', backendPeerIp: 'fdaa:77:8899:a7b::2' });
  });

  it('resolves during provisioning: the marker precedes the app on Fly', async () => {
    const { resolver } = await makeWorld({ provisioningOnly: true });
    expect(await resolver.resolve(APP)).toMatchObject({ orgSlug: 'acme-agents' });
  });

  it('resolves the dedicated Workspace assistant before provisioning, despite its absence from the fleet', async () => {
    const { resolver, userStorage, org } = await makeWorld();
    const assistant = await userStorage.reserveWorkspaceAssistant('u1', org.orgId);
    await userStorage.updateAgentFields('u1', assistant!.id, { provisioningAppName: 'ia-workspace' });
    expect(await resolver.resolve('ia-workspace')).toMatchObject({ orgSlug: 'acme-agents' });
  });

  it('resolves a deployment app through its record', async () => {
    const { resolver } = await makeWorld();
    expect(await resolver.resolve('iapp-dep000001')).toMatchObject({ orgSlug: 'acme-agents' });
  });

  it('keeps an explicitly owned agent app in its original org after the user switches active org', async () => {
    const { resolver, userStorage, orgStorage, resolveHostingContext, org } = await makeWorld();
    await userStorage.updateAgentFields('u1', 'a1', { orgId: org.orgId });
    const another = await orgStorage.createOrg({ name: 'Another', createdByUserId: 'u1' });
    await orgStorage.addMember({ orgId: another.orgId, userId: 'u1', role: 'admin' });
    await orgStorage.setActiveOrg('u1', another.orgId);

    await resolver.resolve(APP);
    expect(resolveHostingContext).toHaveBeenCalledWith(org.orgId);
  });

  it('omits the peer when the org has none yet', async () => {
    const { resolver } = await makeWorld({ wireguard: false });
    const context = await resolver.resolve(APP);
    expect(context!.backendPeerIp).toBeUndefined();
  });

  it('a workplace sharing a Fly account with another one pins to that one\'s tunnel (2026-09-25)', async () => {
    // acme-trading: the first workplace owns the tunnel; a later one records
    // routed-elsewhere and has no peer, yet the host reaches its machines
    // through the first one's interface, from the first one's address.
    const { resolver, orgStorage } = await makeWorld({ wireguard: false });
    const first = await orgStorage.createOrg({ name: 'Acme Trading', createdByUserId: 'u2' });
    await orgStorage.updateOrg(first.orgId, {
      fly: {
        orgSlug: 'acme-agents',
        tokenSecretName: 'FLY_ORG_TOKEN',
        wireguard: { peerName: 'q', peerIp: 'fdaa:77:8899:a7b::7402', endpoint: 'ams1.gateway.6pn.dev', gatewayPubkey: 'H=' },
      },
    });
    const elsewhere = await orgStorage.createOrg({ name: 'Elsewhere', createdByUserId: 'u3' });
    await orgStorage.updateOrg(elsewhere.orgId, {
      fly: {
        orgSlug: 'other-agents',
        tokenSecretName: 'FLY_ORG_TOKEN',
        wireguard: { peerName: 'r', peerIp: 'fdaa:55:1111:a7b::2', endpoint: 'ams1.gateway.6pn.dev', gatewayPubkey: 'I=' },
      },
    });
    expect((await resolver.resolve(APP))!.backendPeerIp).toBe('fdaa:77:8899:a7b::7402');
  });

  it('a tunnel of another Fly account is never borrowed', async () => {
    const { resolver, orgStorage } = await makeWorld({ wireguard: false });
    const elsewhere = await orgStorage.createOrg({ name: 'Elsewhere', createdByUserId: 'u3' });
    await orgStorage.updateOrg(elsewhere.orgId, {
      fly: {
        orgSlug: 'other-agents',
        tokenSecretName: 'FLY_ORG_TOKEN',
        wireguard: { peerName: 'r', peerIp: 'fdaa:55:1111:a7b::2', endpoint: 'ams1.gateway.6pn.dev', gatewayPubkey: 'I=' },
      },
    });
    expect((await resolver.resolve(APP))!.backendPeerIp).toBeUndefined();
  });

  it('answers null only for unclaimed apps; a connected cloud that lost its token fails closed', async () => {
    const { resolver } = await makeWorld();
    expect(await resolver.resolve('ia-nobody00000001')).toBeNull();

    const tokenless = await makeWorld({ contextError: new Error('its token secret "FLY_ORG_TOKEN" is missing') });
    await expect(tokenless.resolver.resolve(APP)).rejects.toThrow(/token secret/);
  });

  it('a hosted workplace resolves to the platform account, pinned to the platform peer (note #664)', async () => {
    const { resolver, madeClients } = await makeWorld({
      wireguard: false,
      context: { source: 'platform', orgSlug: 'infinite-agents', apiToken: 'fo1_platform' },
    });
    const context = await resolver.resolve(APP);
    expect(context).toMatchObject({ orgSlug: 'infinite-agents', backendPeerIp: 'fdaa:99:600e:a7b::4e02' });
    expect(madeClients).toEqual(['fo1_platform']);
  });

  it('org #0, connected to the platform account with no tunnel of its own, gets the platform peer too', async () => {
    // Without it the machine booted with no pin at all and the image skipped
    // its firewall, leaving sshd open to every machine in the network.
    const { resolver } = await makeWorld({
      wireguard: false,
      context: { source: 'org', orgSlug: 'infinite-agents', apiToken: 'fo1_org0' },
    });
    expect((await resolver.resolve(APP))!.backendPeerIp).toBe('fdaa:99:600e:a7b::4e02');
  });

  it('org #0 with a tunnel recorded into the platform account still pins to the backend itself (note #1032 stage 4)', async () => {
    // The backend on Fly once opened a peer into its own organization and
    // recorded it; pinning to that peer locks the machine away from it.
    const { resolver } = await makeWorld({
      wireguard: true,
      context: { source: 'org', orgSlug: 'infinite-agents', apiToken: 'fo1_org0' },
    });
    expect((await resolver.resolve(APP))!.backendPeerIp).toBe('fdaa:99:600e:a7b::4e02');
  });

  it('caches the app→org answer and reuses one client per org', async () => {
    const { resolver, userStorage, madeClients } = await makeWorld();
    const spy = vi.spyOn(userStorage, 'getAllUsers');
    const first = await resolver.resolve(APP);
    const second = await resolver.resolve(APP);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(madeClients).toEqual(['fo1_client']);
    expect(second!.client).toBe(first!.client);
  });
});
