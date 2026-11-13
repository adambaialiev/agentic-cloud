import { createHash, randomBytes } from 'node:crypto';
import type { SqliteDb } from './sqlite/sqlite-db.js';
import type { MailAllowance } from './mail-outbox.js';

/**
 * The platform's doors for a workplace's own APP (note #1178).
 *
 * An app here is a site a workplace runs on our hosting (`<site>.agentbuilt.app`).
 * Some of what such an app may want is the platform's alone and cannot move
 * into it: who is signed in, the person's own mailbox, what the mail provider
 * says about a letter, and what the platform sees arrive (a reply, a guest
 * who came by a tagged link, a private copy reporting in). These doors hand
 * exactly that to the app, for ONE site, with a credential that names it:
 *
 * - a PASS (`ap_…`): a person, minted at their live sign-in by a top-level
 *   visit, sent back to the site in the address's fragment; 12 hours at most
 *   and never past the sign-in it was given to;
 * - an agent PROOF (`sp_…`): an agent, minted with its own agent token
 *   (`agentbuilt app-proof <site>`), 15 minutes. A site checks one by asking
 *   `GET /workspace/api/apps/me` with it.
 *
 * Only a pass sends mail or reads a sent letter's words: an agent never can,
 * and no key anywhere can send as a person (note #527).
 *
 * Who may use them: the platform operator only, for now (Adam, 13 Nov 2026,
 * note #1178: "build them general, switch them on for the operator first").
 * The one switch is `appDoorsOpenFor` in routes/app-doors.ts.
 *
 * The first app is the Outreach site, which moved out of this repository in
 * note #1178; nothing here knows its words.
 */

export const APP_PASS_HOURS = 12;
export const APP_PROOF_MINUTES = 15;
/** How long the feed keeps an event. */
export const APP_FEED_DAYS = 180;
/** How many events one read of the feed answers with at most. */
export const APP_FEED_PAGE = 500;
/**
 * An app's own sending ceilings, narrower than a person's inbox (note #1111):
 * 50 new letters an hour, 60 a day, 50 follow-ups an hour.
 */
export const APP_MAIL_ALLOWANCE: MailAllowance = { newPerHour: 50, newPerDay: 60, repliesPerHour: 50 };

export type AppCredentialKind = 'person' | 'agent';

export interface AppCredentialRecord {
  kind: AppCredentialKind;
  userId: string;
  site: string;
  /** A pass: the sign-in it dies with. */
  sessionId: string | null;
  /** A proof: the agent that asked for it. */
  agentId: string | null;
  agentName: string | null;
  createdAt: string;
  expiresAt: string;
}

/** A letter an app sent from a person's mailbox, so its later facts and its thread are the app's to read. */
export interface AppMailRecord {
  userId: string;
  site: string;
  mailId: string;
  providerId: string | null;
  at: string;
}

export type AppFeedKind = 'mail-event' | 'arrival' | 'guest';

export interface AppFeedEvent {
  seq: number;
  kind: AppFeedKind;
  at: string;
  /** For a `mail-event`: the site whose letter it is. Other kinds belong to every site of the person. */
  site: string | null;
  [field: string]: unknown;
}

export interface AppDoorStore {
  putCredential(hash: string, record: AppCredentialRecord): Promise<void>;
  getCredential(hash: string): Promise<AppCredentialRecord | null>;
  dropCredential(hash: string): Promise<void>;
  sweepCredentials(now: string): Promise<void>;
  /** Once per mail: a second write of the same mail changes nothing. */
  putMail(record: AppMailRecord): Promise<void>;
  getMail(userId: string, mailId: string): Promise<AppMailRecord | null>;
  mailByProvider(providerId: string): Promise<AppMailRecord | null>;
  addEvent(userId: string, event: Omit<AppFeedEvent, 'seq'>): Promise<number>;
  events(userId: string, after: number, limit: number): Promise<AppFeedEvent[]>;
  sweepEvents(before: string): Promise<void>;
}

export class InMemoryAppDoorStore implements AppDoorStore {
  private readonly credentials = new Map<string, AppCredentialRecord>();
  private readonly mails = new Map<string, AppMailRecord>();
  private readonly feed: Array<{ userId: string; event: AppFeedEvent }> = [];
  private seq = 0;
  async putCredential(hash: string, record: AppCredentialRecord) { this.credentials.set(hash, { ...record }); }
  async getCredential(hash: string) { const row = this.credentials.get(hash); return row ? { ...row } : null; }
  async dropCredential(hash: string) { this.credentials.delete(hash); }
  async sweepCredentials(now: string) { for (const [hash, row] of this.credentials) if (row.expiresAt <= now) this.credentials.delete(hash); }
  async putMail(record: AppMailRecord) {
    const key = `${record.userId}\u0000${record.mailId}`;
    if (!this.mails.has(key)) this.mails.set(key, { ...record });
  }
  async getMail(userId: string, mailId: string) { const row = this.mails.get(`${userId}\u0000${mailId}`); return row ? { ...row } : null; }
  async mailByProvider(providerId: string) { for (const row of this.mails.values()) if (row.providerId === providerId) return { ...row }; return null; }
  async addEvent(userId: string, event: Omit<AppFeedEvent, 'seq'>) {
    this.seq += 1;
    this.feed.push({ userId, event: { ...event, seq: this.seq } as AppFeedEvent });
    return this.seq;
  }
  async events(userId: string, after: number, limit: number) {
    return this.feed.filter((row) => row.userId === userId && row.event.seq > after).slice(0, limit).map((row) => ({ ...row.event }));
  }
  async sweepEvents(before: string) {
    for (let i = this.feed.length - 1; i >= 0; i -= 1) if (this.feed[i]!.event.at < before) this.feed.splice(i, 1);
  }
}

