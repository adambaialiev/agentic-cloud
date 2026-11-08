import net from 'node:net';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FlySandboxClient, MachineUnreachableError, MachineWakeError } from '../../services/fly-sandbox-client.js';
import { FlyApiError, type FlyClient, type FlyMachine } from '../../services/fly-client.js';
import { parseFlySandboxId } from '../../services/fly-sandbox-id.js';
import type { SshClient } from '../../services/ssh-client.js';
import { DEFAULT_AGENT_MACHINE_SIZE } from '../../config/agent-machine-sizes.js';

const MACHINE_ID = '9080e6d3a6e389';
const PRIVATE_IP = 'fdaa:0:1234:a7b:cafe::2';

function startedMachine(overrides: Partial<FlyMachine> = {}): FlyMachine {
  return {
    id: MACHINE_ID,
    state: 'started',
    region: 'fra',
    private_ip: PRIVATE_IP,
    config: { image: 'registry.fly.io/ia-machine-images:sha-test', guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 } },
    ...overrides,
  };
}

function createFakeFlyClient(overrides: Partial<Record<keyof FlyClient, any>> = {}) {
  return {
    getApp: vi.fn().mockRejectedValue(new Error('Fly API error (404): not found')),
    createApp: vi.fn().mockResolvedValue(undefined),
    deleteApp: vi.fn().mockResolvedValue(undefined),
    createVolume: vi.fn().mockResolvedValue({ id: 'vol_abc123', name: 'iahome', size_gb: 10, region: 'fra' }),
    listVolumes: vi.fn().mockResolvedValue([{ id: 'vol_abc123' }]),
    deleteVolume: vi.fn().mockResolvedValue(undefined),
    createMachine: vi.fn().mockResolvedValue({ id: MACHINE_ID, state: 'created' }),
    getMachine: vi.fn().mockResolvedValue(startedMachine()),
    listMachines: vi.fn().mockResolvedValue([]),
    startMachine: vi.fn().mockResolvedValue(undefined),
    stopMachine: vi.fn().mockResolvedValue(undefined),
    deleteMachine: vi.fn().mockResolvedValue(undefined),
    waitForMachineState: vi.fn().mockResolvedValue(undefined),
    ensureSharedIpv4: vi.fn().mockResolvedValue('137.66.1.2'),
    ...overrides,
  } as unknown as FlyClient;
}

function createFakeSshClient() {
  return {
    execCommand: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }),
    startSession: vi.fn(),
    sendInput: vi.fn(),
    readSession: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as SshClient;
}

function createClient(
  flyClient: FlyClient,
  sshClient: SshClient,
  extra: Partial<ConstructorParameters<typeof FlySandboxClient>[0]> = {},
) {
  return new FlySandboxClient({
    apiToken: 'token',
    orgSlug: 'infinite-agents',
    machineImage: 'registry.fly.io/ia-machine-images:sha-test',
    sshPublicKey: 'ssh-ed25519 AAAAKEY backend',
    sshPrivateKey: 'PRIVATE',
    region: 'fra',
    volumeSizeGb: 10,
    wakeTimeoutMs: 60,
    // The "still stopping" window (note #763) would otherwise default to
    // five minutes and hold every refusal test that long.
    wakeStoppingTimeoutMs: 150,
    // And the kill of a hung stop would otherwise wait a minute.
    wakeForceStopAfterMs: 60,
    wakePollIntervalMs: 5,
    createTimeoutMs: 60,
    // Keep the post-wake readiness probe + connect-retry fast in tests.
    wakeReadinessTimeoutMs: 200,
    wakeReadinessProbeIntervalMs: 10,
    connectRetryAttempts: 3,
    connectRetryBackoffMs: 5,
    flyClient,
    sshClient,
    ...extra,
  });
}

/** An accepting loopback TCP server standing in for a machine's sshd on :2222. */
async function listenOnLoopback(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, close: () => server.close() };
}

/** A port that is currently closed, so a TCP connect gets ECONNREFUSED. */
async function reserveClosedPort(): Promise<number> {
  const { port, close } = await listenOnLoopback();
  close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return port;
}

describe('FlySandboxClient.createDevelopmentSandbox', () => {
  it('creates app + volume + machine, waits for started, and returns a fly sandbox id', async () => {
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());

    const created = await client.createDevelopmentSandbox({ userId: 'user-1', name: 'Claude Code' });

    // App created on the org DEFAULT 6PN network (NO per-user custom network — the
    // backend's single WireGuard peer only routes the default network), with an
    // opaque non-identifying slug.
    expect(flyClient.createApp).toHaveBeenCalledTimes(1);
    const appArgs = (flyClient.createApp as any).mock.calls[0][0];
    expect(appArgs.orgSlug).toBe('infinite-agents');
    expect(appArgs.appName).toMatch(/^ia-[0-9a-f]{16}$/);
    expect(appArgs.appName).not.toContain('user-1');
    expect(appArgs.network).toBeUndefined();

    // Volume mounted at /data; machine gets the baked image, 4GB/2 DEDICATED
    // vCPU, and AUTHORIZED_KEYS. Dedicated is the point: a shared core throttles
    // to a fraction of itself under a test suite (91-94% steal, measured), which
    // an agent reads as its own code being broken. The shape is written out
    // rather than read from the config, so a change to what EVERY new agent is
    // built at has to be made here too, deliberately.
    expect(flyClient.createVolume).toHaveBeenCalledWith(appArgs.appName, expect.objectContaining({ region: 'fra', sizeGb: 10 }));
    const machineArgs = (flyClient.createMachine as any).mock.calls[0][1];
    expect(machineArgs.image).toBe('registry.fly.io/ia-machine-images:sha-test');
    expect(machineArgs.guest).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 4096 });
    // Without rootfs.persist, Fly wipes apt installs on every sleep's stop/start.
    expect(machineArgs.rootfs).toEqual({ persist: 'restart' });
    // The mount carries its own auto-extend clause, so Fly grows the volume
    // when it fills up without the backend watching it. (This client is built
    // with volumeSizeGb: 10 — the shipped default is smaller; see the
    // auto-extend describe block for the defaults.)
    expect(machineArgs.mounts).toEqual([{
      volume: 'vol_abc123',
      path: '/data',
      extend_threshold_percent: 80,
      add_size_gb: 5,
      size_gb_limit: 50,
    }]);
    // No BACKEND_PEER_IP configured here → env carries the SSH key, PUBLIC_PORT
    // and CPU_KIND. The last is the ONE thing about its own shape the machine
    // cannot see from inside (note #393): Fly throttles shared vCPUs on the
    // host, so /proc reads the same on both halves of the ladder, while cores
    // and memory the image reads from the guest itself.
    expect(machineArgs.env).toEqual({
      AUTHORIZED_KEYS: 'ssh-ed25519 AAAAKEY backend',
      PUBLIC_PORT: '8080',
      CPU_KIND: 'performance',
    });
    // The public 443/80 → 8080 service is baked into the INITIAL config (no
    // post-create reboot needed to publish), and the shared IPv4 is pre-allocated.
    expect(machineArgs.services).toEqual([
      {
        protocol: 'tcp',
        internal_port: 8080,
        autostart: true,
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'], force_https: true },
        ],
      },
    ]);
    expect(flyClient.ensureSharedIpv4).toHaveBeenCalledWith(appArgs.appName);
    expect(flyClient.waitForMachineState).toHaveBeenCalledWith(appArgs.appName, MACHINE_ID, expect.objectContaining({ state: 'started' }));

    // Result: self-contained fly sandbox id + "already prepared" (baked image).
    expect(parseFlySandboxId(created.sandboxId)).toEqual({ appName: appArgs.appName, machineId: MACHINE_ID });
    expect(created.server.provider).toBe('fly');
    expect(created.server.machineId).toBe(MACHINE_ID);
    expect(created.server.appName).toBe(appArgs.appName);
    expect(created.environmentPrepared).toBe(true);
    expect(created.preparationStatus).toBe('succeeded');
  });

  it('injects BACKEND_PEER_IP into the machine env when a backend peer is configured', async () => {
    const flyClient = createFakeFlyClient();
    const client = new FlySandboxClient({
      apiToken: 'token',
      orgSlug: 'infinite-agents',
      machineImage: 'registry.fly.io/ia-machine-images:sha-test',
      sshPublicKey: 'ssh-ed25519 AAAAKEY backend',
      sshPrivateKey: 'PRIVATE',
      backendPeerIp: 'fdaa:0:1:a7b:1:2:3:4',
      region: 'fra',
      volumeSizeGb: 10,
      wakeTimeoutMs: 60,
      wakePollIntervalMs: 5,
      createTimeoutMs: 60,
      flyClient,
      sshClient: createFakeSshClient(),
    });

    await client.createDevelopmentSandbox({ userId: 'user-1', name: 'Claude Code' });

    const machineArgs = (flyClient.createMachine as any).mock.calls[0][1];
    expect(machineArgs.env).toEqual({
      AUTHORIZED_KEYS: 'ssh-ed25519 AAAAKEY backend',
      BACKEND_PEER_IP: 'fdaa:0:1:a7b:1:2:3:4',
      PUBLIC_PORT: '8080',
      CPU_KIND: 'performance',
    });
  });

  it('honors a custom publicPort in the baked service + env', async () => {
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient(), { publicPort: 9000 });

    await client.createDevelopmentSandbox({ userId: 'user-1', name: 'Claude Code' });

    const machineArgs = (flyClient.createMachine as any).mock.calls[0][1];
    expect(machineArgs.env.PUBLIC_PORT).toBe('9000');
    expect(machineArgs.services[0].internal_port).toBe(9000);
  });

  it('rolls back the app, volume, and machine when machine creation fails', async () => {
    const flyClient = createFakeFlyClient({
      createMachine: vi.fn().mockRejectedValue(new Error('Fly API error (422): no capacity')),
    });
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.createDevelopmentSandbox({ userId: 'user-1', name: 'x' })).rejects.toThrow('no capacity');
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.stringMatching(/^ia-/), 'vol_abc123');
    expect(flyClient.deleteApp).toHaveBeenCalledTimes(1);
  });
});

