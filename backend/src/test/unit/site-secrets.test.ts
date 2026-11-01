import { describe, expect, it, vi } from 'vitest';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { DeploymentService } from '../../services/deployment-service.js';
import { UserSecretsService, agentUserSecretScope } from '../../services/user-secrets.js';
import { parseSiteSecretNames, redactSiteSecrets, resolveSiteSecrets } from '../../services/site-secrets.js';
import type { GitNamespace } from '../../services/org-git.js';

// Note #661: a service is handed saved secrets by name, never by value.

describe('parseSiteSecretNames', () => {
  it('reads a comma or space separated list, once each', () => {
    expect(parseSiteSecretNames('TELEGRAM_BOT_TOKEN, OPENAI_API_KEY TELEGRAM_BOT_TOKEN')).toEqual({
      ok: true, names: ['TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY'],
    });
    expect(parseSiteSecretNames('')).toEqual({ ok: true, names: [] });
  });

  it('refuses malformed names, system names and the env the platform sets on a site', () => {
    expect(parseSiteSecretNames('1BAD').ok).toBe(false);
    expect(parseSiteSecretNames('PATH').ok).toBe(false);
    for (const name of ['PORT', 'PUBLIC_PORT', 'AUTHORIZED_KEYS', 'BACKEND_PEER_IP', 'DATA_DIR']) {
      const parsed = parseSiteSecretNames(name);
      expect(parsed.ok).toBe(false);
    }
  });

  it('bounds how many a site may carry', () => {
    const names = Array.from({ length: 21 }, (_, i) => `KEY_${i}`).join(',');
    expect(parseSiteSecretNames(names).ok).toBe(false);
  });
});

describe('resolveSiteSecrets', () => {
  async function workplace() {
    const secretStorage = new InMemorySecretStorage();
    const secrets = new UserSecretsService(secretStorage);
    await secrets.setSecret('workplace-ns', 'TELEGRAM_BOT_TOKEN', 'shared-token', undefined, undefined, 'everyone');
    await secrets.setSecret('workplace-ns', 'ADMIN_ONLY_KEY', 'admin-value', undefined, undefined, 'admins');
    await secrets.setSecret('workplace-ns', 'MINE', 'agent-a-value', agentUserSecretScope('agent-a'));
    await secrets.setSecret('workplace-ns', 'THEIRS', 'agent-b-value', agentUserSecretScope('agent-b'));
    await secrets.setSecret('other-workplace-ns', 'ELSEWHERE', 'other-workplace-value');
    return secretStorage;
  }
  const namespaceAs = (role: 'admin' | 'member') => vi.fn(async (): Promise<GitNamespace> => ({
    namespaceId: 'workplace-ns', orgId: 'org-1', role,
  }));
  const deployer = { userId: 'user-1', orgId: 'org-1', agentId: 'agent-a' };

  it('hands exactly the keys the deploying agent is handed, read from its own workplace', async () => {
    const secretStorage = await workplace();
    const resolveNamespace = namespaceAs('admin');
    const { env, missing } = await resolveSiteSecrets(
      { secretStorage, resolveNamespace }, deployer,
      ['TELEGRAM_BOT_TOKEN', 'ADMIN_ONLY_KEY', 'MINE', 'THEIRS', 'ELSEWHERE'],
    );
    expect(resolveNamespace).toHaveBeenCalledWith('user-1', 'org-1');
    expect(env).toEqual({ TELEGRAM_BOT_TOKEN: 'shared-token', ADMIN_ONLY_KEY: 'admin-value', MINE: 'agent-a-value' });
    // Another agent's private key and another workplace's key are never reachable.
    expect(missing).toEqual(['THEIRS', 'ELSEWHERE']);
  });

  it("keeps a key an admin has not opened to everyone off a member's site", async () => {
    const secretStorage = await workplace();
    const { env, missing } = await resolveSiteSecrets(
      { secretStorage, resolveNamespace: namespaceAs('member') }, deployer,
      ['TELEGRAM_BOT_TOKEN', 'ADMIN_ONLY_KEY'],
    );
    expect(env).toEqual({ TELEGRAM_BOT_TOKEN: 'shared-token' });
    expect(missing).toEqual(['ADMIN_ONLY_KEY']);
  });

  it('reads nothing when no names are asked for', async () => {
    const resolveNamespace = namespaceAs('admin');
    expect(await resolveSiteSecrets({ secretStorage: await workplace(), resolveNamespace }, deployer, []))
      .toEqual({ env: {}, missing: [] });
    expect(resolveNamespace).not.toHaveBeenCalled();
  });

  it('redacts values out of a message', () => {
    expect(redactSiteSecrets('bad config shared-token here', { A: 'shared-token' })).toBe('bad config [redacted] here');
  });
});

