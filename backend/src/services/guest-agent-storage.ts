/**
 * What the platform keeps about guests' agents (note #1038): one row per
 * agent — one being built, a live one, or a removed one kept as the owner's
 * transcript for 90 days — and the switch that says whose workplace they
 * are made in. Beyond what they typed, the only thing kept about a visitor
 * is where they came from (note #1139): Cloudflare's two-letter country, the
 * utm tags of the link they followed and the referring site's host. No
 * address, no city, no user agent; their key only as a SHA-256, dropped a
 * day after the agent goes.
 */
import type { SqliteDb } from './sqlite/sqlite-db.js';
import { GUEST_AGENT_LIMITS, type GuestArrival, type GuestCreateStep, type GuestRemovedReason, type GuestTranscriptRecord } from '../shared/guest-agent.js';

/** `preparing` and `spare` are from before note #1055 (no spares now): the sweeper retires any it finds. */
export type GuestAgentPhase = 'preparing' | 'spare' | 'creating' | 'live' | 'removing' | 'removed';

/** One guest agent, from the moment its record is reserved. */
export interface GuestAgentRow {
  agentId: string;
  /** Owner (the workplace's admin who switched guests on) and workplace. */
  userId: string;
  orgId: string | null;
  phase: GuestAgentPhase;
  /** SHA-256 of the visitor's key while claimed (and a day after removal). */
  keyHash: string | null;
  /** When its record was reserved, and when a visitor claimed it (the same moment since note #1055). */
  preparedAt: string;
  claimedAt: string | null;
  /** Claimed from a ready spare: only rows from before note #1055, when spares existed. */
  fromSpare?: boolean;
  /** The last message or end of a turn: the quiet clock starts here. */
  lastActiveAt: string | null;
  messagesUsed: number;
  claudeSessionId: string | null;
  /** The build's five steps with their times (note #1055); older rows may hold the four old ones. */
  steps: Array<GuestCreateStep | { id: string; done: boolean; startedAt?: string | null; doneAt?: string | null }> | null;
  removedAt: string | null;
  removedReason: GuestRemovedReason | null;
  /** Background jobs this agent started (note #1063), newest last. */
  jobs?: GuestJobRecord[];
  /** Where its visitor came from (note #1139); absent on rows made before. Never given to the agent. */
  arrival?: GuestArrival;
  /** The visitor-facing conversation and the owner's transcript, one record. */
  transcript: GuestTranscriptRecord;
}

/** One background job of a guest's (note #1063), as the backend knows it. */
export interface GuestJobRecord {
  id: string;
  label: string;
  startedAt: string;
  timeoutMs: number;
  quiet: boolean;
  state: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'stopped' | 'interrupted';
  exitCode: number | null;
  finishedAt: string | null;
  /** A bounded, redacted tail of its output, kept for the receipt. */
  tail?: string;
  /** Its receipt has gone into a turn (or it never needs one). */
  announced?: boolean;
}

/** The switch: guests are made in this owner's workplace, or not at all. */
export interface GuestAgentSettings {
  enabled: boolean;
  userId: string;
  orgId: string | null;
  changedAt: string;
}

export interface GuestAgentStorage {
  get(agentId: string): Promise<GuestAgentRow | null>;
  put(row: GuestAgentRow): Promise<void>;
  byKeyHash(keyHash: string): Promise<GuestAgentRow | null>;
  /** Rows in these phases, oldest first. */
  listByPhase(phases: readonly GuestAgentPhase[]): Promise<GuestAgentRow[]>;
  /** Removed rows, newest first. */
  listRemoved(limit: number): Promise<GuestAgentRow[]>;
  /** Agents claimed by a visitor since this moment (the daily cap). */
  countClaimedSince(sinceMs: number): Promise<number>;
  /** Drops keys of agents removed before this moment, and rows prepared before the transcript cutoff. */
  prune(keyBeforeMs: number, rowBeforeMs: number): Promise<number>;
  getSettings(): Promise<GuestAgentSettings | null>;
  setSettings(settings: GuestAgentSettings): Promise<void>;
}

export function guestTranscriptCutoffMs(now = Date.now()): number {
  return now - GUEST_AGENT_LIMITS.transcriptDays * 24 * 60 * 60 * 1000;
}

