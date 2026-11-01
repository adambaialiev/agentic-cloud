import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyApiError, FlyClient, FLY_GRAPHQL_URL, isFlyBillingRequired } from '../../services/fly-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function makeClient() {
  return new FlyClient('test-token', 'https://api.machines.dev/v1', FLY_GRAPHQL_URL);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FlyClient.updateMachine', () => {
  it('POSTs the full config to the machine endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'm1', state: 'started' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    await client.updateMachine('ia-app', 'm1', { image: 'img', services: [{ protocol: 'tcp', internal_port: 3000, ports: [] }] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.machines.dev/v1/apps/ia-app/machines/m1');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ config: { image: 'img', services: [{ protocol: 'tcp', internal_port: 3000, ports: [] }] } });
  });

  it('sends skip_launch as a TOP-LEVEL field, not inside config', async () => {
    // Fly boots the machine it just updated unless this is set, and it is only
    // read at the top level — nested in `config` it is silently ignored, which
    // looks identical to not passing it at all until the fleet wakes up.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'm1', state: 'stopped' }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().updateMachine('ia-app', 'm1', { image: 'img' }, { skipLaunch: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ config: { image: 'img' }, skip_launch: true });
    expect(body.config.skip_launch).toBeUndefined();
  });
});

describe('FlyClient shared-IPv4 allocation (GraphQL)', () => {
  it('listIpAddresses reads the shared v4 + nodes from GraphQL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { app: { sharedIpAddress: '137.66.1.2', ipAddresses: { nodes: [{ address: 'fdaa::1', type: 'private_v6' }] } } },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    const result = await client.listIpAddresses('ia-app');

    expect(fetchMock.mock.calls[0][0]).toBe(FLY_GRAPHQL_URL);
    expect(result.sharedV4).toBe('137.66.1.2');
    expect(result.addresses).toHaveLength(1);
  });

  it('ensureSharedIpv4 returns the existing address WITHOUT allocating', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { app: { sharedIpAddress: '137.66.1.2', ipAddresses: { nodes: [] } } },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    const ip = await client.ensureSharedIpv4('ia-app');

    expect(ip).toBe('137.66.1.2');
    // Only the list query — no allocate mutation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body).toContain('sharedIpAddress');
    expect(fetchMock.mock.calls[0][1].body).not.toContain('allocateIpAddress');
  });

  it('ensureSharedIpv4 allocates shared_v4 when none exists, then re-reads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { app: { sharedIpAddress: null, ipAddresses: { nodes: [] } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { allocateIpAddress: { app: { sharedIpAddress: '137.66.9.9' } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { app: { sharedIpAddress: '137.66.9.9', ipAddresses: { nodes: [] } } } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    const ip = await client.ensureSharedIpv4('ia-app');

    expect(ip).toBe('137.66.9.9');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const allocateBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(allocateBody.query).toContain('allocateIpAddress');
    expect(allocateBody.variables).toEqual({ input: { appId: 'ia-app', type: 'shared_v4' } });
  });

  it('throws on a GraphQL errors payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'unauthorized' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    await expect(client.listIpAddresses('ia-app')).rejects.toThrow(/unauthorized/);
  });
});

describe('FlyClient billing (note #801)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns Fly's 422 billing refusal into plain words, keeping status 422 and the fix link", async () => {
    // Fly's own answer on acme-trading, 23 Oct 2026.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: 'We require your billing information, please add it at https://fly.io/dashboard/acme-trading/billing' },
      422,
    )));
    const error = await new FlyClient('t').createMachine('ia-app', { config: {} } as never).catch((e: unknown) => e);
    expect(isFlyBillingRequired(error)).toBe(true);
    expect(error).toBeInstanceOf(FlyApiError);
    expect((error as FlyApiError).status).toBe(422);
    expect((error as Error).message).toBe(
      'The Fly account this workplace runs on needs its billing sorted before anything can be built or changed. '
      + 'Whoever owns it should open https://fly.io/dashboard/acme-trading/billing and add or update the card.',
    );
  });

  it('leaves any other 422 an ordinary Fly error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid config' }, 422)));
    const error = await new FlyClient('t').createMachine('ia-app', { config: {} } as never).catch((e: unknown) => e);
    expect(isFlyBillingRequired(error)).toBe(false);
    expect((error as Error).message).toBe('Fly API error (422): invalid config');
  });

  it("reads an organization's billing status and saved card", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { organization: { billingStatus: 'PAST_DUE', isCreditCardSaved: true } },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new FlyClient('t').getOrganizationBilling('acme-trading'))
      .resolves.toEqual({ billingStatus: 'PAST_DUE', isCreditCardSaved: true });
    expect(fetchMock.mock.calls[0][0]).toBe(FLY_GRAPHQL_URL);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({ slug: 'acme-trading' });
  });
});
