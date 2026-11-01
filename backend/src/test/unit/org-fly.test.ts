import { describe, expect, it, vi } from 'vitest';
import { OrgFlyService, OrgFlyError, ORG_FLY_TOKEN_SECRET_NAME } from '../../services/org-fly.js';
import { OrgSecretsService } from '../../services/org-secrets.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';

async function makeWorld(args: {
  listApps?: ReturnType<typeof vi.fn>;
  listOrganizations?: ReturnType<typeof vi.fn>;
  getOrganizationBilling?: ReturnType<typeof vi.fn>;
  platform?: { orgSlug: string; apiToken: string };
} = {}) {
  const orgStorage = new InMemoryOrgStorage();
  const orgSecrets = new OrgSecretsService(new InMemorySecretStorage());
  const org = await orgStorage.createOrg({ name: 'Acme Trading', createdByUserId: 'u1' });
  const listApps = args.listApps ?? vi.fn().mockResolvedValue([{ name: 'client-app-1' }, { name: 'client-app-2' }]);
  // The token is the authority on its org: by default it sees exactly one.
  const listOrganizations = args.listOrganizations
    ?? vi.fn().mockResolvedValue([{ slug: 'acme-agents', name: 'Acme Trading' }]);
  const makeFlyClient = vi.fn(() => ({
    listApps,
    listOrganizations,
    ...(args.getOrganizationBilling ? { getOrganizationBilling: args.getOrganizationBilling } : {}),
  }));
  const service = new OrgFlyService({
    orgStorage,
    orgSecrets,
    makeFlyClient,
    ...(args.platform ? { platform: args.platform } : {}),
  });
  return { orgStorage, orgSecrets, org, service, listApps, listOrganizations, makeFlyClient };
}

