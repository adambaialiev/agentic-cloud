import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// backend/src/test/unit → repo root is four levels up.
const SCRIPT = fileURLToPath(new URL('../../../../infra/git-host/backup-repos.sh', import.meta.url));

/**
 * These drive the real script with the real `git` binary, against the `local`
 * transport. The production transport is sftp, and the two share every line
 * above the three functions that move bytes — so what is worth pinning here is
 * the part that decides WHAT to upload and WHAT to delete, not the plumbing.
 *
 * Every case below is one that produced no backups, or destroyed one, while
 * this script was being written.
 */
const ROOTS: string[] = [];

function makeRoot(): { repos: string; dest: string; state: string; lock: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-backup-'));
  ROOTS.push(root);
  const dirs = {
    repos: join(root, 'repos'),
    dest: join(root, 'dest'),
    state: join(root, 'state'),
    lock: join(root, 'lock'),
  };
  mkdirSync(dirs.repos, { recursive: true });
  mkdirSync(dirs.dest, { recursive: true });
  return dirs;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();
}

/** A bare repo with one commit on main, HEAD set as the git host leaves it. */
function seedRepo(reposRoot: string, owner: string, name: string): string {
  const bare = join(reposRoot, owner, `${name}.git`);
  mkdirSync(join(reposRoot, owner), { recursive: true });
  git(['init', '--quiet', '--bare', '-b', 'main', bare]);
  const work = mkdtempSync(join(tmpdir(), 'wc-'));
  git(['init', '--quiet', '-b', 'main', work]);
  git(['commit', '--quiet', '--allow-empty', '-m', `first in ${name}`], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '--quiet', 'origin', 'main'], work);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  rmSync(work, { recursive: true, force: true });
  return bare;
}

/** An empty bare repo: created through the API, never pushed to. */
function seedEmptyRepo(reposRoot: string, owner: string, name: string): string {
  const bare = join(reposRoot, owner, `${name}.git`);
  mkdirSync(join(reposRoot, owner), { recursive: true });
  git(['init', '--quiet', '--bare', '-b', 'main', bare]);
  return bare;
}

