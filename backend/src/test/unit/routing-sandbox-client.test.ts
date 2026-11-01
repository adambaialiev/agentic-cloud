import { describe, expect, it, vi } from 'vitest';
import { RoutingSandboxClient } from '../../services/routing-sandbox-client.js';

const FLY_ID = 'fly-sandbox-ia-app.aa11';
const HETZNER_ID = 'hcloud-sandbox-42';

function stubClient(tag: string) {
  return {
    createDevelopmentSandbox: vi.fn().mockResolvedValue({ sandboxId: `${tag}-new` }),
    getDefaultSandboxSize: vi.fn().mockReturnValue(`${tag}-size`),
    getDefaultReservationQuote: vi.fn().mockResolvedValue(null),
    getSandbox: vi.fn().mockResolvedValue({ id: tag, status: 'running' }),
    execSync: vi.fn().mockResolvedValue({ stdout: tag, stderr: '', exitCode: 0, timedOut: false }),
    execTerminalStart: vi.fn().mockResolvedValue({ sessionId: `${tag}-sess` }),
    execTerminalInput: vi.fn().mockResolvedValue({}),
    execTerminalRead: vi.fn().mockResolvedValue({}),
    execTerminalClose: vi.fn().mockResolvedValue({}),
    enablePersistence: vi.fn().mockResolvedValue({ persistent: true }),
    disablePersistence: vi.fn().mockResolvedValue({ persistent: true }),
    destroySandbox: vi.fn().mockResolvedValue(undefined),
    resolveSshConnection: vi.fn().mockResolvedValue({ host: 'h', port: 2222, username: 'agent', privateKey: 'k' }),
  };
}

/** A provider that can resize and report a disk — what the Fly client is. */
function resizingClient(tag: string) {
  return {
    ...stubClient(tag),
    resizeSandbox: vi.fn().mockResolvedValue({ changed: true, awake: false }),
    getSandboxStorageGb: vi.fn().mockResolvedValue(50),
  };
}

describe('RoutingSandboxClient', () => {
  it('routes Fly sandbox ids to the Fly client and everything else to the default', async () => {
    const hetzner = stubClient('hetzner');
    const fly = stubClient('fly');
    const routing = new RoutingSandboxClient(hetzner as never, fly as never);

    await routing.execSync(FLY_ID, 'echo hi');
    await routing.execSync(HETZNER_ID, 'echo hi');
    await routing.getSandbox(FLY_ID);
    await routing.destroySandbox(FLY_ID);

    expect(fly.execSync).toHaveBeenCalledWith(FLY_ID, 'echo hi', undefined, undefined);
    expect(hetzner.execSync).toHaveBeenCalledWith(HETZNER_ID, 'echo hi', undefined, undefined);
    expect(fly.getSandbox).toHaveBeenCalledWith(FLY_ID);
    expect(fly.destroySandbox).toHaveBeenCalledWith(FLY_ID);
    expect(hetzner.getSandbox).not.toHaveBeenCalled();
  });

  it('keeps provisioning on the default client', async () => {
    const hetzner = stubClient('hetzner');
    const fly = stubClient('fly');
    const routing = new RoutingSandboxClient(hetzner as never, fly as never);

    await routing.createDevelopmentSandbox({ userId: 'u', name: 'n' });
    expect(hetzner.createDevelopmentSandbox).toHaveBeenCalled();
    expect(fly.createDevelopmentSandbox).not.toHaveBeenCalled();
  });

  it('resolves Fly SSH connections and rejects non-Fly ids', async () => {
    const hetzner = stubClient('hetzner');
    const fly = stubClient('fly');
    const routing = new RoutingSandboxClient(hetzner as never, fly as never);

    await routing.resolveFlySshConnection(FLY_ID);
    expect(fly.resolveSshConnection).toHaveBeenCalledWith(FLY_ID, undefined);
    await expect(routing.resolveFlySshConnection(HETZNER_ID)).rejects.toThrow(/only available for Fly/);
  });

  // The optional runtime methods, which a router silently loses by simply not
  // writing them down: nothing in the type system says a wrapper must forward
  // an `?:` member, and every caller tests for the method before offering the
  // control it drives. Dropping them turned the whole Fly fleet's machine
  // screen read-only (note #268).
  it('forwards resize and storage to the provider that owns the id', async () => {
    const retired = stubClient('retired');
    const fly = resizingClient('fly');
    const routing = new RoutingSandboxClient(retired as never, fly as never);

    const size = { cpuKind: 'performance', cpus: 2, memoryMb: 4096 };
    await expect(routing.resizeSandbox(FLY_ID, size)).resolves.toEqual({ changed: true, awake: false });
    expect(fly.resizeSandbox).toHaveBeenCalledWith(FLY_ID, size);
    await expect(routing.getSandboxStorageGb(FLY_ID)).resolves.toBe(50);
    expect(routing.canResizeSandbox(FLY_ID)).toBe(true);
  });

  it('answers no for a provider that cannot resize, and never pretends otherwise', async () => {
    const retired = stubClient('retired');
    const fly = resizingClient('fly');
    const routing = new RoutingSandboxClient(retired as never, fly as never);

    expect(routing.canResizeSandbox(HETZNER_ID)).toBe(false);
    await expect(routing.resizeSandbox(HETZNER_ID, { cpuKind: 'shared', cpus: 1, memoryMb: 2048 }))
      .rejects.toThrow(/cannot resize/);
    await expect(routing.getSandboxStorageGb(HETZNER_ID)).resolves.toBeUndefined();
    expect(fly.resizeSandbox).not.toHaveBeenCalled();
  });

  it('falls back to the default client for everything when Fly is not configured', async () => {
    const hetzner = stubClient('hetzner');
    const routing = new RoutingSandboxClient(hetzner as never);
    await routing.execSync(FLY_ID, 'echo hi');
    expect(hetzner.execSync).toHaveBeenCalledWith(FLY_ID, 'echo hi', undefined, undefined);
    expect(routing.getFlyClient()).toBeUndefined();
  });
});
