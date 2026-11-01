import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { DatabaseBucketBackup } from '../../services/database-bucket-backup.js';

/**
 * A private copy backs its database up into its own bucket (note #807): the
 * snapshot is the database's bytes, the newest `keep` stay, and the snapshot
 * file never outlives the run.
 */
function fakeBucket(initial: string[] = []) {
  const objects = new Map<string, Buffer>(initial.map((key) => [key, Buffer.from('old')]));
  const client = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
        return {};
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

async function setup(keep: number, existing: string[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dbb-'));
  const dbPath = path.join(dir, 'backend.db');
  await writeFile(dbPath, 'live');
  const bucket = fakeBucket(existing);
  const backup = new DatabaseBucketBackup({
    dbPath,
    backup: async (destination) => { await writeFile(destination, 'SQLite format 3 snapshot'); },
    bucket: { endpoint: 'https://fly.storage.tigris.dev', name: 'theirco-backups', accessKeyId: 'k', secretAccessKey: 's' },
    keep,
    client: bucket.client as never,
    now: () => new Date('2026-10-27T03:00:00.000Z'),
  });
  return { dbPath, bucket, backup };
}

describe('DatabaseBucketBackup', () => {
  it('uploads the snapshot gzipped and leaves no snapshot file behind', async () => {
    const { dbPath, bucket, backup } = await setup(14);
    const result = await backup.run();
    expect(result.key).toBe('db/backend-2026-10-27T03-00-00-000Z.db.gz');
    expect(gunzipSync(bucket.objects.get(result.key)!).toString()).toBe('SQLite format 3 snapshot');
    expect(existsSync(`${dbPath}.bucket-backup`)).toBe(false);
    expect(await readFile(dbPath, 'utf8')).toBe('live');
  });

  it('keeps the newest backups and removes the oldest beyond keep', async () => {
    const { bucket, backup } = await setup(2, [
      'db/backend-2026-10-25T03-00-00-000Z.db.gz',
      'db/backend-2026-10-26T03-00-00-000Z.db.gz',
      'db/unrelated.txt',
    ]);
    const result = await backup.run();
    expect(result.removed).toEqual(['db/backend-2026-10-25T03-00-00-000Z.db.gz']);
    expect([...bucket.objects.keys()].sort()).toEqual([
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
