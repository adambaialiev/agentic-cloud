import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';

/**
 * Outreach's old tables go (note #1178; Adam, 16 Nov 2026: "yes delete old
 * copies"). Outreach has its own app and store since 13 Nov 2026; the final
 * copy of these tables is archived in that app's private bucket. Opening a
 * database that still holds them drops them, and touches nothing else.
 */
describe('Outreach\'s old tables (note #1178)', () => {
  it('are dropped on open, with their index; everything else stays', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'retired-outreach-')), 'backend.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE outreach_targets (user_id TEXT, target_id TEXT, doc TEXT);
      CREATE TABLE outreach_touches (user_id TEXT, touch_id TEXT, target_id TEXT, at TEXT, doc TEXT);
      CREATE INDEX outreach_touches_by_target ON outreach_touches (user_id, target_id, at);
      CREATE TABLE outreach_words (user_id TEXT, imported_at TEXT, doc TEXT);
      CREATE TABLE outreach_passes (token_hash TEXT, user_id TEXT, session_id TEXT, created_at TEXT, expires_at TEXT);
      INSERT INTO outreach_targets VALUES ('u', 'northwind-health', '{}');
      CREATE TABLE kept_by_someone_else (x TEXT);
      INSERT INTO kept_by_someone_else VALUES ('still here');
    `);
    raw.close();
    const db = openSqliteDb(file);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'outreach%'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual([]);
    expect(db.prepare('SELECT x FROM kept_by_someone_else').get()).toEqual({ x: 'still here' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_mails'").get()).toEqual({ name: 'app_mails' });
    db.close();
    // A second open finds nothing to drop and does not fail.
    openSqliteDb(file).close();
  });
});
