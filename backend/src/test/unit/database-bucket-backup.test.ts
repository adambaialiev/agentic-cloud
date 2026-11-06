import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import DatabaseConstructor from 'better-sqlite3';
import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  DatabaseBucketBackup, backupKeyTime, backupsToRemove, checkSnapshot, isoWeek,
} from '../../services/database-bucket-backup.js';

/**
 * The database into a bucket (note #807), hardened for production (note
 * #1032): only a snapshot that opens, passes its integrity check and holds
 * tables is uploaded; the archive must decompress to it and the bucket must
 * hold what was sent; retention is 14 dailies + 8 weeklies, never fighting a
 * bucket lock.
 */
function fakeBucket(initial: string[] = [], opts: { shortHead?: boolean } = {}) {
  const objects = new Map<string, Buffer>(initial.map((key) => [key, Buffer.from('old')]));
  const client = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        const body = objects.get(command.input.Key!);
        return { ContentLength: body ? body.length - (opts.shortHead ? 1 : 0) : undefined };
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [...objects.keys()].filter((key) => key.startsWith(command.input.Prefix ?? '')).map((Key) => ({ Key })) };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { objects, client };
}

async function liveDb() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dbb-'));
  const dbPath = path.join(dir, 'backend.db');
  const db = new DatabaseConstructor(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, doc TEXT); CREATE TABLE orgs (id TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO users VALUES (?, ?)');
  for (let i = 0; i < 200; i++) insert.run(`u${i}`, '{}');
  return { dir, dbPath, db };
}

async function setup(keep: number, existing: string[] = [], extra: { lockDays?: number; shortHead?: boolean; backup?: (d: string) => Promise<unknown> } = {}) {
  const { dbPath, db } = await liveDb();
  const bucket = fakeBucket(existing, { shortHead: extra.shortHead });
  const backup = new DatabaseBucketBackup({
    dbPath,
    backup: extra.backup ?? ((destination) => db.backup(destination)),
    bucket: { endpoint: 'https://fly.storage.tigris.dev', name: 'theirco-backups', accessKeyId: 'k', secretAccessKey: 's' },
    keep,
    ...(extra.lockDays !== undefined ? { lockDays: extra.lockDays } : {}),
    client: bucket.client as never,
    now: () => new Date('2026-10-27T03:00:00.000Z'),
  });
  return { dbPath, db, bucket, backup };
}

describe('DatabaseBucketBackup', () => {
  it('uploads a checked snapshot gzipped, WAL rows included, and leaves no snapshot file behind', async () => {
    const { dbPath, db, bucket, backup } = await setup(14);
    const result = await backup.run();
    expect(result.key).toBe('db/backend-2026-10-27T03-00-00-000Z.db.gz');
    expect(result.tables).toBe(2);
    const restored = path.join(path.dirname(dbPath), 'restored.db');
    writeFileSync(restored, gunzipSync(bucket.objects.get(result.key)!));
    const back = new DatabaseConstructor(restored, { readonly: true });
    // 200 rows that were still only in the WAL when the backup ran.
    expect((back.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n).toBe(200);
    back.close();
    expect(existsSync(`${dbPath}.bucket-backup`)).toBe(false);
    expect((await readFile(dbPath)).length).toBeGreaterThan(0);
    db.close();
  });

  it('refuses a snapshot that is not a database, and uploads nothing', async () => {
    const { bucket, backup } = await setup(14, [], { backup: async (d) => { await writeFile(d, 'not a database at all, just bytes'); } });
    await expect(backup.run()).rejects.toThrow(/not a database|will not open/);
    expect(bucket.objects.size).toBe(0);
  });

  it('refuses an empty-but-valid database', async () => {
    const { bucket, backup } = await setup(14, [], {
      backup: async (d) => { const empty = new DatabaseConstructor(d); empty.exec('VACUUM'); empty.close(); },
    });
    await expect(backup.run()).rejects.toThrow(/no tables/);
    expect(bucket.objects.size).toBe(0);
  });

  it('fails the run when the bucket does not hold what was sent', async () => {
    const { backup } = await setup(14, [], { shortHead: true });
    await expect(backup.run()).rejects.toThrow(/bytes for db\/backend-/);
  });

  it('keeps one per day for the newest days and removes the rest beyond them', async () => {
    const { bucket, backup } = await setup(2, [
      'db/backend-2026-10-25T03-00-00-000Z.db.gz',
      'db/backend-2026-10-26T03-00-00-000Z.db.gz',
      'db/unrelated.txt',
    ]);
    const result = await backup.run();
    // 25 Oct is the third-newest day but the newest of its ISO week (W43);
    // 26 and 27 Oct are W44. So with 2 dailies + 8 weeklies, nothing goes.
    expect(result.removed).toEqual([]);
    expect([...bucket.objects.keys()].sort()).toEqual([
      'db/backend-2026-10-25T03-00-00-000Z.db.gz',
      'db/backend-2026-10-26T03-00-00-000Z.db.gz',
      'db/backend-2026-10-27T03-00-00-000Z.db.gz',
      'db/unrelated.txt',
    ]);
  });

  it('refuses to keep nothing', () => {
    expect(() => new DatabaseBucketBackup({
      dbPath: '/x', backup: async () => {}, keep: 0,
      bucket: { endpoint: 'e', name: 'b', accessKeyId: 'k', secretAccessKey: 's' },
    })).toThrow();
  });
});

describe('retention', () => {
  const key = (iso: string) => `db/backend-${iso.replace(/[:.]/g, '-')}.db.gz`;
  const now = new Date('2026-11-06T18:00:00.000Z');
  // Every 6 hours for 70 days back from now.
  const keys: string[] = [];
  for (let t = now.getTime(); t > now.getTime() - 70 * 86_400_000; t -= 6 * 3_600_000) keys.push(key(new Date(t).toISOString()));

  it('keeps the newest of each of 14 days and of each of 8 ISO weeks, and nothing else', () => {
    const removed = new Set(backupsToRemove(keys, { keepDaily: 14, keepWeekly: 8, lockDays: 0, now }));
    const kept = keys.filter((k) => !removed.has(k));
    const days = new Set(kept.map((k) => backupKeyTime(k)!.toISOString().slice(0, 10)));
    const weeks = new Set(kept.map((k) => isoWeek(backupKeyTime(k)!)));
    expect(kept).toContain(keys[0]);
    expect(days.size).toBe(kept.length); // never two of one day
    expect(kept.length).toBeLessThanOrEqual(14 + 8);
    expect(weeks.size).toBeGreaterThanOrEqual(8);
  });

  it('never tries to delete what a 30-day bucket lock still holds', () => {
    const removed = backupsToRemove(keys, { keepDaily: 14, keepWeekly: 8, lockDays: 30, now });
    for (const k of removed) expect(now.getTime() - backupKeyTime(k)!.getTime()).toBeGreaterThan(30 * 86_400_000);
  });

  it('never removes the only backup, and ignores keys that are not ours', () => {
    expect(backupsToRemove([key('2025-01-01T00:00:00.000Z'), 'db/hand-made.db.gz'], { keepDaily: 1, keepWeekly: 0, lockDays: 0, now })).toEqual([]);
  });

  it('names ISO weeks the way the calendar does', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2026-11-06T00:00:00Z'))).toBe('2026-W45');
  });
});

describe('checkSnapshot', () => {
  it('counts user tables and passes a sound database', async () => {
    const { dbPath, db } = await liveDb();
    const copy = `${dbPath}.copy`;
    await db.backup(copy);
    expect(checkSnapshot(copy)).toEqual({ tables: 2 });
    db.close();
  });
});
