import { describe, expect, it } from 'vitest';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { siteNameFromHost, siteRedirectHandler, siteTlsAskHandler } from '../../services/site-redirects.js';

const APPS_DOMAIN = 'agentbuilt.app';

/**
 * Enough of Express's req/res to drive the two handlers. AWAITS the handler:
 * both are async, and reading `res.statusCode` without waiting reads it before
 * the storage lookup has resolved — which is a test that passes or fails on
 * microtask timing rather than on behaviour.
 */
async function call(handler: ReturnType<typeof siteRedirectHandler>, opts: {
  host?: string;
  url?: string;
  query?: Record<string, string>;
}) {
  const res = {
    statusCode: 0,
    location: null as string | null,
    ended: false,
    status(code: number) { this.statusCode = code; return this; },
    end() { this.ended = true; return this; },
    redirect(code: number, location: string) { this.statusCode = code; this.location = location; return this; },
  };
  let nexted = false;
  const req = {
    headers: { host: opts.host },
    originalUrl: opts.url ?? '/',
    query: opts.query ?? {},
  };
  await handler(req as never, res as never, (() => { nexted = true; }) as never);
  return { res, nexted: () => nexted };
}

async function seeded() {
  const storage = new InMemoryDeploymentStorage();
  const moved = await storage.create({
    userId: 'u', agentId: 'a', name: 'eldiyar-math', preset: 'service', status: 'live',
  });
  await storage.update(moved.id, { name: 'school', formerNames: ['eldiyar-math'] });
  await storage.create({ userId: 'u', agentId: 'a', name: 'garden', preset: 'static', status: 'live' });
  return storage;
}

describe('siteNameFromHost', () => {
  it('takes the one label in front of the apps domain, and nothing else', () => {
    expect(siteNameFromHost('shop.agentbuilt.app', APPS_DOMAIN)).toBe('shop');
    // Ports and case: a Host header carries both.
    expect(siteNameFromHost('Shop.AgentBuilt.app:443', APPS_DOMAIN)).toBe('shop');
    // Not ours, however much it looks it. The last one matters: a suffix match
    // alone would hand `evil-agentbuilt.app` a site name.
    expect(siteNameFromHost('api.agenticcloudcomputer.com', APPS_DOMAIN)).toBeNull();
    expect(siteNameFromHost('a.b.agentbuilt.app', APPS_DOMAIN)).toBeNull();
    expect(siteNameFromHost('agentbuilt.app', APPS_DOMAIN)).toBeNull();
    expect(siteNameFromHost('evil-agentbuilt.app', APPS_DOMAIN)).toBeNull();
    expect(siteNameFromHost(undefined, APPS_DOMAIN)).toBeNull();
  });
});

describe('on-demand TLS gate', () => {
  /**
   * This endpoint is the whole security of on-demand TLS. A yes means Caddy
   * issues a publicly-trusted certificate for that hostname, in our name, to
   * whoever pointed DNS at us — so every no below is load-bearing.
   */
  const ask = async (storage: InMemoryDeploymentStorage, domain: string) => {
    const handler = siteTlsAskHandler({ storage, appsDomain: APPS_DOMAIN });
    const { res } = await call(handler as never, { query: { domain } });
    return res.statusCode;
  };

  it('says yes only for an address a live site was renamed away from', async () => {
    const storage = await seeded();
    expect(await ask(storage, 'eldiyar-math.agentbuilt.app')).toBe(200);
  });

  it('says no to a stranger, an unused name, and a site\'s CURRENT name', async () => {
    const storage = await seeded();
    // Someone else's domain pointed at us — the attack this gate exists for.
    expect(await ask(storage, 'victim.example.com')).toBe(403);
    // Free name in our own zone: nobody has ever had it.
    expect(await ask(storage, 'nobody-has-this.agentbuilt.app')).toBe(403);
    // A live site's current name resolves to its own machine and never
    // reaches this host; issuing for it here would only create a second,
    // stale place its traffic could land.
    expect(await ask(storage, 'garden.agentbuilt.app')).toBe(403);
    expect(await ask(storage, 'school.agentbuilt.app')).toBe(403);
    // No domain at all.
    expect(await ask(storage, '')).toBe(403);
  });

  it('says no once the site is destroyed, and never crashes on a storage failure', async () => {
    const storage = await seeded();
    const doc = (await storage.getByName('school'))!;
    await storage.update(doc.id, { status: 'destroyed' });
    expect(await ask(storage, 'eldiyar-math.agentbuilt.app')).toBe(403);

    const broken = {
      getByName: async () => { throw new Error('db down'); },
    } as unknown as InMemoryDeploymentStorage;
    // A database blip must be a refusal, not an unhandled rejection that takes
    // the request down — and refusing only costs a certificate renewal.
    expect(await ask(broken, 'eldiyar-math.agentbuilt.app')).toBe(403);
  });
});

describe('old-address redirect', () => {
  const open = async (storage: InMemoryDeploymentStorage, host: string, url = '/') => {
    const handler = siteRedirectHandler({ storage, appsDomain: APPS_DOMAIN });
    return call(handler, { host, url });
  };

  it('301s an old address to the current one, keeping path and query', async () => {
    const storage = await seeded();
    const { res } = await open(storage, 'eldiyar-math.agentbuilt.app', '/lessons/3?day=tue');
    expect(res.statusCode).toBe(301);
    expect(res.location).toBe('https://school.agentbuilt.app/lessons/3?day=tue');
  });

  it('leaves everything else alone', async () => {
    const storage = await seeded();
    // The backend's own host: API traffic must never be redirected.
    let call1 = await open(storage, 'api.agenticcloudcomputer.com', '/api/agent-cli/deployments');
    expect(call1.res.statusCode).toBe(0);
    expect(call1.nexted()).toBe(true);
    // A site that has not moved, and a name nobody has used.
    for (const host of ['garden.agentbuilt.app', 'nobody-has-this.agentbuilt.app']) {
      const { res, nexted } = await open(storage, host);
      expect(res.statusCode).toBe(0);
      expect(nexted()).toBe(true);
    }
  });

  it('stops redirecting the moment a site moves back to its old name', async () => {
    // A → B → A. The DNS record goes back to the machine, but a browser
    // holding a cached 301 may still arrive here; it must not be told to
    // redirect to the address it is already on.
    const storage = await seeded();
    const doc = (await storage.getByName('school'))!;
    await storage.update(doc.id, { name: 'eldiyar-math', formerNames: ['school'] });

    const back = await open(storage, 'eldiyar-math.agentbuilt.app');
    expect(back.res.statusCode).toBe(0);
    expect(back.nexted()).toBe(true);
    // And the name it left now redirects instead.
    const { res } = await open(storage, 'school.agentbuilt.app');
    expect(res.location).toBe('https://eldiyar-math.agentbuilt.app/');
  });

  it('does not redirect a destroyed site\'s old address into a dead one', async () => {
    const storage = await seeded();
    const doc = (await storage.getByName('school'))!;
    await storage.update(doc.id, { status: 'destroyed' });
    const { res, nexted } = await open(storage, 'eldiyar-math.agentbuilt.app');
    expect(res.statusCode).toBe(0);
    expect(nexted()).toBe(true);
  });
});
