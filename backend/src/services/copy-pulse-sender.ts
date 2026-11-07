import { createHash } from 'node:crypto';
import type { SqliteDb } from './sqlite/sqlite-db.js';
import type { WorkspaceCopyPulse } from '../shared/workspace-api.js';
import { parseCopyPulse, type CopyPulse, type CopyPulseReason } from '../shared/copy-pulse.js';
import {
  COPY_PULSE_KEY_HEADER,
  COPY_PULSE_SIGNATURE_HEADER,
  newCopyIdentity,
  signPulseBody,
} from '../shared/copy-pulse-signing.js';

/**
 * A private copy's daily pulse, the copy's side (note #1057; the shape is the
 * contract in shared/copy-pulse.ts, which our receiving route and the Copies
 * screen read).
 *
 * WHAT: counts only, plus the contact person the copy's admin gave on purpose
 * (the one piece of personal data in it). Built fresh each time by `collect`.
 *
 * WHEN: once a day at a fixed hour of the copy's clock (06:mm UTC; the minute
 * comes from the copyId so copies do not all arrive at once), at every boot
 * (two minutes in), and when the admin changes the contact. Its own call, to
 * our backend: the two daily reads the copy already makes go to other places
 * (the release list to the update service, the CLI pin is a GET), so riding
 * them would mean a POST hidden inside a read. If we are unreachable nothing
 * happens to the copy: it tries again at the next boot or the next day. It is
 * never a licence check and nothing waits on it.
 *
 * OFF: `pulseEnabled`, default on, set by the admin. Turning it off sends one
 * last pulse with pulseEnabled: false (reason contact-changed: a change the
 * admin made on that screen), so our side reads "opted out" rather than
 * "silent"; it is retried daily until it is delivered, and then nothing more
 * is sent. With COPY_LICENCE=on the switch is ignored: the licence terms
 * include the pulse.
 *
 * WHO: a copyId and an Ed25519 key pair, made together the first time the
 * backend starts (during the install) and kept here. The private half never
 * leaves the copy; each pulse carries the public half and a signature.
 */

export const DEFAULT_PULSE_URL = 'https://api.agenticcloudcomputer.com/api/copy-pulse';
const DAY_MS = 86_400_000;
const FIRST_PULSE_MS = 120_000;
const DEFAULT_HOUR_UTC = 6;

/** Everything in a pulse that the copy counts, rather than knows. */
export type CopyPulseFacts = Pick<CopyPulse,
  'people' | 'agentsByCli' | 'turnsLast24hByCli' | 'machineHours24h' | 'sitesLive' | 'lastActivityAt' | 'health' | 'updatesState'>;

export interface CopyPulseLast {
  /** The body exactly as it was sent (or would have been, when it could not be). */
  body: string | null;
  sentAt: string;
  reason: CopyPulseReason;
  delivered: boolean;
  /** Why it was not delivered, in words; absent when it was. */
  error?: string;
}

export interface CopyPulseSettings {
  copyId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
  contactName?: string;
  contactEmail?: string;
  /** Where the contact came from: the installer, the first admin, or an admin on the screen. */
  contactFrom?: 'install' | 'first-admin' | 'admin';
  contactSetAt?: string;
  pulseEnabled?: boolean;
  /** The last pulse with pulseEnabled false has reached us; nothing more is sent while off. */
  optOutDelivered?: boolean;
  lastPulse?: CopyPulseLast;
  lastDeliveredAt?: string;
}

export interface CopyPulseSettingsStore {
  get(): CopyPulseSettings | null;
  put(doc: CopyPulseSettings): void;
}

export class SqliteCopyPulseSettingsStore implements CopyPulseSettingsStore {
  constructor(private readonly db: SqliteDb) {}
  get(): CopyPulseSettings | null {
    const row = this.db.prepare('SELECT doc FROM copy_settings WHERE key = ?').get('pulse') as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as CopyPulseSettings : null;
  }
  put(doc: CopyPulseSettings): void {
    this.db.prepare('INSERT INTO copy_settings (key, doc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc')
      .run('pulse', JSON.stringify(doc));
  }
}

export class InMemoryCopyPulseSettingsStore implements CopyPulseSettingsStore {
  private doc: CopyPulseSettings | null = null;
  get(): CopyPulseSettings | null { return this.doc ? structuredClone(this.doc) : null; }
  put(doc: CopyPulseSettings): void { this.doc = structuredClone(doc); }
}

export interface CopyContact { name: string; email: string }