describe('FlySandboxClient wake-on-connect', () => {
  it('starts a stopped machine and waits for sshd before handing out a connection target', async () => {
    const server = await listenOnLoopback();
    // The woken machine resolves to a reachable loopback host + sshd port.
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn()
        .mockResolvedValueOnce(startedMachine({ state: 'stopped' }))
        .mockResolvedValue(startedMachine({ private_ip: '127.0.0.1' })),
    });
    const sshClient = createFakeSshClient();
    const client = createClient(flyClient, sshClient, { sshPort: server.port });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const result = await client.execSync(sandboxId, 'echo hi');

    expect(flyClient.startMachine).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60', MACHINE_ID);
    expect(result.exitCode).toBe(0);
    // SSH targets the machine's private IPv6 on the sshd port as the agent user,
    // and only after the readiness probe saw the port accept a connection.
    const connection = (sshClient.execCommand as any).mock.calls[0][0];
    expect(connection).toMatchObject({ host: '127.0.0.1', port: server.port, username: 'agent' });
    server.close();
  });

  // Note #1073: Fly answered 404 once for a guest's machine that the cleanup
  // found a second later, and the whole build failed at its last step.
  it('reads a machine Fly answered 404 for again before giving up on it', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn()
        .mockRejectedValueOnce(new FlyApiError('Fly API error (404): machine not found', 404))
        .mockResolvedValue(startedMachine()),
    });
    const sshClient = createFakeSshClient();
    const client = createClient(flyClient, sshClient, { notFoundRereadMs: 1 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const result = await client.execSync(sandboxId, 'echo hi');

    expect(result.exitCode).toBe(0);
    expect(flyClient.getMachine).toHaveBeenCalledTimes(2);
    expect(sshClient.execCommand).toHaveBeenCalledTimes(1);
  });

  it('still fails on a machine that stays 404, after two re-reads', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockRejectedValue(new FlyApiError('Fly API error (404): machine not found', 404)),
    });
    const sshClient = createFakeSshClient();
    const client = createClient(flyClient, sshClient, { notFoundRereadMs: 1 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await expect(client.execSync(sandboxId, 'echo hi')).rejects.toMatchObject({ status: 404 });
    expect(flyClient.getMachine).toHaveBeenCalledTimes(3);
    expect(sshClient.execCommand).not.toHaveBeenCalled();
  });

  it('does not re-read on any answer but 404', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockRejectedValue(new FlyApiError('Fly API error (401): unauthorized', 401)),
    });
    const client = createClient(flyClient, createFakeSshClient(), { notFoundRereadMs: 1 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await expect(client.execSync(sandboxId, 'echo hi')).rejects.toMatchObject({ status: 401 });
    expect(flyClient.getMachine).toHaveBeenCalledTimes(1);
  });

  it('does not start an already-started machine', async () => {
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await client.execSync(sandboxId, 'echo hi');
    expect(flyClient.startMachine).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'stopping'] as const)(
    'refuses rather than waking a %s machine when an observation sets wake=false',
    async (state) => {
      const flyClient = createFakeFlyClient({
        getMachine: vi.fn().mockResolvedValue(startedMachine({ state })),
      });
      const sshClient = createFakeSshClient();
      const client = createClient(flyClient, sshClient);
      const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

      await expect(client.execSync(sandboxId, 'echo hi', undefined, { wake: false }))
        .rejects.toThrow(`is ${state}; refusing to wake it`);
      expect(flyClient.startMachine).not.toHaveBeenCalled();
      expect(sshClient.execCommand).not.toHaveBeenCalled();
    },
  );

  it('surfaces a clear error when a stopped machine cannot be started (no reserved capacity)', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ state: 'stopped', private_ip: PRIVATE_IP })),
      startMachine: vi.fn().mockRejectedValue(new Error('Fly API error (422): insufficient capacity in fra')),
    });
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await expect(client.execSync(sandboxId, 'echo hi')).rejects.toThrow(/Failed to wake Fly machine.*don't reserve host capacity.*insufficient capacity/s);
    await expect(client.execSync(sandboxId, 'echo hi')).rejects.toBeInstanceOf(MachineWakeError);
  });

  it('does not call a machine Fly never finished stopping a capacity problem (note #714)', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ state: 'stopped', private_ip: PRIVATE_IP })),
      startMachine: vi.fn().mockRejectedValue(new FlyApiError('Fly API error (412): failed_precondition: machine still stopping, refusing to start', 412)),
    });
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const error = await client.execSync(sandboxId, 'echo hi').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MachineWakeError);
    expect((error as Error).message).toMatch(/^Failed to wake Fly machine .*: Fly API error \(412\): failed_precondition: machine still stopping/);
    expect((error as Error).message).not.toMatch(/capacity/);
    // And says how long it waited for the stop to finish (note #763).
    expect((error as Error).message).toMatch(/which Fly kept calling "still stopping" for \d+s/);
  });

  it('keeps trying past the ordinary wake window while Fly says the machine is still stopping, and wakes it when the stop finishes (note #763)', async () => {
    const server = await listenOnLoopback();
    let starts = 0;
    let state: 'stopped' | 'started' = 'stopped';
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockImplementation(async () => startedMachine({ state, private_ip: '127.0.0.1' })),
      startMachine: vi.fn().mockImplementation(async () => {
        starts += 1;
        // Far more refusals than the 60 ms window at a 5 ms poll allows: the
        // stop finishes only on the 40th ask, as a slow host's would.
        if (starts < 40) throw new FlyApiError('Fly API error (412): failed_precondition: machine still stopping, refusing to start', 412);
        state = 'started';
      }),
    });
    const client = createClient(flyClient, createFakeSshClient(), { sshPort: server.port, wakeStoppingTimeoutMs: 10_000 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const conn = await client.resolveSshConnection(sandboxId);

    expect(conn).toMatchObject({ host: '127.0.0.1', port: server.port });
    expect(flyClient.startMachine).toHaveBeenCalledTimes(40);
    server.close();
  });

  it('kills a machine whose stop has hung for the force-stop wait, then starts it (owner, 2026-10-16)', async () => {
    const server = await listenOnLoopback();
    let state: 'stopped' | 'started' = 'stopped';
    let killed = false;
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockImplementation(async () => startedMachine({ state, private_ip: '127.0.0.1' })),
      // Fly refuses every start until the kill lands; the start right after it is accepted.
      startMachine: vi.fn().mockImplementation(async () => {
        if (!killed) throw new FlyApiError('Fly API error (412): failed_precondition: machine still stopping, refusing to start', 412);
        state = 'started';
      }),
      stopMachine: vi.fn().mockImplementation(async () => { killed = true; }),
    });
    const client = createClient(flyClient, createFakeSshClient(), { sshPort: server.port, wakeStoppingTimeoutMs: 10_000, wakeForceStopAfterMs: 40 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const conn = await client.resolveSshConnection(sandboxId);

    expect(conn).toMatchObject({ host: '127.0.0.1', port: server.port });
    expect(flyClient.stopMachine).toHaveBeenCalledTimes(1);
    expect(flyClient.stopMachine).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60', MACHINE_ID, { signal: 'SIGKILL', timeout: '5s' });
    // Refused for at least the force-stop wait before the kill was asked for.
    expect((flyClient.startMachine as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(4);
    server.close();
  });

  it('asks for the kill once, and a refused kill keeps the wait going to its end (owner, 2026-10-16)', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ state: 'stopped', private_ip: PRIVATE_IP })),
      startMachine: vi.fn().mockRejectedValue(new FlyApiError('Fly API error (412): failed_precondition: machine still stopping, refusing to start', 412)),
      stopMachine: vi.fn().mockRejectedValue(new FlyApiError('Fly API error (412): failed_precondition: machine still stopping', 412)),
    });
    const client = createClient(flyClient, createFakeSshClient(), { wakeStoppingTimeoutMs: 300, wakeForceStopAfterMs: 40 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const error = await client.execSync(sandboxId, 'echo hi').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MachineWakeError);
    expect((error as Error).message).toMatch(/still stopping" for \d+s \(even after a kill was asked for\)/);
    expect(flyClient.stopMachine).toHaveBeenCalledTimes(1);
  });

  it('never kills when the force-stop wait is off (non-positive)', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ state: 'stopped', private_ip: PRIVATE_IP })),
      startMachine: vi.fn().mockRejectedValue(new FlyApiError('Fly API error (412): failed_precondition: machine still stopping, refusing to start', 412)),
    });
    const client = createClient(flyClient, createFakeSshClient(), { wakeForceStopAfterMs: 0 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);
    await expect(client.execSync(sandboxId, 'echo hi')).rejects.toBeInstanceOf(MachineWakeError);
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
  });

  it('gives a refusal that stops being "still stopping" only the ordinary window (note #763)', async () => {
    let starts = 0;
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ state: 'stopped', private_ip: PRIVATE_IP })),
      startMachine: vi.fn().mockImplementation(async () => {
        starts += 1;
        if (starts <= 2) throw new FlyApiError('Fly API error (412): failed_precondition: machine still stopping, refusing to start', 412);
        throw new Error('Fly API error (422): insufficient capacity in fra');
      }),
    });
    const client = createClient(flyClient, createFakeSshClient(), { wakeStoppingTimeoutMs: 10_000 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const begun = Date.now();
    await expect(client.execSync(sandboxId, 'echo hi')).rejects.toThrow(/don't reserve host capacity.*insufficient capacity/s);
    // Well inside the 10 s "still stopping" budget: the capacity answer ended it at the 60 ms window.
    expect(Date.now() - begun).toBeLessThan(2_000);
  });
});

