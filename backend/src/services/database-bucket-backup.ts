import { readFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Database backups into a bucket (note #807).
 *
 * Our own platform copies its database to a Hetzner Storage Box with a shell
 * script and a timer on the backend host (infra/db-backup). A private copy has
 * no such host: its backend is one Fly machine, and the copy's backups bucket
 * is in the same Fly account. So the backend does it itself, on a timer: an
 * online SQLite backup beside the live file (safe while writes continue),
 * gzipped, uploaded as `db/backend-<time>.db.gz`, and the oldest beyond `keep`
 * removed. Configured only by the BACKUP_S3_* settings, which our own backend
 * does not carry.
 */
export interface DatabaseBucketBackupOptions {
  /** The live database file; the snapshot is written beside it. */
  dbPath: string;
  /** better-sqlite3's online backup of the open database. */
  backup: (destination: string) => Promise<unknown>;
  bucket: { endpoint: string; name: string; accessKeyId: string; secretAccessKey: string; region?: string };
  /** How many backups to keep (the newest are kept). */
  keep: number;
  client?: Pick<S3Client, 'send'>;
  now?: () => Date;
  log?: (line: string) => void;
  /** Told about every run, so a backup monitor can see the gaps. */
  record?: (status: 'ok' | 'fail', detail: string) => void;
}

export interface DatabaseBucketBackupResult {
  key: string;
  bytes: number;
  gzippedBytes: number;
  kept: number;
  removed: string[];
}

export const DATABASE_BACKUP_PREFIX = 'db/';

export class DatabaseBucketBackup {
  private readonly client: Pick<S3Client, 'send'>;
  private running: Promise<DatabaseBucketBackupResult> | null = null;

  constructor(private readonly options: DatabaseBucketBackupOptions) {
    if (!(options.keep >= 1)) throw new Error('keep must be at least 1');
    this.client = options.client ?? new S3Client({
      endpoint: options.bucket.endpoint,
      region: options.bucket.region ?? 'auto',
      credentials: { accessKeyId: options.bucket.accessKeyId, secretAccessKey: options.bucket.secretAccessKey },
      forcePathStyle: true,
    });
  }

  /** One backup; a second call while one runs joins it. */
  run(): Promise<DatabaseBucketBackupResult> {
    this.running ??= this.runOnce().finally(() => { this.running = null; });
    return this.running;
  }

  /** Every `intervalMs`, the first after `firstAfterMs`; failures are told, never thrown. */
  start(intervalMs: number, firstAfterMs: number): void {
    const tick = () => {
      this.run().then((result) => {
        const line = `${result.key}: ${result.bytes} bytes (${result.gzippedBytes} gzipped), ${result.kept} kept`
          + (result.removed.length ? `, removed ${result.removed.length}` : '');
        this.options.log?.(line);
        this.options.record?.('ok', line);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`backup failed: ${message}`);
        this.options.record?.('fail', message);
      });
    };
    setTimeout(tick, firstAfterMs).unref();
    setInterval(tick, intervalMs).unref();
  }

  private async runOnce(): Promise<DatabaseBucketBackupResult> {
    const snapshot = `${this.options.dbPath}.bucket-backup`;
    await rm(snapshot, { force: true });
    try {
      await this.options.backup(snapshot);
      const raw = await readFile(snapshot);
      const gz = gzipSync(raw);
      const stamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
      const key = `${DATABASE_BACKUP_PREFIX}backend-${stamp}.db.gz`;
      await this.client.send(new PutObjectCommand({
        Bucket: this.options.bucket.name, Key: key, Body: gz, ContentType: 'application/gzip',
      }));
      const removed = await this.prune(key);
      const kept = (await this.listKeys()).length;
      return { key, bytes: raw.length, gzippedBytes: gz.length, kept, removed };
    } finally {
      await rm(snapshot, { force: true });
    }
  }

  private async listKeys(): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.options.bucket.name, Prefix: DATABASE_BACKUP_PREFIX, ContinuationToken: token,
      }));
      for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  /** Oldest first beyond `keep`; the backup just written is never one of them. */
  private async prune(justWritten: string): Promise<string[]> {
    const keys = (await this.listKeys()).filter((key) => /^db\/backend-.+\.db\.gz$/.test(key));
    const excess = keys.slice(0, Math.max(0, keys.length - this.options.keep)).filter((key) => key !== justWritten);
    for (const key of excess) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket.name, Key: key }));
    }
    return excess;
  }
}
