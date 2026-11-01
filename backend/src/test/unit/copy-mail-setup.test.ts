/**
 * Email set up after the install (note #946): a private copy installs with no
 * mail, and an admin turns it on later from the Workspace — the provider, the
 * mail receiver in the copy's own Fly organization, the records checked on
 * the domain's own name servers, and mail on by itself once they are right.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CopyMailSetup, CopyMailSetupError, InMemoryCopyMailSetupStore, recordAnswers, resendDomains,
  type CopyMailSending, type CopyMailSetupOptions, type RecordResolver,
} from '../../services/copy-mail-setup.js';
import { SecretCipher } from '../../services/secret-cipher.js';
import { createCopyHealth } from '../../services/copy-health.js';
import type { FlyClient } from '../../services/fly-client.js';
import type { WorkspaceCopyMailRecord } from '../../shared/workspace-api.js';

const DOMAIN = 'agents.theirco.test';
const RESEND_KEY = 're_live_0123456789abcdef';
const RESEND_RECORDS: WorkspaceCopyMailRecord[] = [
  { name: `send.${DOMAIN}`, type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, why: 'mail out through Resend (SPF)' },
  { name: `resend._domainkey.${DOMAIN}`, type: 'TXT', value: 'p=MIGf', why: 'mail out through Resend (DKIM)' },
];

/** Fly as the setup sees it: apps, addresses, disks and machines, remembered. */
function fakeFly({ existing }: { existing?: { ipv4: string; machine: boolean } } = {}) {
  const apps = new Set<string>(existing ? ['theirco-mx'] : []);
  const ips = new Map<string, string>(existing ? [['theirco-mx', existing.ipv4]] : []);
  const machines: Array<{ id: string; app: string; state: string; config: Record<string, unknown> }> = existing?.machine
    ? [{ id: 'm-old', app: 'theirco-mx', state: 'started', config: { image: 'registry.fly.io/theirco-images:mx-2026.10.29.0' } }]
    : [];
  const volumes: Array<{ id: string; name: string; attached_machine_id?: string }> = [];
  const restarts: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const fly = {
    listApps: async () => [...apps].map((name) => ({ name })),
    createApp: async ({ appName }: { appName: string }) => { apps.add(appName); },
    ensureDedicatedIpv4: async (app: string) => {
      if (!ips.has(app)) ips.set(app, '203.0.113.25');
      return ips.get(app);
    },
    listMachines: async (app: string) => machines.filter((machine) => machine.app === app),
    listVolumes: async () => volumes,
    createVolume: async (_app: string, args: { name: string }) => {
      const volume = { id: `vol_${volumes.length + 1}`, name: args.name };
      volumes.push(volume);
      return volume;
    },
    createMachine: async (app: string, args: Record<string, unknown>) => {
      const machine = { id: `m${machines.length + 1}`, app, state: 'started', config: { image: args.image, env: args.env, services: args.services, mounts: args.mounts, guest: args.guest } };
      machines.push(machine);
      return machine;
    },
    getMachine: async (_app: string, id: string) => machines.find((machine) => machine.id === id)!,
    updateMachine: async (_app: string, id: string, config: Record<string, unknown>) => {
      updates.push(config);
      const machine = machines.find((entry) => entry.id === id)!;
      machine.config = config;
      return machine;
    },
    restartMachine: async (_app: string, id: string) => { restarts.push(id); },
  };
  return { fly: fly as unknown as FlyClient, apps, machines, volumes, restarts, updates };
}

function zoneResolver(zone: () => WorkspaceCopyMailRecord[]): RecordResolver {
  const find = (name: string, type: string) => zone().filter((record) => record.name === name && record.type === type);
  return {
    resolve4: (name, done) => done(null, find(name, 'A').map((record) => record.value)),
    resolveCname: (name, done) => done(null, find(name, 'CNAME').map((record) => record.value)),
    resolveMx: (name, done) => done(null, find(name, 'MX').map((record) => ({ priority: record.priority ?? 0, exchange: `${record.value}.` }))),
    resolveTxt: (name, done) => done(null, find(name, 'TXT').map((record) => [record.value])),
  };
}

