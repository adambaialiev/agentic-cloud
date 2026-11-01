import { describe, expect, it, vi } from 'vitest';
import {
  MAP_MAX_AGE_MS,
  MISS_RECHECK_MS,
  PreviewDomainService,
  previewMapHandler,
  previewMappingsFromProfiles,
  siteMappingsFromDeployments,
  type NameTarget,
} from '../../services/preview-domain-service.js';
import { PREVIEW_ADJECTIVES, PREVIEW_NOUNS } from '../../services/preview-name-words.js';
import { DEPLOYMENT_NAME_DENYLIST, validateDeploymentName } from '../../types/deployment.js';

function fakes(overrides: {
  recordExists?: boolean[];
  isNameTaken?: (name: string) => Promise<boolean>;
  mappings?: Array<[string, NameTarget]>;
} = {}) {
  const cnameQueue = [...(overrides.recordExists ?? [])];
  const dns = {
    deleteTxt: vi.fn().mockResolvedValue(undefined),
    deleteCname: vi.fn().mockResolvedValue(undefined),
    recordExists: vi.fn().mockImplementation(async () => cnameQueue.shift() ?? false),
  };
  const clock = { now: 1_000_000 };
  const records = { mappings: [...(overrides.mappings ?? [])] };
  const loadMappings = vi.fn(async () => records.mappings);
  const service = new PreviewDomainService({
    dns: dns as never,
    appsDomain: 'agentbuilt.app',
    ...(overrides.isNameTaken ? { isNameTaken: overrides.isNameTaken } : {}),
    loadMappings,
    log: () => undefined,
    now: () => clock.now,
  });
  return { service, dns, clock, records, loadMappings };
}