export class SqliteAppDoorStore implements AppDoorStore {
  constructor(private readonly db: SqliteDb) {}
  async putCredential(hash: string, r: AppCredentialRecord) {
    this.db.prepare('INSERT INTO app_credentials (token_hash, kind, user_id, site, session_id, agent_id, agent_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(hash, r.kind, r.userId, r.site, r.sessionId, r.agentId, r.agentName, r.createdAt, r.expiresAt);
  }
  async getCredential(hash: string) {
    const row = this.db.prepare('SELECT kind, user_id, site, session_id, agent_id, agent_name, created_at, expires_at FROM app_credentials WHERE token_hash = ?').get(hash) as
      { kind: AppCredentialKind; user_id: string; site: string; session_id: string | null; agent_id: string | null; agent_name: string | null; created_at: string; expires_at: string } | undefined;
    return row ? {
      kind: row.kind, userId: row.user_id, site: row.site, sessionId: row.session_id, agentId: row.agent_id, agentName: row.agent_name,
      createdAt: row.created_at, expiresAt: row.expires_at,
    } : null;
  }
  async dropCredential(hash: string) { this.db.prepare('DELETE FROM app_credentials WHERE token_hash = ?').run(hash); }
  async sweepCredentials(now: string) { this.db.prepare('DELETE FROM app_credentials WHERE expires_at <= ?').run(now); }
  async putMail(r: AppMailRecord) {
    this.db.prepare('INSERT OR IGNORE INTO app_mails (user_id, mail_id, site, provider_id, at) VALUES (?, ?, ?, ?, ?)').run(r.userId, r.mailId, r.site, r.providerId, r.at);
  }
  private static mail(row: { user_id: string; mail_id: string; site: string; provider_id: string | null; at: string } | undefined): AppMailRecord | null {
    return row ? { userId: row.user_id, mailId: row.mail_id, site: row.site, providerId: row.provider_id, at: row.at } : null;
  }
  async getMail(userId: string, mailId: string) {
    return SqliteAppDoorStore.mail(this.db.prepare('SELECT * FROM app_mails WHERE user_id = ? AND mail_id = ?').get(userId, mailId) as never);
  }
  async mailByProvider(providerId: string) {
    return SqliteAppDoorStore.mail(this.db.prepare('SELECT * FROM app_mails WHERE provider_id = ? LIMIT 1').get(providerId) as never);
  }
  async addEvent(userId: string, event: Omit<AppFeedEvent, 'seq'>) {
    const info = this.db.prepare('INSERT INTO app_feed (user_id, at, doc) VALUES (?, ?, ?)').run(userId, event.at, JSON.stringify(event));
    return Number(info.lastInsertRowid);
  }
  async events(userId: string, after: number, limit: number) {
    const rows = this.db.prepare('SELECT seq, doc FROM app_feed WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(userId, after, limit) as Array<{ seq: number; doc: string }>;
    return rows.map((row) => ({ ...(JSON.parse(row.doc) as Omit<AppFeedEvent, 'seq'>), seq: row.seq }) as AppFeedEvent);
  }
  async sweepEvents(before: string) { this.db.prepare('DELETE FROM app_feed WHERE at < ?').run(before); }
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKEN = /^(ap|sp)_[A-Za-z0-9_-]{40,60}$/;

/** The credential in `Authorization: Bearer …`, or null. */
export function appCredentialFrom(header: string | undefined): string | null {
  const match = /^Bearer\s+((?:ap|sp)_[A-Za-z0-9_-]+)$/.exec(header?.trim() ?? '');
  return match ? match[1]! : null;
}

/** A site's name as the hosting writes it: lower-case letters, digits and hyphens. */
export function appSiteName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : null;
}

/** The address a pass may be sent back to: on the site's own origin, nowhere else. */
export function appReturnTo(raw: unknown, siteOrigin: string): string | null {
  if (typeof raw !== 'string' || !raw) return `${siteOrigin}/`;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== siteOrigin || url.username || url.password) return null;
  return `${url.origin}${url.pathname}${url.search}`;
}

export interface AppMailEventInput {
  eventId: string;
  event: string;
  providerId: string;
  at: string;
  to: string[];
  subject: string;
  detail?: string | null;
  permanent?: boolean;
}

export class AppDoors {
  private readonly now: () => Date;
  constructor(private readonly store: AppDoorStore, now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  private async mint(record: Omit<AppCredentialRecord, 'createdAt' | 'expiresAt'>, prefix: 'ap' | 'sp', ends: number): Promise<{ token: string; expiresAt: string }> {
    const now = this.now();
    await this.store.sweepCredentials(now.toISOString()).catch(() => undefined);
    const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(ends).toISOString();
    await this.store.putCredential(hashOf(token), { ...record, createdAt: now.toISOString(), expiresAt });
    return { token, expiresAt };
  }

  /** A person's pass for one site, never outliving their sign-in. */
  async mintPass(userId: string, site: string, session: { sessionId: string; absoluteExpiresAt: string }) {
    const ends = Math.min(this.now().getTime() + APP_PASS_HOURS * 3_600_000, Date.parse(session.absoluteExpiresAt) || Infinity);
    return this.mint({ kind: 'person', userId, site, sessionId: session.sessionId, agentId: null, agentName: null }, 'ap', ends);
  }

  /** An agent's proof for one site; its owner is the person it acts for. */
  async mintProof(userId: string, site: string, agent: { agentId: string; name: string }) {
    return this.mint({ kind: 'agent', userId, site, sessionId: null, agentId: agent.agentId, agentName: agent.name }, 'sp', this.now().getTime() + APP_PROOF_MINUTES * 60_000);
  }

  async read(token: string | null | undefined): Promise<AppCredentialRecord | null> {
    if (!token || !TOKEN.test(token)) return null;
    const record = await this.store.getCredential(hashOf(token));
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.store.dropCredential(hashOf(token)).catch(() => undefined);
      return null;
    }
    return record;
  }