describe('FlySandboxClient status / stop / destroy', () => {
  it('maps machine state to sandbox status without waking', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ state: 'stopped' })),
    });
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const info = await client.getSandbox(sandboxId);
    expect(info.status).toBe('stopped');
    expect(flyClient.startMachine).not.toHaveBeenCalled();
  });

  it('does not call a stopping or unknown Fly state running', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn()
        .mockResolvedValueOnce(startedMachine({ state: 'stopping' }))
        .mockResolvedValueOnce(startedMachine({ state: 'mystery-transition' })),
    });
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await expect(client.getSandbox(sandboxId)).resolves.toMatchObject({ status: 'stopped' });
    await expect(client.getSandbox(sandboxId)).resolves.toMatchObject({ status: 'error' });
    expect(flyClient.startMachine).not.toHaveBeenCalled();
  });

  it('deletes the machine + volume and the app when it was the last machine', async () => {
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await client.destroySandbox(sandboxId);
    expect(flyClient.deleteMachine).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60', MACHINE_ID, { force: true });
    expect(flyClient.deleteVolume).toHaveBeenCalled();
    expect(flyClient.deleteApp).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60');
  });

  it('keeps the app when other machines remain', async () => {
    const flyClient = createFakeFlyClient({
      listMachines: vi.fn().mockResolvedValue([{ id: 'other-machine', state: 'stopped' }]),
    });
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await client.destroySandbox(sandboxId);
    expect(flyClient.deleteApp).not.toHaveBeenCalled();
  });
});

/**
 * Note #268 — moving an agent's machine onto another shape. Two rules that
 * each cost a user something when broken: a sleeping machine must not be
 * woken by the write, and a no-op must not spend a reboot.
 */
describe('FlySandboxClient.resizeSandbox', () => {
  const APP = 'ia-9f0a1b2c3d4e5f60';
  const sandboxId = () => FlySandboxClient.buildSandboxId(APP, MACHINE_ID);

  it('writes the new guest and keeps the rest of the config', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({
        state: 'stopped',
        config: {
          image: 'registry.fly.io/ia-machine-images:sha-test',
          guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 },
          env: { AUTHORIZED_KEYS: 'ssh-ed25519 AAAAKEY backend' },
        },
      })),
      updateMachine: vi.fn().mockResolvedValue(startedMachine()),
    });
    const client = createClient(flyClient, createFakeSshClient());

    const result = await client.resizeSandbox(sandboxId(), {
      cpuKind: 'performance', cpus: 4, memoryMb: 8192,
    });

    expect(result).toEqual({ changed: true, awake: false });
    const [app, machineId, config, options] = (flyClient.updateMachine as ReturnType<typeof vi.fn>).mock.calls[0];
    expect([app, machineId]).toEqual([APP, MACHINE_ID]);
    expect(config.guest).toEqual({ cpu_kind: 'performance', cpus: 4, memory_mb: 8192 });
    // A resize is the other moment the shape moves, so the word moves with it
    // — and the rest of the env (the key the backend connects with) survives.
    expect(config.env).toEqual({ AUTHORIZED_KEYS: 'ssh-ed25519 AAAAKEY backend', CPU_KIND: 'performance' });
    // The image (and every other config field) rides across untouched — a
    // whole-config update that dropped one would rebuild the machine wrong.
    expect(config.image).toBe('registry.fly.io/ia-machine-images:sha-test');
    // THE FLAG THAT MATTERS: a config update BOOTS a stopped machine unless
    // this is set, and most of the fleet is asleep most of the time.
    expect(options).toEqual({ skipLaunch: true });
  });

  it('lets a running machine take the reboot, and says it was awake', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine()),
      updateMachine: vi.fn().mockResolvedValue(startedMachine()),
    });
    const client = createClient(flyClient, createFakeSshClient());

    const result = await client.resizeSandbox(sandboxId(), {
      cpuKind: 'performance', cpus: 2, memoryMb: 4096,
    });

    expect(result).toEqual({ changed: true, awake: true });
    expect((flyClient.updateMachine as ReturnType<typeof vi.fn>).mock.calls[0][3]).toEqual({ skipLaunch: false });
  });

  /** Fly reboots a running machine on ANY successful config change, so asking
   *  for the size it already has would kill a live turn to change nothing. */
  it('sends nothing when the machine is already that shape', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine()),
      updateMachine: vi.fn(),
    });
    const client = createClient(flyClient, createFakeSshClient());

    const result = await client.resizeSandbox(sandboxId(), {
      cpuKind: 'shared', cpus: 2, memoryMb: 4096,
    });

    expect(result).toEqual({ changed: false, awake: true });
    expect(flyClient.updateMachine).not.toHaveBeenCalled();
  });

  it('reads the shape back onto the sandbox info, so a screen can name it', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ state: 'stopped' })),
    });
    const client = createClient(flyClient, createFakeSshClient());

    expect(await client.getSandbox(sandboxId())).toMatchObject({
      status: 'stopped', cpuKind: 'shared', cpus: 2, memoryMb: 4096,
    });
  });

  it('answers the volume attached to this machine, and stays quiet when the read fails', async () => {
    const client = createClient(createFakeFlyClient({
      listVolumes: vi.fn().mockResolvedValue([
        { id: 'vol_other', size_gb: 10, attached_machine_id: 'someone-else' },
        { id: 'vol_mine', size_gb: 50, attached_machine_id: MACHINE_ID },
      ]),
    }), createFakeSshClient());
    expect(await client.getSandboxStorageGb(sandboxId())).toBe(50);

    // A missing disk figure is one absent line on the screen, never a screen
    // that will not open.
    const broken = createClient(createFakeFlyClient({
      listVolumes: vi.fn().mockRejectedValue(new Error('Fly API error (500)')),
    }), createFakeSshClient());
    expect(await broken.getSandboxStorageGb(sandboxId())).toBeUndefined();
  });
});

