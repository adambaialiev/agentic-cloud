import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HetznerClient,
  quoteHetznerReservationFromPricing,
} from '../../services/hetzner-client.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

describe('HetznerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps platform size and region parameters to Hetzner server_type and location', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      server: {
        id: 42,
        name: 'sandbox-user-test',
        status: 'initializing',
        server_type: { id: 1, name: 'cpx22' },
        location: { id: 2, name: 'fsn1' },
        image: { id: 3, name: 'ubuntu-24.04', description: 'Ubuntu 24.04' },
        public_net: { ipv4: { ip: '203.0.113.10' }, ipv6: null, floating_ips: [] },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HetznerClient('hcloud-token');
    await client.createServer({
      name: 'sandbox-user-test',
      size: 'cpx22',
      region: 'fsn1',
      image: 'ubuntu-24.04',
      ssh_keys: [17],
      tags: ['default-development'],
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.hetzner.cloud/v1/servers', expect.objectContaining({
      method: 'POST',
      dispatcher: expect.objectContaining({
        dispatch: expect.any(Function),
      }),
      headers: expect.objectContaining({
        Authorization: 'Bearer hcloud-token',
      }),
    }));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      name: 'sandbox-user-test',
      server_type: 'cpx22',
      location: 'fsn1',
      image: 'ubuntu-24.04',
      ssh_keys: [17],
    });
    expect(body.labels).toMatchObject({
      'infinite-agents/tag-0': 'default-development',
    });
  });

  it('filters listed locations to the supported EU Hetzner Cloud locations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      locations: [
        { id: 1, name: 'fsn1', city: 'Falkenstein', country: 'DE' },
        { id: 2, name: 'nbg1', city: 'Nuremberg', country: 'DE' },
        { id: 3, name: 'hel1', city: 'Helsinki', country: 'FI' },
        { id: 4, name: 'ash', city: 'Ashburn', country: 'US' },
        { id: 5, name: 'hil', city: 'Hillsboro', country: 'US' },
        { id: 6, name: 'sin', city: 'Singapore', country: 'SG' },
        { id: 7, name: 'moon1', city: 'Moon Base', country: 'MO' },
      ],
      meta: { pagination: { next_page: null } },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const locations = await new HetznerClient('hcloud-token').listLocations();

    expect(locations.map((location) => location.name)).toEqual([
      'fsn1',
      'nbg1',
      'hel1',
    ]);
  });

  it('matches SSH keys by public key material while ignoring trailing comments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      ssh_keys: [
        {
          id: 17,
          name: 'sumai-user',
          fingerprint: 'aa:bb',
          public_key: 'ssh-ed25519 AAAAexisting username@host',
        },
      ],
      meta: { pagination: { next_page: null } },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const key = await new HetznerClient('hcloud-token')
      .findSSHKeyByPublicKey('ssh-ed25519 AAAAexisting configured-comment');

    expect(key?.id).toBe(17);
  });

  it('quotes upfront reservations from monthly capped pricing', () => {
    const quote = quoteHetznerReservationFromPricing({
      pricing: {
        currency: 'EUR',
        server_types: [{
          id: 1,
          name: 'cpx22',
          prices: [{
            location: 'fsn1',
            price_hourly: { net: '0.0074', gross: '0.0088' },
            price_monthly: { net: '4.35', gross: '5.18' },
          }],
        }],
      },
      size: 'cpx22',
      region: 'fsn1',
    });

    expect(quote).toMatchObject({
      provider: 'hetzner',
      size: 'cpx22',
      region: 'fsn1',
      monthlyAmount: 5.18,
      currency: 'EUR',
      upfrontHours: 24,
      baseCents: 18,
    });
  });

  it('defaults reservation quotes to the EU default location instead of the first pricing row', () => {
    const quote = quoteHetznerReservationFromPricing({
      pricing: {
        currency: 'USD',
        server_types: [{
          id: 1,
          name: 'cpx31',
          prices: [
            {
              location: 'ash',
              price_hourly: { net: '0.1178', gross: '0.1178' },
              price_monthly: { net: '73.49', gross: '73.49' },
            },
            {
              location: 'nbg1',
              price_hourly: { net: '0.0328', gross: '0.0328' },
              price_monthly: { net: '20.49', gross: '20.49' },
            },
          ],
        }],
      },
      size: 'cpx31',
    });

    expect(quote).toMatchObject({
      provider: 'hetzner',
      size: 'cpx31',
      region: 'nbg1',
      monthlyAmount: 20.49,
      currency: 'USD',
    });
  });
});