describe('PreviewDomainService', () => {
  it('generates shareable word names: adjective, noun, and a 3-digit number', () => {
    for (let i = 0; i < 200; i += 1) {
      const name = PreviewDomainService.generateName();
      const [adjective, noun, digits, ...extra] = name.split('-');

      expect(extra).toHaveLength(0);
      expect(PREVIEW_ADJECTIVES).toContain(adjective);
      expect(PREVIEW_NOUNS).toContain(noun);
      // 100–999: never zero-padded, so a name read aloud cannot lose a digit.
      expect(digits).toMatch(/^[1-9][0-9]{2}$/);
    }
  });

  it('actually varies — a fixed name would collide on every agent', () => {
    const names = new Set(Array.from({ length: 100 }, () => PreviewDomainService.generateName()));
    expect(names.size).toBeGreaterThan(90);
  });

  it('every generated name is a name the platform itself would accept', () => {
    // Preview slugs share the apps domain with paid hosting sites, so a
    // minted name must satisfy the same rules a user-chosen one does.
    for (let i = 0; i < 200; i += 1) {
      expect(validateDeploymentName(PreviewDomainService.generateName())).toBeNull();
    }
  });

  describe('the word lists', () => {
    const lists = { adjectives: PREVIEW_ADJECTIVES, nouns: PREVIEW_NOUNS };

    for (const [label, words] of Object.entries(lists)) {
      it(`${label}: plain lowercase words, each a valid DNS label on its own`, () => {
        for (const word of words) expect(word).toMatch(/^[a-z]{3,10}$/);
      });

      it(`${label}: no duplicates`, () => {
        expect(new Set(words).size).toBe(words.length);
      });

      it(`${label}: nothing that reads as an official or credential surface`, () => {
        // We must never mint `secure-bank-402.agentbuilt.app` ourselves.
        for (const banned of DEPLOYMENT_NAME_DENYLIST) expect(words).not.toContain(banned);
      });
    }

    it('the two lists are disjoint, so no name stutters', () => {
      const nouns = new Set(PREVIEW_NOUNS);
      expect(PREVIEW_ADJECTIVES.filter((word) => nouns.has(word))).toEqual([]);
    });

    it('are large enough that collisions stay rare', () => {
      // pickFreeName gives up after 5 attempts; that only stays safe while the
      // space is far larger than the number of agents.
      expect(PREVIEW_ADJECTIVES.length * PREVIEW_NOUNS.length * 900).toBeGreaterThan(10_000_000);
    });
  });

  it('provisioning writes nothing to the DNS zone: the agent record is the mapping', async () => {
    const { service, dns } = fakes();

    const name = await service.provision('ia-abc123');

    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
    // Nothing per agent may land in the zone: its 200-record ceiling is
    // exactly what this replaced. The client has no write left to call.
    expect('ensureTxt' in dns).toBe(false);
    expect(dns.deleteCname).not.toHaveBeenCalled();
  });

  it('keeps an existing name on rebuild instead of minting a new one', async () => {
    const { service, dns, loadMappings } = fakes();

    // A pre-2026-08-09 random slug: agents minted before word names keep the
    // name they already handed out, and nothing here parses it.
    const name = await service.provision('ia-newapp', 'k3x9m2');

    expect(name).toBe('k3x9m2');
    // No availability checks for a name the agent already owns.
    expect(dns.recordExists).not.toHaveBeenCalled();
    expect(loadMappings).not.toHaveBeenCalled();
  });

  it('retries generation past hosting-table, CNAME and other-agent collisions', async () => {
    const generate = vi.spyOn(PreviewDomainService, 'generateName')
      .mockReturnValueOnce('brave-otter-101') // a hosting site owns it
      .mockReturnValueOnce('brave-otter-102') // a legacy/hosting CNAME
      .mockReturnValueOnce('brave-otter-103') // another agent holds it
      .mockReturnValueOnce('brave-otter-104');
    const isNameTaken = vi.fn(async (name: string) => name === 'brave-otter-101');
    const { service, dns } = fakes({
      recordExists: [true, false],
      mappings: [['brave-otter-103', 'ia-someone']],
      isNameTaken,
    });

    expect(await service.provision('ia-abc123')).toBe('brave-otter-104');
    expect(isNameTaken).toHaveBeenCalledTimes(4);
    expect(dns.recordExists).toHaveBeenCalledTimes(2);
    generate.mockRestore();
  });

  it('release clears what older models left in the zone: the TXT mapping and a certificate-era CNAME', async () => {
    const { service, dns } = fakes();
    await service.release('k3x9m2');
    expect(dns.deleteTxt).toHaveBeenCalledWith('_map.k3x9m2');
    expect(dns.deleteCname).toHaveBeenCalledWith('k3x9m2');
  });

  it('runs with no zone at all: a private copy names its own domain and its router asks this map (note #804)', async () => {
    const records = { mappings: [['brave-otter-427', { app: 'ia-emma' }]] as Array<[string, NameTarget]> };
    const service = new PreviewDomainService({
      dns: null,
      appsDomain: 'copy.theirco.test',
      loadMappings: async () => records.mappings,
      log: () => undefined,
    });
    const name = await service.provision('ia-new');
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
    expect(service.url(name)).toBe(`https://${name}.copy.theirco.test`);
    await expect(service.release(name)).resolves.toBeUndefined();
    expect(await service.resolve('brave-otter-427')).toEqual({ app: 'ia-emma' });
  });

  describe('resolve — the Worker\'s question', () => {
    it('answers from the agent records', async () => {
      const { service } = fakes({ mappings: [['brave-otter-427', { app: 'ia-emma' }], ['k3x9m2', { app: 'ia-legacy' }]] });

      expect(await service.resolve('brave-otter-427')).toEqual({ app: 'ia-emma' });
      expect(await service.resolve('k3x9m2')).toEqual({ app: 'ia-legacy' });
    });

    it('reads the records once for many lookups, and again once the index is old', async () => {
      const { service, clock, loadMappings } = fakes({ mappings: [['brave-otter-427', { app: 'ia-emma' }]] });

      for (let i = 0; i < 20; i += 1) await service.resolve('brave-otter-427');
      expect(loadMappings).toHaveBeenCalledTimes(1);

      clock.now += MAP_MAX_AGE_MS;
      await service.resolve('brave-otter-427');
      expect(loadMappings).toHaveBeenCalledTimes(2);
    });

    it('a stream of unknown names costs at most one read per recheck interval', async () => {
      const { service, clock, loadMappings } = fakes();

      for (let i = 0; i < 50; i += 1) expect(await service.resolve(`nobody-${i}`)).toBeNull();
      expect(loadMappings).toHaveBeenCalledTimes(1);

      clock.now += MISS_RECHECK_MS;
      await service.resolve('nobody-else');
      expect(loadMappings).toHaveBeenCalledTimes(2);
    });

    it('finds a brand-new agent whose record was written after the index was read', async () => {
      const { service, clock, records } = fakes();
      expect(await service.resolve('brave-otter-427')).toBeNull();

      records.mappings.push(['brave-otter-427', { app: 'ia-new' }]);
      clock.now += MISS_RECHECK_MS;

      expect(await service.resolve('brave-otter-427')).toEqual({ app: 'ia-new' });
    });

    it('re-reads at once after a provision or a release here', async () => {
      const { service, records, loadMappings } = fakes({ mappings: [['k3x9m2', { app: 'ia-old' }]] });
      expect(await service.resolve('k3x9m2')).toEqual({ app: 'ia-old' });

      records.mappings = [['k3x9m2', { app: 'ia-rebuilt' }]];
      await service.provision('ia-rebuilt', 'k3x9m2');
      expect(await service.resolve('k3x9m2')).toEqual({ app: 'ia-rebuilt' });

      records.mappings = [];
      await service.release('k3x9m2');
      expect(await service.resolve('k3x9m2')).toBeNull();
      expect(loadMappings).toHaveBeenCalledTimes(3);
    });
  });

  describe('resolve — hosted sites (note #766)', () => {
    it('answers a site name with its app and a former name with a redirect', async () => {
      const { service } = fakes({ mappings: [
        ...siteMappingsFromDeployments([
          { name: 'school', status: 'live', flyApp: 'iapp-756b', formerNames: ['eldiyar-math'] },
        ]),
      ] });

      expect(await service.resolve('school')).toEqual({ app: 'iapp-756b' });
      expect(await service.resolve('eldiyar-math')).toEqual({ redirect: 'school' });
    });

    it('the first entry for a name wins, so a site listed before an agent shadows it', async () => {
      // The order the backend lists them in, mirroring the old precedence of
      // a site's own CNAME over the wildcard record every agent rides.
      const { service } = fakes({ mappings: [
        ['shop', { app: 'iapp-site' }],
        ['shop', { app: 'ia-agent' }],
      ] });
      expect(await service.resolve('shop')).toEqual({ app: 'iapp-site' });
    });

    it('invalidate() makes the next lookup re-read the records, which is what a deploy, rename or delete calls', async () => {
      const { service, records, loadMappings } = fakes({ mappings: [] });
      expect(await service.resolve('shop')).toBeNull();

      records.mappings = [['shop', { app: 'iapp-new' }]];
      service.invalidate();
      expect(await service.resolve('shop')).toEqual({ app: 'iapp-new' });

      records.mappings = [['shop', { redirect: 'store' }], ['store', { app: 'iapp-new' }]];
      service.invalidate();
      expect(await service.resolve('shop')).toEqual({ redirect: 'store' });
      expect(loadMappings).toHaveBeenCalledTimes(3);
    });
  });

  it('urls carry the apps domain, for both name shapes', () => {
    const { service } = fakes();
    expect(service.url('brave-otter-427')).toBe('https://brave-otter-427.agentbuilt.app');
    expect(service.url('k3x9m2')).toBe('https://k3x9m2.agentbuilt.app');
  });
});