describe('DeploymentService and site secrets', () => {
  function fly() {
    const machineEnv: { current: Record<string, string> } = { current: {} };
    const client = {
      createApp: vi.fn(async () => {}),
      ensureSharedIpv4: vi.fn(async () => {}),
      ensureDedicatedIpv6: vi.fn(async () => {}),
      createVolume: vi.fn(async () => ({ id: 'vol_1' })),
      createMachine: vi.fn(async (_app: string, config: { env: Record<string, string> }) => {
        machineEnv.current = { ...config.env };
        return { id: 'mach_1' };
      }),
      waitForMachineState: vi.fn(async () => {}),
      getMachine: vi.fn(async () => ({ id: 'mach_1', config: { image: 'img', env: { ...machineEnv.current } } })),
      updateMachine: vi.fn(async (_app: string, _id: string, config: { env: Record<string, string> }) => {
        machineEnv.current = { ...config.env };
        return { id: 'mach_1' };
      }),
      listMachines: vi.fn(async () => []),
      deleteMachine: vi.fn(async () => {}),
      deleteApp: vi.fn(async () => {}),
    };
    return { client, machineEnv };
  }

  function build(resolveSecrets?: (d: never) => Promise<Record<string, string>>) {
    const { client, machineEnv } = fly();
    const storage = new InMemoryDeploymentStorage();
    const service = new DeploymentService({
      fly: client as never,
      sandboxClient: {} as never,
      storage,
      dns: null,
      orgSlug: 'test',
      region: 'ams',
      image: 'registry/img:x',
      appsDomain: 'agentbuilt.app',
      authorizedKeys: 'ssh-ed25519 AAAA backend',
      ...(resolveSecrets ? { resolveSecrets } : {}),
      logger: () => {},
    });
    return { client, machineEnv, storage, service };
  }

  it('provisions a new service with its secrets in the machine env, platform env winning', async () => {
    const resolveSecrets = vi.fn(async () => ({ TELEGRAM_BOT_TOKEN: 'tok', PUBLIC_PORT: '1' }));
    const { client, storage, service } = build(resolveSecrets);
    const rec = await storage.create({
      userId: 'u', agentId: 'a', name: 'bot', preset: 'service', status: 'pending-payment', secretNames: ['TELEGRAM_BOT_TOKEN'],
    });
    await service.provision(rec.id);
    expect(resolveSecrets).toHaveBeenCalledTimes(1);
    const env = (client.createMachine.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env.TELEGRAM_BOT_TOKEN).toBe('tok');
    expect(env.PUBLIC_PORT).toBe('8080');
    expect(env.AUTHORIZED_KEYS).toBe('ssh-ed25519 AAAA backend');
  });

  it('asks for nothing when a site has no secrets, and fails before building when they cannot be read', async () => {
    const resolveSecrets = vi.fn(async () => { throw new Error('no longer handed'); });
    const { client, storage, service } = build(resolveSecrets);
    const plain = await storage.create({ userId: 'u', agentId: 'a', name: 'plain', preset: 'service', status: 'pending-payment' });
    await service.provision(plain.id);
    expect(resolveSecrets).not.toHaveBeenCalled();

    client.createApp.mockClear();
    const bot = await storage.create({
      userId: 'u', agentId: 'a', name: 'bot', preset: 'service', status: 'pending-payment', secretNames: ['GONE'],
    });
    await expect(service.provision(bot.id)).rejects.toThrow('no longer handed');
    expect(client.createApp).not.toHaveBeenCalled();
    expect((await storage.get(bot.id))?.status).toBe('pending-payment');
  });

  it('swaps a live service’s secrets in place and leaves platform env alone', async () => {
    const { client, machineEnv, storage, service } = build();
    const rec = await storage.create({
      userId: 'u', agentId: 'a', name: 'bot', preset: 'service', status: 'live', flyApp: 'iapp-x', machineId: 'mach_1',
    });
    machineEnv.current = { PUBLIC_PORT: '8080', AUTHORIZED_KEYS: 'k', OLD_KEY: 'old' };

    expect(await service.setSecretEnv(rec.id, { TELEGRAM_BOT_TOKEN: 'tok' }, ['OLD_KEY'])).toBe(true);
    expect(machineEnv.current).toEqual({ PUBLIC_PORT: '8080', AUTHORIZED_KEYS: 'k', TELEGRAM_BOT_TOKEN: 'tok' });
    expect(client.waitForMachineState).toHaveBeenCalled();

    // Same keys, same values: no machine update, so no restart.
    client.updateMachine.mockClear();
    expect(await service.setSecretEnv(rec.id, { TELEGRAM_BOT_TOKEN: 'tok' }, ['TELEGRAM_BOT_TOKEN'])).toBe(false);
    expect(client.updateMachine).not.toHaveBeenCalled();

    // A rotated value is a change.
    expect(await service.setSecretEnv(rec.id, { TELEGRAM_BOT_TOKEN: 'tok2' }, ['TELEGRAM_BOT_TOKEN'])).toBe(true);
    // Clearing takes them all off.
    expect(await service.setSecretEnv(rec.id, {}, ['TELEGRAM_BOT_TOKEN'])).toBe(true);
    expect(machineEnv.current).toEqual({ PUBLIC_PORT: '8080', AUTHORIZED_KEYS: 'k' });
  });
});
