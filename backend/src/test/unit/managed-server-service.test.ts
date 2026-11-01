import { describe, expect, it } from 'vitest';
import {
  InMemoryManagedServerStorage,
  ManagedServerService,
  type ManagedServerRecord,
} from '../../services/managed-server-service.js';

function buildManagedServerRecord(
  overrides: Partial<ManagedServerRecord> = {},
): ManagedServerRecord {
  return {
    recordId: 'hcloud_101',
    userId: 'user-1',
    serverId: 101,
    provider: 'hetzner',
    name: 'dev-sandbox-1',
    purpose: 'default_sandbox',
    isDefaultDevelopment: true,
    status: 'active',
    cloudStatus: 'active',
    region: 'nbg1',
    size: 's-2vcpu-2gb-intel',
    publicAddress: '203.0.113.10',
    environmentPrepared: true,
    codexPrepared: false,
    claudePrepared: false,
    preparationStatus: 'succeeded',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ManagedServerService', () => {
  it('returns an explicit empty runtime server context when no servers are tracked', async () => {
    const service = new ManagedServerService(new InMemoryManagedServerStorage());

    await expect(service.buildRuntimeContext('user-1')).resolves.toEqual({
      managedServers: {
        servers: [],
      },
    });
  });

  it('builds an empty runtime server context after the last tracked server is deleted', async () => {
    const storage = new InMemoryManagedServerStorage();
    const service = new ManagedServerService(storage);
    await storage.saveServer(buildManagedServerRecord());

    await expect(service.buildRuntimeContext('user-1')).resolves.toMatchObject({
      developmentRoot: '/home/agent',
      managedServers: {
        servers: [
          {
            serverId: 101,
            name: 'dev-sandbox-1',
            status: 'active',
          },
        ],
      },
    });

    await service.markDeleted({ userId: 'user-1', serverId: 101 });

    await expect(service.buildRuntimeContext('user-1')).resolves.toEqual({
      managedServers: {
        servers: [],
      },
    });
  });

  it('registers created Hetzner servers with tracked cloud record ids', async () => {
    const storage = new InMemoryManagedServerStorage();
    const service = new ManagedServerService(storage);

    await service.registerCreatedCloudServer({
      userId: 'user-1',
      server: {
        id: 123,
        provider: 'hetzner',
        name: 'hcloud-server',
        status: 'active',
      },
      purpose: 'general',
    });

    expect(await service.getServer('user-1', 123, 'hetzner')).toMatchObject({
      recordId: 'hcloud_123',
      provider: 'hetzner',
      name: 'hcloud-server',
    });
    await service.markDeleted({ userId: 'user-1', serverId: 123, provider: 'hetzner' });

    expect(await service.getServer('user-1', 123, 'hetzner')).toBeNull();
  });
});
