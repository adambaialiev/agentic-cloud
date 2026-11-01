import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostingFulfilment } from '../../services/hosting-fulfilment.js';
import { FlyBillingRequiredError } from '../../services/fly-client.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import type { DeploymentService } from '../../services/deployment-service.js';
import type { DeploymentDocument } from '../../types/deployment.js';

/**
 * Building a site and announcing it. This used to live inside the Paddle
 * service, because a machine was only ever built when a payment webhook said
 * so; hosting comes with the plan now, so `agentbuilt deploy` starts the build
 * and this runs with no billing anywhere in the picture.
 *
 * What the tests guard hardest is the same thing they always did: the work
 * runs DETACHED from the request that asked for it, and the backend restarts
 * on every deploy of ours — so the record-level marker has to let a new
 * process pick up where a killed one stopped (a deploy killed hello-world's
 * notice probe 4 seconds before it fired, 2026-08-05).
 */

function makeFulfilment(args: {
  storage?: InMemoryDeploymentStorage;
  notify?: ReturnType<typeof vi.fn>;
  /**
   * What the readiness probe's fetch of the public URL meets: the site
   * (default), nothing at all, or the preview router's 404 for a name it has
   * no mapping for.
   */
  urlReady?: boolean | 'router-404' | 'site-502';
  /** Long enough for a second probe (the first miss is when it nudges). */
  probeTimeoutMs?: number;
} = {}) {
  // The announcement waits for the public URL to answer; tests never hit the
  // network.
  const probeFetch = vi.spyOn(globalThis, 'fetch');
  if (args.urlReady === false) {
    probeFetch.mockRejectedValue(new Error('ENOTFOUND'));
  } else if (args.urlReady === 'site-502') {
    probeFetch.mockImplementation(async () => new Response('bad gateway', { status: 502, headers: { 'fly-request-id': '01M3CWQ2XN8BDDH2JDFQ65VK5S-ams' } }));
  } else if (args.urlReady === 'router-404') {
    probeFetch.mockImplementation(async () => new Response('No such preview.\n', { status: 404 }));
  } else {
    probeFetch.mockImplementation(async () => new Response('ok', { headers: { 'fly-request-id': '01M3CWQ2XN8BDDH2JDFQ65VK5S-ams' } }));
  }
  const storage = args.storage ?? new InMemoryDeploymentStorage();
  const actions = {
    provision: vi.fn(async (id: string) => {
      await storage.update(id, { status: 'live' });
      return { deployment: (await storage.get(id))!, url: 'https://ember.agentbuilt.app' };
    }),
    resume: vi.fn(async (id: string) => {
      await storage.update(id, { status: 'live' });
    }),
    resize: vi.fn(async (id: string, preset: DeploymentDocument['preset']) => {
      await storage.update(id, { preset });
    }),
    url: (d: DeploymentDocument) => `https://${d.name}.agentbuilt.app`,
  };
  const notify = args.notify ?? vi.fn(async () => true);
  const fulfilment = new HostingFulfilment({
    storage,
    service: actions as unknown as DeploymentService,
    notify,
    readyProbe: { timeoutMs: args.probeTimeoutMs ?? 5, intervalMs: 10 },
  });
  return { fulfilment, storage, actions, notify };
}

const seed = (
  storage: InMemoryDeploymentStorage,
  overrides: Partial<DeploymentDocument> = {},
): Promise<DeploymentDocument> => storage.create({
  userId: 'u1', agentId: 'agent-a', name: 'ember', preset: 'static',
  status: 'pending-payment',
  ...overrides,
} as never);

