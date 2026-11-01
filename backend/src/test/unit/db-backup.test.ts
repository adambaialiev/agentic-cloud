import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// backend/src/test/unit → repo root is four levels up.
const SNAPSHOT_SCRIPT = fileURLToPath(new URL('../../../../infra/db-backup/snapshot-db.sh', import.meta.url));
const BACKUP_SCRIPT = fileURLToPath(new URL('../../../../infra/db-backup/backup-db.sh', import.meta.url));

/**
 * The platform database is the one dataset whose loss cannot be worked around,
 * and until this job existed its only off-box copy was a side effect of the
 * object-store backup. So the case that matters here is not "did it make a
 * file" but "does that file open as a database and give the rows back" —
 * every assertion below goes through a real SQLite read, never a byte compare.
 */
const ROOTS: string[] = [];

/**
 * The scripts shell out to the `sqlite3` CLI, which ia-backend has and the CI
 * machine image does not (node, git, jq, ripgrep — no sqlite3). Rather than
 * skip the whole suite where it would matter most, stand in a shim backed by
 * better-sqlite3: the same SQLite library, and `db.backup()` is the same online
 * backup API the real CLI's `.backup` calls, so the WAL guarantee below is
 * still being tested rather than assumed.
 *
 * Used ONLY when there is no real binary. Where one exists — dev boxes, and CI
 * once the image carries it — the tests drive the real thing, including its
 * argument quoting.
 */
let sqliteBinDir: string | null = null;

function ensureSqlite3(): void {
  if (spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).status === 0) return;

  const require_ = createRequire(import.meta.url);
  // Absolute: the shim lives in a temp dir with no node_modules of its own.
  const betterSqlite = require_.resolve('better-sqlite3');
  sqliteBinDir = mkdtempSync(join(tmpdir(), 'sqlite3-shim-'));
  ROOTS.push(sqliteBinDir);
  const shim = `#!/usr/bin/env node
const Database = require(${JSON.stringify(betterSqlite)});
const [file, sql] = process.argv.slice(2);
(async () => {
  const db = new Database(file);
  const backup = /^\\s*\\.backup\\s+'(.+)'\\s*$/.exec(sql ?? '');
  if (backup) { await db.backup(backup[1]); db.close(); return; }
  const stmt = db.prepare(sql);
  // .get()/.all() throw on a statement that returns nothing; run() is correct
  // for those. reader tells them apart the way the CLI's own loop does.
  if (stmt.reader) {
    for (const row of stmt.all()) console.log(Object.values(row).join('|'));
  } else { stmt.run(); }
  db.close();
})().catch((err) => { console.error(String(err && err.message ? err.message : err)); process.exit(1); });
`;
  writeFileSync(join(sqliteBinDir, 'sqlite3'), shim, { mode: 0o755 });
}

/** PATH for the spawned scripts, with the shim in front only if one was built. */
function scriptEnv(): NodeJS.ProcessEnv {
  if (!sqliteBinDir) return process.env;
  return { ...process.env, PATH: `${sqliteBinDir}:${process.env.PATH ?? ''}` };
}

beforeAll(() => {
  ensureSqlite3();
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'db-backup-'));
  ROOTS.push(root);
  const dirs = {
    db: join(root, 'live', 'backend.db'),
    dest: join(root, 'dest'),
    state: join(root, 'state'),
    spool: join(root, 'spool'),
    root,
  };
  mkdirSync(join(root, 'live'), { recursive: true });
  mkdirSync(dirs.dest, { recursive: true });

  const db = new Database(dirs.db);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO users (name) VALUES ('alex'), ('sam')");
  // Secret values are AES-256-GCM ciphertext at rest since #1089. Present here
  // because a restore has to give back exactly what was stored, not a
  // helpfully decrypted version of it.
  db.exec('CREATE TABLE secrets (name TEXT, value TEXT)');
  db.exec("INSERT INTO secrets VALUES ('HETZNER_SSH_PRIVATE_KEY', 'enc:v1:Zm9vYmFy')");
  db.close();
  return dirs;
}