describe('FlySandboxClient.destroyAbandonedApp', () => {
  const APP = 'ia-9f0a1b2c3d4e5f60';

  it('tears down the machine, volume and app of a provision that never finished', async () => {
    const flyClient = createFakeFlyClient({
      listMachines: vi.fn()
        .mockResolvedValueOnce([{ id: MACHINE_ID, state: 'started' }])
        .mockResolvedValue([]),
    });
    const client = createClient(flyClient, createFakeSshClient());

    await client.destroyAbandonedApp(APP);

    expect(flyClient.deleteMachine).toHaveBeenCalledWith(APP, MACHINE_ID, { force: true });
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(APP, 'vol_abc123');
    expect(flyClient.deleteApp).toHaveBeenCalledWith(APP);
  });

  it('still clears the volume and app shell when the machine is already gone', async () => {
    // The half-provisioned shape that bills quietly: no machine, volume left.
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());

    await client.destroyAbandonedApp(APP);

    expect(flyClient.deleteMachine).not.toHaveBeenCalled();
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(APP, 'vol_abc123');
    expect(flyClient.deleteApp).toHaveBeenCalledWith(APP);
  });
});

/**
 * Successful createAgentSandbox paths run the post-create sshd readiness
 * probe; give them a live loopback "sshd" and machines that report 127.0.0.1.
 */
async function createClientWithLoopbackSshd(flyClient: FlyClient) {
  const sshd = await listenOnLoopback();
  (flyClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
    startedMachine({ private_ip: '127.0.0.1' }),
  );
  const client = createClient(flyClient, createFakeSshClient(), { sshPort: sshd.port });
  return { client, close: sshd.close };
}

describe('FlySandboxClient.createAgentSandbox (app-per-agent)', () => {
  it('mints a FRESH app per agent and rolls back the machine + volume + app on failure', async () => {
    // getApp rejects (app absent) → a fresh app is created for this agent.
    const flyClient = createFakeFlyClient({
      createMachine: vi.fn().mockRejectedValue(new Error('Fly API error (422): no capacity')),
    });
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.createAgentSandbox({ name: 'Codex' }))
      .rejects.toThrow('no capacity');

    expect(flyClient.createApp).toHaveBeenCalledTimes(1);
    const appName = (flyClient.createApp as any).mock.calls[0][0].appName;
    // The agent owns its app alone, so a failed provision tears the WHOLE app down.
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(appName, 'vol_abc123');
    expect(flyClient.deleteApp).toHaveBeenCalledWith(appName);
  });

  it('provisions a fresh app + machine and returns its fly record target', async () => {
    const flyClient = createFakeFlyClient();
    const { client, close } = await createClientWithLoopbackSshd(flyClient);
    onTestFinished(() => close());

    const created = await client.createAgentSandbox({ name: 'Codex' });

    const appName = (flyClient.createApp as any).mock.calls[0][0].appName;
    expect(appName).toMatch(/^ia-[0-9a-f]{16}$/);
    expect(created.appName).toBe(appName);
    expect(created.machineId).toBe(MACHINE_ID);
    expect(created.sandboxId).toBe(`fly-sandbox-${appName}.${MACHINE_ID}`);
    expect(flyClient.createVolume).toHaveBeenCalledWith(appName, expect.objectContaining({ sizeGb: 10 }));
  });

  /**
   * NOTE #355: the organization chooses what its new agents are built on, and
   * one client serves every organization on this backend — so the shape rides
   * the CALL, and a call that names none still builds the machine every agent
   * got before the setting existed.
   */
  it('builds at the shape the caller asked for, and at the standard one when it asks for none', async () => {
    const flyClient = createFakeFlyClient();
    const { client, close } = await createClientWithLoopbackSshd(flyClient);
    onTestFinished(() => close());

    await client.createAgentSandbox({ name: 'Codex', size: { cpuKind: 'shared', cpus: 1, memoryMb: 2048 } });
    expect((flyClient.createMachine as any).mock.calls[0][1].guest)
      .toEqual({ cpu_kind: 'shared', cpus: 1, memory_mb: 2048 });
    // …and the machine is TOLD which half of the ladder it landed on, so its
    // own CLAUDE.md can say "1 shared core" rather than leaving an agent to
    // read the throttling as a bug in its code (note #393).
    expect((flyClient.createMachine as any).mock.calls[0][1].env.CPU_KIND).toBe('shared');

    await client.createAgentSandbox({ name: 'Codex' });
    expect((flyClient.createMachine as any).mock.calls[1][1].guest).toEqual({
      cpu_kind: DEFAULT_AGENT_MACHINE_SIZE.cpuKind,
      cpus: DEFAULT_AGENT_MACHINE_SIZE.cpus,
      memory_mb: DEFAULT_AGENT_MACHINE_SIZE.memoryMb,
    });
    expect((flyClient.createMachine as any).mock.calls[1][1].env.CPU_KIND)
      .toBe(DEFAULT_AGENT_MACHINE_SIZE.cpuKind);
  });

  it('hands the caller the app name BEFORE anything by that name exists', async () => {
    // The whole anti-orphan guarantee: whatever dies next, the app that may be
    // born is already named on a record somebody owns.
    const flyClient = createFakeFlyClient();
    const { client, close } = await createClientWithLoopbackSshd(flyClient);
    onTestFinished(() => close());

    let appsCreatedWhenNamed = -1;
    let namedWith = '';
    const created = await client.createAgentSandbox({
      name: 'Codex',
      onAppNamed: async (appName) => {
        namedWith = appName;
        appsCreatedWhenNamed = (flyClient.createApp as any).mock.calls.length;
      },
    });

    expect(appsCreatedWhenNamed).toBe(0);
    expect(namedWith).toBe(created.appName);
  });

  it('creates NOTHING when the caller cannot record the app name', async () => {
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.createAgentSandbox({
      name: 'Codex',
      onAppNamed: async () => { throw new Error('agent record is gone'); },
    })).rejects.toThrow('agent record is gone');

    expect(flyClient.createApp).not.toHaveBeenCalled();
    expect(flyClient.createVolume).not.toHaveBeenCalled();
    expect(flyClient.createMachine).not.toHaveBeenCalled();
  });

  it('lands two consecutive agent creations in DIFFERENT apps (no shared URL)', async () => {
    const flyClient = createFakeFlyClient();
    const { client, close } = await createClientWithLoopbackSshd(flyClient);
    onTestFinished(() => close());

    const first = await client.createAgentSandbox({ name: 'Claude Code' });
    const second = await client.createAgentSandbox({ name: 'Codex' });

    // Each agent gets its own opaque app slug → its own exclusive fly.dev URL.
    expect(first.appName).not.toBe(second.appName);
    expect(flyClient.createApp).toHaveBeenCalledTimes(2);
    const slugs = (flyClient.createApp as any).mock.calls.map((c: any[]) => c[0].appName);
    expect(new Set(slugs).size).toBe(2);
    for (const slug of slugs) {
      expect(slug).toMatch(/^ia-[0-9a-f]{16}$/);
    }
  });

  it('bakes the public 8080 service + PUBLIC_PORT env and pre-allocates the shared IPv4', async () => {
    const flyClient = createFakeFlyClient();
    const { client, close } = await createClientWithLoopbackSshd(flyClient);
    onTestFinished(() => close());

    const created = await client.createAgentSandbox({ name: 'Codex' });

    expect(flyClient.ensureSharedIpv4).toHaveBeenCalledWith(created.appName);
    const machineArgs = (flyClient.createMachine as any).mock.calls[0][1];
    expect(machineArgs.env.PUBLIC_PORT).toBe('8080');
    expect(machineArgs.services).toEqual([
      {
        protocol: 'tcp',
        internal_port: 8080,
        autostart: true,
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'], force_https: true },
        ],
      },
    ]);
  });
});