/** The build/notify half runs detached from the caller — let it drain. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bringing a site up', () => {
  it('builds a reserved site and announces it once the address answers', async () => {
    const { fulfilment, storage, actions, notify } = makeFulfilment();
    const dep = await seed(storage);

    expect(await fulfilment.startBringUp(dep.id)).toBe('provisioning');
    await flush();

    expect(actions.provision).toHaveBeenCalledWith(dep.id);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', agentId: 'agent-a', text: expect.stringContaining('live!'),
    }));
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeUndefined();
  });

  it("holds the 'live' announcement when the URL isn't answering yet (DNS/cert lag)", async () => {
    const { fulfilment, storage, notify } = makeFulfilment({ urlReady: false });
    const dep = await seed(storage);

    await fulfilment.startBringUp(dep.id);
    await flush();

    // The site exists either way — but the message must not claim "live"
    // while a visitor still gets an SSL error (first sale, 2026-08-05).
    const announcement = notify.mock.calls.at(-1)![0] as { text: string };
    expect(announcement.text).toContain('no working link yet');
    expect(announcement.text).not.toContain('https://');
    expect(announcement.text).not.toContain('live!');
  });

  it("the preview router's 404 for a name it does not know is not the site answering (2026-09-25)", async () => {
    // Every agentbuilt.app name that is not set up yet gets "No such
    // preview." from the router — an answer, but not the site's.
    const { fulfilment, storage, notify } = makeFulfilment({ urlReady: 'router-404' });
    const dep = await seed(storage);

    await fulfilment.startBringUp(dep.id);
    await flush();

    const announcement = notify.mock.calls.at(-1)![0] as { text: string };
    expect(announcement.text).toContain('no working link yet');
    expect(announcement.text).not.toContain('https://');
    expect(announcement.text).not.toContain('live!');
  });

  it('a site answering with a 5xx is announced as not working, never as live or "starting on its own"', async () => {
    // A link that errors is exactly what the owner never wants handed over.
    const { fulfilment, storage, notify } = makeFulfilment({ urlReady: 'site-502', probeTimeoutMs: 25 });
    const dep = await seed(storage);

    await fulfilment.startBringUp(dep.id);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const announcement = notify.mock.calls.at(-1)![0] as { text: string };
    expect(announcement.text).toContain('HTTP 502');
    expect(announcement.text).toContain('does not work yet');
    expect(announcement.text).not.toContain('live!');
    expect(announcement.text).not.toContain('on its own');
  });

  it('starts a paused site rather than building it again', async () => {
    const { fulfilment, storage, actions } = makeFulfilment();
    const dep = await seed(storage, { status: 'payment-lapsed', flyApp: 'iapp-abc', machineId: 'm1' });

    expect(await fulfilment.startBringUp(dep.id)).toBe('resuming');
    await flush();

    expect(actions.resume).toHaveBeenCalledWith(dep.id);
    expect(actions.provision).not.toHaveBeenCalled();
  });

  it('refuses a site an operator stopped, and one that is already serving', async () => {
    const { fulfilment, storage, actions } = makeFulfilment();
    const stopped = await seed(storage, { name: 'stopped-site', status: 'stopped' });
    const live = await seed(storage, { name: 'live-site', status: 'live' });

    expect(await fulfilment.startBringUp(stopped.id)).toBe('unknown');
    expect(await fulfilment.startBringUp(live.id)).toBe('already-live');
    expect(await fulfilment.startBringUp('no-such-id')).toBe('unknown');
    await flush();

    expect(actions.provision).not.toHaveBeenCalled();
    expect(actions.resume).not.toHaveBeenCalled();
  });

  it('keeps the marker down from before the caller is answered until the user is told', async () => {
    let releaseProvision!: () => void;
    const gate = new Promise<void>((resolve) => { releaseProvision = resolve; });
    const { fulfilment, storage, actions } = makeFulfilment();
    actions.provision.mockImplementationOnce(async (id: string) => {
      await gate;
      await storage.update(id, { status: 'live' });
      return { deployment: (await storage.get(id))!, url: 'https://ember.agentbuilt.app' };
    });
    const dep = await seed(storage);

    await fulfilment.startBringUp(dep.id);
    // The deploy request has its answer; the build is still in flight — a
    // crash here must leave the marker for the next boot to find.
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeTruthy();

    releaseProvision();
    await flush();
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeUndefined();
  });

  it('a failed build tells the user gently and screams in the log', async () => {
    const { fulfilment, storage, actions, notify } = makeFulfilment();
    actions.provision.mockRejectedValueOnce(new Error('fly is down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dep = await seed(storage);

    await fulfilment.startBringUp(dep.id);
    await flush();

    const text = String((notify.mock.calls.at(-1)![0] as { text: string }).text);
    expect(text).toContain('longer than expected');
    // Nothing about payment: there was none, and inventing one would be the
    // most alarming possible way to report a slow machine.
    expect(text).not.toContain('payment');
    expect(consoleError.mock.calls.some(([first]) => String(first).includes('BRING-UP FAILED'))).toBe(true);
    // The marker survives the failure — the next boot retries.
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeTruthy();
  });

  it("Fly's billing refusal is said as it is — not as a slow machine we are 'on' (note #801)", async () => {
    const { fulfilment, storage, actions, notify } = makeFulfilment();
    actions.provision.mockRejectedValueOnce(new FlyBillingRequiredError(
      'Fly API error (422): We require your billing information, please add it at https://fly.io/dashboard/acme-trading/billing',
    ));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dep = await seed(storage);

    await fulfilment.startBringUp(dep.id);
    await flush();

    const text = String((notify.mock.calls.at(-1)![0] as { text: string }).text);
    expect(text).toContain('ember could not be built.');
    expect(text).toContain('https://fly.io/dashboard/acme-trading/billing');
    expect(text).not.toContain('longer than expected');
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeTruthy();
  });
});

describe('resizing onto a bigger machine', () => {
  const seedLiveService = (storage: InMemoryDeploymentStorage) => seed(storage, {
    status: 'live', flyApp: 'iapp-abc', machineId: 'm1', preset: 'service',
  });

  it('resizes, tells the user, and clears both markers', async () => {
    const { fulfilment, storage, actions, notify } = makeFulfilment();
    const dep = await seedLiveService(storage);

    expect(await fulfilment.startResize(dep.id, 'service-pro')).toBe(true);
    await flush();

    expect(actions.resize).toHaveBeenCalledWith(dep.id, 'service-pro');
    const updated = await storage.get(dep.id);
    expect(updated?.preset).toBe('service-pro');
    expect(updated?.fulfilmentPendingSince).toBeUndefined();
    expect(updated?.pendingPreset).toBeUndefined();
    const text = String((notify.mock.calls.at(-1)![0] as { text: string }).text);
    expect(text).toContain('bigger machine');
    expect(text).not.toContain('$');
  });

  it('refuses a site that is not live, or is already that size', async () => {
    const { fulfilment, storage, actions } = makeFulfilment();
    const pending = await seed(storage, { name: 'not-built', preset: 'service' });
    const already = await seedLiveService(storage);
    await storage.update(already.id, { preset: 'service-pro' });

    expect(await fulfilment.startResize(pending.id, 'service-pro')).toBe(false);
    expect(await fulfilment.startResize(already.id, 'service-pro')).toBe(false);
    await flush();
    expect(actions.resize).not.toHaveBeenCalled();
  });

  it('a failed resize keeps the marker for the next boot and alerts the operator', async () => {
    const { fulfilment, storage, actions, notify } = makeFulfilment();
    actions.resize.mockRejectedValueOnce(new Error('fly said no'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dep = await seedLiveService(storage);

    await fulfilment.startResize(dep.id, 'service-pro');
    await flush();

    const updated = await storage.get(dep.id);
    expect(updated?.fulfilmentPendingSince).toBeTruthy();
    expect(updated?.pendingPreset).toBe('service-pro');
    expect(consoleError.mock.calls.some(([first]) => String(first).includes('RESIZE FAILED'))).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('taking longer'),
    }));
  });
});

describe('resuming across restarts', () => {
  it('finishes a build a restart killed', async () => {
    const { fulfilment, storage, actions, notify } = makeFulfilment();
    const dep = await seed(storage, { fulfilmentPendingSince: '2026-08-16T10:00:00.000Z' });

    expect(await fulfilment.resumePending()).toBe(1);
    await flush();

    expect(actions.provision).toHaveBeenCalledWith(dep.id);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', agentId: 'agent-a', text: expect.stringContaining('live!'),
    }));
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeUndefined();
  });

  it('re-sends only the lost notice when the site itself already went live', async () => {
    const { fulfilment, storage, notify, actions } = makeFulfilment();
    // The real provision() returns immediately for a live record; mirror that.
    actions.provision.mockImplementationOnce(async (id: string) => (
      { deployment: (await storage.get(id))!, url: 'https://ember.agentbuilt.app' }
    ));
    const dep = await seed(storage, {
      status: 'live', flyApp: 'iapp-abc', machineId: 'm1',
      fulfilmentPendingSince: '2026-08-16T10:00:00.000Z',
    });

    await fulfilment.resumePending();
    await flush();

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('live!'),
    }));
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeUndefined();
  });

  it('finishes a resize a restart killed, told apart by the pending preset', async () => {
    const { fulfilment, storage, actions } = makeFulfilment();
    const dep = await seed(storage, {
      status: 'live', flyApp: 'iapp-abc', machineId: 'm1', preset: 'service',
      pendingPreset: 'service-pro',
      fulfilmentPendingSince: '2026-08-16T10:00:00.000Z',
    });

    expect(await fulfilment.resumePending()).toBe(1);
    await flush();

    expect(actions.resize).toHaveBeenCalledWith(dep.id, 'service-pro');
    expect(actions.provision).not.toHaveBeenCalled();
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeUndefined();
  });

  it('drops the marker without acting when the lifecycle has moved on', async () => {
    const { fulfilment, storage, actions } = makeFulfilment();
    const dep = await seed(storage, {
      status: 'destroyed', fulfilmentPendingSince: '2026-08-16T10:00:00.000Z',
    });

    expect(await fulfilment.resumePending()).toBe(0);
    await flush();

    expect(actions.provision).not.toHaveBeenCalled();
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeUndefined();
  });

  it('a failed boot retry keeps the marker and stays quiet toward the user', async () => {
    const { fulfilment, storage, actions, notify } = makeFulfilment();
    actions.provision.mockRejectedValueOnce(new Error('fly is still down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dep = await seed(storage, { fulfilmentPendingSince: '2026-08-16T10:00:00.000Z' });

    await fulfilment.resumePending();
    await flush();

    // The first attempt already apologized; a broken build must not
    // re-message the user on every deploy of ours.
    expect(notify).not.toHaveBeenCalled();
    expect((await storage.get(dep.id))?.fulfilmentPendingSince).toBeTruthy();
    expect(consoleError.mock.calls.some(([first]) => String(first).includes('BRING-UP FAILED'))).toBe(true);
  });
});