function runSnapshot(dirs: ReturnType<typeof makeRoot>, overrides: Record<string, string> = {}) {
  const result = spawnSync('bash', [SNAPSHOT_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...scriptEnv(),
      SQLITE_DB_PATH: dirs.db,
      DB_BACKUP_SPOOL_DIR: dirs.spool,
      ...overrides,
    },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function runUpload(dirs: ReturnType<typeof makeRoot>, overrides: Record<string, string> = {}) {
  const result = spawnSync('bash', [BACKUP_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...scriptEnv(),
      DB_BACKUP_SPOOL_DIR: dirs.spool,
      DB_BACKUP_STATE_DIR: dirs.state,
      DB_BACKUP_LOCK_FILE: join(dirs.state, 'backup.lock'),
      BACKUP_TRANSPORT: 'local',
      BACKUP_LOCAL_ROOT: dirs.dest,
      DB_BACKUP_NOTIFY: '/nonexistent',
      ...overrides,
    },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The whole job the way systemd runs it: privileged snapshot, then upload. */
function runBackup(dirs: ReturnType<typeof makeRoot>, overrides: Record<string, string> = {}) {
  const snapshot = runSnapshot(dirs);
  if (!snapshot.ok) return snapshot;
  return runUpload(dirs, overrides);
}

function archives(dirs: ReturnType<typeof makeRoot>): string[] {
  const dir = join(dirs.dest, 'db');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().reverse();
}

/** Decompress an artifact and open it as a real database. */
function restore(dirs: ReturnType<typeof makeRoot>, name: string): Database.Database {
  const out = join(dirs.root, `restored-${name.replace(/\W/g, '_')}.db`);
  const gunzip = spawnSync('gzip', ['-dc', join(dirs.dest, 'db', name)], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  expect(gunzip.status).toBe(0);
  writeFileSync(out, gunzip.stdout);
  return new Database(out, { readonly: true });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function fakeNotifier(dir: string): { path: string; read: () => string } {
  const sink = join(dir, 'notified.txt');
  const path = join(dir, 'fake-notify.sh');
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s' "$1" >> ${JSON.stringify(sink)}\nexit 0\n`, { mode: 0o755 });
  return { path, read: () => (existsSync(sink) ? readFileSync(sink, 'utf8') : '') };
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

describe('snapshot-db.sh', () => {
  let dirs: ReturnType<typeof makeRoot>;

  beforeEach(() => {
    dirs = makeRoot();
  });

  it('captures committed data still sitting in the WAL', () => {
    // The reason this job takes a SQLite snapshot instead of copying the file.
    // On ia-backend the main database file is 808 KB and its WAL is 1.6 MB, so
    // a `cp` there would silently lose most of the recent writes — including,
    // on a bad night, every row written since the last checkpoint.
    const live = new Database(dirs.db);
    live.pragma('wal_autocheckpoint = 0');
    const insert = live.prepare('INSERT INTO users (name) VALUES (?)');
    for (let i = 0; i < 200; i += 1) insert.run(`wal-user-${i}`);

    // Still open, still uncheckpointed: exactly the state the nightly timer
    // finds a live backend in.
    expect(existsSync(`${dirs.db}-wal`)).toBe(true);

    const naive = join(dirs.root, 'naive-copy.db');
    copyFileSync(dirs.db, naive);

    expect(runBackup(dirs).ok).toBe(true);
    live.close();

    const restored = restore(dirs, `${today()}.db.gz`);
    expect(restored.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 202 });
    restored.close();

    // And the copy that would have looked fine in a listing does not have them.
    const naiveDb = new Database(naive, { readonly: true });
    const naiveCount = (naiveDb.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
    naiveDb.close();
    expect(naiveCount).toBeLessThan(202);
  });

  it('refuses a database with no tables rather than overwriting a good backup', () => {
    // An empty-but-valid database passes every structural check there is. This
    // is the failure that looks like a green run for weeks.
    const empty = makeRoot();
    rmSync(empty.db);
    new Database(empty.db).close();

    const { ok, output } = runSnapshot(empty);

    expect(ok).toBe(false);
    expect(output).toMatch(/no tables/);
    expect(existsSync(join(empty.spool, 'backend.db'))).toBe(false);
  });

  it('refuses a file that is not a database at all', () => {
    writeFileSync(dirs.db, 'this is not a sqlite database');

    const { ok, output } = runSnapshot(dirs);

    expect(ok).toBe(false);
    expect(output).toMatch(/failed|integrity/i);
    expect(existsSync(join(dirs.spool, 'backend.db'))).toBe(false);
  });

  it('leaves no half-written snapshot behind when it refuses', () => {
    writeFileSync(dirs.db, 'not a database');
    runSnapshot(dirs);

    // Nothing at the real name AND nothing at the .part name: the uploader
    // must never find something that looks like a snapshot and is not one.
    expect(existsSync(join(dirs.spool, 'backend.db'))).toBe(false);
    expect(existsSync(join(dirs.spool, 'backend.db.part'))).toBe(false);
  });
});

describe('backup-db.sh', () => {
  let dirs: ReturnType<typeof makeRoot>;

  beforeEach(() => {
    dirs = makeRoot();
  });

  it('produces an archive that opens as a database and gives the rows back', () => {
    expect(runBackup(dirs).ok).toBe(true);
    expect(archives(dirs)).toEqual([`${today()}.db.gz`]);

    const restored = restore(dirs, `${today()}.db.gz`);
    expect(restored.prepare('SELECT name FROM users ORDER BY id').all()).toEqual([
      { name: 'alex' },
      { name: 'sam' },
    ]);
    // Ciphertext comes back byte for byte. Without SECRETS_MASTER_KEY these
    // rows are unreadable, which is the point — and the reason the README says
    // losing every copy of that key loses every secret.
    expect(restored.prepare('SELECT value FROM secrets').get()).toEqual({ value: 'enc:v1:Zm9vYmFy' });
    restored.close();
  });

  it('clears the spool so a whole copy of the database is not left on disk', () => {
    runBackup(dirs);

    // The spool holds the entire database in the clear between the two steps.
    // Leaving it there would quietly double the blast radius of this box.
    expect(existsSync(join(dirs.spool, 'backend.db'))).toBe(false);
  });

  it('fails loudly when run without a snapshot to upload', () => {
    const { ok, output } = runUpload(dirs);

    expect(ok).toBe(false);
    expect(output).toMatch(/no snapshot/);
  });

  it('skips a night when the database has not changed', () => {
    runBackup(dirs);
    expect(runBackup(dirs).output).toMatch(/unchanged since last backup/);
  });

  it('uploads again as soon as a single row changes', () => {
    runBackup(dirs);
    const live = new Database(dirs.db);
    live.exec("INSERT INTO users (name) VALUES ('newcomer')");
    live.close();

    expect(runBackup(dirs).output).toMatch(/uploaded/);
    const restored = restore(dirs, `${today()}.db.gz`);
    expect(restored.prepare("SELECT count(*) AS n FROM users WHERE name = 'newcomer'").get()).toEqual({ n: 1 });
    restored.close();
  });

  it('keeps 14 dailies and one per ISO week, and always the newest', () => {
    runBackup(dirs);
    const dir = join(dirs.dest, 'db');
    const seed = join(dir, `${today()}.db.gz`);
    for (let i = 1; i <= 120; i += 1) copyFileSync(seed, join(dir, `${daysAgo(i)}.db.gz`));

    const live = new Database(dirs.db);
    live.exec("INSERT INTO users (name) VALUES ('trigger')");
    live.close();
    runBackup(dirs);

    const kept = archives(dirs);
    expect(kept).toHaveLength(23);
    expect(kept[0]).toBe(`${today()}.db.gz`);
    for (let i = 0; i <= 14; i += 1) expect(kept).toContain(`${daysAgo(i)}.db.gz`);
  }, 60_000);

  it('never prunes the only archive there is, however old', () => {
    runBackup(dirs);
    const dir = join(dirs.dest, 'db');
    copyFileSync(join(dir, `${today()}.db.gz`), join(dir, `${daysAgo(900)}.db.gz`));
    rmSync(join(dir, `${today()}.db.gz`));

    runBackup(dirs);

    // An unchanged database is skipped by the uploader, so a pure age rule
    // would delete the last copy of a quiet month and leave nothing at all.
    expect(archives(dirs)).toEqual([`${daysAgo(900)}.db.gz`]);
  });

  it('uploads again when the target has lost what it was holding', () => {
    runBackup(dirs);
    rmSync(join(dirs.dest, 'db', `${today()}.db.gz`));

    const { output } = runBackup(dirs);

    expect(output).toMatch(/holds nothing/);
    expect(archives(dirs)).toEqual([`${today()}.db.gz`]);
  });

  it('does nothing, successfully, until a target is configured', () => {
    // The units ship before the Storage Box path exists.
    const { ok, output } = runBackup(dirs, { BACKUP_TRANSPORT: 'sftp', BACKUP_SSH_TARGET: '' });

    expect(ok).toBe(true);
    expect(output).toMatch(/nothing to do/);
  });

  it('reports success and failure to the ops bot', () => {
    const notifier = fakeNotifier(dirs.root);
    runBackup(dirs, { DB_BACKUP_NOTIFY: notifier.path });
    expect(notifier.read()).toMatch(/database backup OK/);

    const failing = makeRoot();
    const notifier2 = fakeNotifier(failing.root);
    const keyPath = join(failing.root, 'key');
    writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o600 });

    const { ok } = runBackup(failing, {
      DB_BACKUP_NOTIFY: notifier2.path,
      BACKUP_TRANSPORT: 'sftp',
      BACKUP_SSH_TARGET: 'nobody@127.0.0.1:db-backups',
      BACKUP_SSH_PORT: '59999',
      BACKUP_SSH_KEY: keyPath,
    });

    expect(ok).toBe(false);
    expect(notifier2.read()).toMatch(/database backup FAILED/);
  });
});