describe('FlySandboxClient.resolveSshConnection', () => {
  it('wakes a stopped machine and returns its private IPv6 on the sshd port as agent', async () => {
    const server = await listenOnLoopback();
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn()
        .mockResolvedValueOnce(startedMachine({ state: 'stopped' }))
        .mockResolvedValue(startedMachine({ private_ip: '127.0.0.1' })),
    });
    const client = createClient(flyClient, createFakeSshClient(), { sshPort: server.port });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const conn = await client.resolveSshConnection(sandboxId);

    expect(flyClient.startMachine).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60', MACHINE_ID);
    expect(conn).toMatchObject({ host: '127.0.0.1', port: server.port, username: 'agent', privateKey: 'PRIVATE' });
    server.close();
  });
});

describe('FlySandboxClient post-wake sshd readiness', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (servers.length) servers.pop()!.close();
  });

  it('waits until :2222 accepts a connection before returning the target', async () => {
    // A machine whose sshd port only starts accepting after a delay — the wake
    // path must poll until it opens rather than SSHing into a closed port.
    const port = await reserveClosedPort();
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn()
        .mockResolvedValueOnce(startedMachine({ state: 'stopped' }))
        .mockResolvedValue(startedMachine({ private_ip: '127.0.0.1' })),
    });
    const client = createClient(flyClient, createFakeSshClient(), {
      sshPort: port,
      wakeReadinessTimeoutMs: 2_000,
      wakeReadinessProbeIntervalMs: 10,
    });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const startedAt = Date.now();
    const wakePromise = client.wakeSandbox(sandboxId);
    // Open the port only after a delay; the probe should have been failing until now.
    const openTimer = setTimeout(() => {
      const server = net.createServer((socket) => socket.destroy());
      server.listen(port, '127.0.0.1');
      servers.push({ close: () => server.close() });
    }, 80);

    await expect(wakePromise).resolves.toBeUndefined();
    clearTimeout(openTimer);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
  });

  it('throws a clear, machine-scoped error when :2222 never opens', async () => {
    const port = await reserveClosedPort();
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn()
        .mockResolvedValueOnce(startedMachine({ state: 'stopped' }))
        .mockResolvedValue(startedMachine({ private_ip: '127.0.0.1' })),
    });
    const client = createClient(flyClient, createFakeSshClient(), {
      sshPort: port,
      wakeReadinessTimeoutMs: 80,
      wakeReadinessProbeIntervalMs: 10,
    });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await expect(client.wakeSandbox(sandboxId)).rejects.toThrow(
      /ia-9f0a1b2c3d4e5f60.*9080e6d3a6e389.*did not accept a connection|9080e6d3a6e389.*did not accept a connection/s,
    );
  });

  it('does not probe on the hot path when the machine is already started', async () => {
    // sshd port is closed here; if the hot path wrongly probed it, the readiness
    // wait would fail. An already-started machine must skip the probe entirely.
    const closedPort = await reserveClosedPort();
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ private_ip: '127.0.0.1' })),
    });
    const sshClient = createFakeSshClient();
    const client = createClient(flyClient, sshClient, { sshPort: closedPort });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const result = await client.execSync(sandboxId, 'echo hi');

    expect(flyClient.startMachine).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(sshClient.execCommand).toHaveBeenCalledTimes(1);
  });

  it('retries a transient SSH connect failure right after wake through to success', async () => {
    // Already-started machine (no probe); the first SSH connect is refused (the
    // residual race between "port accepts" and "sshd ready for auth"), the retry succeeds.
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ private_ip: '127.0.0.1' })),
    });
    const sshClient = createFakeSshClient();
    (sshClient.execCommand as any)
      .mockRejectedValueOnce(new Error('SSH connection failed: connect ECONNREFUSED fdaa:99::2222'))
      .mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false });
    const client = createClient(flyClient, sshClient);
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    const result = await client.execSync(sandboxId, 'echo hi');

    expect(result.exitCode).toBe(0);
    expect(sshClient.execCommand).toHaveBeenCalledTimes(2);
  });

  it('surfaces a persistent SSH connect failure after exhausting bounded retries', async () => {
    const flyClient = createFakeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ private_ip: '127.0.0.1' })),
    });
    const sshClient = createFakeSshClient();
    (sshClient.execCommand as any).mockRejectedValue(
      new Error('SSH connection failed: connect ECONNREFUSED fdaa:99::2222'),
    );
    const client = createClient(flyClient, sshClient, { connectRetryAttempts: 2 });
    const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

    await expect(client.execSync(sandboxId, 'echo hi')).rejects.toThrow(/ECONNREFUSED/);
    expect(sshClient.execCommand).toHaveBeenCalledTimes(2);
  });
});

describe('FlySandboxClient: a machine that does not answer (note #1068)', () => {
  const OURS = 'fdaa:99:600e:a7b:18b:d4ce:fb3c:2';
  const OLD = 'fdaa:99:600e:a7b:8dd7:52b6:5f88:4e02';
  const handshakeTimeout = () => new Error('SSH connection failed: Timed out while waiting for handshake');
  const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

  it('gives every connection a 15-second budget', async () => {
    const sshClient = createFakeSshClient();
    const client = createClient(createFakeFlyClient(), sshClient, { backendPeerIp: OURS });
    await client.execSync(sandboxId, 'echo hi');
    expect((sshClient.execCommand as any).mock.calls[0][0].readyTimeoutMs).toBe(15_000);
    expect((await client.resolveSshConnection(sandboxId)).readyTimeoutMs).toBe(15_000);
  });

  it('names both addresses when the machine admits another one, and re-pins it once', async () => {
    const pinnedElsewhere = startedMachine({
      config: { image: 'registry.fly.io/ia-machine-images:sha-test', env: { BACKEND_PEER_IP: OLD, KEEP: 'me' } },
    } as Partial<FlyMachine>);
    const updateMachine = vi.fn().mockResolvedValue(pinnedElsewhere);
    const flyClient = createFakeFlyClient({ getMachine: vi.fn().mockResolvedValue(pinnedElsewhere), updateMachine });
    const sshClient = createFakeSshClient();
    (sshClient.execCommand as any).mockRejectedValue(handshakeTimeout());
    const client = createClient(flyClient, sshClient, { backendPeerIp: OURS });

    const error = await client.execSync(sandboxId, 'echo hi').catch((caught) => caught);

    expect(error).toBeInstanceOf(MachineUnreachableError);
    expect(error.message).toContain(`Could not reach machine ${MACHINE_ID} in app ia-9f0a1b2c3d4e5f60 over SSH (:2222): 3 tries of 15 s each`);
    expect(error.message).toContain(`This backend connects from ${OURS}, but the machine admits only ${OLD}.`);
    expect(error.message).toContain(`It has been re-pinned to ${OURS} and is restarting`);
    expect(updateMachine).toHaveBeenCalledTimes(1);
    const [, , config, options] = updateMachine.mock.calls[0];
    expect(config.env).toEqual({ BACKEND_PEER_IP: OURS, KEEP: 'me' });
    expect(config.image).toBe('registry.fly.io/ia-machine-images:sha-test');
    expect(options).toEqual({});

    // A second failure inside the interval explains again but does not re-pin again.
    const again = await client.execSync(sandboxId, 'echo hi').catch((caught) => caught);
    expect(again.message).toContain(`admits only ${OLD}`);
    expect(updateMachine).toHaveBeenCalledTimes(1);
  });

  it('re-pins nothing when the machine already admits this backend, and still says where we came from', async () => {
    const pinnedToUs = startedMachine({
      config: { image: 'registry.fly.io/ia-machine-images:sha-test', env: { BACKEND_PEER_IP: OURS } },
    } as Partial<FlyMachine>);
    const updateMachine = vi.fn();
    const flyClient = createFakeFlyClient({ getMachine: vi.fn().mockResolvedValue(pinnedToUs), updateMachine });
    const sshClient = createFakeSshClient();
    (sshClient.execCommand as any).mockRejectedValue(handshakeTimeout());
    const client = createClient(flyClient, sshClient, { backendPeerIp: OURS });

    const error = await client.execSync(sandboxId, 'echo hi').catch((caught) => caught);

    expect(error).toBeInstanceOf(MachineUnreachableError);
    expect(error.message).toContain(`This backend connects from ${OURS}.`);
    expect(updateMachine).not.toHaveBeenCalled();
  });

  it('a command that fails ON the machine is not called unreachable', async () => {
    const sshClient = createFakeSshClient();
    (sshClient.execCommand as any).mockRejectedValue(new Error('SSH exec failed: channel open failure'));
    const client = createClient(createFakeFlyClient(), sshClient, { backendPeerIp: OURS });
    const error = await client.execSync(sandboxId, 'echo hi').catch((caught) => caught);
    expect(error).not.toBeInstanceOf(MachineUnreachableError);
    expect(sshClient.execCommand).toHaveBeenCalledTimes(1);
  });
});

