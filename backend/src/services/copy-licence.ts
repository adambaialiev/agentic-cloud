/**
 * A private copy's licence (note #814, stage 3 piece 4 of note #811), exactly
 * as Adam decided on note #810:
 *
 *  - an offline signed file, one line (`acc1.<payload>.<Ed25519 signature>`,
 *    the same form as an update key), made only by our issuing command;
 *    the copy checks it by itself and never calls us;
 *  - it names the copy's domain and how many people may use it, and runs a
 *    year: from 30 days before its end the copy's admins see a banner; after
 *    it ends, 30 days of grace; then no new people and no new agents, and
 *    nothing that exists stops;
 *  - at the people limit the next person is refused with a plain line;
 *  - it is easy to leave off (COPY_LICENCE=off) for a first design partner,
 *    who has only the contract and the update key.
 *
 * People are the accounts that can use the copy: members of a workplace and
 * people waiting on a request to join one (an account in neither cannot sign
 * in, note #814). The licence the installer stored (the LICENCE secret) and
 * one an admin pastes later both count; the most recently issued good one
 * wins. Only a private copy reads any of this.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { SqliteDb } from './sqlite/sqlite-db.js';

/** Our signing key's public halves, by the `x` of the Ed25519 JWK. The
 *  first is infra/copy-release/signing-key.pub (a test keeps them equal). A
 *  new key ships here in a release before anything is signed with it. */
export const LICENCE_PUBLIC_KEYS = ['cfwaN3RUihqcroPiQwCVqpbossA4MWpSeQo1izy7LTw'];

export const LICENCE_WARN_DAYS = 30;
export const LICENCE_GRACE_DAYS = 30;
const DAY_MS = 24 * 3600_000;

export interface LicencePayload {
  kind: 'licence';
  id: string;
  customer: string;
  domain: string;
  people: number;
  starts: string;
  ends: string;
  updatesUntil: string;
  issuedAt: string;
}

export type LicenceState = 'missing' | 'invalid' | 'valid' | 'ending' | 'grace' | 'lapsed';

export interface LicenceStatus {
  state: LicenceState;
  licence: LicencePayload | null;
  people: number;
  /** Most people the copy has had at once, for the usage report. */
  peakPeople: number;
  /** Whole days until the end (negative once it has passed). */
  daysLeft: number | null;
  /** The end of the grace period, YYYY-MM-DD. */
  graceEnds: string | null;
  /** True once nobody and nothing new may be added. */
  growthStopped: boolean;
  /** More people than the licence covers (a smaller licence pasted over a
   *  bigger copy): nobody new may join until one with more is pasted. */
  overLimit: boolean;
  /** One plain line for the copy's admins. */
  line: string;
  /** The same, short enough for one row of the health page. */
  short: string;
}

/** What a licence is, or why it is not one this copy may use. */
export function readLicence(text: string, domain: string, publicKeys: string[] = LICENCE_PUBLIC_KEYS):
  { ok: true; licence: LicencePayload } | { ok: false; why: string } {
  const parts = String(text ?? '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'acc1') return { ok: false, why: 'That is not a licence (it is one line starting acc1.).' };
  const keys: KeyObject[] = publicKeys.map((x) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }));
  let signed = false;
  try {
    const signature = Buffer.from(parts[2]!, 'base64url');
    signed = keys.some((key) => verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature));
  } catch { signed = false; }
  if (!signed) return { ok: false, why: 'That licence is damaged or was not made by us. Paste it again exactly as it came.' };
  let payload: Partial<LicencePayload> | null = null;
  try { payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Partial<LicencePayload>; } catch { payload = null; }
  if (payload?.kind !== 'licence') return { ok: false, why: 'That is an update key, not a licence.' };
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!payload.id || !payload.domain || !(Number(payload.people) >= 1) || !day.test(String(payload.ends)) || !day.test(String(payload.starts))) {
    return { ok: false, why: 'That licence is missing what it should say. Ask us for the file again.' };
  }
  if (payload.domain.toLowerCase() !== domain.toLowerCase()) {
    return { ok: false, why: `That licence is for ${payload.domain}, and this copy is ${domain}.` };
  }
  return { ok: true, licence: payload as LicencePayload };
}

