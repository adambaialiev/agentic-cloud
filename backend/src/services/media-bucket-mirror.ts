import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * A nightly copy of the platform's media bucket into the backups bucket
 * (note #1032).
 *
 * The platform's attachments live in one Tigris bucket on Fly
 * (MEDIA_S3_*). Once the control plane is on Fly too, a copy only on Fly is
 * no copy at all, so this mirrors every object into the off-Fly backups
 * bucket (Cloudflare R2) under `media/<same key>`.
 *
 * - ADD-ONLY. An object deleted from the source stays in the mirror: this is
 *   a backup, and a delete that should not have happened is exactly what it
 *   is for. (The R2 bucket's 30-day lock would refuse the delete anyway.)
 * - ONLY WHAT IS MISSING OR DIFFERENT IN SIZE is copied, so a night costs
 *   the new attachments, not the whole store. Media paths are written once
 *   (users/<owner>/…/<id>), so a size change is rare; when the lock refuses
 *   the overwrite it is counted and reported, never retried in a loop.
 * - Workplaces whose media lives in a bucket in THEIR OWN Fly account
 *   (docs/byo-media.md) are not ours to copy, and are not listed here.
 */
export interface BucketConfig {
  endpoint: string;
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  forcePathStyle?: boolean;
}

export interface MediaBucketMirrorOptions {
  source: BucketConfig;
  target: BucketConfig;
  /** Where in the target the copy lives. Default `media/`. */
  prefix?: string;
  /** Objects larger than this are reported and skipped (default 512 MB). */
  maxObjectBytes?: number;
  sourceClient?: Pick<S3Client, 'send'>;
  targetClient?: Pick<S3Client, 'send'>;
  log?: (line: string) => void;
  record?: (status: 'ok' | 'fail', detail: string) => void;
}

export interface MediaBucketMirrorResult {
  sourceObjects: number;
  sourceBytes: number;
  copied: number;
  copiedBytes: number;
  failed: Array<{ key: string; error: string }>;
  skippedTooLarge: string[];
}

function clientFor(bucket: BucketConfig): S3Client {
  return new S3Client({
    endpoint: bucket.endpoint,
    region: bucket.region ?? 'auto',
    credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
    forcePathStyle: bucket.forcePathStyle ?? true,
  });
}

async function listAll(client: Pick<S3Client, 'send'>, bucket: string, prefix?: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })) as {
      Contents?: Array<{ Key?: string; Size?: number }>; IsTruncated?: boolean; NextContinuationToken?: string;
    };
    for (const item of page.Contents ?? []) if (item.Key) out.set(item.Key, item.Size ?? 0);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export class MediaBucketMirror {
  private readonly source: Pick<S3Client, 'send'>;
  private readonly target: Pick<S3Client, 'send'>;
  private readonly prefix: string;
  private running: Promise<MediaBucketMirrorResult> | null = null;

  constructor(private readonly options: MediaBucketMirrorOptions) {
    this.source = options.sourceClient ?? clientFor(options.source);
    this.target = options.targetClient ?? clientFor(options.target);
    this.prefix = options.prefix ?? 'media/';
    if (!this.prefix.endsWith('/')) throw new Error('prefix must end with /');
  }

  run(): Promise<MediaBucketMirrorResult> {
    this.running ??= this.runOnce().finally(() => { this.running = null; });
    return this.running;
  }

  start(intervalMs: number, firstAfterMs: number): void {
    const tick = () => {
      this.run().then((r) => {
        const line = `${r.sourceObjects} objects (${r.sourceBytes} bytes) in the source, copied ${r.copied} (${r.copiedBytes} bytes)`
          + (r.failed.length ? `, ${r.failed.length} failed (first: ${r.failed[0]!.key}: ${r.failed[0]!.error})` : '')
          + (r.skippedTooLarge.length ? `, ${r.skippedTooLarge.length} too large to copy` : '');
        this.options.log?.(line);
        this.options.record?.(r.failed.length ? 'fail' : 'ok', line);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`mirror failed: ${message}`);
        this.options.record?.('fail', message);
      });
    };
    setTimeout(tick, firstAfterMs).unref();
    setInterval(tick, intervalMs).unref();
  }

  private async runOnce(): Promise<MediaBucketMirrorResult> {
    const max = this.options.maxObjectBytes ?? 512 * 1024 * 1024;
    const [have, want] = await Promise.all([
      listAll(this.target, this.options.target.name, this.prefix),
      listAll(this.source, this.options.source.name),
    ]);
    const result: MediaBucketMirrorResult = {
      sourceObjects: want.size, sourceBytes: 0, copied: 0, copiedBytes: 0, failed: [], skippedTooLarge: [],
    };
    for (const [key, size] of want) {
      result.sourceBytes += size;
      if (have.get(this.prefix + key) === size) continue;
      if (size > max) { result.skippedTooLarge.push(key); continue; }
      try {
        const got = await this.source.send(new GetObjectCommand({ Bucket: this.options.source.name, Key: key })) as {
          Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string;
        };
        if (!got.Body) throw new Error('empty body');
        const bytes = Buffer.from(await got.Body.transformToByteArray());
        if (bytes.length !== size) throw new Error(`read ${bytes.length} bytes, listed ${size}`);
        await this.target.send(new PutObjectCommand({
          Bucket: this.options.target.name, Key: this.prefix + key, Body: bytes,
          ...(got.ContentType ? { ContentType: got.ContentType } : {}),
        }));
        result.copied += 1;
        result.copiedBytes += bytes.length;
      } catch (error) {
        result.failed.push({ key, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      }
    }
    return result;
  }
}