describe('FlySandboxClient.exposePort / unexposePort', () => {
  const APP = 'ia-9f0a1b2c3d4e5f60';

  function exposeFlyClient(overrides: Record<string, any> = {}) {
    return createFakeFlyClient({
      ensureSharedIpv4: vi.fn().mockResolvedValue('137.66.1.2'),
      updateMachine: vi.fn().mockResolvedValue(startedMachine()),
      getMachine: vi.fn().mockResolvedValue(startedMachine({ config: { image: 'img', guest: {} } })),
      ...overrides,
    });
  }

  it('allocates a shared IPv4, sets the 443/80 service, opens+persists the firewall, and returns the fly.dev URL', async () => {
    const flyClient = exposeFlyClient();
    const sshClient = createFakeSshClient();
    const client = createClient(flyClient, sshClient);
    const sandboxId = FlySandboxClient.buildSandboxId(APP, MACHINE_ID);

    const result = await client.exposePort(sandboxId, 3000);

    // 1. Shared IPv4 ensured (idempotent allocate-if-absent).
    expect(flyClient.ensureSharedIpv4).toHaveBeenCalledWith(APP);

    // 2. Machine config updated with the 443 (tls+http) / 80 (http, force_https) service.
    const [app, machineId, config] = (flyClient.updateMachine as any).mock.calls[0];
    expect(app).toBe(APP);
    expect(machineId).toBe(MACHINE_ID);
    expect(config.image).toBe('img'); // full config preserved
    expect(config.services).toEqual([
      {
        protocol: 'tcp',
        internal_port: 3000,
        autostart: true,
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'], force_https: true },
        ],
      },
    ]);

    // 3+4. Firewall accept inserted ahead of the drop + persisted to the volume file.
    const command = (sshClient.execCommand as any).mock.calls[0][1] as string;
    expect(command).toContain('/data/exposed-ports');
    expect(command).toContain('nft insert rule ip6 fly_fw input tcp dport 3000 accept');

    expect(result).toEqual({ url: `https://${APP}.fly.dev`, port: 3000, appName: APP });
  });

  it('merges with already-exposed services and de-dupes by internal_port (idempotent double-expose)', async () => {
    const existing = {
      protocol: 'tcp',
      internal_port: 8080,
      ports: [{ port: 443, handlers: ['tls', 'http'] }],
    };
    const flyClient = exposeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ config: { image: 'img', services: [existing, { protocol: 'tcp', internal_port: 3000, ports: [] }] } })),
    });
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId(APP, MACHINE_ID);

    await client.exposePort(sandboxId, 3000);

    const config = (flyClient.updateMachine as any).mock.calls[0][2];
    // The prior 8080 service is preserved; the stale 3000 entry is replaced (not duplicated).
    expect(config.services).toHaveLength(2);
    expect(config.services[0]).toEqual(existing);
    expect(config.services[1].internal_port).toBe(3000);
    expect(config.services.filter((s: any) => s.internal_port === 3000)).toHaveLength(1);
  });

  it('is reboot-free when re-exposing the pre-wired public port (skips the no-op config update)', async () => {
    const prewired = {
      protocol: 'tcp',
      internal_port: 8080,
      autostart: true,
      ports: [
        { port: 443, handlers: ['tls', 'http'] },
        { port: 80, handlers: ['http'], force_https: true },
      ],
    };
    const flyClient = exposeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ config: { image: 'img', services: [prewired] } })),
    });
    const sshClient = createFakeSshClient();
    const client = createClient(flyClient, sshClient);
    const sandboxId = FlySandboxClient.buildSandboxId(APP, MACHINE_ID);

    const result = await client.exposePort(sandboxId, 8080);

    // The pre-wired service already matches → no machine config update → no reboot.
    expect(flyClient.updateMachine).not.toHaveBeenCalled();
    // Still idempotently ensures the IP, opens the firewall, and returns the URL.
    expect(flyClient.ensureSharedIpv4).toHaveBeenCalledWith(APP);
    expect((sshClient.execCommand as any).mock.calls[0][1]).toContain('tcp dport 8080 accept');
    expect(result).toEqual({ url: `https://${APP}.fly.dev`, port: 8080, appName: APP });
  });

  it('does not allocate an IP when one already exists (ensureSharedIpv4 handles idempotency)', async () => {
    const flyClient = exposeFlyClient({ ensureSharedIpv4: vi.fn().mockResolvedValue('137.66.1.2') });
    const client = createClient(flyClient, createFakeSshClient());
    await client.exposePort(FlySandboxClient.buildSandboxId(APP, MACHINE_ID), 3000);
    expect(flyClient.ensureSharedIpv4).toHaveBeenCalledTimes(1);
  });

  it('rejects the SSH port and out-of-range ports before touching Fly', async () => {
    const flyClient = exposeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());
    const sandboxId = FlySandboxClient.buildSandboxId(APP, MACHINE_ID);

    await expect(client.exposePort(sandboxId, 2222)).rejects.toThrow(/reserved/i);
    await expect(client.exposePort(sandboxId, 22)).rejects.toThrow(/reserved/i);
    await expect(client.exposePort(sandboxId, 0)).rejects.toThrow(/between 1 and 65535/);
    await expect(client.exposePort(sandboxId, 70000)).rejects.toThrow(/between 1 and 65535/);
    expect(flyClient.ensureSharedIpv4).not.toHaveBeenCalled();
    expect(flyClient.updateMachine).not.toHaveBeenCalled();
  });

  it('surfaces a failure to open the firewall on the machine', async () => {
    const flyClient = exposeFlyClient();
    const sshClient = createFakeSshClient();
    (sshClient.execCommand as any).mockResolvedValue({ stdout: '', stderr: 'nft: permission denied', exitCode: 1, timedOut: false });
    const client = createClient(flyClient, sshClient);

    await expect(client.exposePort(FlySandboxClient.buildSandboxId(APP, MACHINE_ID), 3000))
      .rejects.toThrow(/Failed to open the firewall/);
  });

  it('unexposePort drops the port service, removes the runtime rule, and clears the persist file', async () => {
    const flyClient = exposeFlyClient({
      getMachine: vi.fn().mockResolvedValue(startedMachine({ config: { image: 'img', services: [
        { protocol: 'tcp', internal_port: 3000, ports: [] },
        { protocol: 'tcp', internal_port: 8080, ports: [] },
      ] } })),
    });
    const sshClient = createFakeSshClient();
    const client = createClient(flyClient, sshClient);
    const sandboxId = FlySandboxClient.buildSandboxId(APP, MACHINE_ID);

    const result = await client.unexposePort(sandboxId, 3000);

    const config = (flyClient.updateMachine as any).mock.calls[0][2];
    expect(config.services).toEqual([{ protocol: 'tcp', internal_port: 8080, ports: [] }]);

    const command = (sshClient.execCommand as any).mock.calls[0][1] as string;
    expect(command).toContain('/data/exposed-ports');
    expect(command).toContain('tcp dport 3000 accept');
    expect(command).toContain('nft delete rule');

    expect(result).toEqual({ port: 3000, appName: APP, remaining: 1 });
  });
});

describe('FlySandboxClient.parseSandboxId', () => {
  it('throws on a non-fly sandbox id', () => {
    expect(() => FlySandboxClient.parseSandboxId('hcloud-sandbox-1')).toThrow('Unsupported Fly sandbox id');
  });
});