const dayWords = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00Z`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plusDays = (yyyyMmDd: string, days: number) => new Date(Date.parse(`${yyyyMmDd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Where a licence stands on a day, with the words its admins read. */
export function licenceStatus(licence: LicencePayload | null, why: string | null, people: number, peakPeople: number, now: Date): LicenceStatus {
  const overLimit = Boolean(licence && people > licence.people);
  const base = { licence, people, peakPeople, overLimit };
  if (!licence) {
    return {
      ...base, state: why ? 'invalid' : 'missing', daysLeft: null, graceEnds: null, growthStopped: true,
      line: why
        ? `The licence is not usable: ${why} Nobody new and no new agents can be added until a good one is pasted.`
        : 'This copy has no licence. Nobody new and no new agents can be added until one is pasted on the workplace page, under This copy.',
      short: why ? 'Not usable · no new people or agents' : 'None · no new people or agents',
    };
  }
  // A licence runs to the END of its last day.
  const endMs = Date.parse(`${licence.ends}T00:00:00Z`) + DAY_MS;
  const daysLeft = Math.ceil((endMs - now.getTime()) / DAY_MS);
  const graceEnds = plusDays(licence.ends, LICENCE_GRACE_DAYS);
  const shortSeats = overLimit ? `${people} people, covers ${licence.people}` : `${people} of ${licence.people} people`;
  const seats = overLimit
    ? `${people} people, more than the ${licence.people} it covers: nobody new can join until a licence with more is pasted`
    : `${people} of ${licence.people} people`;
  if (daysLeft > LICENCE_WARN_DAYS) {
    return {
      ...base, state: 'valid', daysLeft, graceEnds, growthStopped: false,
      line: `Licensed until ${dayWords(licence.ends)} · ${seats}`, short: `Until ${shortDay(licence.ends)} · ${shortSeats}`,
    };
  }
  if (daysLeft > 0) {
    return {
      ...base, state: 'ending', daysLeft, graceEnds, growthStopped: false,
      line: `The licence ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, on ${dayWords(licence.ends)}. Paste the renewal on the workplace page, under This copy, when it comes · ${seats}`,
      short: `Ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} · ${shortSeats}`,
    };
  }
  if (now.getTime() < endMs + LICENCE_GRACE_DAYS * DAY_MS) {
    return {
      ...base, state: 'grace', daysLeft, graceEnds, growthStopped: false,
      line: `The licence ended on ${dayWords(licence.ends)}. Everything works until ${dayWords(graceEnds)}; after that nobody new and no new agents can be added until it is renewed.`,
      short: `Ended ${shortDay(licence.ends)} · grace until ${shortDay(graceEnds)}`,
    };
  }
  return {
    ...base, state: 'lapsed', daysLeft, graceEnds, growthStopped: true,
    line: `The licence ended on ${dayWords(licence.ends)}. Everything that exists keeps working, but nobody new and no new agents can be added until it is renewed.`,
    short: `Ended ${shortDay(licence.ends)} · no new people or agents`,
  };
}

/** The licence a copy pasted, its highest head count and what changed when,
 *  in one small table of its own. */
export interface LicenceStore {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
}

export class SqliteLicenceStore implements LicenceStore {
  constructor(private readonly db: SqliteDb) {}
  get(key: string): unknown {
    const row = this.db.prepare('SELECT doc FROM copy_licence WHERE key = ?').get(key) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) : undefined;
  }
  put(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO copy_licence (key, doc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc')
      .run(key, JSON.stringify(value));
  }
}

export class InMemoryLicenceStore implements LicenceStore {
  private readonly rows = new Map<string, unknown>();
  get(key: string): unknown { return this.rows.get(key); }
  put(key: string, value: unknown): void { this.rows.set(key, value); }
}

export interface CopyLicenceOptions {
  domain: string;
  /** The licence the installer stored, from the LICENCE secret. */
  installed?: string;
  store: LicenceStore;
  countPeople: () => Promise<number>;
  publicKeys?: string[];
  now?: () => Date;
  log?: (line: string) => void;
}

export class CopyLicence {
  private readonly now: () => Date;
  constructor(private readonly options: CopyLicenceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The licence in force: the most recently issued good one of the
   *  installed and the pasted; with neither good, why not. */
  private inForce(): { licence: LicencePayload | null; why: string | null } {
    const read = (text: unknown) => (typeof text === 'string' && text.trim()
      ? readLicence(text, this.options.domain, this.options.publicKeys)
      : null);
    const candidates = [read(this.options.installed), read(this.options.store.get('pasted'))];
    const good = candidates.flatMap((one) => (one?.ok ? [one.licence] : []))
      .sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
    if (good[0]) return { licence: good[0], why: null };
    const bad = candidates.find((one) => one && !one.ok);
    return { licence: null, why: bad && !bad.ok ? bad.why : null };
  }

  async status(): Promise<LicenceStatus> {
    const people = await this.options.countPeople();
    const peak = Math.max(people, Number(this.options.store.get('peakPeople') ?? 0));
    if (peak !== Number(this.options.store.get('peakPeople') ?? 0)) this.options.store.put('peakPeople', peak);
    const { licence, why } = this.inForce();
    return licenceStatus(licence, why, people, peak, this.now());
  }

  /** A renewal pasted by an admin: kept if it is good for this copy. */
  async paste(text: string): Promise<{ ok: true; status: LicenceStatus } | { ok: false; why: string }> {
    const read = readLicence(text, this.options.domain, this.options.publicKeys);
    if (!read.ok) return read;
    this.options.store.put('pasted', String(text).trim());
    const status = await this.status();
    this.record(status, `licence ${read.licence.id} pasted`);
    return { ok: true, status };
  }

  /** Null when one more person may join; else the plain line that says why not. */
  async personRefusal(): Promise<string | null> {
    const status = await this.status();
    if (status.growthStopped) return `This copy cannot take anyone new right now: ${status.line}`;
    if (status.licence && status.people >= status.licence.people) {
      return `This copy's licence covers ${status.licence.people} people, and all ${status.licence.people} places are taken. An admin can ask for a licence with more.`;
    }
    return null;
  }

  /** Null when a new agent may be made; else the plain line that says why not. */
  async agentRefusal(): Promise<string | null> {
    const status = await this.status();
    return status.growthStopped ? `No new agents can be made here right now: ${status.line}` : null;
  }

  /** Each change of state, written down once, with when. */
  record(status: LicenceStatus, because = 'daily check'): void {
    const last = this.options.store.get('lastState') as { state?: string; id?: string } | undefined;
    const id = status.licence?.id ?? null;
    if (last?.state === status.state && last?.id === id && because === 'daily check') return;
    const entry = { at: this.now().toISOString(), state: status.state, id, people: status.people, because };
    this.options.store.put('lastState', entry);
    const audit = (this.options.store.get('audit') as unknown[] | undefined) ?? [];
    this.options.store.put('audit', [...audit, entry].slice(-100));
    this.options.log?.(`[licence] ${status.state}${id ? ` (${id})` : ''}: ${status.line}`);
  }

  /** At start and once a day. */
  start(intervalMs = DAY_MS): void {
    const tick = () => { void this.status().then((status) => this.record(status)).catch(() => {}); };
    tick();
    setInterval(tick, intervalMs).unref();
  }

  audit(): unknown[] {
    return (this.options.store.get('audit') as unknown[] | undefined) ?? [];
  }
}