/** What the admin screen shows (GET api/copy/pulse): the Workspace's own type. */
export type CopyPulseView = WorkspaceCopyPulse;

export interface CopyPulseOptions {
  store: CopyPulseSettingsStore;
  /** Where pulses go (COPY_PULSE_URL, ours by default); null sends nothing (tests). */
  url: string | null;
  domain: string;
  release: string | null;
  collect: () => Promise<CopyPulseFacts>;
  /** The contact the installer gave (COPY_CONTACT_NAME / COPY_CONTACT_EMAIL). */
  installContact?: Partial<CopyContact>;
  /** The copy's first admin, for a copy installed before the installer asked. */
  firstAdmin?: () => Promise<CopyContact | null>;
  licenceOn?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  hourUtc?: number;
  firstPulseMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}$/;

/** A contact an admin typed, cleaned, or the reason it cannot be one. */
export function checkContact(name: unknown, email: unknown): { ok: true; contact: CopyContact } | { ok: false; error: string } {
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (!cleanEmail || cleanEmail.length > 254 || !EMAIL.test(cleanEmail)) return { ok: false, error: 'The contact needs an email address.' };
  const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : cleanEmail;
  return { ok: true, contact: { name: cleanName, email: cleanEmail } };
}

export function createCopyPulse(options: CopyPulseOptions) {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const hourUtc = options.hourUtc ?? DEFAULT_HOUR_UTC;
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let nextDailyAt: Date | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  /** The copy's settings, made (identity) and seeded (contact) the first time. */
  async function settings(): Promise<CopyPulseSettings> {
    let doc = options.store.get();
    if (!doc) {
      const identity = newCopyIdentity();
      doc = { ...identity, createdAt: now().toISOString(), pulseEnabled: true };
      options.store.put(doc);
      options.log?.(`[copy-pulse] this copy's id is ${doc.copyId}`);
    }
    if (!doc.contactEmail) {
      const fromInstall = checkContact(options.installContact?.name, options.installContact?.email);
      let contact: CopyContact | null = fromInstall.ok ? fromInstall.contact : null;
      let from: CopyPulseSettings['contactFrom'] = 'install';
      if (!contact) {
        const first = await options.firstAdmin?.().catch(() => null) ?? null;
        const checked = first ? checkContact(first.name, first.email) : null;
        contact = checked?.ok ? checked.contact : null;
        from = 'first-admin';
      }
      if (contact) {
        doc = { ...doc, contactName: contact.name, contactEmail: contact.email, contactFrom: from, contactSetAt: now().toISOString() };
        options.store.put(doc);
      }
    }
    return doc;
  }

  const enabled = (doc: CopyPulseSettings) => Boolean(options.licenceOn) || doc.pulseEnabled !== false;

  /** Build, sign and send one pulse. Never throws; records what happened. */
  async function sendNow(reason: CopyPulseReason): Promise<CopyPulseLast | null> {
    if (!options.url) return null;
    let doc = await settings();
    const on = enabled(doc);
    // Off: only the one last pulse, until it is delivered.
    if (!on && doc.optOutDelivered) return null;
    const sentAt = now().toISOString();
    let body: string | null = null;
    let last: CopyPulseLast;
    try {
      if (!doc.contactEmail) throw new Error('no contact yet: an admin sets one under Your Agentic Cloud');
      const facts = await options.collect();
      const pulse: CopyPulse = {
        copyId: doc.copyId,
        domain: options.domain,
        contactName: doc.contactName ?? doc.contactEmail,
        contactEmail: doc.contactEmail,
        sentAt,
        reason,
        release: options.release,
        pulseEnabled: on,
        ...facts,
      };
      // Our own check first, with the same parser our side uses: a pulse it
      // would refuse is not sent, and the screen says why.
      const checked = parseCopyPulse(pulse);
      if (!checked.ok) throw new Error(`not sent: ${checked.error}`);
      body = JSON.stringify(pulse);
      const answer = await fetchImpl(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [COPY_PULSE_KEY_HEADER]: doc.publicKey,
          [COPY_PULSE_SIGNATURE_HEADER]: signPulseBody(body, doc.privateKey),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!answer.ok) {
        const words = await answer.json().then((json: { error?: unknown }) => (typeof json?.error === 'string' ? json.error : '')).catch(() => '');
        throw new Error(`answered ${answer.status}${words ? `: ${words}` : ''}`);
      }
      last = { body, sentAt, reason, delivered: true };
    } catch (error) {
      const words = error instanceof Error && error.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s`
        : error instanceof Error ? (error.message === 'fetch failed' ? 'not reachable' : error.message) : String(error);
      last = { body, sentAt, reason, delivered: false, error: words };
    }
    doc = options.store.get() ?? doc;
    options.store.put({
      ...doc,
      lastPulse: last,
      ...(last.delivered ? { lastDeliveredAt: sentAt } : {}),
      ...(last.delivered && !on ? { optOutDelivered: true } : {}),
    });
    options.log?.(`[copy-pulse] ${reason}${on ? '' : ' (pulse off: the last one)'}: ${last.delivered ? 'delivered' : `not delivered (${last.error})`}`);
    return last;
  }

  /** One send at a time, in order. */
  function send(reason: CopyPulseReason): Promise<CopyPulseLast | null> {
    const run = chain.then(() => sendNow(reason), () => sendNow(reason));
    chain = run.catch(() => undefined);
    return run;
  }

  /** The minute of the hour this copy sends at, from its id: spread, and stable. */
  const minuteOf = (copyId: string) => createHash('sha256').update(copyId).digest()[0] % 60;

  function nextDaily(copyId: string, from: Date): Date {
    const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc, minuteOf(copyId)));
    return at.getTime() > from.getTime() ? at : new Date(at.getTime() + DAY_MS);
  }

  async function view(): Promise<CopyPulseView> {
    const doc = await settings();
    return {
      copyId: doc.copyId,
      contactName: doc.contactName ?? null,
      contactEmail: doc.contactEmail ?? null,
      contactFrom: doc.contactFrom ?? null,
      pulseEnabled: doc.pulseEnabled !== false,
      licenceKeepsOn: Boolean(options.licenceOn),
      sendsTo: options.url,
      lastPulse: doc.lastPulse ?? null,
      lastDeliveredAt: doc.lastDeliveredAt ?? null,
      nextDailyAt: options.url && (enabled(doc) || !doc.optOutDelivered) ? (nextDailyAt ?? nextDaily(doc.copyId, now())).toISOString() : null,
    };
  }

  /** The admin changed the contact: kept, and told to us at once. */
  async function setContact(name: unknown, email: unknown): Promise<{ ok: true; view: CopyPulseView } | { ok: false; error: string }> {
    const checked = checkContact(name, email);
    if (!checked.ok) return checked;
    const doc = await settings();
    const changed = doc.contactName !== checked.contact.name || doc.contactEmail !== checked.contact.email;
    options.store.put({ ...doc, contactName: checked.contact.name, contactEmail: checked.contact.email, contactFrom: 'admin', contactSetAt: now().toISOString() });
    if (changed) await send('contact-changed');
    return { ok: true, view: await view() };
  }

  /** The off switch. Off sends the one last pulse; on starts again at once. */
  async function setEnabled(on: boolean): Promise<CopyPulseView> {
    const doc = await settings();
    const was = doc.pulseEnabled !== false;
    options.store.put({ ...doc, pulseEnabled: on, optOutDelivered: on ? false : doc.optOutDelivered && !was });
    if (was !== on && !options.licenceOn) await send('contact-changed');
    return view();
  }

  function scheduleDaily(copyId: string) {
    nextDailyAt = nextDaily(copyId, now());
    const timer = setTimeout(() => {
      void send('daily').finally(() => scheduleDaily(copyId));
    }, Math.max(1_000, nextDailyAt.getTime() - now().getTime()));
    timer.unref?.();
    timers.push(timer);
  }

  async function start(): Promise<void> {
    if (!options.url || timers.length) return;
    const doc = await settings();
    const boot = setTimeout(() => { void send('boot'); }, options.firstPulseMs ?? FIRST_PULSE_MS);
    boot.unref?.();
    timers.push(boot);
    scheduleDaily(doc.copyId);
  }

  function stop(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  return { settings, send, view, setContact, setEnabled, start, stop, url: options.url };
}

export type CopyPulseSender = ReturnType<typeof createCopyPulse>;

/**
 * COPY_PULSE_URL: unset means ours. A URL sends elsewhere (a scratch receiver
 * in a test). There is deliberately no "off" here: the off switch is the
 * admin's, on the screen, and it sends the one last pulse that says so.
 */
export function pulseUrlFrom(value: string | undefined): string {
  const raw = (value ?? '').trim();
  try {
    const url = raw ? new URL(raw) : null;
    return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : DEFAULT_PULSE_URL;
  } catch {
    return DEFAULT_PULSE_URL;
  }
}
