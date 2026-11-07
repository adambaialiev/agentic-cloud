import type { SqliteDb } from './sqlite/sqlite-db.js';

/**
 * The public half of each private copy's pulse key, on OUR side (note #1057).
 * Kept the first time a copyId reaches us; after that it is the only key that
 * may speak for that copy. Only the public half: we hold nothing that could
 * sign as a copy.
 */
export interface CopyPulseKeyStore {
  get(copyId: string): Promise<string | null>;
  /**
   * Keep `publicKey` for `copyId` unless a key is already kept; return the
   * key that is kept now (the given one, or the earlier one).
   */
  register(copyId: string, publicKey: string, at: string): Promise<string>;
}

export class InMemoryCopyPulseKeyStore implements CopyPulseKeyStore {
  private readonly keys = new Map<string, string>();
  async get(copyId: string): Promise<string | null> { return this.keys.get(copyId) ?? null; }
  async register(copyId: string, publicKey: string): Promise<string> {
    if (!this.keys.has(copyId)) this.keys.set(copyId, publicKey);
    return this.keys.get(copyId)!;
  }
}

export class SqliteCopyPulseKeyStore implements CopyPulseKeyStore {
  constructor(private readonly db: SqliteDb) {}
  async get(copyId: string): Promise<string | null> {
    const row = this.db.prepare('SELECT public_key FROM copy_pulse_keys WHERE copy_id = ?').get(copyId) as { public_key: string } | undefined;
    return row?.public_key ?? null;
  }
  async register(copyId: string, publicKey: string, at: string): Promise<string> {
    // First writer wins: ON CONFLICT DO NOTHING, then read what is kept.
    this.db.prepare('INSERT INTO copy_pulse_keys (copy_id, public_key, first_seen_at) VALUES (?, ?, ?) ON CONFLICT(copy_id) DO NOTHING')
      .run(copyId, publicKey, at);
    return (await this.get(copyId))!;
  }
}