function harness(overrides: Partial<CopyMailSetupOptions> & { existing?: { ipv4: string; machine: boolean } } = {}) {
  const store = new InMemoryCopyMailSetupStore();
  const cipher = new SecretCipher(randomBytes(32).toString('base64'));
  const flyFake = fakeFly({ existing: overrides.existing });
  let zone: WorkspaceCopyMailRecord[] = [];
  let starttls = false;
  let resendVerified = false;
  const sent: Array<CopyMailSending | null> = [];
  let clock = new Date('2026-11-01T16:00:00Z');
  const setup = new CopyMailSetup({
    store,
    cipher,
    domain: DOMAIN,
    org: 'theirco-org',
    region: 'fra',
    prefix: 'theirco',
    mxImage: 'registry.fly.io/theirco-images:mx-2026.11.02.0',
    ingestSecret: 'ingest-secret-0123',
    backendUrl: 'http://theirco-backend.internal:8080',
    fly: flyFake.fly,
    fromInstall: null,
    onSendingChanged: (sending) => { sent.push(sending); },
    resend: (key) => ({
      register: async (domain) => {
        expect(key).toBe(RESEND_KEY);
        expect(domain).toBe(DOMAIN);
        return { id: 'dom_1', records: RESEND_RECORDS };
      },
      verified: async () => resendVerified,
    }),
    verifySmtp: async (settings) => { if (settings.password === 'wrong') throw new Error('535 Authentication failed'); },
    resolver: async () => zoneResolver(() => zone),
    fetchImpl: (async (url: string) => {
      expect(url).toBe('http://theirco-mx.internal:8080/health');
      return new Response(JSON.stringify({ ok: true, starttls }));
    }) as typeof fetch,
    now: () => clock,
    log: () => {},
    ...overrides,
  });
  return {
    setup, store, flyFake, sent,
    addRecords: (records: WorkspaceCopyMailRecord[]) => { zone = records; },
    certificate: () => { starttls = true; },
    verify: () => { resendVerified = true; },
    later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
  };
}

