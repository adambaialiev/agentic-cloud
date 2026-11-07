import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCopyIdentity, signPulseBody, verifyPulseBody, COPY_PULSE_KEY_HEADER, COPY_PULSE_SIGNATURE_HEADER } from '../../shared/copy-pulse-signing.js';
import { fixturePulse } from '../../shared/copy-pulse-fixtures.js';
import { copyPulseHandler } from '../../routes/copy-pulse.js';
import { InMemoryCopyPulseStore } from '../../services/copy-pulse-storage.js';
import { InMemoryCopyPulseKeyStore, SqliteCopyPulseKeyStore } from '../../services/copy-pulse-keys.js';
import {
  createCopyPulse,
  checkContact,
  InMemoryCopyPulseSettingsStore,
  pulseUrlFrom,
  DEFAULT_PULSE_URL,
  SqliteCopyPulseSettingsStore,
  type CopyPulseFacts,
} from '../../services/copy-pulse-sender.js';
import { collectCopyPulseFacts } from '../../services/copy-pulse-facts.js';
import { openSqliteDb, serializeDoc } from '../../services/sqlite/sqlite-db.js';

/**
 * Note #1057: a private copy's daily pulse, both ends — signed by the copy,
 * checked and kept by us — and the copy's contact and off switch.
 */

const FACTS: CopyPulseFacts = {
  people: 4,
  agentsByCli: { claude: 3, codex: 1, opencode: 0 },
  turnsLast24hByCli: { claude: 20, codex: 2, opencode: 0 },
  machineHours24h: 3.5,
  sitesLive: 1,
  lastActivityAt: '2026-11-07T15:00:00.000Z',
  health: { backupAgeHours: 4, diskFreePercent: 71, state: 'ok' },
  updatesState: 'current',
};
const NOW = new Date('2026-11-07T16:00:00.000Z');