function runBackup(
  dirs: ReturnType<typeof makeRoot>,
  overrides: Record<string, string> = {},
): { ok: boolean; output: string } {
  // spawnSync rather than execFileSync: the script reports skips on stdout and
  // every warning on stderr, and half the cases below turn on a warning.
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REPOS_ROOT: dirs.repos,
      BACKUP_TRANSPORT: 'local',
      BACKUP_LOCAL_ROOT: dirs.dest,
      BACKUP_STATE_DIR: dirs.state,
      BACKUP_LOCK_FILE: dirs.lock,
      ...overrides,
    },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function bundlesFor(dirs: ReturnType<typeof makeRoot>, owner: string, name: string): string[] {
  const dir = join(dirs.dest, 'git', owner, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().reverse();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

describe('backup-repos.sh', () => {
  let dirs: ReturnType<typeof makeRoot>;

  beforeEach(() => {
    dirs = makeRoot();
  });

  it('bundles every non-empty repo and skips the ones never pushed to', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    seedEmptyRepo(dirs.repos, 'user-a', 'never-pushed');

    const { ok, output } = runBackup(dirs);

    expect(ok).toBe(true);
    expect(bundlesFor(dirs, 'user-a', 'alpha')).toEqual([`${today()}.bundle`]);
    // `git bundle create --all` refuses to make an empty bundle, and a repo
    // with no refs has nothing to lose yet — so this must be a skip, not a
    // failure that turns the whole run red every night.
    expect(output).toMatch(/never-pushed: empty/);
    expect(bundlesFor(dirs, 'user-a', 'never-pushed')).toEqual([]);
  });

  it('produces a bundle that clones back out checked out, at the right commit', () => {
    const bare = seedRepo(dirs.repos, 'user-a', 'alpha');
    runBackup(dirs);

    const restore = mkdtempSync(join(tmpdir(), 'restore-'));
    ROOTS.push(restore);
    const target = join(restore, 'clone');
    git(['clone', '--quiet', join(dirs.dest, 'git', 'user-a', 'alpha', `${today()}.bundle`), target]);

    // `--all` alone leaves the bundle without HEAD, and the clone lands with no
    // branch and no working tree. The data survives either way; a restore that
    // needs explaining does not count as one.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], target)).toBe('main');
    expect(git(['rev-parse', 'HEAD'], target)).toBe(git(['rev-parse', 'main'], bare));
  });

  it('skips a repo whose refs have not moved, and re-bundles one that pushed', () => {
    const bare = seedRepo(dirs.repos, 'user-a', 'alpha');
    runBackup(dirs);

    expect(runBackup(dirs).output).toMatch(/alpha: unchanged/);

    const work = mkdtempSync(join(tmpdir(), 'wc-'));
    ROOTS.push(work);
    git(['clone', '--quiet', bare, work]);
    git(['commit', '--quiet', '--allow-empty', '-m', 'second'], work);
    git(['push', '--quiet', 'origin', 'main'], work);

    expect(runBackup(dirs).output).toMatch(/alpha: uploaded/);
  });

  // Seeds 120 days rather than a year: the daily window is 14 days and the
  // weekly one 8 weeks, so 120 fills every retention slot and still leaves
  // plenty that must be deleted — at a third of the file churn. The explicit
  // timeout is because the pruning is a shell loop, and vitest's 5s default
  // fitted on a workstation but not on the CI machine, where this first ran.
  it('keeps daily bundles, one per ISO week beyond that, and always the newest', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    runBackup(dirs);

    const dir = join(dirs.dest, 'git', 'user-a', 'alpha');
    const seed = join(dir, `${today()}.bundle`);
    for (let i = 1; i <= 120; i += 1) copyFileSync(seed, join(dir, `${daysAgo(i)}.bundle`));
    expect(readdirSync(dir)).toHaveLength(121);

    runBackup(dirs);
    const kept = bundlesFor(dirs, 'user-a', 'alpha');

    // 15 dailies (ages 0..14) + 8 weeklies.
    expect(kept).toHaveLength(23);
    expect(kept[0]).toBe(`${today()}.bundle`);
    for (let i = 0; i <= 14; i += 1) expect(kept).toContain(`${daysAgo(i)}.bundle`);

    // Nothing older than the daily window may share an ISO week with another
    // survivor — that is the whole point of the weekly tier.
    const olds = kept.filter((f) => f < `${daysAgo(14)}.bundle`);
    expect(olds).toHaveLength(8);
    const weeks = olds.map((f) => {
      const d = new Date(`${f.replace('.bundle', '')}T00:00:00Z`);
      const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
      const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return `${t.getUTCFullYear()}-${Math.ceil(((t.getTime() - start.getTime()) / 86400000 + 1) / 7)}`;
    });
    expect(new Set(weeks).size).toBe(weeks.length);
  }, 30_000);

  it('never prunes the only bundle a repo has, however old it is', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    runBackup(dirs);

    // An idle repo is skipped by the uploader, so a pure age rule would delete
    // its last copy and leave it with no backup at all.
    const dir = join(dirs.dest, 'git', 'user-a', 'alpha');
    const ancient = join(dir, `${daysAgo(900)}.bundle`);
    copyFileSync(join(dir, `${today()}.bundle`), ancient);
    rmSync(join(dir, `${today()}.bundle`));

    runBackup(dirs);

    expect(bundlesFor(dirs, 'user-a', 'alpha')).toEqual([`${daysAgo(900)}.bundle`]);
  });

  it('re-uploads everything when the target changes', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    runBackup(dirs);

    const elsewhere = join(ROOTS[ROOTS.length - 1], 'dest2');
    const { output } = runBackup(dirs, { BACKUP_LOCAL_ROOT: elsewhere });

    // Keyed on the refs alone, a repointed backup would report "unchanged"
    // for every repo and leave the new target empty until someone pushed.
    expect(output).toMatch(/alpha: uploaded/);
    expect(existsSync(join(elsewhere, 'git', 'user-a', 'alpha', `${today()}.bundle`))).toBe(true);
  });

  it('notices a target that lost its bundles and uploads again', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    runBackup(dirs);

    rmSync(join(dirs.dest, 'git', 'user-a', 'alpha', `${today()}.bundle`));
    const { output } = runBackup(dirs);

    // State is a claim about the far end; the far end is where things get
    // deleted by accident. Believing the claim is how a backup system spends
    // months backing nothing up.
    expect(output).toMatch(/holds nothing/);
    expect(bundlesFor(dirs, 'user-a', 'alpha')).toEqual([`${today()}.bundle`]);
  });

  it('does nothing, successfully, until a target is configured', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');

    const { ok, output } = runBackup(dirs, { BACKUP_TRANSPORT: 'sftp', BACKUP_SSH_TARGET: '' });

    // The units ship before the Storage Box exists. That must be a no-op, not
    // a failed service every night until someone finishes provisioning.
    expect(ok).toBe(true);
    expect(output).toMatch(/nothing to do/);
  });

  it('backs up a repo whose HEAD points at a branch that no longer exists', () => {
    const bare = seedRepo(dirs.repos, 'user-a', 'alpha');
    git(['symbolic-ref', 'HEAD', 'refs/heads/deleted-branch'], bare);

    const { ok, output } = runBackup(dirs);

    // Naming HEAD to `bundle create` fails outright when it dangles, and a
    // repo that cannot be bundled is a repo with no backup — much worse than
    // one that restores without a checked-out branch.
    expect(ok).toBe(true);
    expect(output).toMatch(/HEAD does not resolve/);
    expect(bundlesFor(dirs, 'user-a', 'alpha')).toEqual([`${today()}.bundle`]);
  });

  it('fails loudly when the destination cannot be reached', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');

    const { ok } = runBackup(dirs, {
      BACKUP_TRANSPORT: 'sftp',
      BACKUP_SSH_TARGET: 'nobody@127.0.0.1:backups',
      BACKUP_SSH_PORT: '59999',
      BACKUP_SSH_KEY: writeThrowawayKey(dirs),
    });

    // Silence is the failure mode that matters here: systemd only reports a
    // problem if the run exits non-zero.
    expect(ok).toBe(false);
  });
});

