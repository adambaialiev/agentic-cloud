import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { OutreachTargetRecord, OutreachTouch, OutreachWords } from '../../shared/outreach.js';
import type { OutreachStore } from '../outreach-storage.js';

/** Outreach on disk (outreach-storage.ts says what each table is for). */
export class SqliteOutreachStore implements OutreachStore {
  constructor(private readonly db: SqliteDb) {}

  async words(userId: string) {
    const row = this.db.prepare('SELECT imported_at, doc FROM outreach_words WHERE user_id = ?').get(userId) as { imported_at: string; doc: string } | undefined;
    return row ? { importedAt: row.imported_at, words: deserializeDoc<OutreachWords>(row.doc) } : null;
  }

  async setWords(userId: string, importedAt: string, words: OutreachWords) {
    this.db.prepare('INSERT INTO outreach_words (user_id, imported_at, doc) VALUES (?, ?, ?)'
      + ' ON CONFLICT(user_id) DO UPDATE SET imported_at = excluded.imported_at, doc = excluded.doc').run(userId, importedAt, serializeDoc(words));
  }

  async targets(userId: string) {
    const rows = this.db.prepare('SELECT doc FROM outreach_targets WHERE user_id = ?').all(userId) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<OutreachTargetRecord>(row.doc));
  }

  async target(userId: string, targetId: string) {
    const row = this.db.prepare('SELECT doc FROM outreach_targets WHERE user_id = ? AND target_id = ?').get(userId, targetId) as { doc: string } | undefined;
    return row ? deserializeDoc<OutreachTargetRecord>(row.doc) : null;
  }

  async putTarget(record: OutreachTargetRecord) {
    this.db.prepare('INSERT INTO outreach_targets (user_id, target_id, doc) VALUES (?, ?, ?)'
      + ' ON CONFLICT(user_id, target_id) DO UPDATE SET doc = excluded.doc').run(record.userId, record.id, serializeDoc(record));
  }

  async allTargets() {
    const rows = this.db.prepare('SELECT doc FROM outreach_targets').all() as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<OutreachTargetRecord>(row.doc));
  }

  async touches(userId: string, targetId?: string) {
    const rows = (targetId
      ? this.db.prepare('SELECT doc FROM outreach_touches WHERE user_id = ? AND target_id = ? ORDER BY at DESC, touch_id DESC').all(userId, targetId)
      : this.db.prepare('SELECT doc FROM outreach_touches WHERE user_id = ? ORDER BY at DESC, touch_id DESC').all(userId)) as Array<{ doc: string }>;
    return rows.map((row) => deserializeDoc<OutreachTouch>(row.doc));
  }

  async addTouch(userId: string, touch: OutreachTouch) {
    this.db.prepare('INSERT INTO outreach_touches (user_id, touch_id, target_id, at, doc) VALUES (?, ?, ?, ?, ?)')
      .run(userId, touch.id, touch.targetId, touch.at, serializeDoc(touch));
  }
}