describe('OrgFlyService.connectOrgFly', () => {
  it('derives the org FROM the token — no name asked — then writes the secret and pointer', async () => {
    const { service, orgStorage, orgSecrets, org, listApps, makeFlyClient } = await makeWorld();

    const result = await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' });

    expect(result).toEqual({ connected: true, orgSlug: 'acme-agents', appCount: 2, moved: false });
    // Validation used the OFFERED token, not anything ambient — and the
    // proof-of-life app list ran against the org the token named.
    expect(makeFlyClient).toHaveBeenCalledWith('fo1_client');
    expect(listApps).toHaveBeenCalledWith('acme-agents');
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBe('fo1_client');
    expect((await orgStorage.getOrg(org.orgId))!.fly).toEqual({
      orgSlug: 'acme-agents',
      tokenSecretName: ORG_FLY_TOKEN_SECRET_NAME,
    });
  });

  it('the real name wins over what anyone typed — Fly de-duplicates silently', async () => {
    // The dashboard said "big-bang"; Fly's real name is "big-bang-988". The
    // typed name (an optional hint from scripts) never overrides the token.
    const { service, orgStorage, org } = await makeWorld({
      listApps: vi.fn().mockResolvedValue([]),
      listOrganizations: vi.fn().mockResolvedValue([{ slug: 'big-bang-988', name: 'big-bang' }]),
    });
    const result = await service.connectOrgFly({ orgId: org.orgId, orgSlug: 'big-bang', token: 'fo1_ok' });
    expect(result).toEqual({ connected: true, orgSlug: 'big-bang-988', appCount: 0, moved: false });
    expect((await orgStorage.getOrg(org.orgId))!.fly!.orgSlug).toBe('big-bang-988');
  });

  it('a second token for the SAME org rotates in place, peer and all', async () => {
    // The common re-paste (note #372): a key was leaked or expired. Nothing
    // about the cloud moves, so the WireGuard peer — which is a registration
    // in THIS account, on THIS network, with a key we still hold — is carried
    // over rather than dropped. Re-minting it would flap a live tunnel.
    const { service, orgSecrets, orgStorage, org } = await makeWorld();
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_old' });
    const peer = {
      peerName: 'ia-backend-o1', peerIp: 'fdaa:9:1::2', endpoint: 'ams1.gw:51820', gatewayPubkey: 'gw=',
    };
    await orgStorage.updateOrg(org.orgId, {
      fly: { ...(await orgStorage.getOrg(org.orgId))!.fly!, wireguard: peer },
    });

    const result = await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_new' });

    expect(result).toEqual({
      connected: true, orgSlug: 'acme-agents', appCount: 2, previousSlug: 'acme-agents', moved: false,
    });
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBe('fo1_new');
    expect((await orgStorage.getOrg(org.orgId))!.fly!.wireguard).toEqual(peer);
  });

  it('a token for a DIFFERENT org asks first and writes nothing', async () => {
    // The whole point of note #372's guard: everything already running stays
    // in the old account and goes out of this platform's reach, so the move
    // cannot happen on the same tap that reveals it is a move.
    const { service, orgSecrets, orgStorage, org, listOrganizations } = await makeWorld({
      listOrganizations: vi.fn()
        .mockResolvedValueOnce([{ slug: 'acme-agents', name: 'Acme' }])
        .mockResolvedValue([{ slug: 'acme-agents-2', name: 'Acme 2' }]),
    });
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_old' });

    const asked = await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_elsewhere' });

    expect(asked).toEqual({
      connected: false,
      move: {
        fromSlug: 'acme-agents',
        toSlug: 'acme-agents-2',
        appCount: 2,
        // This org has no git host, buckets or media of its own, so the
        // question says so rather than warning about things it does not have.
        leaves: { gitHost: false, gitBackup: false, media: false },
      },
    });
    // Nothing at all committed: the pointer and the token are the old ones.
    expect((await orgStorage.getOrg(org.orgId))!.fly!.orgSlug).toBe('acme-agents');
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBe('fo1_old');
    expect(listOrganizations).toHaveBeenCalledTimes(2);
  });

  it('the same token with `replace` moves the pointer and drops the old peer', async () => {
    const { service, orgSecrets, orgStorage, org } = await makeWorld({
      listOrganizations: vi.fn()
        .mockResolvedValueOnce([{ slug: 'acme-agents', name: 'Acme' }])
        .mockResolvedValue([{ slug: 'acme-agents-2', name: 'Acme 2' }]),
    });
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_old' });
    await orgStorage.updateOrg(org.orgId, {
      fly: {
        ...(await orgStorage.getOrg(org.orgId))!.fly!,
        wireguard: {
          peerName: 'ia-backend-o1', peerIp: 'fdaa:9:1::2', endpoint: 'ams1.gw:51820', gatewayPubkey: 'gw=',
        },
      },
    });

    const result = await service.connectOrgFly({
      orgId: org.orgId, token: 'fo1_elsewhere', replace: 'acme-agents-2',
    });

    expect(result).toEqual({
      connected: true, orgSlug: 'acme-agents-2', appCount: 2, previousSlug: 'acme-agents', moved: true,
    });
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBe('fo1_elsewhere');
    // A peer into the account we just left is not a peer into this one: it
    // goes, so the next ensure mints one where the machines now are.
    expect((await orgStorage.getOrg(org.orgId))!.fly).toEqual({
      orgSlug: 'acme-agents-2', tokenSecretName: ORG_FLY_TOKEN_SECRET_NAME,
    });
  });

  it('the question names what the org would strand besides its machines', async () => {
    // Oscar's review of PR #735: a move takes the git host, its backups and
    // the attachment bucket out of reach too — all three are apps and
    // extensions in the account being left. A warning about machines alone
    // reads as a promise about the rest.
    const { service, orgStorage, org } = await makeWorld({
      listOrganizations: vi.fn()
        .mockResolvedValueOnce([{ slug: 'acme-agents', name: 'Acme' }])
        .mockResolvedValue([{ slug: 'acme-agents-2', name: 'Acme 2' }]),
    });
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_old' });
    await orgStorage.updateOrg(org.orgId, {
      git: {
        namespaceId: 'n1',
        host: { app: 'iagit-o1', flycastIp: 'fdaa::3', volumeId: 'vol_1' },
        backup: { addOnName: 'bk', bucket: 'b', endpoint: 'e' },
      },
      media: { addOnName: 'md', bucket: 'm', endpoint: 'e' },
    });

    const asked = await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_elsewhere' });

    expect(asked).toMatchObject({
      connected: false,
      move: { leaves: { gitHost: true, gitBackup: true, media: true } },
    });
  });

  it('consent names the org it agreed to, and a token that has moved on refuses', async () => {
    // A bare yes is a yes to whatever the SECOND resolution finds, and the
    // two resolutions are separate calls into Fly: a token whose visibility
    // changed in between would land the org somewhere nobody was shown.
    const { service, orgSecrets, orgStorage, org } = await makeWorld({
      listOrganizations: vi.fn()
        .mockResolvedValueOnce([{ slug: 'acme-agents', name: 'Acme' }])
        .mockResolvedValue([{ slug: 'somewhere-else', name: 'Elsewhere' }]),
    });
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_old' });

    await expect(
      service.connectOrgFly({ orgId: org.orgId, token: 'fo1_elsewhere', replace: 'acme-agents-2' }),
    ).rejects.toThrow(/now points at Fly org "somewhere-else", not the "acme-agents-2" you agreed to/);
    expect((await orgStorage.getOrg(org.orgId))!.fly!.orgSlug).toBe('acme-agents');
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBe('fo1_old');
  });

  it('`replace` on a FIRST connect is harmless — there is nothing to move from', async () => {
    const { service, orgStorage, org } = await makeWorld();
    const result = await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client', replace: 'acme-agents' });
    expect(result).toEqual({ connected: true, orgSlug: 'acme-agents', appCount: 2, moved: false });
    expect((await orgStorage.getOrg(org.orgId))!.fly!.orgSlug).toBe('acme-agents');
  });

  it('refuses a token Fly itself rejects, and commits nothing', async () => {
    const { service, orgSecrets, orgStorage, org } = await makeWorld({
      listOrganizations: vi.fn().mockRejectedValue(new Error('401 unauthorized')),
    });
    await expect(
      service.connectOrgFly({ orgId: org.orgId, token: 'fo1_typo' }),
    ).rejects.toThrow(/did not accept that token/);
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBeNull();
    expect((await orgStorage.getOrg(org.orgId))!.fly).toBeUndefined();
  });

  it('a token seeing several orgs connects only with a matching hint — else names them', async () => {
    const several = () => vi.fn().mockResolvedValue([
      { slug: 'personal', name: 'Dana Ives' },
      { slug: 'big-bang-988', name: 'Big-Bang' },
    ]);
    // The display-name hint (case-insensitive) picks the right one.
    const hinted = await makeWorld({
      listApps: vi.fn().mockResolvedValue([{ name: 'x' }]),
      listOrganizations: several(),
    });
    const result = await hinted.service.connectOrgFly({
      orgId: hinted.org.orgId, orgSlug: 'big-bang', token: 'fo1_ok',
    });
    expect(result).toMatchObject({ connected: true, orgSlug: 'big-bang-988' });

    // No hint (the form's shape): the refusal lists where the token works.
    const bare = await makeWorld({ listOrganizations: several() });
    await expect(
      bare.service.connectOrgFly({ orgId: bare.org.orgId, token: 'fo1_ok' }),
    ).rejects.toThrow(/"personal", "big-bang-988"/);
    expect((await bare.orgStorage.getOrg(bare.org.orgId))!.fly).toBeUndefined();
  });

  it('a token seeing no org, and one that cannot list its org\'s apps, both refuse whole', async () => {
    const blind = await makeWorld({ listOrganizations: vi.fn().mockResolvedValue([]) });
    await expect(
      blind.service.connectOrgFly({ orgId: blind.org.orgId, token: 'fo1_none' }),
    ).rejects.toThrow(/cannot see any Fly organization/);

    const noDeploy = await makeWorld({
      listApps: vi.fn().mockRejectedValue(new Error('403')),
    });
    await expect(
      noDeploy.service.connectOrgFly({ orgId: noDeploy.org.orgId, token: 'fo1_narrow' }),
    ).rejects.toThrow(/could not list its apps/);
    expect(await noDeploy.orgSecrets.getOrgSecret(noDeploy.org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBeNull();
    expect((await noDeploy.orgStorage.getOrg(noDeploy.org.orgId))!.fly).toBeUndefined();
  });

  it('refuses an unknown org and a blank token', async () => {
    const { service } = await makeWorld();
    await expect(
      service.connectOrgFly({ orgId: 'nope', token: 'fo1_x' }),
    ).rejects.toThrow(OrgFlyError);
    await expect(
      service.connectOrgFly({ orgId: 'nope', token: ' ' }),
    ).rejects.toThrow(OrgFlyError);
  });
});

describe('OrgFlyService.resolveOrgFlyContext', () => {
  it('resolves a connected org to its own context', async () => {
    const { service, org } = await makeWorld();
    await service.connectOrgFly({ orgId: org.orgId, orgSlug: 'acme-agents', token: 'fo1_client' });

    expect(await service.resolveOrgFlyContext(org.orgId)).toEqual({
      source: 'org',
      orgSlug: 'acme-agents',
      apiToken: 'fo1_client',
    });
  });

  it('refuses an unconnected org even when the platform itself has Fly credentials', async () => {
    // "The workplace's OWN account" stays a narrow question: the consumers
    // that act in a customer's account (git host, backups, media bucket, CI,
    // the spending walk) must never be handed ours. Hosting is its own verb.
    const { service, org } = await makeWorld({ platform: { orgSlug: 'infinite-agents', apiToken: 'fo1_platform' } });
    await expect(service.resolveOrgFlyContext(org.orgId)).rejects.toThrow(
      /connect and validate its Fly token/,
    );
  });

  it('a pointed org with a missing token fails loudly — never the platform fallback', async () => {
    // The disaster class this exists to prevent: a client org losing its
    // secret row must NOT quietly aim machines and deploys at OUR Fly org.
    const { service, orgStorage, org } = await makeWorld();
    await orgStorage.updateOrg(org.orgId, {
      fly: { orgSlug: 'acme-agents', tokenSecretName: ORG_FLY_TOKEN_SECRET_NAME },
    });

    await expect(service.resolveOrgFlyContext(org.orgId)).rejects.toThrow(/token secret .* is missing/);
  });

  it('throws for an unknown org, and when nothing at all is configured', async () => {
    const { service, org } = await makeWorld();
    await expect(service.resolveOrgFlyContext('nope')).rejects.toThrow(OrgFlyError);
    await expect(service.resolveOrgFlyContext(org.orgId)).rejects.toThrow(/no Fly org connected/);
  });
});

describe('OrgFlyService.resolveHostingContext (note #664)', () => {
  const platform = { orgSlug: 'infinite-agents', apiToken: 'fo1_platform' };

  it('hosts a workplace with no cloud of its own on the platform account', async () => {
    const { service, org } = await makeWorld({ platform });
    expect(await service.resolveHostingContext(org.orgId)).toEqual({
      source: 'platform',
      orgSlug: 'infinite-agents',
      apiToken: 'fo1_platform',
    });
  });

  it('a workplace that connected its own cloud stays in it', async () => {
    const { service, org } = await makeWorld({ platform });
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' });
    expect(await service.resolveHostingContext(org.orgId)).toEqual({
      source: 'org',
      orgSlug: 'acme-agents',
      apiToken: 'fo1_client',
    });
  });

  it('a connected cloud that lost its token still refuses — never moved onto ours', async () => {
    const { service, orgStorage, org } = await makeWorld({ platform });
    await orgStorage.updateOrg(org.orgId, {
      fly: { orgSlug: 'acme-agents', tokenSecretName: ORG_FLY_TOKEN_SECRET_NAME },
    });
    await expect(service.resolveHostingContext(org.orgId)).rejects.toThrow(/token secret .* is missing/);
  });

  it('refuses when the backend has no platform account to host on, and for an unknown org', async () => {
    const { service, org } = await makeWorld();
    await expect(service.resolveHostingContext(org.orgId)).rejects.toThrow(/no platform Fly account/);
    await expect(service.resolveHostingContext('nope')).rejects.toThrow(OrgFlyError);
  });
});

describe('OrgFlyService card check (note #801)', () => {
  const billing = (billingStatus: string, isCreditCardSaved = true) => vi.fn().mockResolvedValue({ billingStatus, isCreditCardSaved });

  it('connects an organization whose billing is current, and asked the offered token', async () => {
    const getOrganizationBilling = billing('CURRENT');
    const { service, orgStorage, org } = await makeWorld({ getOrganizationBilling });
    const result = await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' });
    expect(result).toMatchObject({ connected: true, orgSlug: 'acme-agents' });
    expect(getOrganizationBilling).toHaveBeenCalledWith('acme-agents');
    expect((await orgStorage.getOrg(org.orgId))!.fly!.orgSlug).toBe('acme-agents');
  });

  it('refuses in plain words, writing nothing, when Fly says the bill is past due — the acme-trading case', async () => {
    // acme-trading on 26 Oct 2026: a card saved, billingStatus PAST_DUE, and
    // every new machine refused with Fly's 422.
    const { service, orgStorage, orgSecrets, org } = await makeWorld({ getOrganizationBilling: billing('PAST_DUE', true) });
    await expect(service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' }))
      .rejects.toThrow(/past due.*https:\/\/fly\.io\/dashboard\/acme-agents\/billing/);
    expect((await orgStorage.getOrg(org.orgId))!.fly).toBeUndefined();
    expect(await orgSecrets.getOrgSecret(org.orgId, ORG_FLY_TOKEN_SECRET_NAME)).toBeFalsy();
  });

  it('refuses an organization with no card: no payment source, or a trial without one', async () => {
    for (const [status, card] of [['SOURCE_REQUIRED', false], ['TRIAL_ACTIVE', false], ['TRIAL_ENDED', false]] as const) {
      const { service, org } = await makeWorld({ getOrganizationBilling: billing(status, card) });
      await expect(service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' }))
        .rejects.toThrow(/Add a card to your Fly organization "acme-agents" first/);
    }
  });

  it('an invoiced organization with no card on file still connects — the status is what Fly acts on', async () => {
    const { service, org } = await makeWorld({ getOrganizationBilling: billing('CURRENT', false) });
    await expect(service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' })).resolves.toMatchObject({ connected: true });
  });

  it('an unreadable billing status connects anyway — the 422 still speaks if Fly refuses later', async () => {
    const getOrganizationBilling = vi.fn().mockRejectedValue(new Error('Fly GraphQL error: field gone'));
    const { service, org } = await makeWorld({ getOrganizationBilling });
    await expect(service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' })).resolves.toMatchObject({ connected: true });
  });

  it('a rotation is not re-checked: same account, same bill', async () => {
    const getOrganizationBilling = billing('CURRENT');
    const { service, org } = await makeWorld({ getOrganizationBilling });
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_old' });
    getOrganizationBilling.mockResolvedValue({ billingStatus: 'PAST_DUE', isCreditCardSaved: true });
    await expect(service.connectOrgFly({ orgId: org.orgId, token: 'fo1_new' })).resolves.toMatchObject({ connected: true, moved: false });
    expect(getOrganizationBilling).toHaveBeenCalledTimes(1);
  });

  it('billingProblem reads the connected account live, for the Cloud card', async () => {
    const getOrganizationBilling = billing('CURRENT');
    const { service, org } = await makeWorld({ getOrganizationBilling });
    await service.connectOrgFly({ orgId: org.orgId, token: 'fo1_client' });
    expect(await service.billingProblem(org.orgId)).toBeNull();
    getOrganizationBilling.mockResolvedValue({ billingStatus: 'SUSPENDED', isCreditCardSaved: true });
    expect(await service.billingProblem(org.orgId)).toEqual({
      problem: expect.stringMatching(/Fly has suspended your Fly organization "acme-agents"/),
      fixUrl: 'https://fly.io/dashboard/acme-agents/billing',
    });
  });
});
