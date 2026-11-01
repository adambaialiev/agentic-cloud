import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryWorkspaceNotificationStorage,
  WorkspaceNotificationService,
} from '../../services/workspace-notifications.js';
import { openSqliteDb, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteWorkspaceNotificationStorage } from '../../services/sqlite/sqlite-workspace-notifications.js';

describe('WorkspaceNotificationService', () => {
  it('commits a durable inbox row, deduplicates event retries, and isolates reads by user', async () => {
    const service = new WorkspaceNotificationService(new InMemoryWorkspaceNotificationStorage());
    const input = {
      userId: 'u1', kind: 'approval_required' as const, title: 'Approval needed',
      body: 'PR #3', url: '/workspace/decisions/pr/p3', dedupeKey: 'pr:p3',
    };
    const first = await service.notify(input);
    const retry = await service.notify({ ...input, title: 'Retry title' });
    expect(retry.notificationId).toBe(first.notificationId);
    expect((await service.list('u1')).unread).toBe(1);
    expect((await service.list('u2')).notifications).toEqual([]);
    expect(await service.markRead('u2', [first.notificationId])).toBe(0);
    expect(await service.markRead('u1', [first.notificationId])).toBe(1);
    expect((await service.list('u1')).unread).toBe(0);
  });

  it('refuses an off-origin notification click target', async () => {
    const service = new WorkspaceNotificationService(new InMemoryWorkspaceNotificationStorage());
    await expect(service.notify({
      userId: 'u', kind: 'agent_completed', title: 'Done', body: '', url: 'https://evil.example/',
    })).rejects.toThrow(/under \/workspace/);
    // A traversal resolves to an address on this origin, which is refused
    // unless the registry knows it. (One word, `/outside`, IS one now — a
    // person's page — and two, `/outside/here`, a workplace's repository,
    // public-addresses slices 5 and 6 — so the unknown shape here is three.)
    await expect(service.notify({
      userId: 'u', kind: 'agent_completed', title: 'Done', body: '', url: '/workspace/../../outside/here/now',
    })).rejects.toThrow(/under \/workspace/);
  });
});

describe('SQLite notification persistence', () => {
  let dir: string;
  let db: SqliteDb;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-notifications-'));
    db = openSqliteDb(join(dir, 'test.db'));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('persists inbox state with its source', async () => {
    const service = new WorkspaceNotificationService(new SqliteWorkspaceNotificationStorage(db));
    const note = await service.notify({
      userId: 'u1', kind: 'agent_completed', title: 'Agent finished', body: 'Open it',
      url: '/workspace/chat/a1', source: 'direct_agent_chat', dedupeKey: 'turn:1',
    });
    expect((await service.list('u1')).notifications[0]).toMatchObject({
      notificationId: note.notificationId,
      source: 'direct_agent_chat',
    });
    expect(await service.markAllRead('u1')).toBe(1);
    expect((await service.list('u1')).unread).toBe(0);
  });

  it('drops the browser push subscriptions an older installation still holds (note #477)', () => {
    // The table used to hold encrypted push endpoints. Opening the database
    // again after it exists must remove it: nothing sends to those rows.
    db.close();
    const older = openSqliteDb(join(dir, 'older.db'));
    older.exec('CREATE TABLE workspace_push_subscriptions (endpoint_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, doc TEXT NOT NULL)');
    older.prepare('INSERT INTO workspace_push_subscriptions VALUES (?, ?, ?)').run('h1', 'u1', '{}');
    older.close();
    db = openSqliteDb(join(dir, 'older.db'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_push_subscriptions'").all();
    expect(tables).toEqual([]);
  });
});
