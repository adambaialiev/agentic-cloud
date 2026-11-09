import { createHash, randomBytes } from 'node:crypto';
import type { SqliteDb } from './sqlite/sqlite-db.js';

/**
 * The Outreach site's pass (note #1093). Outreach is its own site, and the
 * platform's sign-in is a `__Host-` cookie no other site can read, so the
 * owner signs in HERE as usual and is sent back to the site with a pass:
 *
 *   - minted only by the pass door, only for the platform operator's live
 *     session, and only towards the one site origin this backend knows;
 *   - good for the Outreach routes and nothing else, for at most
 *     `OUTREACH_PASS_HOURS`, and never past the sign-in it was given to —
 *     signing out of the platform ends it too;
 *   - kept here as a hash; the key itself exists only in the owner's
 *     browser. No agent holds one and no secret carries one, which is the
 *     point: nothing but his own press, in his own signed-in browser, sends
 *     a letter as him from the site.
 */
export const OUTREACH_PASS_HOURS = 12;

export interface OutreachPassRecord {
  userId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
}

export interface OutreachPassStore {
  put(tokenHash: string, record: OutreachPassRecord): Promise<void>;
  get(tokenHash: string): Promise<OutreachPassRecord | null>;
  drop(tokenHash: string): Promise<void>;
  /** Forget passes past their hour. */
  sweep(now: string): Promise<void>;
}

export class InMemoryOutreachPassStore implements OutreachPassStore {
  private readonly rows = new Map<string, OutreachPassRecord>();
  async put(tokenHash: string, record: OutreachPassRecord) { this.rows.set(tokenHash, { ...record }); }
  async get(tokenHash: string) { const row = this.rows.get(tokenHash); return row ? { ...row } : null; }
  async drop(tokenHash: string) { this.rows.delete(tokenHash); }
  async sweep(now: string) { for (const [hash, row] of this.rows) if (row.expiresAt <= now) this.rows.delete(hash); }
}

export class SqliteOutreachPassStore implements OutreachPassStore {
  constructor(private readonly db: SqliteDb) {}
  async put(tokenHash: string, record: OutreachPassRecord) {
    this.db.prepare('INSERT INTO outreach_passes (token_hash, user_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, record.userId, record.sessionId, record.createdAt, record.expiresAt);
  }
  async get(tokenHash: string) {
    const row = this.db.prepare('SELECT user_id, session_id, created_at, expires_at FROM outreach_passes WHERE token_hash = ?').get(tokenHash) as
      { user_id: string; session_id: string; created_at: string; expires_at: string } | undefined;
    return row ? { userId: row.user_id, sessionId: row.session_id, createdAt: row.created_at, expiresAt: row.expires_at } : null;
  }
  async drop(tokenHash: string) { this.db.prepare('DELETE FROM outreach_passes WHERE token_hash = ?').run(tokenHash); }
  async sweep(now: string) { this.db.prepare('DELETE FROM outreach_passes WHERE expires_at <= ?').run(now); }
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

export class OutreachPasses {
  private readonly now: () => Date;
  constructor(private readonly store: OutreachPassStore, now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  /** A new pass for this live sign-in, ending at its hour or the sign-in's own end, whichever is first. */
  async mint(userId: string, session: { sessionId: string; absoluteExpiresAt: string }): Promise<{ token: string; expiresAt: string }> {
    const now = this.now();
    await this.store.sweep(now.toISOString()).catch(() => undefined);
    const token = `op_${randomBytes(32).toString('base64url')}`;
    const ends = Math.min(now.getTime() + OUTREACH_PASS_HOURS * 3_600_000, Date.parse(session.absoluteExpiresAt) || Infinity);
    const expiresAt = new Date(ends).toISOString();
    await this.store.put(hashOf(token), { userId, sessionId: session.sessionId, createdAt: now.toISOString(), expiresAt });
    return { token, expiresAt };
  }

  /** Who a pass belongs to, while it is good. The caller also checks the sign-in is still live. */
  async read(token: string | null | undefined): Promise<OutreachPassRecord | null> {
    if (!token || !/^op_[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    const record = await this.store.get(hashOf(token));
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.store.drop(hashOf(token)).catch(() => undefined);
      return null;
    }
    return record;
  }

  async end(token: string | null | undefined): Promise<void> {
    if (token) await this.store.drop(hashOf(token));
  }
}

/** The pass from `Authorization: Bearer op_…`, or null. */
export function outreachPassFrom(header: string | undefined): string | null {
  const match = /^Bearer\s+(op_[A-Za-z0-9_-]+)$/.exec(header?.trim() ?? '');
  return match ? match[1]! : null;
}

/**
 * Where the pass door may send a pass: the site's own origin, and a path on
 * it. Anything else — another host, a scheme trick, a userinfo part — is
 * refused, so a pass is never handed to a page that is not the site.
 */
export function outreachReturnTo(raw: unknown, siteOrigin: string): string | null {
  if (typeof raw !== 'string' || !raw) return `${siteOrigin}/`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== siteOrigin || url.username || url.password) return null;
  return `${url.origin}${url.pathname}${url.search}`;
}
