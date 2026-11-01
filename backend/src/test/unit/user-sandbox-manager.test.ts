import { describe, expect, it, vi } from 'vitest';

// Pin the EUR->USD rate so reservation charges are deterministic. Without this
// the manager hits the live Frankfurter API and Math.round(48 * rate) flips
// between 55 and 56 cents as the market moves, making the balance assertion flaky.
// The factory is hoisted above any top-level variables, so the rate is inlined here.
vi.mock('../../services/fx-rate-service.js', () => ({
  getEurToUsdRate: vi.fn().mockResolvedValue(1.17),
}));

import { InMemorySandboxStorage } from '../../services/sandbox-storage.js';
import type { WorkspaceProvisioningClient } from '../../services/sandbox-client.js';
import { UserDevelopmentEnvironmentManager } from '../../services/user-sandbox-manager.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';

function createProvisioningRuntimeClient(
  overrides: Partial<{
    sandboxId: string;
    serverId: number;
    serverName: string;
    size: string;
    region: string;
    address: string;
  }> = {},
): WorkspaceProvisioningClient {
  const sandboxId = overrides.sandboxId ?? 'hcloud-sandbox-101';
  const serverId = overrides.serverId ?? 101;
  const serverName = overrides.serverName ?? 'sandbox-user-1-default-sandbox';
  const size = overrides.size ?? 'cpx22';
  const region = overrides.region ?? 'fsn1';
  const address = overrides.address ?? '203.0.113.10';

  return {
    getSandbox: vi.fn(),
    execSync: vi.fn(),
    execTerminalStart: vi.fn(),
    execTerminalInput: vi.fn(),
    execTerminalRead: vi.fn(),
    execTerminalClose: vi.fn(),
    enablePersistence: vi.fn(),
    disablePersistence: vi.fn(),
    destroySandbox: vi.fn().mockResolvedValue(undefined),
    getDefaultSandboxSize: vi.fn().mockReturnValue(size),
    getDefaultReservationQuote: vi.fn().mockResolvedValue({
      provider: 'hetzner',
      region,
      size,
      currency: 'EUR',
      unit: 'hour',
      unitPriceCents: 2,
      baseCents: 48,
      upfrontHours: 24,
      estimate: true,
      description: 'Hetzner cpx22 reservation',
    }),
    createDevelopmentSandbox: vi.fn().mockResolvedValue({
      sandboxId,
      server: {
        id: serverId,
        provider: 'hetzner',
        name: serverName,
        status: 'active',
        region,
        size,
        publicAddress: address,
      },
      reservationQuote: {
        provider: 'hetzner',
        region,
        size,
        currency: 'EUR',
        unit: 'hour',
        unitPriceCents: 2,
        baseCents: 48,
        upfrontHours: 24,
        estimate: true,
        description: 'Hetzner cpx22 reservation',
      },
      environmentPrepared: true,
      codexPrepared: true,
      codexVersion: '0.130.0',
      claudePrepared: true,
      claudeVersion: '1.2.3',
      preparationStatus: 'succeeded',
      preparationSummary: 'Installed baseline development tooling.',
    }),
  } as unknown as WorkspaceProvisioningClient;
}

describe('UserDevelopmentEnvironmentManager', () => {
  it('provisions a server-backed default sandbox', async () => {
    const sandboxStorage = new InMemorySandboxStorage();
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', { email: 'user@example.com' });

    const runtimeClient = createProvisioningRuntimeClient();
    const manager = new UserDevelopmentEnvironmentManager(
      runtimeClient,
      sandboxStorage,
    );

    const sandbox = await manager.ensureDefaultSandboxForUser('user-1');

    expect(sandbox).toMatchObject({
      sandboxId: 'hcloud-sandbox-101',
      name: 'Development Server',
      provider: 'hetzner',
      status: 'running',
      serverId: 101,
      region: 'fsn1',
      size: 'cpx22',
      publicAddress: '203.0.113.10',
      environmentPrepared: true,
      codexPrepared: true,
      codexVersion: '0.130.0',
      claudePrepared: true,
      claudeVersion: '1.2.3',
      preparationStatus: 'succeeded',
    });
    expect(runtimeClient.createDevelopmentSandbox).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      name: 'Development Server',
      prepareEnvironment: true,
      tags: expect.arrayContaining(['sumai-sandbox', 'default-development']),
    }));
    expect((await sandboxStorage.getDefaultSandbox('user-1'))?.sandboxId).toBe('hcloud-sandbox-101');
  });

  it('migrates a legacy default sandbox to a server-backed sandbox', async () => {
    const sandboxStorage = new InMemorySandboxStorage();
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', { email: 'user@example.com' });
    await sandboxStorage.saveSandbox('user-1', {
      sandboxId: 'sandbox-legacy',
      name: 'Default Sandbox',
      provider: 'sumai',
      status: 'running',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-04-01T00:00:00.000Z'),
    }, { makeDefault: true });

    const runtimeClient = createProvisioningRuntimeClient({
      sandboxId: 'hcloud-sandbox-202',
      serverId: 202,
      serverName: 'sandbox-user-1-migrated-default',
      address: '203.0.113.20',
    });
    const manager = new UserDevelopmentEnvironmentManager(
      runtimeClient,
      sandboxStorage,
      undefined,
      userStorage,
      { checkSpendAllowance: vi.fn().mockResolvedValue({ allowed: true, usage: null }) } as any,
    );

    const sandbox = await manager.ensureDefaultSandboxForUser('user-1');
    const state = await sandboxStorage.getSandboxState('user-1');

    expect(sandbox.sandboxId).toBe('hcloud-sandbox-202');
    expect(state.defaultSandboxId).toBe('hcloud-sandbox-202');
    expect(state.sandboxes).toHaveLength(1);
    expect(state.sandboxes[0]).toMatchObject({
      sandboxId: 'hcloud-sandbox-202',
      provider: 'hetzner',
      serverId: 202,
      publicAddress: '203.0.113.20',
    });
    expect(await sandboxStorage.getSandbox('user-1', 'sandbox-legacy')).toBeNull();
    expect(runtimeClient.createDevelopmentSandbox).toHaveBeenCalledTimes(1);
  });
});