describe('FlySandboxClient.createAgentSandbox region fallback', () => {
  it('retries the primary once, then falls back to the neighbor region on start-deadline 408s', async () => {
    const flyClient = createFakeFlyClient();
    // Two fra start-deadline failures, then success (the ams attempt).
    (flyClient.waitForMachineState as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Fly API error (408): deadline_exceeded: machine failed to reach desired state, started, currently created'))
      .mockRejectedValueOnce(new Error('Fly API error (408): deadline_exceeded: machine failed to reach desired state, started, currently created'))
      .mockResolvedValue(undefined);
    const sshd = await listenOnLoopback();
    onTestFinished(() => sshd.close());
    (flyClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
      startedMachine({ private_ip: '127.0.0.1' }),
    );
    const client = createClient(flyClient, createFakeSshClient(), { fallbackRegions: ['ams'], sshPort: sshd.port });

    const created = await client.createAgentSandbox({ name: 'Emma' });

    expect(created.region).toBe('ams');
    const volumeRegions = (flyClient.createVolume as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].region);
    expect(volumeRegions).toEqual(['fra', 'fra', 'ams']);
    const machineRegions = (flyClient.createMachine as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].region);
    expect(machineRegions).toEqual(['fra', 'fra', 'ams']);
    // Every failed attempt rolled back its app/volume/machine.
    expect((flyClient.deleteApp as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('re-announces the app name on every region attempt', async () => {
    // Each attempt mints its own app, so a caller told only about the first
    // would be holding the name of an app that was rolled back — and blind to
    // the one that actually exists.
    const flyClient = createFakeFlyClient();
    (flyClient.waitForMachineState as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Fly API error (408): deadline_exceeded: machine failed to reach desired state, started, currently created'))
      .mockResolvedValue(undefined);
    const sshd = await listenOnLoopback();
    onTestFinished(() => sshd.close());
    (flyClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
      startedMachine({ private_ip: '127.0.0.1' }),
    );
    const client = createClient(flyClient, createFakeSshClient(), { fallbackRegions: ['ams'], sshPort: sshd.port });

    const named: string[] = [];
    const created = await client.createAgentSandbox({
      name: 'Emma',
      onAppNamed: async (appName) => { named.push(appName); },
    });

    expect(named).toHaveLength(2);
    expect(named[0]).not.toBe(named[1]);
    expect(named.at(-1)).toBe(created.appName);
  });

  it('does not region-retry non-transient errors', async () => {
    const flyClient = createFakeFlyClient();
    (flyClient.createVolume as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('Fly API error (422): unprocessable'));
    const client = createClient(flyClient, createFakeSshClient(), { fallbackRegions: ['ams'] });

    await expect(client.createAgentSandbox({ name: 'Emma' })).rejects.toThrow('422');
    expect((flyClient.createVolume as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe('FlySandboxClient.sandboxExists', () => {
  const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

  it('is true for a machine Fly still knows about', async () => {
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.sandboxExists(sandboxId)).resolves.toBe(true);
  });

  it('is false only on a definite 404', async () => {
    const flyClient = createFakeFlyClient();
    (flyClient.getMachine as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new FlyApiError('Fly API error (404): machine not found', 404));
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.sandboxExists(sandboxId)).resolves.toBe(false);
  });

  it('is false for a machine Fly still lists but has destroyed', async () => {
    // A destroyed machine keeps answering GET with state 'destroyed' for a
    // while; a start against it is refused with 412. Existence must read the
    // state, or the rebuild written for a gone machine never runs.
    for (const state of ['destroyed', 'destroying'] as const) {
      const flyClient = createFakeFlyClient();
      (flyClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(startedMachine({ state }));
      const client = createClient(flyClient, createFakeSshClient());

      await expect(client.sandboxExists(sandboxId)).resolves.toBe(false);
    }
  });

  it('is false on 403 — the app is in an organization this token cannot see', async () => {
    // A workplace that moved its cloud: the old account's machines are out of
    // reach by design, and Fly says so with 403 (a bad token is 401).
    const flyClient = createFakeFlyClient();
    (flyClient.getMachine as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new FlyApiError('Fly API error (403): unauthorized', 403));
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.sandboxExists(sandboxId)).resolves.toBe(false);
  });

  it('assumes the machine exists when Fly is merely unhappy', async () => {
    // A false "gone" costs the user their repos and uncommitted work, so every
    // ambiguous failure — 5xx, auth, network — has to answer true.
    for (const failure of [
      new FlyApiError('Fly API error (500): internal', 500),
      new FlyApiError('Fly API error (401): unauthorized', 401),
      new Error('fetch failed'),
    ]) {
      const flyClient = createFakeFlyClient();
      (flyClient.getMachine as ReturnType<typeof vi.fn>).mockRejectedValue(failure);
      const client = createClient(flyClient, createFakeSshClient());

      await expect(client.sandboxExists(sandboxId)).resolves.toBe(true);
    }
  });

  it('assumes the machine exists for a sandbox id it cannot parse', async () => {
    const flyClient = createFakeFlyClient();
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.sandboxExists('hcloud-sandbox-1')).resolves.toBe(true);
    expect(flyClient.getMachine).not.toHaveBeenCalled();
  });
});
describe('FlySandboxClient volume sizing + region defaults', () => {
  /**
   * A client built WITHOUT region/volume options, so the shipped defaults are
   * what gets exercised. Timeouts are still shrunk — they are test ergonomics,
   * not the behaviour under test.
   */
  function createDefaultClient(
    flyClient: FlyClient,
    sshPort: number,
    overrides: Record<string, unknown> = {},
  ) {
    return new FlySandboxClient({
      apiToken: 'token',
      orgSlug: 'infinite-agents',
      machineImage: 'registry.fly.io/ia-machine-images:sha-test',
      sshPrivateKey: 'PRIVATE',
      sshPort,
      wakeTimeoutMs: 60,
      wakePollIntervalMs: 5,
      createTimeoutMs: 60,
      wakeReadinessTimeoutMs: 200,
      wakeReadinessProbeIntervalMs: 10,
      connectRetryAttempts: 1,
      connectRetryBackoffMs: 5,
      flyClient,
      sshClient: createFakeSshClient(),
      ...overrides,
    } as ConstructorParameters<typeof FlySandboxClient>[0]);
  }

  /** Fly client + a live loopback sshd, so createAgentSandbox runs to completion. */
  async function setup(overrides: Record<string, unknown> = {}) {
    const flyClient = createFakeFlyClient();
    (flyClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
      startedMachine({ private_ip: '127.0.0.1' }),
    );
    const sshd = await listenOnLoopback();
    onTestFinished(() => sshd.close());
    return { flyClient, client: createDefaultClient(flyClient, sshd.port, overrides) };
  }

  function mountOf(flyClient: FlyClient) {
    return (flyClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[0][1].mounts[0];
  }

  it('provisions a 5GB volume in ams that grows itself past 80% full', async () => {
    const { flyClient, client } = await setup();

    await client.createAgentSandbox({ name: 'Ada' });

    expect(flyClient.createVolume).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ region: 'ams', sizeGb: 5 }),
    );
    expect((flyClient.createMachine as ReturnType<typeof vi.fn>).mock.calls[0][1].region).toBe('ams');
    expect(mountOf(flyClient)).toEqual({
      volume: 'vol_abc123',
      path: '/data',
      extend_threshold_percent: 80,
      add_size_gb: 5,
      size_gb_limit: 50,
    });
  });

  it('falls back to fra when ams declines the start', async () => {
    // The default fallback list has to be the MIRROR of the primary region: it
    // is filtered against the primary, so leaving it as ['ams'] while moving
    // the primary to ams would silently leave no fallback at all.
    const { flyClient, client } = await setup();
    (flyClient.waitForMachineState as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Fly API error (408): deadline_exceeded: machine failed to reach desired state, started, currently created'))
      .mockRejectedValueOnce(new Error('Fly API error (408): deadline_exceeded: machine failed to reach desired state, started, currently created'))
      .mockResolvedValue(undefined);

    const created = await client.createAgentSandbox({ name: 'Ada' });

    expect(created.region).toBe('fra');
  });

  it('omits the auto-extend clause entirely when it is switched off', async () => {
    // A mount carrying extend_threshold_percent WITHOUT add_size_gb is rejected
    // by Fly at create time, so a bad increment has to drop the whole clause
    // rather than break provisioning.
    for (const off of [{ volumeExtendThresholdPercent: 0 }, { volumeExtendIncrementGb: 0 }]) {
      const { flyClient, client } = await setup(off);

      await client.createAgentSandbox({ name: 'Ada' });

      expect(mountOf(flyClient)).toEqual({ volume: 'vol_abc123', path: '/data' });
    }
  });

  it('drops only the ceiling when no size limit is wanted', async () => {
    const { flyClient, client } = await setup({ volumeSizeLimitGb: 0 });

    await client.createAgentSandbox({ name: 'Ada' });

    expect(mountOf(flyClient).size_gb_limit).toBeUndefined();
    expect(mountOf(flyClient).extend_threshold_percent).toBe(80);
  });
});

describe('FlySandboxClient.destroySandbox', () => {
  const sandboxId = FlySandboxClient.buildSandboxId('ia-9f0a1b2c3d4e5f60', MACHINE_ID);

  it('tears down machine, volume and app', async () => {
    const flyClient = createFakeFlyClient();
    (flyClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
      startedMachine({ config: { mounts: [{ volume: 'vol_abc123' }] } }),
    );
    const client = createClient(flyClient, createFakeSshClient());

    await client.destroySandbox(sandboxId);

    expect(flyClient.deleteMachine).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60', MACHINE_ID, { force: true });
    expect(flyClient.deleteVolume).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60', 'vol_abc123');
    expect(flyClient.deleteApp).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60');
  });

  it('is idempotent for a machine Fly has already forgotten', async () => {
    // A retried teardown, or one racing a manual `fly apps destroy`, must not
    // throw — the recycler's next step is to clear the record, and a machine
    // already in the state we wanted should not block that.
    const flyClient = createFakeFlyClient();
    (flyClient.getMachine as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new FlyApiError('Fly API error (404): machine not found', 404));
    const client = createClient(flyClient, createFakeSshClient());

    await expect(client.destroySandbox(sandboxId)).resolves.toBeUndefined();
    expect(flyClient.deleteMachine).not.toHaveBeenCalled();
  });

  it('still reclaims the volume when only the machine is gone', async () => {
    // The volume is the part that keeps billing, so a half-destroyed app has
    // to be finished off rather than skipped.
    const flyClient = createFakeFlyClient();
    (flyClient.getMachine as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new FlyApiError('Fly API error (404): machine not found', 404));
    (flyClient.listMachines as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (flyClient.listVolumes as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'vol_orphan' }]);
    const client = createClient(flyClient, createFakeSshClient());

    await client.destroySandbox(sandboxId);

    expect(flyClient.deleteVolume).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60', 'vol_orphan');
    expect(flyClient.deleteApp).toHaveBeenCalledWith('ia-9f0a1b2c3d4e5f60');
  });

  it('leaves a shared legacy app alone while it still holds machines', async () => {
    const flyClient = createFakeFlyClient();
    (flyClient.listMachines as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'other' }]);
    const client = createClient(flyClient, createFakeSshClient());

    await client.destroySandbox(sandboxId);

    expect(flyClient.deleteApp).not.toHaveBeenCalled();
  });
});

describe('FlySandboxClient per-app org contexts (byo-fly)', () => {
  const CLIENT_PEER_IP = 'fdaa:77:8899:a7b:1:2:3:4';

  function resolvedContext(orgClient: FlyClient) {
    return {
      client: orgClient,
      orgSlug: 'acme-agents',
      backendPeerIp: CLIENT_PEER_IP,
    };
  }

  it('creates an agent machine entirely in the resolved org: token, slug, peer env', async () => {
    const defaultClient = createFakeFlyClient();
    const orgClient = createFakeFlyClient();
    const sshd = await listenOnLoopback();
    onTestFinished(() => sshd.close());
    (orgClient.getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(
      startedMachine({ private_ip: '127.0.0.1' }),
    );
    const client = createClient(defaultClient, createFakeSshClient(), {
      sshPort: sshd.port,
      resolveAppContext: async () => resolvedContext(orgClient),
    });

    const created = await client.createAgentSandbox({ name: 'Acme dev' });

    // Every Fly call rode the ORG's client; the boot-time one saw nothing.
    expect(orgClient.createApp).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: 'acme-agents' }));
    expect(orgClient.createVolume).toHaveBeenCalled();
    expect(orgClient.createMachine).toHaveBeenCalled();
    expect(defaultClient.createApp).not.toHaveBeenCalled();
    expect(defaultClient.createMachine).not.toHaveBeenCalled();
    // The machine's firewall pin is the backend's peer INTO THAT ORG.
    const machineArgs = (orgClient.createMachine as any).mock.calls[0][1];
    expect(machineArgs.env.BACKEND_PEER_IP).toBe(CLIENT_PEER_IP);
    expect(created.appName).toMatch(/^ia-[0-9a-f]{16}$/);
  });

  it('post-creation operations resolve per app and never use the default client for an unclaimed app', async () => {
    const defaultClient = createFakeFlyClient();
    const orgClient = createFakeFlyClient();
    const client = createClient(defaultClient, createFakeSshClient(), {
      resolveAppContext: async (appName) => (appName === 'ia-clientapp0001' ? resolvedContext(orgClient) : null),
    });

    await client.sandboxExists('fly-sandbox-ia-clientapp0001.9080e6d3a6e389');
    expect(orgClient.getMachine).toHaveBeenCalledWith('ia-clientapp0001', '9080e6d3a6e389');
    expect(defaultClient.getMachine).not.toHaveBeenCalled();

    await expect(client.stopSandbox('fly-sandbox-ia-defaultapp001.9080e6d3a6e389'))
      .rejects.toThrow(/no organization context/);
    expect(defaultClient.stopMachine).not.toHaveBeenCalled();
  });

  it('propagates resolver errors without touching the boot-time client', async () => {
    const defaultClient = createFakeFlyClient();
    const client = createClient(defaultClient, createFakeSshClient(), {
      resolveAppContext: async () => { throw new Error('storage down'); },
    });

    await expect(client.stopSandbox('fly-sandbox-ia-someapp000001.9080e6d3a6e389'))
      .rejects.toThrow(/storage down/);
    expect(defaultClient.stopMachine).not.toHaveBeenCalled();
  });

  /**
   * Note #246. An organization with no Fly account of its own resolves to
   * nothing, and the refusal above is right for every verb that CREATES. On
   * destroy it strands the machine: it keeps running, keeps billing, and the
   * record naming it can never be removed — which in turn made the agent, and
   * the organization holding the agent, permanently undeletable.
   */
  it('destroys with the platform token when the app has no resolvable org', async () => {
    const defaultClient = createFakeFlyClient();
    const client = createClient(defaultClient, createFakeSshClient(), {
      resolveAppContext: async () => null,
    });

    await client.destroySandbox('fly-sandbox-ia-strandedapp01.9080e6d3a6e389');

    expect(defaultClient.deleteMachine)
      .toHaveBeenCalledWith('ia-strandedapp01', '9080e6d3a6e389', { force: true });
    expect(defaultClient.deleteVolume).toHaveBeenCalled();
    expect(defaultClient.deleteApp).toHaveBeenCalledWith('ia-strandedapp01');
  });

  it('falls back for a resolver that throws, and for an abandoned app too', async () => {
    const defaultClient = createFakeFlyClient({
      listMachines: vi.fn().mockResolvedValue([]),
    });
    const client = createClient(defaultClient, createFakeSshClient(), {
      resolveAppContext: async () => { throw new Error('storage down'); },
    });

    await client.destroyAbandonedApp('ia-strandedapp01');
    expect(defaultClient.deleteApp).toHaveBeenCalledWith('ia-strandedapp01');
  });

  /**
   * The fallback is destroy-only on purpose. `sandboxExists` feeds the repair
   * path, which decides whether to REBUILD a machine — reasoning about that
   * through a token which may not be the app's is how a machine gets rebuilt
   * in the wrong organization. Unresolvable keeps its existing answer, "assume
   * it is still there", which declines to rebuild rather than guessing.
   */
  it('keeps the repair path strict — existence never asks the platform token', async () => {
    const defaultClient = createFakeFlyClient();
    const client = createClient(defaultClient, createFakeSshClient(), {
      resolveAppContext: async () => null,
    });

    expect(await client.sandboxExists('fly-sandbox-ia-strandedapp01.9080e6d3a6e389')).toBe(true);
    expect(defaultClient.getMachine).not.toHaveBeenCalled();
  });
});
