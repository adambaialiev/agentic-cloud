import { describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitService } from '../../services/org-git.js';
import { OrgGitHostService, OrgGitHostError, orgGitAppName } from '../../services/org-git-host.js';
import { GIT_USER_MAX_BYTES } from '../../types/git-repo.js';

/**
 * Per-org git hosts (byo-git-design slice 2b): provisioning is lazy and
 * idempotent, resolution is layered like the Fly context, and the one org
 * that must never migrate (a stamped one) cannot be provisioned by accident.
 */

const PLATFORM = { baseUrl: 'https://git.central.test', controlUrl: 'https://git.central.test', secret: 'central-secret' };

function fakeFly(args?: { volumeSizeGb?: number }) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown) => { (calls[name] ??= []).push(args); };
  const machines: Array<{ id: string; state: string }> = [];
  const state = { volumeSizeGb: args?.volumeSizeGb ?? 10 };
  return {
    calls,
    machines,
    state,
    client: {
      createApp: vi.fn(async (args: unknown) => { record('createApp', args); }),
      ensureFlycastIpv6: vi.fn(async () => 'fdaa:2:3::5'),
      listVolumes: vi.fn(async () => []),
      createVolume: vi.fn(async (_app: string, args: { name: string }) => {
        record('createVolume', args);
        return { id: 'vol_1', name: args.name, region: 'ams' } as never;
      }),
      getVolume: vi.fn(async () => ({ id: 'vol_1', name: 'gitdata', size_gb: state.volumeSizeGb, snapshot_retention: 14 } as never)),
      extendVolume: vi.fn(async (_app: string, _volumeId: string, sizeGb: number) => {
        record('extendVolume', sizeGb);
        state.volumeSizeGb = sizeGb;
        return { needsRestart: true };
      }),
      stopMachine: vi.fn(async (_app: string, machineId: string) => { record('stopMachine', machineId); }),
      listMachines: vi.fn(async () => machines as never),
      createMachine: vi.fn(async (_app: string, args: unknown) => {
        record('createMachine', args);
        const machine = { id: 'mach_1', state: 'started' };
        machines.push(machine);
        return machine as never;
      }),
      waitForMachineState: vi.fn(async () => {}),
    },
  };
}

async function build(args?: {
  stamped?: boolean; flySource?: 'org' | 'platform-env'; healthOk?: boolean;
  volumeSizeGb?: number;
}) {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin-1' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'admin-1', role: 'admin' });
  const orgGit = new OrgGitService({ orgStorage });
  if (args?.stamped) await orgGit.stampOrgGitNamespace(org.orgId, 'admin-1');
  const secrets = new Map<string, string>();
  const orgSecrets = {
    setOrgSecret: vi.fn(async (orgId: string, name: string, value: string) => {
      secrets.set(`${orgId}:${name}`, value);
    }),
    getOrgSecret: vi.fn(async (orgId: string, name: string) => secrets.get(`${orgId}:${name}`) ?? null),
  };
  const fly = fakeFly(args);
  const fetchImpl = vi.fn(async () => ({
    ok: args?.healthOk !== false,
    status: args?.healthOk === false ? 502 : 200,
    json: async () => ({ ok: args?.healthOk !== false, diskUsedPercent: 12 }),
  })) as unknown as typeof fetch;
  const service = new OrgGitHostService({
    orgStorage,
    orgSecrets: orgSecrets as never,
    orgFly: {
      resolveOrgFlyContext: vi.fn(async () => ({
        source: args?.flySource ?? 'org', orgSlug: 'acme-fly', apiToken: 'tok',
      })),
    } as never,
    orgGit,
    gitHostImage: 'ghcr.io/example/images:git-host-sha-abc',
    backendUrl: 'https://api.example.test',
    region: 'ams',
    platformEnv: PLATFORM,
    makeFlyClient: () => fly.client as never,
    fetchImpl,
    sleep: async () => {},
    healthTimeoutMs: 200,
  });
  return { service, orgStorage, orgGit, org, fly, secrets, fetchImpl };
}

describe('orgGitAppName', () => {
  it('derives a stable app slug from the orgId hex', () => {
    expect(orgGitAppName('87c99fa5-26a3-49b9-b676-d5bf667854dc')).toBe('iagit-87c99fa526a3');
  });
});

describe('OrgGitHostService.resolveContext', () => {
  it('answers the platform seed for no org, an unstamped org, and org #0', async () => {
    const { service, org } = await build({ stamped: true });
    expect((await service.resolveContext(null)).source).toBe('platform-env');
    // Stamped WITHOUT a host (org #0's shape) still resolves to the seed.
    expect((await service.resolveContext(org.orgId)).source).toBe('platform-env');
  });

  it('answers the org host once one exists, and refuses a pointed org with a lost secret', async () => {
    const { service, org, orgStorage, secrets } = await build();
    await service.ensureOrgGitHost(org.orgId);
    const context = await service.resolveContext(org.orgId);
    expect(context.source).toBe('org');
    expect(context.baseUrl).toBe('http://[fdaa:2:3::5]:8080');
    expect(context.secret).toBe(secrets.get(`${org.orgId}:GIT_HOST_SECRET`));

    secrets.clear();
    await expect(service.resolveContext(org.orgId)).rejects.toThrow(/secret is missing/);
    // NEVER the platform fallback: acting on the wrong host is the disaster.
    expect((await orgStorage.getOrg(org.orgId))?.git?.host).toBeTruthy();
  });
});