/** Our receiving end on a real socket, raw body, exactly as index.ts mounts it. */
async function receiver() {
  const store = new InMemoryCopyPulseStore();
  const keys = new InMemoryCopyPulseKeyStore();
  const onPulse = vi.fn();
  const app = express();
  app.use('/api/copy-pulse', express.raw({ type: () => true, limit: '64kb' }));
  app.use(express.json());
  app.post('/api/copy-pulse', copyPulseHandler({ store, keys, onPulse, now: () => NOW }));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy-pulse`;
  servers.push(server);
  return { store, keys, onPulse, url };
}
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => { s.close(resolve); })));
});

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

function signed(pulse: object, identity = newCopyIdentity()) {
  const body = JSON.stringify(pulse);
  return { body, headers: { [COPY_PULSE_KEY_HEADER]: identity.publicKey, [COPY_PULSE_SIGNATURE_HEADER]: signPulseBody(body, identity.privateKey) }, identity };
}

describe('signing', () => {
  it('a signature checks against its key over the exact bytes, and nothing else', () => {
    const me = newCopyIdentity();
    const other = newCopyIdentity();
    const body = Buffer.from('{"a":1}');
    const sig = signPulseBody(body, me.privateKey);
    expect(verifyPulseBody(body, me.publicKey, sig)).toBe(true);
    expect(verifyPulseBody(Buffer.from('{"a":2}'), me.publicKey, sig)).toBe(false);
    expect(verifyPulseBody(Buffer.from('{"a": 1}'), me.publicKey, sig)).toBe(false);
    expect(verifyPulseBody(body, other.publicKey, sig)).toBe(false);
    expect(verifyPulseBody(body, undefined, sig)).toBe(false);
    expect(verifyPulseBody(body, me.publicKey, undefined)).toBe(false);
    expect(verifyPulseBody(body, 'not-a-key', sig)).toBe(false);
    expect(verifyPulseBody(body, me.publicKey, 'x'.repeat(86))).toBe(false);
  });

  it('a copy id is random and fits the pulse shape', () => {
    const a = newCopyIdentity();
    expect(a.copyId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(newCopyIdentity().copyId).not.toBe(a.copyId);
  });
});

describe('POST /api/copy-pulse', () => {
  it('keeps a signed pulse as the copy\'s latest and its day\'s row, and nudges the alerts', async () => {
    const r = await receiver();
    const { body, headers, identity } = signed({ ...fixturePulse(), copyId: 'copy-aaaaaaaa' });
    const answer = await post(r.url, body, headers);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, receivedAt: NOW.toISOString() });
    const kept = await r.store.get('copy-aaaaaaaa');
    expect(kept?.pulse).toMatchObject({ contactEmail: 'dana@acme.example', receivedAt: NOW.toISOString() });
    expect(await r.store.days('copy-aaaaaaaa')).toHaveLength(1);
    expect(await r.keys.get('copy-aaaaaaaa')).toBe(identity.publicKey);
    expect(r.onPulse).toHaveBeenCalledOnce();
  });

  it.each(['daily', 'boot', 'contact-changed'] as const)('takes reason %s', async (reason) => {
    const r = await receiver();
    const { body, headers } = signed({ ...fixturePulse(), reason });
    expect((await post(r.url, body, headers)).status).toBe(200);
    expect((await r.store.list())[0].pulse.reason).toBe(reason);
  });

  it('refuses an unsigned pulse, and keeps nothing', async () => {
    const r = await receiver();
    const answer = await post(r.url, JSON.stringify(fixturePulse()));
    expect(answer.status).toBe(401);
    expect(await r.store.list()).toEqual([]);
    expect(r.onPulse).not.toHaveBeenCalled();
  });

  it('refuses a body changed after signing', async () => {
    const r = await receiver();
    const { headers } = signed(fixturePulse());
    expect((await post(r.url, JSON.stringify({ ...fixturePulse(), people: 9999 }), headers)).status).toBe(401);
    expect(await r.store.list()).toEqual([]);
  });

  it('refuses a known copy id signed by another key — the first key a copy arrives with is the one it keeps', async () => {
    const r = await receiver();
    const first = signed(fixturePulse());
    expect((await post(r.url, first.body, first.headers)).status).toBe(200);
    const impostor = signed({ ...fixturePulse(), contactEmail: 'mallory@evil.example' });
    const answer = await post(r.url, impostor.body, impostor.headers);
    expect(answer.status).toBe(401);
    expect((await r.store.get(fixturePulse().copyId))?.pulse.contactEmail).toBe('dana@acme.example');
  });

  it('refuses a signed body that is not a pulse', async () => {
    const r = await receiver();
    const { body, headers } = signed({ ...fixturePulse(), reason: 'because' });
    const answer = await post(r.url, body, headers);
    expect(answer.status).toBe(400);
    expect((await answer.json()).error).toContain('reason');
    expect(await r.keys.get(fixturePulse().copyId)).toBeNull();
  });

  it('keeps the public half on disk, first writer wins', async () => {
    const db = openSqliteDb(join(mkdtempSync(join(tmpdir(), 'pulse-keys-')), 'db.sqlite'));
    const keys = new SqliteCopyPulseKeyStore(db);
    expect(await keys.register('copy-1', 'A'.repeat(43), NOW.toISOString())).toBe('A'.repeat(43));
    expect(await keys.register('copy-1', 'B'.repeat(43), NOW.toISOString())).toBe('A'.repeat(43));
    expect(await keys.get('copy-2')).toBeNull();
  });
});

function sender(url: string | null, over: Partial<Parameters<typeof createCopyPulse>[0]> = {}) {
  const store = over.store ?? new InMemoryCopyPulseSettingsStore();
  const pulse = createCopyPulse({
    store,
    url,
    domain: 'agents.theirco.test',
    release: '2026.11.06.0',
    collect: async () => FACTS,
    installContact: { name: 'Theirco IT', email: 'it@theirco.test' },
    now: () => NOW,
    ...over,
  });
  return { pulse, store };
}

describe('the copy\'s sender, against the real receiving route', () => {
  it('sends a signed pulse we keep, with the counts and the contact, and remembers it exactly as sent', async () => {
    const r = await receiver();
    const { pulse, store } = sender(r.url);
    const last = await pulse.send('boot');
    expect(last?.delivered).toBe(true);
    const doc = store.get()!;
    const kept = await r.store.get(doc.copyId);
    expect(kept?.pulse).toMatchObject({
      domain: 'agents.theirco.test', contactName: 'Theirco IT', contactEmail: 'it@theirco.test', reason: 'boot',
      release: '2026.11.06.0', pulseEnabled: true, people: 4, sitesLive: 1,
    });
    expect(JSON.parse(doc.lastPulse!.body!)).toEqual(JSON.parse(JSON.stringify({ ...kept!.pulse, receivedAt: undefined })));
    expect(doc.lastDeliveredAt).toBe(NOW.toISOString());
    // The private half stays here; only the public half reached us.
    expect(await r.keys.get(doc.copyId)).toBe(doc.publicKey);
    expect(doc.lastPulse!.body).not.toContain(doc.privateKey);
  });

  it('a changed contact is kept and told at once (contact-changed)', async () => {
    const r = await receiver();
    const { pulse, store } = sender(r.url);
    const changed = await pulse.setContact('Ops desk', 'ops@theirco.test');
    expect(changed.ok).toBe(true);
    expect(store.get()).toMatchObject({ contactName: 'Ops desk', contactEmail: 'ops@theirco.test', contactFrom: 'admin' });
    const kept = await r.store.get(store.get()!.copyId);
    expect(kept?.pulse).toMatchObject({ reason: 'contact-changed', contactEmail: 'ops@theirco.test' });
    expect((await pulse.setContact('x', 'not an address')).ok).toBe(false);
  });

  it('off: one last pulse saying so, then nothing — not daily, not at boot', async () => {
    const r = await receiver();
    const { pulse, store } = sender(r.url);
    await pulse.send('daily');
    const view = await pulse.setEnabled(false);
    expect(view.pulseEnabled).toBe(false);
    const copyId = store.get()!.copyId;
    expect((await r.store.get(copyId))?.pulse).toMatchObject({ pulseEnabled: false, reason: 'contact-changed' });
    const before = (await r.store.days(copyId)).length;
    expect(await pulse.send('daily')).toBeNull();
    expect(await pulse.send('boot')).toBeNull();
    expect((await r.store.get(copyId))?.pulse.pulseEnabled).toBe(false);
    expect((await r.store.days(copyId)).length).toBe(before);
    expect((await pulse.view()).nextDailyAt).toBeNull();
    // On again: told at once, and the daily pulse is back.
    await pulse.setEnabled(true);
    expect((await r.store.get(copyId))?.pulse.pulseEnabled).toBe(true);
    expect((await pulse.send('daily'))?.delivered).toBe(true);
  });

  it('the last pulse is retried until it arrives, then nothing more', async () => {
    let up = false;
    const r = await receiver();
    const flaky = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!up) throw new TypeError('fetch failed');
      return fetch(input, init);
    });
    const { pulse } = sender(r.url, { fetchImpl: flaky as unknown as typeof fetch });
    await pulse.setEnabled(false);
    expect((await pulse.view()).lastPulse).toMatchObject({ delivered: false, error: 'not reachable' });
    up = true;
    expect((await pulse.send('daily'))?.delivered).toBe(true);
    expect((await r.store.list())[0].pulse.pulseEnabled).toBe(false);
    expect(await pulse.send('daily')).toBeNull();
  });

  it('with the licence on, the switch is ignored and the pulse keeps going', async () => {
    const r = await receiver();
    const { pulse } = sender(r.url, { licenceOn: true });
    const view = await pulse.setEnabled(false);
    expect(view).toMatchObject({ pulseEnabled: false, licenceKeepsOn: true });
    expect((await pulse.send('daily'))?.delivered).toBe(true);
    expect((await r.store.list())[0].pulse.pulseEnabled).toBe(true);
  });

  it('unreachable: the copy carries on, and says so on its screen', async () => {
    const { pulse } = sender('http://127.0.0.1:9/api/copy-pulse', { timeoutMs: 2_000 });
    const last = await pulse.send('daily');
    expect(last).toMatchObject({ delivered: false, reason: 'daily' });
    expect(last?.body).toContain('"reason":"daily"');
  });

  it('a copy installed before the installer asked takes its first admin as the contact', async () => {
    const r = await receiver();
    const { pulse, store } = sender(r.url, { installContact: {}, firstAdmin: async () => ({ name: 'Ada Admin', email: 'ada@theirco.test' }) });
    await pulse.send('boot');
    expect(store.get()).toMatchObject({ contactName: 'Ada Admin', contactEmail: 'ada@theirco.test', contactFrom: 'first-admin' });
  });

  it('with no contact at all, sends nothing and says why', async () => {
    const fetchImpl = vi.fn();
    const { pulse } = sender('http://unused.test/api/copy-pulse', { installContact: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    const last = await pulse.send('boot');
    expect(last).toMatchObject({ delivered: false });
    expect(last?.error).toContain('no contact');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps its identity: the same copy id and key across restarts', async () => {
    const db = openSqliteDb(join(mkdtempSync(join(tmpdir(), 'pulse-settings-')), 'db.sqlite'));
    const first = sender(null, { store: new SqliteCopyPulseSettingsStore(db) });
    const a = await first.pulse.settings();
    const again = sender(null, { store: new SqliteCopyPulseSettingsStore(db) });
    const b = await again.pulse.settings();
    expect(b.copyId).toBe(a.copyId);
    expect(b.privateKey).toBe(a.privateKey);
  });

  it('sends at boot two minutes in, and daily at a fixed minute after 06:00 UTC', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-07T05:00:00.000Z') });
    try {
      const reasons: string[] = [];
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        reasons.push(JSON.parse(String(init?.body)).reason);
        return new Response('{"ok":true}', { status: 200 });
      });
      const { pulse } = sender('http://receiver.test/api/copy-pulse', { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => new Date() });
      await pulse.start();
      const next = new Date((await pulse.view()).nextDailyAt!);
      expect(next.getUTCHours()).toBe(6);
      expect(next.toISOString().slice(0, 10)).toBe('2026-11-07');
      await vi.advanceTimersByTimeAsync(121_000);
      expect(reasons).toEqual(['boot']);
      await vi.advanceTimersByTimeAsync(next.getTime() - Date.now() + 1_000);
      expect(reasons).toEqual(['boot', 'daily']);
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(reasons).toEqual(['boot', 'daily', 'daily']);
      pulse.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('small pieces', () => {
  it('checkContact needs an address and takes it as the name when none is given', () => {
    expect(checkContact('', 'a@b.test')).toEqual({ ok: true, contact: { name: 'a@b.test', email: 'a@b.test' } });
    expect(checkContact('Name', '')).toMatchObject({ ok: false });
  });

  it('COPY_PULSE_URL points at another receiver; anything else is ours', () => {
    expect(pulseUrlFrom(undefined)).toBe(DEFAULT_PULSE_URL);
    expect(pulseUrlFrom('off')).toBe(DEFAULT_PULSE_URL);
    expect(pulseUrlFrom('https://scratch.example/api/copy-pulse')).toBe('https://scratch.example/api/copy-pulse');
  });
});

describe('collectCopyPulseFacts', () => {
  it('counts from the copy\'s own database, and nothing but counts', async () => {
    const db = openSqliteDb(join(mkdtempSync(join(tmpdir(), 'pulse-facts-')), 'db.sqlite'));
    const now = new Date('2026-11-07T12:00:00.000Z');
    db.prepare('INSERT INTO users (user_id, doc) VALUES (?, ?)').run('u1', serializeDoc({
      userId: 'u1', email: 'x@y.test', telegram: { agents: { a1: { cli: 'claude' }, a2: { cli: 'codex' }, a3: { cli: 'opencode' } } },
    }));
    const msg = db.prepare('INSERT INTO agent_chat_messages (user_id, agent_id, seq, doc) VALUES (?, ?, ?, ?)');
    msg.run('u1', 'a1', 1, JSON.stringify({ role: 'owner', text: 'hi', at: '2026-11-07T10:00:00.000Z' }));
    msg.run('u1', 'a1', 2, JSON.stringify({ role: 'agent', text: 'hello', at: '2026-11-07T10:01:00.000Z' }));
    msg.run('u1', 'a1', 3, JSON.stringify({ role: 'agent', text: 'old', at: '2026-11-05T10:01:00.000Z' }));
    msg.run('u1', 'a2', 1, JSON.stringify({ role: 'agent', text: 'yo', at: '2026-11-07T11:00:00.000Z' }));
    db.prepare('INSERT INTO agent_work_days (user_id, agent_id, day, working_ms) VALUES (?, ?, ?, ?)').run('u1', 'a1', '2026-11-07', 2 * 3_600_000);
    db.prepare('INSERT INTO agent_work_days (user_id, agent_id, day, working_ms) VALUES (?, ?, ?, ?)').run('u1', 'a1', '2026-11-06', 4 * 3_600_000);
    db.prepare('INSERT INTO deployments (deployment_id, name, user_id, doc) VALUES (?, ?, ?, ?)').run('d1', 'site', 'u1', JSON.stringify({ status: 'live' }));
    db.prepare('INSERT INTO deployments (deployment_id, name, user_id, doc) VALUES (?, ?, ?, ?)').run('d2', 'gone', 'u1', JSON.stringify({ status: 'destroyed' }));
    db.prepare('INSERT INTO telegram_agent_activity (user_id, agent_id, last_active_at_ms) VALUES (?, ?, ?)').run('u1', 'a1', Date.parse('2026-11-07T11:30:00.000Z'));
    const facts = await collectCopyPulseFacts({
      db,
      countPeople: async () => 2,
      lastBackupAt: () => '2026-11-07T06:00:00.000Z',
      healthReport: async () => ({ parts: [{ ok: true }, { ok: false }], updates: { state: 'behind' } }),
      now: () => now,
    });
    expect(facts).toEqual({
      people: 2,
      agentsByCli: { claude: 1, codex: 1, opencode: 1 },
      turnsLast24hByCli: { claude: 1, codex: 1, opencode: 0 },
      // Today's 2 h whole, yesterday's 4 h for the half of it inside the window.
      machineHours24h: 4,
      sitesLive: 1,
      lastActivityAt: '2026-11-07T11:30:00.000Z',
      health: { backupAgeHours: 6, diskFreePercent: null, state: 'trouble' },
      updatesState: 'behind',
    });
  });
});