export const GUEST_AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS guest_agents (
  agent_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  key_hash TEXT,
  prepared_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  removed_at_ms INTEGER,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guest_agents_by_phase ON guest_agents (phase, prepared_at_ms);
CREATE INDEX IF NOT EXISTS guest_agents_by_key ON guest_agents (key_hash);
CREATE INDEX IF NOT EXISTS guest_agents_by_claim ON guest_agents (claimed_at_ms);
CREATE TABLE IF NOT EXISTS guest_agent_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL
);
`;

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

export class InMemoryGuestAgentStorage implements GuestAgentStorage {
  private readonly rows = new Map<string, GuestAgentRow>();
  private settings: GuestAgentSettings | null = null;
  async get(agentId: string) { const r = this.rows.get(agentId); return r ? structuredClone(r) : null; }
  async put(row: GuestAgentRow) { this.rows.set(row.agentId, structuredClone(row)); }
  async byKeyHash(keyHash: string) {
    const all = [...this.rows.values()].filter((r) => r.keyHash === keyHash).sort((a, b) => (b.claimedAt ?? '').localeCompare(a.claimedAt ?? ''));
    return all[0] ? structuredClone(all[0]) : null;
  }
  async listByPhase(phases: readonly GuestAgentPhase[]) {
    return [...this.rows.values()].filter((r) => phases.includes(r.phase))
      .sort((a, b) => a.preparedAt.localeCompare(b.preparedAt)).map((r) => structuredClone(r));
  }
  async listRemoved(limit: number) {
    return [...this.rows.values()].filter((r) => r.phase === 'removed')
      .sort((a, b) => (b.removedAt ?? '').localeCompare(a.removedAt ?? '')).slice(0, limit).map((r) => structuredClone(r));
  }
  async countClaimedSince(sinceMs: number) {
    return [...this.rows.values()].filter((r) => r.claimedAt && Date.parse(r.claimedAt) >= sinceMs).length;
  }
  async prune(keyBeforeMs: number, rowBeforeMs: number) {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.phase === 'removed' && Date.parse(r.preparedAt) < rowBeforeMs) { this.rows.delete(id); n++; continue; }
      if (r.phase === 'removed' && r.keyHash && r.removedAt && Date.parse(r.removedAt) < keyBeforeMs) r.keyHash = null;
    }
    return n;
  }
  async getSettings() { return this.settings ? { ...this.settings } : null; }
  async setSettings(settings: GuestAgentSettings) { this.settings = { ...settings }; }
}

export class SqliteGuestAgentStorage implements GuestAgentStorage {
  constructor(private readonly db: SqliteDb) {
    db.exec(GUEST_AGENT_SCHEMA);
  }

  private parse(row: { doc: string } | undefined): GuestAgentRow | null {
    return row ? JSON.parse(row.doc) as GuestAgentRow : null;
  }

  async get(agentId: string) {
    return this.parse(this.db.prepare('SELECT doc FROM guest_agents WHERE agent_id = ?').get(agentId) as { doc: string } | undefined);
  }

  async put(row: GuestAgentRow) {
    this.db.prepare(
      'INSERT INTO guest_agents (agent_id, phase, key_hash, prepared_at_ms, claimed_at_ms, removed_at_ms, doc) VALUES (?, ?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(agent_id) DO UPDATE SET phase = excluded.phase, key_hash = excluded.key_hash, claimed_at_ms = excluded.claimed_at_ms,'
      + ' removed_at_ms = excluded.removed_at_ms, doc = excluded.doc',
    ).run(row.agentId, row.phase, row.keyHash, Date.parse(row.preparedAt), ms(row.claimedAt), ms(row.removedAt), JSON.stringify(row));
  }

  async byKeyHash(keyHash: string) {
    return this.parse(this.db.prepare('SELECT doc FROM guest_agents WHERE key_hash = ? ORDER BY claimed_at_ms DESC LIMIT 1').get(keyHash) as { doc: string } | undefined);
  }

  async listByPhase(phases: readonly GuestAgentPhase[]) {
    if (!phases.length) return [];
    const rows = this.db.prepare(
      `SELECT doc FROM guest_agents WHERE phase IN (${phases.map(() => '?').join(', ')}) ORDER BY prepared_at_ms ASC`,
    ).all(...phases) as Array<{ doc: string }>;
    return rows.map((r) => JSON.parse(r.doc) as GuestAgentRow);
  }

  async listRemoved(limit: number) {
    const rows = this.db.prepare("SELECT doc FROM guest_agents WHERE phase = 'removed' ORDER BY removed_at_ms DESC LIMIT ?").all(limit) as Array<{ doc: string }>;
    return rows.map((r) => JSON.parse(r.doc) as GuestAgentRow);
  }

  async countClaimedSince(sinceMs: number) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM guest_agents WHERE claimed_at_ms >= ?').get(sinceMs) as { n: number };
    return row.n;
  }

  async prune(keyBeforeMs: number, rowBeforeMs: number) {
    let removed = 0;
    this.db.transaction(() => {
      removed = this.db.prepare("DELETE FROM guest_agents WHERE phase = 'removed' AND prepared_at_ms < ?").run(rowBeforeMs).changes;
      const stale = this.db.prepare("SELECT doc FROM guest_agents WHERE phase = 'removed' AND key_hash IS NOT NULL AND removed_at_ms < ?").all(keyBeforeMs) as Array<{ doc: string }>;
      for (const r of stale) {
        const row = JSON.parse(r.doc) as GuestAgentRow;
        row.keyHash = null;
        this.db.prepare('UPDATE guest_agents SET key_hash = NULL, doc = ? WHERE agent_id = ?').run(JSON.stringify(row), row.agentId);
      }
    })();
    return removed;
  }

  async getSettings() {
    const row = this.db.prepare('SELECT doc FROM guest_agent_settings WHERE id = 1').get() as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as GuestAgentSettings : null;
  }

  async setSettings(settings: GuestAgentSettings) {
    this.db.prepare('INSERT INTO guest_agent_settings (id, doc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc').run(JSON.stringify(settings));
  }
}