describe('previewMappingsFromProfiles', () => {
  it('maps each named agent to the app its machine runs in, or the app reserved for it', () => {
    const pairs = previewMappingsFromProfiles([
      { telegram: { agents: {
        a: { previewHostname: 'brave-otter-427', serverId: 'fly_ia-emma.1234567890abcd' },
        b: { previewHostname: 'calm-comet-812', provisioningAppName: 'ia-building' },
        c: { serverId: 'fly_ia-nameless.1234567890abcd' },   // no name: nothing to route
        d: { previewHostname: 'quiet-kestrel-770' },          // recycled: no app to route to
      } } },
      {},
    ]);

    expect(pairs).toEqual([
      ['brave-otter-427', { app: 'ia-emma' }],
      ['calm-comet-812', { app: 'ia-building' }],
    ]);
  });
});

describe('siteMappingsFromDeployments (note #766)', () => {
  it('routes live and paused sites to their app, and every former name to the current one', () => {
    const pairs = siteMappingsFromDeployments([
      { name: 'school', status: 'live', flyApp: 'iapp-aaa', formerNames: ['eldiyar-math'] },
      { name: 'launches', status: 'payment-lapsed', flyApp: 'iapp-bbb', formerNames: ['sf-launches', 'launches'] },
      { name: 'draft', status: 'pending-payment' },                       // nothing built: no app to route to
      { name: 'building', status: 'provisioning', flyApp: 'iapp-ccc' },   // not yet: the machine is not up
      { name: 'killed', status: 'stopped', flyApp: 'iapp-ddd' },          // an operator stop takes it off the air
      { name: 'gone', status: 'destroyed', flyApp: 'iapp-eee', formerNames: ['old-gone'] },
    ]);

    expect(pairs).toEqual([
      ['school', { app: 'iapp-aaa' }],
      ['eldiyar-math', { redirect: 'school' }],
      ['launches', { app: 'iapp-bbb' }],
      ['sf-launches', { redirect: 'launches' }],
    ]);
  });
});

describe('previewMapHandler', () => {
  async function call(slug: string, resolve: (slug: string) => Promise<NameTarget | null>) {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      set(name: string, value: string) { this.headers[name] = value; return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
    };
    const url = (name: string) => `https://${name}.agentbuilt.app`;
    await previewMapHandler({ resolve, url })({ params: { slug } } as never, res as never, (() => undefined) as never);
    return res;
  }

  it('answers a mapped slug with its app, never cached by anyone but the Worker', async () => {
    const res = await call('brave-otter-427', async () => ({ app: 'ia-emma' }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ app: 'ia-emma' });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('answers a renamed site\'s old name with the full address to redirect to', async () => {
    const res = await call('eldiyar-math', async () => ({ redirect: 'school' }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ redirect: 'https://school.agentbuilt.app' });
  });

  it('404s an unknown slug', async () => {
    expect((await call('nobody-here-100', async () => null)).statusCode).toBe(404);
  });

  it('404s anything that is not a DNS label without looking it up', async () => {
    const resolve = vi.fn(async () => ({ app: 'ia-emma' }));
    for (const bad of ['-leading', 'trailing-', 'has_underscore', 'a.b', '']) {
      expect((await call(bad, resolve)).statusCode, bad).toBe(404);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('503s when the records cannot be read, so the Worker falls back to its last answer', async () => {
    const res = await call('brave-otter-427', async () => { throw new Error('db locked'); });
    expect(res.statusCode).toBe(503);
  });
});