describe('OrgGitHostService.ensureOrgGitHost', () => {
  it('provisions the whole host and stamps the org with its own id', async () => {
    const { service, org, orgStorage, fly } = await build();
    const context = await service.ensureOrgGitHost(org.orgId);
    expect(context.source).toBe('org');

    const stored = await orgStorage.getOrg(org.orgId);
    expect(stored?.git?.namespaceId).toBe(org.orgId);
    expect(stored?.git?.host).toEqual(expect.objectContaining({
      app: orgGitAppName(org.orgId), flycastIp: 'fdaa:2:3::5', volumeId: 'vol_1',
    }));

    const machine = (fly.calls.createMachine?.[0] ?? {}) as {
      env?: Record<string, string>; services?: Array<{ autostop?: string; ports?: unknown[] }>; mounts?: unknown[];
    };
    expect(machine.env?.GIT_HOST_ORG).toBe(org.orgId);
    expect(machine.env?.BACKEND_URL).toBe('https://api.example.test');
    expect(machine.env?.GIT_HOST_SECRET).toBeTruthy();
    expect(machine.services?.[0]?.autostop).toBe('stop');
    // The binding is what makes flycast answer AT ALL — an empty ports list
    // leaves the proxy with nothing to listen on (found live, 2026-08-23).
    expect(machine.services?.[0]?.ports).toEqual([{ port: 8080 }]);
    expect(machine.mounts).toEqual([{ volume: 'vol_1', path: '/data' }]);
  });

  it('is idempotent: a second call health-checks and creates nothing new', async () => {
    const { service, org, fly } = await build();
    await service.ensureOrgGitHost(org.orgId);
    await service.ensureOrgGitHost(org.orgId);
    expect(fly.client.createMachine).toHaveBeenCalledTimes(1);
    expect(fly.client.createVolume).toHaveBeenCalledTimes(1);
  });

  it('refuses a stamped org — the one that must never migrate cannot be, by accident', async () => {
    const { service, org } = await build({ stamped: true });
    await expect(service.ensureOrgGitHost(org.orgId)).rejects.toThrow(/refusing to provision a second home/);
  });

  it('refuses to build in the PLATFORM Fly org', async () => {
    const { service, org } = await build({ flySource: 'platform-env' });
    await expect(service.ensureOrgGitHost(org.orgId)).rejects.toThrow(/own cloud account/);
  });

  it('a host that never turns healthy fails the provision loudly', async () => {
    const { service, org } = await build({ healthOk: false });
    await expect(service.ensureOrgGitHost(org.orgId)).rejects.toThrow(OrgGitHostError);
  });
});

describe('OrgGitHostService.maybeProvisionForOrg', () => {
  it('quiet no for a stamped org, provision for a fresh client org', async () => {
    const stamped = await build({ stamped: true });
    expect(await stamped.service.maybeProvisionForOrg(stamped.org.orgId)).toBe(false);

    const fresh = await build();
    expect(await fresh.service.maybeProvisionForOrg(fresh.org.orgId)).toBe(true);
    expect(await fresh.service.maybeProvisionForOrg(fresh.org.orgId)).toBe(false);
  });

  it('quiet no for an org without its own cloud', async () => {
    const { service, org } = await build({ flySource: 'platform-env' });
    expect(await service.maybeProvisionForOrg(org.orgId)).toBe(false);
  });
});

