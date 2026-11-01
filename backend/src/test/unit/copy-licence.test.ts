/**
 * A private copy's licence (note #814), as Adam decided on note #810: an
 * offline signed file for one domain that counts people; a banner 30 days
 * ahead, 30 days of grace, then no new people or agents and nothing that
 * exists stops; the next person at the limit refused in words.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CopyLicence, InMemoryLicenceStore, LICENCE_PUBLIC_KEYS, licenceStatus, readLicence, type LicencePayload,
} from '../../services/copy-licence.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const X = publicKey.export({ format: 'jwk' }).x!;
const stranger = generateKeyPairSync('ed25519').privateKey;
const DOMAIN = 'agents.theirco.test';

function licence(fields: Partial<LicencePayload> = {}, key = privateKey): string {
  const payload: LicencePayload = {
    kind: 'licence', id: 'l1', customer: 'theirco', domain: DOMAIN, people: 3,
    starts: '2026-10-27', ends: '2027-10-26', updatesUntil: '2027-10-26', issuedAt: '2026-10-27T12:00:00.000Z', ...fields,
  };
  const body = `acc1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`;
}

const on = (day: string) => new Date(`${day}T12:00:00.000Z`);

describe('reading a licence (note #814)', () => {
  it('takes ours for this domain and refuses everything else in words', () => {
    expect(readLicence(licence(), DOMAIN, [X])).toMatchObject({ ok: true, licence: { id: 'l1', people: 3 } });
    expect(readLicence(licence({ domain: 'agents.other.test' }), DOMAIN, [X])).toEqual({ ok: false, why: 'That licence is for agents.other.test, and this copy is agents.theirco.test.' });
    expect(readLicence(licence({}, stranger), DOMAIN, [X])).toMatchObject({ ok: false, why: expect.stringContaining('not made by us') });
    const [head, , tail] = licence().split('.');
    const edited = `${head}.${Buffer.from(JSON.stringify({ kind: 'licence', domain: DOMAIN, people: 999 })).toString('base64url')}.${tail}`;
    expect(readLicence(edited, DOMAIN, [X])).toMatchObject({ ok: false, why: expect.stringContaining('damaged') });
    expect(readLicence(licence({ kind: 'update' as 'licence' }), DOMAIN, [X])).toEqual({ ok: false, why: 'That is an update key, not a licence.' });
    expect(readLicence('hello', DOMAIN, [X])).toMatchObject({ ok: false });
  });

  it('carries our own public key, the one the issuing command signs for', () => {
    const committed = readFileSync(path.resolve(__dirname, '../../../../infra/copy-release/signing-key.pub'), 'utf8').trim();
    expect(LICENCE_PUBLIC_KEYS[0]).toBe(committed);
  });
});

describe('where a licence stands (note #814)', () => {
  const payload = readLicence(licence({ ends: '2027-10-26' }), DOMAIN, [X]);
  const ours = payload.ok ? payload.licence : null;

  it('is quiet for most of the year, then warns 30 days ahead', () => {
    expect(licenceStatus(ours, null, 2, 2, on('2027-06-01'))).toMatchObject({ state: 'valid', growthStopped: false, line: 'Licensed until 26 October 2027 · 2 of 3 people', short: 'Until 26 Oct 2027 · 2 of 3 people' });
    expect(licenceStatus(ours, null, 2, 2, on('2027-10-17'))).toMatchObject({ state: 'ending', daysLeft: 10, growthStopped: false, line: expect.stringContaining('ends in 10 days, on 26 October 2027'), short: 'Ends in 10 days · 2 of 3 people' });
  });

  it('gives 30 days of grace, then stops only growth', () => {
    expect(licenceStatus(ours, null, 2, 2, on('2027-11-10'))).toMatchObject({ state: 'grace', growthStopped: false, graceEnds: '2027-11-25', line: expect.stringContaining('Everything works until 25 November 2027') });
    expect(licenceStatus(ours, null, 2, 2, on('2027-12-01'))).toMatchObject({ state: 'lapsed', growthStopped: true, line: expect.stringContaining('Everything that exists keeps working'), short: 'Ended 26 Oct 2027 · no new people or agents' });
  });

  it('says plainly when there is none, or none that can be used', () => {
    expect(licenceStatus(null, null, 1, 1, on('2027-01-01'))).toMatchObject({ state: 'missing', growthStopped: true });
    expect(licenceStatus(null, 'That licence is for x.', 1, 1, on('2027-01-01'))).toMatchObject({ state: 'invalid', line: expect.stringContaining('That licence is for x.') });
  });
});

describe('a copy and its licence (note #814)', () => {
  const make = ({ installed, people = 2, day = '2027-01-01' }: { installed?: string; people?: number; day?: string } = {}) => {
    const store = new InMemoryLicenceStore();
    const logged: string[] = [];
    let count = people;
    const copy = new CopyLicence({
      domain: DOMAIN, ...(installed ? { installed } : {}), store, publicKeys: [X],
      countPeople: async () => count, now: () => on(day), log: (line) => logged.push(line),
    });
    return { copy, store, logged, setPeople: (n: number) => { count = n; } };
  };

  it('says so when a smaller licence leaves the copy over its limit', () => {
    const small = readLicence(licence({ people: 2 }), DOMAIN, [X]);
    expect(licenceStatus(small.ok ? small.licence : null, null, 3, 3, on('2027-01-01'))).toMatchObject({
      state: 'valid', overLimit: true,
      line: 'Licensed until 26 October 2027 · 3 people, more than the 2 it covers: nobody new can join until a licence with more is pasted',
    });
  });

  it('refuses the next person at the limit, and not before', async () => {
    const { copy, setPeople } = make({ installed: licence({ people: 3 }) });
    expect(await copy.personRefusal()).toBeNull();
    setPeople(3);
    expect(await copy.personRefusal()).toBe('This copy\'s licence covers 3 people, and all 3 places are taken. An admin can ask for a licence with more.');
    expect(await copy.agentRefusal()).toBeNull();
  });

  it('takes no new people or agents once lapsed, or with no licence', async () => {
    const lapsed = make({ installed: licence({ ends: '2026-11-01' }), day: '2027-01-15' }).copy;
    expect(await lapsed.personRefusal()).toContain('cannot take anyone new right now');
    expect(await lapsed.agentRefusal()).toContain('No new agents can be made here right now');
    expect(await make().copy.agentRefusal()).toContain('This copy has no licence.');
  });

  it('takes a pasted renewal at once, the most recently issued winning, and refuses a bad one', async () => {
    const { copy, logged } = make({ installed: licence({ ends: '2026-11-01', issuedAt: '2025-11-01T00:00:00.000Z' }), day: '2027-01-15' });
    expect((await copy.status()).state).toBe('lapsed');
    expect(await copy.paste(licence({ domain: 'agents.other.test' }))).toMatchObject({ ok: false });
    const renewed = await copy.paste(licence({ id: 'l2', ends: '2028-01-14', issuedAt: '2027-01-14T00:00:00.000Z' }));
    expect(renewed).toMatchObject({ ok: true, status: { state: 'valid', licence: { id: 'l2' } } });
    expect(await copy.agentRefusal()).toBeNull();
    expect(logged.at(-1)).toContain('[licence] valid (l2)');
    expect(copy.audit()).toEqual([expect.objectContaining({ state: 'valid', id: 'l2', because: 'licence l2 pasted' })]);
  });

  it('keeps the highest head count for the usage report', async () => {
    const { copy, setPeople } = make({ installed: licence({ people: 10 }) });
    setPeople(7);
    await copy.status();
    setPeople(4);
    expect(await copy.status()).toMatchObject({ people: 4, peakPeople: 7 });
  });
});
