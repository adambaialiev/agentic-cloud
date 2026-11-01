import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDeploymentName } from '../../types/deployment.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { DeploymentService, isDeploymentAppName, DEPLOYMENT_APP_PREFIX } from '../../services/deployment-service.js';

describe('deployment names', () => {
  it('accepts ordinary site names', () => {
    for (const name of ['ember-coffee', 'my-shop-2', 'abc']) {
      expect(validateDeploymentName(name)).toBeNull();
    }
  });

  it('rejects malformed names', () => {
    for (const name of ['ab', '-x-', 'Big', 'a_b', 'x'.repeat(43), 'ends-']) {
      expect(validateDeploymentName(name)).not.toBeNull();
    }
  });

  // The denylist matches whole hyphen-tokens, so "login", "my-login" and
  // "login-page" are all refused — but "blogin" (substring only) is fine.
  it('rejects phishing-shaped names as whole tokens', () => {
    expect(validateDeploymentName('login')).not.toBeNull();
    expect(validateDeploymentName('my-login')).not.toBeNull();
    expect(validateDeploymentName('login-page')).not.toBeNull();
    expect(validateDeploymentName('blogin')).toBeNull();
  });

  // The code host and a private copy's mail answer on these exact names
  // beside every site (note #804); an explicit record beats the wildcard.
  it('keeps the platform\'s own names, whole names only', () => {
    expect(validateDeploymentName('git')).toMatch(/platform's own address/);
    expect(validateDeploymentName('mail')).toMatch(/platform's own address/);
    expect(validateDeploymentName('git-stats')).toBeNull();
    expect(validateDeploymentName('mail-merge')).toBeNull();
  });
});

describe('deployment storage', () => {
  it('enforces live-name uniqueness but frees names of destroyed deployments', async () => {
    const storage = new InMemoryDeploymentStorage();
    const first = await storage.create({
      userId: 'u1', agentId: 'a1', name: 'ember', preset: 'static', status: 'pending-payment',
    });
    await expect(storage.create({
      userId: 'u2', agentId: 'a2', name: 'ember', preset: 'static', status: 'pending-payment',
    })).rejects.toThrow(/taken/);

    await storage.update(first.id, { status: 'destroyed' });
    const second = await storage.create({
      userId: 'u2', agentId: 'a2', name: 'ember', preset: 'service', status: 'pending-payment',
    });
    // The live record wins name lookups over the tombstone.
    const byName = await storage.getByName('ember');
    expect(byName?.id).toBe(second.id);
  });
});

describe('deployment app identification', () => {
  // The reaper's skip relies on this prefix test: agent apps are `ia-<hex>`,
  // deployment apps `iapp-<hex>` — an agent app must never match.
  it('distinguishes deployment apps from agent apps', () => {
    expect(isDeploymentAppName(`${DEPLOYMENT_APP_PREFIX}abc123`)).toBe(true);
    expect(isDeploymentAppName('ia-9f2c11aa22bb33cc')).toBe(false);
    expect(isDeploymentAppName('ia-machine-images')).toBe(false);
    expect(isDeploymentAppName(undefined)).toBe(false);
  });
});

describe('provision: no DNS record, no certificate (note #766)', () => {
  function fakes() {
    const calls: string[] = [];
    const fly = {
      createApp: async ({ appName }: any) => { calls.push(`createApp:${appName}`); },
      ensureSharedIpv4: async () => { calls.push('v4'); },
      ensureDedicatedIpv6: async () => { calls.push('v6'); },
      createVolume: async () => { calls.push('volume'); return { id: 'vol_1' }; },
      createMachine: async () => { calls.push('machine'); return { id: 'mach_1' }; },
      waitForMachineState: async () => { calls.push('started'); },
      addCertificate: async (_app: string, hostname: string) => { calls.push(`cert:${hostname}`); },
      getCertificate: async () => { calls.push('getCertificate'); return null; },
      checkCertificate: async (_app: string, hostname: string) => { calls.push(`check:${hostname}`); },
      listMachines: async () => [],
      deleteMachine: async () => { calls.push('deleteMachine'); },
      deleteApp: async () => { calls.push('deleteApp'); },
      stopMachine: async () => {}, startMachine: async () => {},
    };
    // The DNS client has no write left; only the deletes a legacy site needs.
    const dns = {
      async deleteCname(name: string) { calls.push(`deleteCname:${name}`); },
      async recordExists() { calls.push('recordExists'); return false; },
    };
    return { calls, fly, dns };
  }

  async function build(overrides: Partial<ReturnType<typeof fakes>['fly']> = {}) {
    const { calls, fly, dns } = fakes();
    Object.assign(fly, overrides);
    const { DeploymentService } = await import('../../services/deployment-service.js');
    const storage = new InMemoryDeploymentStorage();
    const namesChanged = vi.fn();
    const service = new DeploymentService({
      fly: fly as any, sandboxClient: {} as any, storage, dns: dns as any,
      orgSlug: 'test', region: 'ams', image: 'registry/img:x',
      appsDomain: 'agentbuilt.app', logger: () => {}, onNamesChanged: namesChanged,
    });
    return { calls, storage, service, namesChanged };
  }

  it('brings a site live with its address answered from the record alone', async () => {
    // One proxied wildcard record and the preview-router Worker carry every
    // name; the zone's 200-record ceiling is exactly what this stops spending.
    const { calls, storage, service, namesChanged } = await build();
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'pending-payment' });
    const { deployment, url } = await service.provision(rec.id);

    expect(url).toBe('https://ember.agentbuilt.app');
    expect(deployment.status).toBe('live');
    expect(deployment.flyApp).toMatch(/^iapp-[0-9a-f]{12}$/);
    expect(calls).toEqual([
      `createApp:${deployment.flyApp}`, 'v4', 'v6', 'volume', 'machine', 'started',
    ]);
    expect(calls.some((c) => c.startsWith('cert:') || c.startsWith('check:') || c.startsWith('deleteCname:'))).toBe(false);
    // The name map is told the moment the record is live, so the first
    // visitor's lookup finds the site.
    expect(namesChanged).toHaveBeenCalledTimes(1);
  });

  it('rolls infrastructure back and restores status when provisioning fails', async () => {
    const { calls, storage, service, namesChanged } = await build({
      createMachine: async () => { throw new Error('boom'); },
    });
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'pending-payment' });
    await expect(service.provision(rec.id)).rejects.toThrow('boom');
    expect(calls).toContain('deleteApp');
    // Nothing was written outside Fly, so there is nothing else to undo.
    expect(calls.some((c) => c.startsWith('deleteCname:'))).toBe(false);
    expect((await storage.get(rec.id))?.status).toBe('pending-payment');
    expect(namesChanged).not.toHaveBeenCalled();
  });

  it('works with no DNS client at all, since a new site never needs one', async () => {
    const { fly } = fakes();
    const { DeploymentService } = await import('../../services/deployment-service.js');
    const storage = new InMemoryDeploymentStorage();
    const service = new DeploymentService({
      fly: fly as any, sandboxClient: {} as any, storage, dns: null,
      orgSlug: 'test', region: 'ams', image: 'registry/img:x', appsDomain: 'agentbuilt.app', logger: () => {},
    });
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'pending-payment' });
    expect((await service.provision(rec.id)).deployment.status).toBe('live');
  });
});