  async end(token: string | null | undefined): Promise<void> {
    if (token) await this.store.dropCredential(hashOf(token));
  }

  /** The app sent this letter: its facts and its thread are now the app's to read. */
  async sent(record: AppMailRecord): Promise<void> {
    await this.store.putMail(record);
  }

  /** The letter, when this site sent it; else null. */
  async mailOf(userId: string, site: string, mailId: string): Promise<AppMailRecord | null> {
    const row = await this.store.getMail(userId, mailId);
    return row && row.site === site ? row : null;
  }

  /** The mail provider's word on a letter. Recorded when an app sent it; anybody else's mail is not kept. */
  async noteMailEvent(input: AppMailEventInput): Promise<boolean> {
    const mail = await this.store.mailByProvider(input.providerId);
    if (!mail) return false;
    const seen = await this.store.events(mail.userId, 0, Number.MAX_SAFE_INTEGER);
    if (seen.some((one) => one.kind === 'mail-event' && one.eventId === input.eventId)) return true;
    await this.store.addEvent(mail.userId, {
      kind: 'mail-event', at: input.at, site: mail.site, mailId: mail.mailId, providerId: input.providerId, eventId: input.eventId,
      event: input.event, to: input.to, subject: input.subject,
      ...(input.detail ? { detail: input.detail } : {}), ...(input.permanent === false ? { permanent: false } : {}),
    });
    return true;
  }

  /** A letter arrived in this person's inbox: who from and about what, never its words. */
  async noteArrival(userId: string, arrival: { id: string; from?: string; answerTo?: string; subject: string; receivedAt: string }, suspicious: boolean): Promise<void> {
    await this.store.addEvent(userId, {
      kind: 'arrival', at: arrival.receivedAt, site: null, mailId: arrival.id, from: arrival.from ?? null, answerTo: arrival.answerTo ?? null,
      subject: arrival.subject.slice(0, 200), ...(suspicious ? { suspicious: true } : {}),
    });
  }

  /** A guest agent started by somebody who came by a tagged link. */
  async noteGuest(userId: string, guest: { agentId: string; name: string; country: string | null; utm: Record<string, string> }): Promise<void> {
    await this.store.addEvent(userId, { kind: 'guest', at: this.now().toISOString(), site: null, agentId: guest.agentId, name: guest.name, country: guest.country, utm: guest.utm });
  }

  /** What happened since `after`, for one site: its own letters' facts, and the person's arrivals and guests. */
  async feed(userId: string, site: string, after: number): Promise<{ events: AppFeedEvent[]; last: number }> {
    await this.store.sweepEvents(new Date(this.now().getTime() - APP_FEED_DAYS * 86_400_000).toISOString()).catch(() => undefined);
    let cursor = after;
    const events: AppFeedEvent[] = [];
    // Another site's letters are skipped, not counted against the page.
    for (;;) {
      const page = await this.store.events(userId, cursor, APP_FEED_PAGE);
      for (const event of page) {
        cursor = event.seq;
        if (event.kind === 'mail-event' && event.site !== site) continue;
        events.push(event);
        if (events.length === APP_FEED_PAGE) return { events, last: cursor };
      }
      if (page.length < APP_FEED_PAGE) return { events, last: cursor };
    }
  }
}
