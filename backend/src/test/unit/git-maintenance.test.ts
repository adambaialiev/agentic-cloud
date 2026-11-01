import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// backend/src/test/unit → repo root is four levels up.
const SCRIPT = fileURLToPath(new URL('../../../../infra/git-host/maintain-repos.sh', import.meta.url));

/**
 * Drives the real script with the real `git` binary. What is worth pinning:
 * that the loose objects the merge endpoint leaves behind actually get
 * packed (the reason this job exists), that history survives the packing,
 * and that a repo which cannot be collected turns into a named failure
 * rather than a silent skip.
 */
const ROOTS: string[] = [];

function makeRoot(): { repos: string; lock: string; scratch: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-maint-'));
  ROOTS.push(root);
  const dirs = { repos: join(root, 'repos'), lock: join(root, 'lock'), scratch: root };
  mkdirSync(dirs.repos, { recursive: true });
  return dirs;
}

function git(args: string[], opts: { cwd?: string; input?: string } = {}): string {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();
}

/**
 * A bare repo whose objects are all LOOSE — the exact shape the merge
 * endpoint leaves behind: hash-object/mktree/commit-tree write loose objects,
 * and no receive-pack ever runs to pack them.
 */
function seedLooseRepo(reposRoot: string, owner: string, name: string, commits = 5): string {
  const bare = join(reposRoot, owner, `${name}.git`);
  mkdirSync(join(reposRoot, owner), { recursive: true });
  git(['init', '--quiet', '--bare', '-b', 'main', bare]);
  let parent = '';
  for (let i = 0; i < commits; i += 1) {
    const blob = git(['--git-dir', bare, 'hash-object', '-w', '--stdin'], { input: `content ${i}\n` });
    const tree = git(['--git-dir', bare, 'mktree'], { input: `100644 blob ${blob}\tfile.txt\n` });
    parent = git(
      ['--git-dir', bare, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `commit ${i}`],
    );
  }
  git(['--git-dir', bare, 'update-ref', 'refs/heads/main', parent]);
  return bare;
}

/** Loose (unpacked) object count, from `git count-objects`: "N objects, K kilobytes". */
function looseCount(bare: string): number {
  return Number(git(['--git-dir', bare, 'count-objects']).split(' ')[0]);
}

function runMaintenance(
  dirs: ReturnType<typeof makeRoot>,
  overrides: Record<string, string> = {},
): { ok: boolean; output: string } {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REPOS_ROOT: dirs.repos,
      MAINT_LOCK_FILE: dirs.lock,
      ...overrides,
    },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function fakeNotifier(dir: string): { path: string; read: () => string } {
  const sink = join(dir, 'notified.txt');
  const path = join(dir, 'fake-notify.sh');
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s' "$1" >> ${JSON.stringify(sink)}\n`, { mode: 0o755 });
  return { path, read: () => (existsSync(sink) ? readFileSync(sink, 'utf8') : '') };
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

describe('maintain-repos.sh', () => {
  it('packs the loose objects an approved merge leaves behind — history intact', () => {
    const dirs = makeRoot();
    const bare = seedLooseRepo(dirs.repos, 'user-a', 'busy');
    expect(looseCount(bare)).toBeGreaterThan(0);

    const { ok, output } = runMaintenance(dirs);

    expect(ok).toBe(true);
    expect(output).toMatch(/user-a\/busy/);
    // Everything was reachable, so a full gc packs all of it.
    expect(looseCount(bare)).toBe(0);
    expect(git(['--git-dir', bare, 'log', '--format=%s', 'main']).split('\n')).toHaveLength(5);
  });

  it('stays silent when healthy, and names the repo that failed when not', () => {
    const dirs = makeRoot();
    seedLooseRepo(dirs.repos, 'user-a', 'fine');
    const notifier = fakeNotifier(dirs.scratch);

    expect(runMaintenance(dirs, { MAINT_NOTIFY: notifier.path }).ok).toBe(true);
    // A healthy week is a journal line, not a Telegram message.
    expect(notifier.read()).toBe('');

    // A directory that says .git but holds no repository: gc cannot run, and
    // that must become a named failure, not a silent skip.
    mkdirSync(join(dirs.repos, 'user-b', 'broken.git'), { recursive: true });
    const { ok } = runMaintenance(dirs, { MAINT_NOTIFY: notifier.path });

    expect(ok).toBe(false);
    expect(notifier.read()).toMatch(/git maintenance FAILED/);
    expect(notifier.read()).toMatch(/user-b\/broken/);
  });
});