describe('OrgGitHostService.describeHost', () => {
  it('null for an org on the central host — there is no host of theirs to describe', async () => {
    const { service, org } = await build({ stamped: true });
    expect(await service.describeHost(org.orgId)).toBeNull();
  });

  it('answers health, disk and volume size for an org with its own host', async () => {
    const { service, org } = await build();
    await service.ensureOrgGitHost(org.orgId);
    expect(await service.describeHost(org.orgId)).toEqual({
      app: orgGitAppName(org.orgId),
      health: 'ok',
      diskUsedPercent: 12,
      volumeSizeGb: 10,
      snapshotRetentionDays: 14,
    });
  });

  it('a timed-out probe answers waking — the poke itself starts a stopped host', async () => {
    const { service, org, fetchImpl } = await build();
    await service.ensureOrgGitHost(org.orgId);
    (fetchImpl as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const error = new Error('operation timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    const facts = await service.describeHost(org.orgId);
    expect(facts?.health).toBe('waking');
    // The Fly API is up regardless of the machine: size still answers.
    expect(facts?.volumeSizeGb).toBe(10);
  });
});

describe('OrgGitHostService.growVolume', () => {
  it('extends by one step and stops the running machine so the next wake sees the grown disk', async () => {
    const { service, org, fly } = await build();
    await service.ensureOrgGitHost(org.orgId);
    expect(await service.growVolume(org.orgId)).toEqual({ sizeGb: 20 });
    expect(fly.calls.extendVolume).toEqual([20]);
    expect(fly.calls.stopMachine).toEqual(['mach_1']);
    expect((await service.describeHost(org.orgId))?.volumeSizeGb).toBe(20);
  });

  it('refuses an org without its own host, and refuses to grow past the ceiling', async () => {
    const central = await build({ stamped: true });
    await expect(central.service.growVolume(central.org.orgId)).rejects.toThrow(/nothing to grow/);

    const nearCeiling = await build({ volumeSizeGb: 95 });
    await nearCeiling.service.ensureOrgGitHost(nearCeiling.org.orgId);
    await expect(nearCeiling.service.growVolume(nearCeiling.org.orgId)).rejects.toThrow(/conversation with the platform/);
    expect(nearCeiling.fly.client.extendVolume).not.toHaveBeenCalled();
  });
});

/**
 * Note #62. The push ceiling used to be one flat constant — a fair share of
 * the SHARED box — handed out no matter which disk a namespace was on. Two
 * things were wrong with that once repos moved into the org's own cloud: an
 * org was capped at a tenth of a volume it pays for, and the admin's
 * grow-the-volume tap moved no ceiling at all.
 */
describe('OrgGitHostService.userMaxBytesFor', () => {
  const GIB = 1024 * 1024 * 1024;

  it('sizes an org’s own namespace from the volume it pays for', async () => {
    const { service, org } = await build();
    await service.ensureOrgGitHost(org.orgId);
    // 80% of 10 GB, the same headroom the host's own disk guard keeps.
    expect(await service.userMaxBytesFor(org.orgId)).toBe(8 * GIB);
  });

  it('moves when the volume grows — the whole point of the tap', async () => {
    const { service, org } = await build();
    await service.ensureOrgGitHost(org.orgId);
    const before = await service.userMaxBytesFor(org.orgId);
    await service.growVolume(org.orgId);
    const after = await service.userMaxBytesFor(org.orgId);
    expect(after).toBe(16 * GIB);
    expect(after).toBeGreaterThan(before);
  });

  it('keeps the shared box on the fair share — that disk is still shared', async () => {
    const { service, org } = await build({ stamped: true });
    // An org on the central host, and the no-org case, both answer the flat
    // constant: nothing about this change loosens the shared disk.
    expect(await service.userMaxBytesFor(org.orgId)).toBe(GIT_USER_MAX_BYTES);
    expect(await service.userMaxBytesFor(null)).toBe(GIT_USER_MAX_BYTES);
  });

  it('falls back to the provisioning default for a host stamped before this shipped', async () => {
    const { service, orgStorage, org } = await build();
    await service.ensureOrgGitHost(org.orgId);
    // Exactly the shape on disk for every host provisioned before note #62:
    // a pointer with no size on it. Those were all built at the default and
    // never grown, so the default IS their size — no migration needed.
    const stored = await orgStorage.getOrg(org.orgId);
    const { volumeGb: _dropped, ...withoutSize } = stored!.git!.host!;
    await orgStorage.updateOrg(org.orgId, { git: { ...stored!.git!, host: withoutSize } });
    expect(await service.userMaxBytesFor(org.orgId)).toBe(8 * GIB);
  });

  it('answers without needing the host secret — a quota must not fail a push', async () => {
    const { service, org, secrets } = await build();
    await service.ensureOrgGitHost(org.orgId);
    // resolveContext throws for a pointed org whose secret has gone; the
    // ceiling is read off the record instead, so the missing secret surfaces
    // where it belongs (clientFor) rather than as a mystery quota.
    secrets.clear();
    await expect(service.resolveContext(org.orgId)).rejects.toThrow(/secret is missing/);
    expect(await service.userMaxBytesFor(org.orgId)).toBe(8 * GIB);
  });
});

describe('OrgGitHostService.clientFor', () => {
  it('caches per target and answers different hosts for different orgs', async () => {
    const { service, org } = await build();
    const central = await service.clientFor(null);
    expect(central.cloneUrl('u', 'r')).toContain('git.central.test');
    await service.ensureOrgGitHost(org.orgId);
    const own = await service.clientFor(org.orgId);
    expect(own.cloneUrl(org.orgId, 'api')).toBe(`http://[fdaa:2:3::5]:8080/${encodeURIComponent(org.orgId)}/api.git`);
    expect(await service.clientFor(org.orgId)).toBe(own);
  });
});