const NOTIFY = fileURLToPath(new URL('../../../../infra/git-host/notify.sh', import.meta.url));
const NOTIFY_ON_FAILURE = fileURLToPath(new URL('../../../../infra/git-host/notify-unit-failure.sh', import.meta.url));

/**
 * A stand-in notifier: records what it was handed, so these can assert on the
 * message the job composes without standing up a Telegram.
 */
function fakeNotifier(dir: string, exitCode = 0): { path: string; read: () => string } {
  const sink = join(dir, 'notified.txt');
  const path = join(dir, 'fake-notify.sh');
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s' "$1" >> ${JSON.stringify(sink)}\nexit ${exitCode}\n`, { mode: 0o755 });
  return { path, read: () => (existsSync(sink) ? readFileSync(sink, 'utf8') : '') };
}

describe('backup notifications', () => {
  let dirs: ReturnType<typeof makeRoot>;

  beforeEach(() => {
    dirs = makeRoot();
  });

  it('reports one summary for the whole run, not one per repo', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    seedRepo(dirs.repos, 'user-a', 'beta');
    const notifier = fakeNotifier(dirs.state.replace(/state$/, ''));

    runBackup(dirs, { BACKUP_NOTIFY: notifier.path });

    const sent = notifier.read();
    // A nightly "all fine" is the point rather than noise: the failure this
    // job guards against is silence, and an operator who sees a green line
    // every morning notices the morning it stops.
    expect(sent).toMatch(/git backups OK/);
    expect(sent).toMatch(/2 repos/);
    expect(sent).toMatch(/2 uploaded/);
    expect(sent.match(/git backups/g)).toHaveLength(1);
  });

  it('names the repos that failed', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    const notifier = fakeNotifier(dirs.state.replace(/state$/, ''));

    const { ok } = runBackup(dirs, {
      BACKUP_NOTIFY: notifier.path,
      BACKUP_TRANSPORT: 'sftp',
      BACKUP_SSH_TARGET: 'nobody@127.0.0.1:backups',
      BACKUP_SSH_PORT: '59999',
      BACKUP_SSH_KEY: writeThrowawayKey(dirs),
    });

    expect(ok).toBe(false);
    const sent = notifier.read();
    expect(sent).toMatch(/FAILED/);
    expect(sent).toMatch(/user-a\/alpha — upload failed/);
  });

  it('BACKUP_QUIET_OK silences success but still heartbeats — and never silences failure', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    const scratch = dirs.state.replace(/state$/, '');
    const notifier = fakeNotifier(scratch);
    // The heartbeat is called as `heartbeat git ok|fail "detail"`.
    const hbSink = join(scratch, 'heartbeat.txt');
    const hbPath = join(scratch, 'fake-heartbeat.sh');
    writeFileSync(hbPath, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(hbSink)}\n`, { mode: 0o755 });

    const { ok } = runBackup(dirs, {
      BACKUP_NOTIFY: notifier.path,
      BACKUP_HEARTBEAT: hbPath,
      BACKUP_QUIET_OK: '1',
    });

    // An intra-day run that succeeded says nothing to the operator — the one
    // green line per day stays the nightly's — but the heartbeat still fires,
    // so quiet never means unaccounted-for.
    expect(ok).toBe(true);
    expect(notifier.read()).toBe('');
    expect(readFileSync(hbSink, 'utf8')).toMatch(/^git ok/);

    // A failing run is never quiet, whatever the flag says.
    const { ok: failedOk } = runBackup(dirs, {
      BACKUP_NOTIFY: notifier.path,
      BACKUP_QUIET_OK: '1',
      BACKUP_TRANSPORT: 'sftp',
      BACKUP_SSH_TARGET: 'nobody@127.0.0.1:backups',
      BACKUP_SSH_PORT: '59999',
      BACKUP_SSH_KEY: writeThrowawayKey(dirs),
    });
    expect(failedOk).toBe(false);
    expect(notifier.read()).toMatch(/FAILED/);
  });

  it('does not fail the backup when the notifier itself fails', () => {
    seedRepo(dirs.repos, 'user-a', 'alpha');
    const notifier = fakeNotifier(dirs.state.replace(/state$/, ''), 1);

    const { ok } = runBackup(dirs, { BACKUP_NOTIFY: notifier.path });

    // A backup that landed is a backup that landed. Telegram being down must
    // not turn it into a red unit and a false alarm.
    expect(ok).toBe(true);
    expect(bundlesFor(dirs, 'user-a', 'alpha')).toEqual([`${today()}.bundle`]);
  });

  it('stays silent when no bot is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-'));
    ROOTS.push(root);
    const config = join(root, 'ops.env');
    writeFileSync(config, 'TELEGRAM_OPS_BOT_TOKEN=\nTELEGRAM_OPS_CHAT_ID=\n');

    const result = spawnSync('bash', [NOTIFY, 'nobody home'], {
      encoding: 'utf8',
      env: { ...process.env, OPS_NOTIFY_ENV: config, TELEGRAM_API_BASE: 'http://127.0.0.1:59997' },
    });

    // The units ship before the bot exists. Unconfigured is a normal state.
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toBe('');
  });

  it('never prints the bot token, even when Telegram is unreachable', () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-'));
    ROOTS.push(root);
    const config = join(root, 'ops.env');
    writeFileSync(config, 'TELEGRAM_OPS_BOT_TOKEN=123456:SECRET-TOKEN-VALUE\nTELEGRAM_OPS_CHAT_ID=42\n');

    const result = spawnSync('bash', [NOTIFY, 'hello'], {
      encoding: 'utf8',
      env: { ...process.env, OPS_NOTIFY_ENV: config, TELEGRAM_API_BASE: 'http://127.0.0.1:59997' },
    });

    // curl prints the URL it was fetching when a connection fails, and the
    // token lives in that URL. A token in the journal is a token written down.
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/SECRET-TOKEN-VALUE/);
    expect(output).toMatch(/HTTP 000/);
  });

  it('the OnFailure handler keeps quiet when the job already reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-'));
    ROOTS.push(root);
    const notifier = fakeNotifier(root);
    const marker = join(root, 'marker');
    writeFileSync(marker, `${Math.floor(Date.now() / 1000)}\n`);

    spawnSync('bash', [NOTIFY_ON_FAILURE, 'agentgit-backup.service'], {
      encoding: 'utf8',
      env: { ...process.env, OPS_NOTIFY_SCRIPT: notifier.path, OPS_NOTIFY_MARKER: marker },
    });

    // The job sends detail and THEN exits non-zero, which trips OnFailure too.
    expect(notifier.read()).toBe('');
  });

  it('the OnFailure handler speaks up when the job died without reporting', () => {
    const root = mkdtempSync(join(tmpdir(), 'notify-'));
    ROOTS.push(root);
    const notifier = fakeNotifier(root);
    const marker = join(root, 'marker');
    writeFileSync(marker, '0\n');

    spawnSync('bash', [NOTIFY_ON_FAILURE, 'agentgit-backup.service'], {
      encoding: 'utf8',
      env: { ...process.env, OPS_NOTIFY_SCRIPT: notifier.path, OPS_NOTIFY_MARKER: marker },
    });

    // Killed by its own timeout, or exited before the summary. These are the
    // failures that would otherwise be perfectly silent.
    expect(notifier.read()).toMatch(/did not say why/);
  });
});

/** A syntactically valid key the script can read; it never authenticates. */
function writeThrowawayKey(dirs: ReturnType<typeof makeRoot>): string {
  const path = join(dirs.state, '..', 'throwaway_key');
  writeFileSync(path, '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o600 });
  return path;
}