function buildSyncService(args: {
  storage: InMemoryDeploymentStorage;
  uploadToSandbox: ReturnType<typeof vi.fn>;
  execSync: ReturnType<typeof vi.fn>;
  stagingDir?: string;
  fly?: object;
}) {
  return new DeploymentService({
    fly: (args.fly ?? {}) as never,
    sandboxClient: { uploadToSandbox: args.uploadToSandbox, execSync: args.execSync } as never,
    storage: args.storage,
    dns: null,
    orgSlug: 'test',
    region: 'ams',
    image: 'registry/img:x',
    appsDomain: 'agentbuilt.app',
    ...(args.stagingDir ? { stagingDir: args.stagingDir } : {}),
    logger: () => {},
  });
}

describe('sync resilience', () => {
  // The first SSH exchange after a machine wake sometimes dies on stream
  // teardown (2026-08-05 E2E); a retry always succeeded by hand, so the
  // service performs it itself.
  it('retries the upload+swap once after a transport failure', async () => {
    vi.useFakeTimers();
    try {
      const storage = new InMemoryDeploymentStorage();
      const rec = await storage.create({
        userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'live',
        flyApp: 'iapp-abc123def456', machineId: 'mach_1',
      });
      const uploadToSandbox = vi.fn()
        .mockRejectedValueOnce(new Error('SSH stream closed unexpectedly'))
        .mockResolvedValue(undefined);
      const execSync = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
      const service = buildSyncService({ storage, uploadToSandbox, execSync });

      const sync = service.syncTarball(rec.id, Buffer.from('tarball'));
      await vi.advanceTimersByTimeAsync(3500);
      await sync;

      expect(uploadToSandbox).toHaveBeenCalledTimes(2);
      expect(execSync).toHaveBeenCalledTimes(1);
      expect((await storage.get(rec.id))?.lastDeployAt).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the second failure', async () => {
    vi.useFakeTimers();
    try {
      const storage = new InMemoryDeploymentStorage();
      const rec = await storage.create({
        userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'live',
        flyApp: 'iapp-abc123def456', machineId: 'mach_1',
      });
      const uploadToSandbox = vi.fn().mockRejectedValue(new Error('still broken'));
      const execSync = vi.fn();
      const service = buildSyncService({ storage, uploadToSandbox, execSync });

      const sync = service.syncTarball(rec.id, Buffer.from('tarball'));
      const outcome = sync.catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(3500);
      expect(await outcome).toMatchObject({ message: 'still broken' });
      expect(uploadToSandbox).toHaveBeenCalledTimes(2);
      expect(execSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('provision dedup', () => {
  // Paddle fires created+activated near-simultaneously after checkout; both
  // land on provision(). Only one machine may result.
  it('concurrent provisions of one deployment share a single run', async () => {
    const storage = new InMemoryDeploymentStorage();
    let apps = 0;
    const fly = {
      createApp: async () => { apps += 1; },
      ensureSharedIpv4: async () => {},
      ensureDedicatedIpv6: async () => {},
      createVolume: async () => ({ id: 'vol_1' }),
      createMachine: async () => ({ id: 'mach_1' }),
      waitForMachineState: async () => {},
    };
    const service = buildSyncService({
      storage,
      uploadToSandbox: vi.fn().mockResolvedValue(undefined),
      execSync: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      fly,
    });
    const rec = await service.createPending({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static' });

    const [a, b] = await Promise.all([service.provision(rec.id), service.provision(rec.id)]);
    expect(apps).toBe(1);
    expect(a.url).toBe(b.url);
  });
});

describe('tarball staging', () => {
  it('provision brings staged first-deploy content up, then clears the stage', async () => {
    const stagingDir = await mkdtemp(path.join(os.tmpdir(), 'deploy-staging-'));
    const storage = new InMemoryDeploymentStorage();
    const uploadToSandbox = vi.fn().mockResolvedValue(undefined);
    const execSync = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const fly = {
      createApp: async () => {},
      ensureSharedIpv4: async () => {},
      ensureDedicatedIpv6: async () => {},
      createVolume: async () => ({ id: 'vol_1' }),
      createMachine: async () => ({ id: 'mach_1' }),
      waitForMachineState: async () => {},
    };
    const service = buildSyncService({ storage, uploadToSandbox, execSync, stagingDir, fly });

    const rec = await service.createPending({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static' });
    await service.stageTarball(rec.id, Buffer.from('site-content'));

    await service.provision(rec.id);

    // The staged bytes reached the machine and the stage file is gone — the
    // paid-for URL never comes up empty.
    expect(uploadToSandbox).toHaveBeenCalledTimes(1);
    const uploaded = uploadToSandbox.mock.calls[0]![1] as Array<{ content: Buffer }>;
    expect(uploaded[0]!.content.toString()).toBe('site-content');
    expect(await service.readStagedTarball(rec.id)).toBeNull();
    expect((await storage.get(rec.id))?.status).toBe('live');
  });
});

describe('rename', () => {
  function fakes() {
    const calls: string[] = [];
    const fly = {
      addCertificate: async (_app: string, hostname: string) => { calls.push(`cert:${hostname}`); },
      getCertificate: async () => { calls.push('getCertificate'); return null; },
      deleteCertificate: async (_app: string, hostname: string) => { calls.push(`uncert:${hostname}`); },
      listMachines: async () => [], deleteMachine: async () => {}, deleteApp: async () => {},
      stopMachine: async () => {}, startMachine: async () => {},
    };
    const dns = {
      async deleteCname(name: string) { calls.push(`delete-cname:${name}`); },
      async recordExists() { calls.push('recordExists'); return false; },
    };
    return { calls, fly, dns };
  }

  async function build() {
    const { calls, fly, dns } = fakes();
    const { DeploymentService } = await import('../../services/deployment-service.js');
    const storage = new InMemoryDeploymentStorage();
    const namesChanged = vi.fn();
    const service = new DeploymentService({
      fly: fly as any, sandboxClient: {} as any, storage, dns: dns as any,
      orgSlug: 'test', region: 'ams', image: 'registry/img:x',
      appsDomain: 'agentbuilt.app', logger: () => {}, onNamesChanged: namesChanged,
    });
    return { calls, storage, service, namesChanged };
  }

  /** A live site with infrastructure already attached. */
  async function liveSite(storage: InMemoryDeploymentStorage, name = 'eldiyar-math') {
    const rec = await storage.create({ userId: 'u', agentId: 'a', name, preset: 'service', status: 'pending-payment' });
    await storage.update(rec.id, { status: 'live', flyApp: 'iapp-abc123def456', machineId: 'mach_1' });
    return (await storage.get(rec.id))!;
  }

  it('moves the site by changing the record alone: no DNS, no certificate, and the name map is told', async () => {
    // The new name routes to the app and the old name redirects to it from
    // the name map (siteMappingsFromDeployments); nothing is written to the
    // zone or to Fly, so there is nothing that can half-succeed.
    const { calls, storage, service, namesChanged } = await build();
    const site = await liveSite(storage);
    const result = await service.rename(site.id, 'school');

    expect(result.url).toBe('https://school.agentbuilt.app');
    expect(result.previousUrl).toBe('https://eldiyar-math.agentbuilt.app');
    expect(result.deployment.name).toBe('school');
    expect(result.deployment.formerNames).toEqual(['eldiyar-math']);
    expect(calls).toEqual([]);
    expect(namesChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the old name reserved, so nobody else can claim it', async () => {
    // Released into a first-come namespace, the old name could be taken by a
    // stranger — and then a link the owner handed out opens someone else's
    // site. That is worse than a dead link, so the name follows the record.
    const { storage, service } = await build();
    const site = await liveSite(storage);
    await service.rename(site.id, 'school');

    const byOld = await storage.getByName('eldiyar-math');
    expect(byOld?.id).toBe(site.id);
    expect(byOld?.name).toBe('school');
    expect(byOld?.formerNames).toEqual(['eldiyar-math']);
    await expect(storage.create({ userId: 'other', agentId: 'z', name: 'eldiyar-math', preset: 'static', status: 'pending-payment' }))
      .rejects.toThrow(/already taken/);
  });

  it('refuses a name that another live site holds, and leaves everything alone', async () => {
    const { calls, storage, service, namesChanged } = await build();
    const site = await liveSite(storage);
    await storage.create({ userId: 'u', agentId: 'a', name: 'shop', preset: 'static', status: 'live' });

    await expect(service.rename(site.id, 'shop')).rejects.toThrow(/already taken/);
    expect(calls).toEqual([]);
    expect(namesChanged).not.toHaveBeenCalled();
    expect((await storage.get(site.id))!.name).toBe('eldiyar-math');
  });

  it('applies the same name rules as a first deploy', async () => {
    const { storage, service } = await build();
    const site = await liveSite(storage);
    // Phishing-shaped, and malformed: both refused by the shared validator, so
    // a rename can never smuggle in a name a deploy would have rejected.
    await expect(service.rename(site.id, 'login')).rejects.toThrow(/not allowed/);
    await expect(service.rename(site.id, 'my-login-page')).rejects.toThrow(/not allowed/);
    await expect(service.rename(site.id, '-nope-')).rejects.toThrow(/3–42 characters/);
    await expect(service.rename(site.id, 'eldiyar-math')).rejects.toThrow(/already its name/);
  });

  it('lets a site move back: A → B → A, with the list never holding the current name', async () => {
    const { storage, service } = await build();
    const site = await liveSite(storage, 'first');
    await service.rename(site.id, 'second');
    const back = await service.rename(site.id, 'first');

    expect(back.deployment.name).toBe('first');
    expect(back.deployment.formerNames).toEqual(['second']);
    expect((await storage.getByName('second'))?.id).toBe(site.id);
  });

  it('what the name map then says: the new name routes, every old name redirects to it', async () => {
    const { siteMappingsFromDeployments } = await import('../../services/preview-domain-service.js');
    const { storage, service } = await build();
    const site = await liveSite(storage, 'first');
    await service.rename(site.id, 'second');
    await service.rename(site.id, 'third');

    expect(siteMappingsFromDeployments(await storage.listAll())).toEqual([
      ['third', { app: 'iapp-abc123def456' }],
      ['first', { redirect: 'third' }],
      ['second', { redirect: 'third' }],
    ]);
  });

  it('renames a site that is still waiting on payment without touching infrastructure', async () => {
    const { calls, storage, service } = await build();
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'draft', preset: 'static', status: 'pending-payment' });
    const result = await service.rename(rec.id, 'parents-page');

    expect(result.deployment.name).toBe('parents-page');
    expect(calls).toEqual([]);
    expect((await storage.getByName('draft'))?.id).toBe(rec.id);
  });

  it('refuses to rename a destroyed site', async () => {
    const { storage, service } = await build();
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'old', preset: 'static', status: 'destroyed' });
    await expect(service.rename(rec.id, 'new-one')).rejects.toThrow(/is gone/);
  });
});

describe('destroy and delete leave the name map, and clear what an older site left in DNS', () => {
  async function build() {
    const calls: string[] = [];
    const fly = {
      listMachines: async () => [{ id: 'm1' }],
      deleteMachine: async () => { calls.push('deleteMachine'); },
      deleteApp: async () => { calls.push('deleteApp'); },
      deleteCertificate: async () => { calls.push('uncert'); },
    };
    const dns = { async deleteCname(name: string) { calls.push(`delete-cname:${name}`); } };
    const { DeploymentService } = await import('../../services/deployment-service.js');
    const storage = new InMemoryDeploymentStorage();
    const namesChanged = vi.fn();
    const service = new DeploymentService({
      fly: fly as any, sandboxClient: {} as any, storage, dns: dns as any,
      orgSlug: 'test', region: 'ams', image: 'registry/img:x', appsDomain: 'agentbuilt.app', logger: () => {},
      onNamesChanged: namesChanged,
    });
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'school', preset: 'static', status: 'live' });
    await storage.update(rec.id, { flyApp: 'iapp-abc', machineId: 'm1', formerNames: ['eldiyar-math'] });
    return { calls, storage, service, namesChanged, id: rec.id };
  }

  it('destroy: infrastructure down, the legacy record removed best-effort, the name map told', async () => {
    const { siteMappingsFromDeployments } = await import('../../services/preview-domain-service.js');
    const { calls, storage, service, namesChanged, id } = await build();
    await service.destroy(id);

    expect(calls).toEqual(['deleteMachine', 'deleteApp', 'delete-cname:school']);
    expect((await storage.get(id))?.status).toBe('destroyed');
    expect(namesChanged).toHaveBeenCalledTimes(1);
    // Gone from the map: the address answers "No such preview." from the next
    // lookup, and so does the former name.
    expect(siteMappingsFromDeployments(await storage.listAll())).toEqual([]);
  });

  it('destroy with no DNS client is the whole teardown for a site that never had a record', async () => {
    const { calls, storage, service, id } = await build();
    (service as any).opts.dns = null;
    await service.destroy(id);
    expect(calls).toEqual(['deleteMachine', 'deleteApp']);
    expect((await storage.get(id))?.status).toBe('destroyed');
  });
});

describe('release (a deleted workplace, 2026-09-22)', () => {
  async function build(options: { dnsFails?: boolean; unreachable?: boolean } = {}) {
    const calls: string[] = [];
    const fly = {
      deleteCertificate: async (app: string, hostname: string) => { calls.push(`uncert:${app}:${hostname}`); },
      listMachines: async () => { calls.push('listMachines'); return []; },
      deleteMachine: async () => { calls.push('deleteMachine'); },
      deleteApp: async () => { calls.push('deleteApp'); },
    };
    const dns = {
      async deleteCname(name: string) {
        if (options.dnsFails) throw new Error('Cloudflare said 500');
        calls.push(`delete-cname:${name}`);
      },
    };
    const { DeploymentService } = await import('../../services/deployment-service.js');
    const storage = new InMemoryDeploymentStorage();
    const service = new DeploymentService({
      fly: fly as any, sandboxClient: {} as any, storage, dns: dns as any,
      orgSlug: 'test', region: 'ams', image: 'registry/img:x', appsDomain: 'agentbuilt.app', logger: () => {},
      ...(options.unreachable ? { resolveAppContext: async () => { throw new Error('token revoked'); } } : {}),
    });
    const rec = await storage.create({ userId: 'u', agentId: 'a', orgId: 'o1', name: 'school', preset: 'static', status: 'live' });
    await storage.update(rec.id, { flyApp: 'iapp-abc', formerNames: ['eldiyar-math'] });
    return { calls, storage, service, id: rec.id };
  }

  it('hands back every name it answered on and leaves the app alone', async () => {
    const { calls, storage, service, id } = await build();
    await service.release(id);
    expect(calls).toEqual([
      'uncert:iapp-abc:school.agentbuilt.app',
      'uncert:iapp-abc:eldiyar-math.agentbuilt.app',
      'delete-cname:school',
      'delete-cname:eldiyar-math',
    ]);
    // No tombstone: the name is free for anyone.
    expect(await storage.getByName('school')).toBeNull();
    expect(await storage.getByName('eldiyar-math')).toBeNull();
  });

  it('keeps the record when its DNS could not be removed, so the next try finishes it', async () => {
    const { storage, service, id } = await build({ dnsFails: true });
    await expect(service.release(id)).rejects.toThrow('Cloudflare said 500');
    expect(await storage.get(id)).not.toBeNull();
  });

  it('frees the name of a site whose account can no longer be reached at all', async () => {
    const { calls, storage, service, id } = await build({ unreachable: true });
    await service.release(id);
    expect(calls).toEqual(['delete-cname:school', 'delete-cname:eldiyar-math']);
    expect(await storage.get(id)).toBeNull();
  });
});

describe('client-org deploys (byo-fly)', () => {
  function flyFake(calls: string[], tag: string) {
    return {
      createApp: async ({ appName, orgSlug }: any) => { calls.push(`${tag}:createApp:${orgSlug}:${appName}`); },
      ensureSharedIpv4: async () => { calls.push(`${tag}:v4`); },
      ensureDedicatedIpv6: async () => { calls.push(`${tag}:v6`); },
      createVolume: async () => ({ id: 'vol_1' }),
      createMachine: async (_app: string, args: any) => { calls.push(`${tag}:machine:peer=${args.env?.BACKEND_PEER_IP ?? 'none'}`); return { id: 'mach_1' }; },
      waitForMachineState: async () => {},
      addCertificate: async () => {},
      getCertificate: async (_app: string, hostname: string) => ({
        clientStatus: 'Awaiting configuration',
        dnsValidationTarget: `${hostname}.tok123.flydns.net.`,
      }),
      listMachines: async () => [],
      deleteMachine: async () => {},
      deleteApp: async () => {},
      stopMachine: async () => {},
      startMachine: async () => {},
    };
  }

  it('provisions in the resolved org — its client, its slug, its peer — with flyApp persisted first', async () => {
    const calls: string[] = [];
    const defaultFly = flyFake(calls, 'default');
    const orgFly = flyFake(calls, 'org');
    const storage = new InMemoryDeploymentStorage();
    let flyAppAtCreate: string | undefined | null = null;
    let created = '';
    orgFly.createApp = async ({ appName, orgSlug }: any) => {
      created = appName;
      // The record must already claim the app when Fly first hears of it.
      flyAppAtCreate = (await storage.getByName('ember'))?.flyApp;
      calls.push(`org:createApp:${orgSlug}:${appName}`);
    };
    const service = new DeploymentService({
      fly: defaultFly as any, sandboxClient: {} as any, storage, dns: null,
      orgSlug: 'infinite-agents', region: 'ams', image: 'ghcr/img:x',
      appsDomain: 'agentbuilt.app', backendPeerIp: 'fdaa:99:600e::2', logger: () => {},
      resolveAppContext: async () => ({
        client: orgFly as any,
        orgSlug: 'acme-agents',
        backendPeerIp: 'fdaa:bd:1a93::2',
      }),
    });
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'pending-payment' });

    const { deployment } = await service.provision(rec.id);

    expect(deployment.status).toBe('live');
    expect(flyAppAtCreate).toBe(created);
    // Everything rode the ORG's client, in the ORG's slug, with the ORG's peer.
    expect(calls).toContain(`org:createApp:acme-agents:${created}`);
    expect(calls).toContain('org:machine:peer=fdaa:bd:1a93::2');
    expect(calls.some((c) => c.startsWith('default:'))).toBe(false);
  });

  it('a null resolution fails closed without touching the boot-time context', async () => {
    const calls: string[] = [];
    const defaultFly = flyFake(calls, 'default');
    const storage = new InMemoryDeploymentStorage();
    const service = new DeploymentService({
      fly: defaultFly as any, sandboxClient: {} as any, storage, dns: null,
      orgSlug: 'infinite-agents', region: 'ams', image: 'ghcr/img:x',
      appsDomain: 'agentbuilt.app', backendPeerIp: 'fdaa:99:600e::2', logger: () => {},
      resolveAppContext: async () => null,
    });
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'pending-payment' });

    await expect(service.provision(rec.id)).rejects.toThrow(/no organization context/);

    expect(calls.some((c) => c.startsWith('default:'))).toBe(false);
    expect((await storage.get(rec.id))?.status).toBe('pending-payment');
  });
});

describe('custom domains (byo-fly)', () => {
  async function liveWorld() {
    const calls: string[] = [];
    const fly = {
      addCertificate: async (_app: string, hostname: string) => { calls.push(`cert:${hostname}`); },
      deleteCertificate: async (_app: string, hostname: string) => { calls.push(`delcert:${hostname}`); },
      getCertificate: async (_app: string, hostname: string) => ({
        clientStatus: 'Awaiting configuration',
        configured: false,
        dnsValidationTarget: `${hostname}.tok999.flydns.net.`,
      }),
    };
    const storage = new InMemoryDeploymentStorage();
    const service = new DeploymentService({
      fly: fly as any, sandboxClient: {} as any, storage, dns: null,
      orgSlug: 'test', region: 'ams', image: 'ghcr/img:x',
      appsDomain: 'agentbuilt.app', logger: () => {},
    });
    const rec = await storage.create({ userId: 'u', agentId: 'a', name: 'ember', preset: 'static', status: 'pending-payment' });
    await storage.update(rec.id, { status: 'live', flyApp: 'iapp-abc123def456', machineId: 'm1' });
    return { calls, storage, service, id: rec.id };
  }

  it('adds a domain: cert on the app, the CNAME instruction back, hostname recorded', async () => {
    const { calls, storage, service, id } = await liveWorld();
    const result = await service.addCustomDomain(id, 'App.TheirCo.com');
    expect(result.hostname).toBe('app.theirco.com');
    expect(result.cnameTarget).toBe('tok999.iapp-abc123def456.fly.dev');
    expect(calls).toContain('cert:app.theirco.com');
    expect((await storage.get(id))!.customDomains).toEqual(['app.theirco.com']);

    // Idempotent: re-adding refreshes the instruction, records once.
    await service.addCustomDomain(id, 'app.theirco.com');
    expect((await storage.get(id))!.customDomains).toEqual(['app.theirco.com']);
  });

  it('status reports each domain with its instruction; remove deletes cert and record', async () => {
    const { calls, storage, service, id } = await liveWorld();
    await service.addCustomDomain(id, 'app.theirco.com');

    const statuses = await service.customDomainStatus(id);
    expect(statuses).toEqual([{
      hostname: 'app.theirco.com',
      configured: false,
      clientStatus: 'Awaiting configuration',
      cnameTarget: 'tok999.iapp-abc123def456.fly.dev',
    }]);

    await service.removeCustomDomain(id, 'app.theirco.com');
    expect(calls).toContain('delcert:app.theirco.com');
    expect((await storage.get(id))!.customDomains).toEqual([]);
  });

  it('refuses our zones, junk hostnames, and sites that are not live', async () => {
    const { service, storage, id } = await liveWorld();
    await expect(service.addCustomDomain(id, 'evil.agentbuilt.app')).rejects.toThrow(/agentbuilt.app/);
    await expect(service.addCustomDomain(id, 'x.fly.dev')).rejects.toThrow(/Fly-managed/);
    await expect(service.addCustomDomain(id, 'no-dots')).rejects.toThrow(/not a valid hostname/);
    await storage.update(id, { status: 'payment-lapsed' });
    await expect(service.addCustomDomain(id, 'app.theirco.com')).rejects.toThrow(/live site/);
  });
});