describe('email set up after the install (note #946)', () => {
  it('starts off: no provider, no receiver, nothing to send through, and says why nothing is missing', () => {
    const h = harness();
    expect(h.setup.isOn()).toBe(false);
    expect(h.setup.phase()).toBe('off');
    expect(h.setup.sending()).toBeNull();
    expect(h.setup.status()).toMatchObject({ state: 'off', domain: DOMAIN, records: [], certificate: 'unknown', monthlyUsd: 4.09 });
    expect(h.setup.status().unavailable).toBeUndefined();
  });

  it('keeps a Resend key encrypted, registers the domain and reads its records back', async () => {
    const h = harness();
    await expect(h.setup.setProvider({ kind: 'resend', apiKey: 'nope' })).rejects.toThrow('does not look like a Resend key');
    const status = await h.setup.setProvider({ kind: 'resend', apiKey: RESEND_KEY });
    expect(status.state).toBe('provider');
    expect(status.provider).toEqual({ kind: 'resend', line: 'Resend' });
    expect(JSON.stringify(h.store.get())).not.toContain(RESEND_KEY);
    expect(JSON.stringify(status)).not.toContain(RESEND_KEY);
    // Nothing goes out until the records are right.
    expect(h.setup.sending()).toBeNull();
  });

  it('checks SMTP by signing in before keeping it, and keeps the password encrypted', async () => {
    const h = harness();
    await expect(h.setup.setProvider({ kind: 'smtp', host: 'smtp.postmarkapp.com', port: 587, user: 'token', password: 'wrong' }))
      .rejects.toThrow('Could not sign in to smtp.postmarkapp.com:587: 535 Authentication failed');
    await expect(h.setup.setProvider({ kind: 'smtp', host: 'smtp.postmarkapp.com', port: 25 })).rejects.toThrow('587 or 465');
    const status = await h.setup.setProvider({ kind: 'smtp', host: 'smtp.postmarkapp.com', port: 587, user: 'token', password: 'right-password' });
    expect(status.provider).toEqual({ kind: 'smtp', line: 'smtp.postmarkapp.com:587 as token' });
    expect(JSON.stringify(h.store.get())).not.toContain('right-password');
  });

  it('makes the mail receiver in the copy\'s own organization and prints exactly the records to add', async () => {
    const h = harness();
    await expect(h.setup.createReceiver()).rejects.toThrow('Set the mail provider first');
    await h.setup.setProvider({ kind: 'resend', apiKey: RESEND_KEY });
    const status = await h.setup.createReceiver();
    h.setup.stop();
    expect([...h.flyFake.apps]).toEqual(['theirco-mx']);
    const [machine] = h.flyFake.machines;
    expect(machine.config.image).toBe('registry.fly.io/theirco-images:mx-2026.11.02.0');
    expect(machine.config.env).toMatchObject({
      MAIL_DOMAIN: DOMAIN, MX_HOSTNAME: `mx.${DOMAIN}`, BACKEND_URL: 'http://theirco-backend.internal:8080', MAIL_INGEST_SECRET: 'ingest-secret-0123', CERT_DIR: '/data/tls',
    });
    expect(JSON.stringify(machine.config.services)).toContain('"proxy_proto"');
    expect(machine.config.mounts).toEqual([{ volume: 'vol_1', path: '/data' }]);
    expect(status.state).toBe('records');
    expect(status.receiver).toEqual({ app: 'theirco-mx', ipv4: '203.0.113.25' });
    expect(status.records.map((record) => `${record.name} ${record.type} ${record.value}`)).toEqual([
      `${DOMAIN} MX mx.${DOMAIN}`,
      `mx.${DOMAIN} A 203.0.113.25`,
      `_dmarc.${DOMAIN} TXT v=DMARC1; p=quarantine`,
      `send.${DOMAIN} MX feedback-smtp.eu-west-1.amazonses.com`,
      `resend._domainkey.${DOMAIN} TXT p=MIGf`,
    ]);
    // Asked again, it makes nothing twice.
    await h.setup.createReceiver();
    h.setup.stop();
    expect(h.flyFake.machines).toHaveLength(1);
    expect(h.flyFake.volumes).toHaveLength(1);
  });

  it('takes over the receiver an older installer made, as it is', async () => {
    const h = harness({ existing: { ipv4: '198.51.100.7', machine: true } });
    await h.setup.setProvider({ kind: 'smtp', host: 'smtp.example.com', port: 465 });
    const status = await h.setup.createReceiver();
    h.setup.stop();
    expect(h.flyFake.machines.map((machine) => machine.id)).toEqual(['m-old']);
    expect(status.receiver).toEqual({ app: 'theirco-mx', ipv4: '198.51.100.7', adopted: true });
    expect(status.providerRecordsNote).toContain('SPF and DKIM records smtp.example.com gives you');
  });

  it('turns mail on by itself once the records answer right and Resend has verified, and swaps the senders in', async () => {
    const h = harness();
    await h.setup.setProvider({ kind: 'resend', apiKey: RESEND_KEY });
    const made = await h.setup.createReceiver();
    h.setup.stop();

    const waiting = await h.setup.check();
    expect(waiting.state).toBe('records');
    expect(waiting.records.every((record) => record.ok === false)).toBe(true);
    expect(h.sent).toEqual([]);

    h.addRecords(made.records);
    const unverified = await h.setup.check();
    expect(unverified.records.every((record) => record.ok === true)).toBe(true);
    expect(unverified.providerVerified).toBe(false);
    expect(unverified.state).toBe('records');

    h.verify();
    const on = await h.setup.check();
    expect(on.state).toBe('on');
    expect(on.certificate).toBe('pending');
    expect(h.setup.isOn()).toBe(true);
    expect(h.sent).toEqual([{ kind: 'resend', apiKey: RESEND_KEY }]);
    expect(h.setup.sending()).toEqual({ kind: 'resend', apiKey: RESEND_KEY });
  });

  it('restarts the receiver once its name has settled and it still has no certificate, at most four times', async () => {
    const h = harness();
    await h.setup.setProvider({ kind: 'smtp', host: 'smtp.example.com', port: 587 });
    const made = await h.setup.createReceiver();
    h.setup.stop();
    // The check the receiver's making started is let finish first.
    await h.setup.check();
    h.addRecords(made.records);
    await h.setup.check();
    // On at once for SMTP: its own records are the provider's to check.
    expect(h.setup.isOn()).toBe(true);
    expect(h.flyFake.restarts).toEqual([]);
    for (let i = 0; i < 8; i += 1) {
      h.later(6 * 60_000);
      await h.setup.check();
    }
    expect(h.flyFake.restarts).toEqual(['m1', 'm1', 'm1', 'm1']);
    h.certificate();
    expect((await h.setup.check()).certificate).toBe('issued');
  });

  it('keeps a receiver it made on the copy\'s release after an upgrade', async () => {
    const h = harness();
    await h.setup.setProvider({ kind: 'smtp', host: 'smtp.example.com', port: 587 });
    await h.setup.createReceiver();
    h.setup.stop();
    const upgraded = new CopyMailSetup({
      store: h.store, cipher: null, domain: DOMAIN, org: 'theirco-org', region: 'fra', prefix: 'theirco',
      mxImage: 'registry.fly.io/theirco-images:mx-2026.11.09.0', ingestSecret: 'ingest-secret-0123', backendUrl: 'http://theirco-backend.internal:8080',
      fly: h.flyFake.fly, fromInstall: null, onSendingChanged: () => {}, resolver: async () => zoneResolver(() => []),
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch, log: () => {},
    });
    upgraded.boot();
    upgraded.stop();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(h.flyFake.updates.at(-1)?.image).toBe('registry.fly.io/theirco-images:mx-2026.11.09.0');
  });

  it('a copy whose installer set mail up is on from the start, and changes it there', async () => {
    const h = harness({ fromInstall: { kind: 'smtp', settings: { host: 'smtp.example.com', port: 587 } } });
    expect(h.setup.isOn()).toBe(true);
    expect(h.setup.phase()).toBe('on');
    expect(h.setup.status()).toMatchObject({ state: 'on', fromInstall: true, provider: { kind: 'smtp', line: 'smtp.example.com, set up by the installer' } });
    await expect(h.setup.setProvider({ kind: 'resend', apiKey: RESEND_KEY })).rejects.toBeInstanceOf(CopyMailSetupError);
  });

  it('says plainly what it cannot do without, before anything is made', async () => {
    const noImage = harness({ mxImage: null });
    expect(noImage.setup.status().unavailable).toContain('FLY_MX_IMAGE');
    await expect(noImage.setup.setProvider({ kind: 'smtp', host: 'smtp.example.com', port: 587 })).rejects.toThrow('Upgrade it with the installer first');
    const noFly = harness({ fly: null });
    expect(noFly.setup.status().unavailable).toContain('no Fly token');
  });

  it('checks each kind of record, and any DMARC policy will do', async () => {
    const resolver = zoneResolver(() => [
      { name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}`, priority: 10, why: '' },
      { name: `mx.${DOMAIN}`, type: 'A', value: '203.0.113.25', why: '' },
      { name: `_dmarc.${DOMAIN}`, type: 'TXT', value: 'v=DMARC1; p=reject', why: '' },
    ]);
    expect(await recordAnswers(resolver, { name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}`, priority: 10, why: '' })).toBe(true);
    expect(await recordAnswers(resolver, { name: DOMAIN, type: 'MX', value: `mx.${DOMAIN}`, priority: 20, why: '' })).toBe(false);
    expect(await recordAnswers(resolver, { name: `mx.${DOMAIN}`, type: 'A', value: '203.0.113.26', why: '' })).toBe(false);
    expect(await recordAnswers(resolver, { name: `_dmarc.${DOMAIN}`, type: 'TXT', value: 'v=DMARC1; p=quarantine', why: '' })).toBe(true);
  });

  it('reads Resend\'s domain records whole, and says a sending-only key cannot register one', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      seen.push(`${init.method} ${new URL(url).pathname}`);
      if (url.endsWith('/domains') && init.method === 'GET') return new Response(JSON.stringify({ data: [] }));
      if (url.endsWith('/domains') && init.method === 'POST') {
        return new Response(JSON.stringify({ id: 'd1', records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf' }] }));
      }
      return new Response(JSON.stringify({ id: 'd1', status: 'verified' }));
    }) as typeof fetch;
    const { id, records } = await resendDomains('re_x', fetchImpl).register(DOMAIN);
    expect(id).toBe('d1');
    expect(records).toEqual([{ name: `resend._domainkey.${DOMAIN}`, type: 'TXT', value: 'p=MIGf', why: 'mail out through Resend (DKIM)' }]);
    expect(await resendDomains('re_x', fetchImpl).verified('d1')).toBe(true);
    const restricted = (async () => new Response(JSON.stringify({ message: 'This API key is restricted to only send emails' }), { status: 401 })) as typeof fetch;
    await expect(resendDomains('re_x', restricted).register(DOMAIN)).rejects.toThrow('Use a key with full access');
  });

  it('the health page says mail is not set up, not that it is broken', async () => {
    const parts = async (phase: 'off' | 'provider' | 'records' | 'on', answer?: Record<string, unknown>) => {
      const health = createCopyHealth({
        startedAt: new Date(), env: {},
        mail: () => ({ phase, healthUrl: phase === 'off' || phase === 'provider' ? null : 'http://theirco-mx.internal:8080/health' }),
        fetchImpl: (async () => (answer ? new Response(JSON.stringify(answer)) : Promise.reject(new TypeError('fetch failed')))) as unknown as typeof fetch,
      });
      return (await health.report()).parts.find((part) => part.key === 'mail-in');
    };
    expect(await parts('off')).toMatchObject({ ok: true, line: 'not set up: an admin can set it up under Mail' });
    expect(await parts('records')).toMatchObject({ ok: false, line: expect.stringContaining('being set up') });
    expect(await parts('on', { ok: true, starttls: true })).toMatchObject({ ok: true, line: 'answering, encryption on' });
  });
});
