import { describe, expect, it } from 'vitest';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { MediaBucketMirror } from '../../services/media-bucket-mirror.js';

/** The platform's media, copied add-only into the off-Fly backups bucket (note #1032). */
function bucket(initial: Record<string, string> = {}, opts: { refusePut?: (key: string) => boolean; pageSize?: number } = {}) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const puts: string[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        const keys = [...objects.keys()].filter((k) => k.startsWith(command.input.Prefix ?? '')).sort();
        const start = Number(command.input.ContinuationToken ?? 0);
        const size = opts.pageSize ?? 1000;
        const page = keys.slice(start, start + size);
        return {
          Contents: page.map((Key) => ({ Key, Size: objects.get(Key)!.length })),
          IsTruncated: start + size < keys.length,
          NextContinuationToken: String(start + size),
        };
      }
      if (command instanceof GetObjectCommand) {
        const body = objects.get(command.input.Key!)!;
        return { Body: { transformToByteArray: async () => new Uint8Array(body) }, ContentType: 'image/png' };
      }
      if (command instanceof PutObjectCommand) {
        if (opts.refusePut?.(command.input.Key!)) throw new Error('AccessDenied: object is locked');
        objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
        puts.push(command.input.Key!);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { objects, client, puts };
}

const cfg = { endpoint: 'e', name: 'n', accessKeyId: 'k', secretAccessKey: 's' };

describe('MediaBucketMirror', () => {
  it('copies what is missing, across pages, and nothing twice', async () => {
    const source = bucket({ 'users/a/1.png': 'one', 'users/a/2.png': 'two', 'users/b/3.png': 'three' }, { pageSize: 2 });
    const target = bucket({ 'media/users/a/1.png': 'one', 'db/x.db.gz': 'db' });
    const mirror = new MediaBucketMirror({ source: cfg, target: cfg, sourceClient: source.client as never, targetClient: target.client as never });
    const first = await mirror.run();
    expect(first).toMatchObject({ sourceObjects: 3, copied: 2, failed: [] });
    expect(target.puts.sort()).toEqual(['media/users/a/2.png', 'media/users/b/3.png']);
    const second = await mirror.run();
    expect(second.copied).toBe(0);
  });

  it('never deletes what the source no longer has', async () => {
    const source = bucket({});
    const target = bucket({ 'media/users/gone.png': 'kept' });
    const mirror = new MediaBucketMirror({ source: cfg, target: cfg, sourceClient: source.client as never, targetClient: target.client as never });
    await mirror.run();
    expect(target.objects.has('media/users/gone.png')).toBe(true);
  });

  it('reports a refused overwrite and keeps going', async () => {
    const source = bucket({ 'users/a/1.png': 'changed!', 'users/a/2.png': 'two' });
    const target = bucket({ 'media/users/a/1.png': 'one' }, { refusePut: (k) => k === 'media/users/a/1.png' });
    const records: Array<[string, string]> = [];
    const mirror = new MediaBucketMirror({
      source: cfg, target: cfg, sourceClient: source.client as never, targetClient: target.client as never,
      record: (status, detail) => records.push([status, detail]),
    });
    const result = await mirror.run();
    expect(result.copied).toBe(1);
    expect(result.failed).toEqual([{ key: 'users/a/1.png', error: 'AccessDenied: object is locked' }]);
  });

  it('skips objects over the size limit', async () => {
    const source = bucket({ 'users/big.bin': 'x'.repeat(50) });
    const target = bucket({});
    const mirror = new MediaBucketMirror({ source: cfg, target: cfg, maxObjectBytes: 10, sourceClient: source.client as never, targetClient: target.client as never });
    expect((await mirror.run()).skippedTooLarge).toEqual(['users/big.bin']);
  });
});
