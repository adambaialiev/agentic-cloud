import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import DatabaseConstructor from 'better-sqlite3';
import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Database backups into a bucket (note #807; hardened for production by
 * note #1032).
 *
 * A private copy has no backup host: its backend is one Fly machine. So the
 * backend does it itself, on a timer: an online SQLite backup beside the live
 * file (safe while writes continue, and it folds the WAL in), uploaded as
 * `db/backend-<time>.db.gz`. Configured only by the BACKUP_S3_* settings.
 *
 * Since note #1032 our own platform uses this too, into Cloudflare R2 off Fly,
 * in place of the Hetzner host script (infra/db-backup). So it now carries
 * that script's discipline, which it lacked:
 *
 *  - IT REFUSES MORE THAN IT REPORTS. A snapshot that will not open, fails
 *    `PRAGMA integrity_check`, or holds no tables at all is never uploaded.
 *    An empty-but-valid database is the failure that looks green for weeks.
 *  - IT VERIFIES WHAT IT SENDS, THE WAY A RESTORE WOULD. The gzip is
 *    decompressed again and must be byte-identical to the checked snapshot;
 *    after the upload the bucket must report exactly the size that was sent.
 *  - RETENTION IS THE STORAGE BOX'S: every backup of the newest `keepDaily`
 *    days keeps its newest, every one of the newest `keepWeekly` ISO weeks
 *    keeps its newest, and the newest archive is never removed whatever its
 *    age. Copies used to keep "the newest N"; at one backup a day that is the
 *    same N dailies, now with weeklies behind them.
 *  - A BUCKET LOCK IS RESPECTED, NOT FOUGHT. R2's lock refuses deletes of
 *    anything younger than its age; `lockDays` makes the prune leave those
 *    alone instead of failing a good run on them.
 */
export interface DatabaseBucketBackupOptions {
  /** The live database file; the snapshot is written beside it. */
  dbPath: string;
  /** better-sqlite3's online backup of the open database. */
  backup: (destination: string) => Promise<unknown>;
  bucket: { endpoint: string; name: string; accessKeyId: string; secretAccessKey: string; region?: string };
  /** Days that keep their newest backup (and, before note #1032, the "keep newest N"). */
  keep: number;
  /** ISO weeks that keep their newest backup. Default 8. */
  keepWeekly?: number;
  /** The bucket refuses deletes younger than this; the prune does not try. Default 0. */
  lockDays?: number;
  client?: Pick<S3Client, 'send'>;
  now?: () => Date;
  log?: (line: string) => void;
  /** Told about every run, so a backup monitor can see the gaps. */
  record?: (status: 'ok' | 'fail', detail: string) => void;
  /**
   * Told when the bucket already holds a good backup this process did not
   * take: at start, and on a check that finds the newest one still fresh
   * (note #1082). Without it a restart forgot the last backup until the next
   * one was due, a whole interval later, so a copy's pulse said
   * `backupAgeHours: null` minutes after "backed up just now".
   */
  found?: (at: Date) => void;
}

export interface DatabaseBucketBackupResult {
  key: string;
  bytes: number;
  gzippedBytes: number;
  /** User tables in the snapshot (sqlite_* excluded). */
  tables: number;
  kept: number;
  removed: string[];
}

export const DATABASE_BACKUP_PREFIX = 'db/';
const BACKUP_KEY = /^db\/backend-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db\.gz$/;
const DAY_MS = 24 * 60 * 60_000;

/** The time a backup key was taken at, or null for anything that is not one of ours. */
export function backupKeyTime(key: string): Date | null {
  const m = BACKUP_KEY.exec(key);
  if (!m) return null;
  const time = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isNaN(time.getTime()) ? null : time;
}

/** ISO-8601 week, as `2026-W45`. */
export function isoWeek(time: Date): string {
  const d = new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Which backups a prune may remove: everything not kept by the newest-of-day
 * (`keepDaily` days), newest-of-ISO-week (`keepWeekly` weeks) and newest-overall
 * rules, and not younger than the bucket's lock. Keys that are not backups of
 * ours are never candidates.
 */
export function backupsToRemove(keys: string[], rules: { keepDaily: number; keepWeekly: number; lockDays: number; now: Date }): string[] {
  const backups = keys
    .map((key) => ({ key, time: backupKeyTime(key) }))
    .filter((b): b is { key: string; time: Date } => b.time !== null)
    .sort((a, b) => b.time.getTime() - a.time.getTime());
  if (backups.length === 0) return [];
  const kept = new Set<string>([backups[0]!.key]);
  const newestOf = (bucketOf: (time: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const b of backups) {
      const bucket = bucketOf(b.time);
      if (seen.has(bucket)) continue;
      if (seen.size >= count) break;
      seen.add(bucket);
      kept.add(b.key);
    }
  };
  newestOf((time) => time.toISOString().slice(0, 10), rules.keepDaily);
  newestOf(isoWeek, rules.keepWeekly);
  const lockedAfter = rules.now.getTime() - rules.lockDays * DAY_MS;
  return backups
    .filter((b) => !kept.has(b.key) && b.time.getTime() < lockedAfter)
    .map((b) => b.key)
    .reverse();
}

/**
 * Open a snapshot the way a restore would and say how many tables it holds.
 * Throws for a file that will not open, fails its integrity check, or holds no
 * tables: none of those may ever be uploaded as a backup.
 */
export function checkSnapshot(file: string): { tables: number } {
  let db: InstanceType<typeof DatabaseConstructor>;
  try {
    db = new DatabaseConstructor(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`snapshot will not open: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    let rows: Array<{ integrity_check: string }>;
    try {
      rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    } catch (error) {
      throw new Error(`snapshot is not a database: ${error instanceof Error ? error.message : String(error)}`);
    }
    const verdict = rows.map((row) => row.integrity_check).join('; ');
    if (verdict !== 'ok') throw new Error(`snapshot failed its integrity check: ${verdict.slice(0, 200)}`);
    const { n } = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number };
    if (n === 0) throw new Error('snapshot holds no tables: refusing to call an empty database a backup');
    return { tables: n };
  } finally {
    db.close();
  }
}

export class DatabaseBucketBackup {
  private readonly client: Pick<S3Client, 'send'>;
  private running: Promise<DatabaseBucketBackupResult> | null = null;

  constructor(private readonly options: DatabaseBucketBackupOptions) {
    if (!(options.keep >= 1)) throw new Error('keep must be at least 1');
    if (options.keepWeekly !== undefined && !(options.keepWeekly >= 0)) throw new Error('keepWeekly must not be negative');
    if (options.lockDays !== undefined && !(options.lockDays >= 0)) throw new Error('lockDays must not be negative');
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

  /**
   * Age of the newest backup in the bucket, or null when there is none (or
   * the bucket cannot be listed, in which case a backup is taken anyway).
   */
  async newestAgeMs(): Promise<number | null> {
    const newest = await this.newestAt();
    return newest ? (this.options.now?.() ?? new Date()).getTime() - newest.getTime() : null;
  }

  /** When the newest backup in the bucket was taken, or null (none, or the bucket cannot be listed). */
  async newestAt(): Promise<Date | null> {
    try {
      const times = (await this.listKeys()).map(backupKeyTime).filter((t): t is Date => t !== null);
      return times.length === 0 ? null : new Date(Math.max(...times.map((t) => t.getTime())));
    } catch {
      return null;
    }
  }

  /**
   * A backup whenever the newest one in the bucket is `intervalMs` old,
   * checked every `checkEveryMs` (default 30 min, at most the interval) and
   * first after `firstAfterMs`. The bucket is the clock, not this process
   * (note #1032): production restarts on every deploy, a dozen times a day,
   * and a timer that started over at each boot took a backup after every one
   * of them, each kept for the bucket lock's 30 days. Failures are told,
   * never thrown.
   */
  start(intervalMs: number, firstAfterMs: number, checkEveryMs = 30 * 60_000): void {
    const tick = async () => {
      const newest = await this.newestAt();
      const age = newest ? (this.options.now?.() ?? new Date()).getTime() - newest.getTime() : null;
      // A little slack, so a check that lands a minute early does not wait a whole round.
      if (newest && age !== null && age < intervalMs - Math.min(5 * 60_000, intervalMs / 10)) {
        this.options.found?.(newest);
        return;
      }
      try {
        const result = await this.run();
        const line = `${result.key}: ${result.tables} tables, ${result.bytes} bytes (${result.gzippedBytes} gzipped), ${result.kept} kept`
          + (result.removed.length ? `, removed ${result.removed.length}` : '');
        this.options.log?.(line);
        this.options.record?.('ok', line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`backup failed: ${message}`);
        this.options.record?.('fail', message);
      }
    };
    // Say at once what the bucket already holds, so the health page and the
    // pulse know the last backup from the first minute, not the first check.
    if (this.options.found) void this.newestAt().then((at) => { if (at) this.options.found?.(at); });
    setTimeout(() => { void tick(); }, firstAfterMs).unref();
    setInterval(() => { void tick(); }, Math.min(checkEveryMs, intervalMs)).unref();
  }

  private async runOnce(): Promise<DatabaseBucketBackupResult> {
    const snapshot = `${this.options.dbPath}.bucket-backup`;
    await rm(snapshot, { force: true });
    try {
      await this.options.backup(snapshot);
      const { tables } = checkSnapshot(snapshot);
      const raw = await readFile(snapshot);
      const gz = gzipSync(raw);
      const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      if (sha(gunzipSync(gz)) !== sha(raw)) throw new Error('the archive does not decompress to the snapshot it was made from');
      const stamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
      const key = `${DATABASE_BACKUP_PREFIX}backend-${stamp}.db.gz`;
      await this.client.send(new PutObjectCommand({
        Bucket: this.options.bucket.name, Key: key, Body: gz, ContentType: 'application/gzip',
        Metadata: { 'sha256-db': sha(raw), tables: String(tables) },
      }));
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket.name, Key: key })) as { ContentLength?: number };
      if (head.ContentLength !== gz.length) {
        throw new Error(`the bucket holds ${head.ContentLength ?? 'no'} bytes for ${key}, ${gz.length} were sent`);
      }
      const removed = await this.prune(key);
      const kept = (await this.listKeys()).filter((k) => backupKeyTime(k)).length;
      return { key, bytes: raw.length, gzippedBytes: gz.length, tables, kept, removed };
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

  /** The retention rules above; the backup just written is never one of them. */
  private async prune(justWritten: string): Promise<string[]> {
    const excess = backupsToRemove(await this.listKeys(), {
      keepDaily: this.options.keep,
      keepWeekly: this.options.keepWeekly ?? 8,
      lockDays: this.options.lockDays ?? 0,
      now: this.options.now?.() ?? new Date(),
    }).filter((key) => key !== justWritten);
    for (const key of excess) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket.name, Key: key }));
    }
    return excess;
  }
}
