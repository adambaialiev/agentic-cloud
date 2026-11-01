import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The deploy jobs' path filter asks "what changed since I last TRIED", never
 * "what changed in this one commit" — because the git host fast-forwards most
 * merges, the pushed tip is a branch's LAST commit, and a branch ending in a
 * site or test commit used to skip its deploy while the backend commits under
 * it were never looked at by anything (the Workspace type scale, 2026-09-07).
 * Tried, not shipped: a rolled-back release must not be retried by every
 * unrelated merge behind it, and an older sha must never ship backwards.
 *
 * Exercised by running the real shell — the range-filter functions lifted out
 * of run-job.sh — against a real temporary git history and a fake `ssh` that
 * answers for the prod host's last-attempt file / `current` symlink. Reading
 * the script for the right words would not catch a wrong range or exit path.
 */
const RUN_JOB = fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url));
const runJob = readFileSync(RUN_JOB, 'utf8');

function lift(): string {
  const start = runJob.indexOf('# ── "Did anything this job ships change?"');
  const endMarker = '# ── end of the range filter';
  const end = runJob.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('range filter block not found in run-job.sh');
  return runJob.slice(start, end);
}

interface History { c1: string; c2: string; c3: string; d1: string; dir: string }

/** c1 → c2 (backend + ci-runner) → c3 (site only); d1 (site only) off c1. */
function history(root: string): History {
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, {
      cwd: dir, encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, body: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  git('init', '-q', '-b', 'main');
  write('backend/a.ts', '1');
  write('src/index.html', '1');
  write('infra/ci-runner/x.sh', '1');
  git('add', '-A'); git('commit', '-qm', 'c1');
  const c1 = git('rev-parse', 'HEAD');
  write('backend/a.ts', '2');
  write('infra/ci-runner/x.sh', '2');
  git('add', '-A'); git('commit', '-qm', 'c2 backend');
  const c2 = git('rev-parse', 'HEAD');
  write('src/index.html', '2');
  git('add', '-A'); git('commit', '-qm', 'c3 site');
  const c3 = git('rev-parse', 'HEAD');
  git('checkout', '-q', c1);
  write('src/index.html', '3');
  git('add', '-A'); git('commit', '-qm', 'd1 site off c1');
  const d1 = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return { c1, c2, c3, d1, dir };
}

interface Scenario {
  mode: 'prod' | 'record';
  sha: string;
  /** What the fake ssh prints (the last-attempt sha, or `readlink -f current`); `undefined` = ssh fails. */
  live?: string;
  record?: string;
  force?: boolean;
}

function run(h: History, s: Scenario): { code: number; out: string; verdict: string; recorded?: string } {
  const root = join(h.dir, '..');
  const bin = join(root, 'bin');
  const workdir = join(root, `work-${Math.random().toString(36).slice(2)}`);
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(workdir, 'attempted'), { recursive: true });
  writeFileSync(join(bin, 'ssh'), s.live === undefined
    ? '#!/usr/bin/env bash\necho "ssh: connect to host prod: No route to host" >&2\nexit 255\n'
    : `#!/usr/bin/env bash\nprintf '%s\\n' '${s.live}'\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  if (s.record !== undefined) writeFileSync(join(workdir, 'attempted', 'self-update'), `${s.record}\n`);
  const kind = s.mode === 'prod' ? 'deploy-prod' : 'self-update';
  const script = [
    'set -euo pipefail',
    `KIND=${kind}; SHA=${s.sha}; WORKDIR='${workdir}'`,
    'SSH_OPTS="-i key"; PROD_HOST=prod; DEPLOY_ROOT=/opt/ia',
    lift(),
    `cd '${h.dir}'`,
    s.mode === 'prod'
      ? 'LAST_TRIED=$(prod_last_attempt); if changed_since "$LAST_TRIED" \'^backend/\'; then echo VERDICT=run; else echo VERDICT=skip; fi'
      : 'if changed_since "$(last_attempted)" \'^infra/ci-runner/\'; then echo VERDICT=run; else echo VERDICT=skip; fi; record_attempt',
  ].join('\n');
  const file = join(workdir, 'run.sh');
  writeFileSync(file, script);
  const r = spawnSync('bash', [file], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...(s.force ? { IA_FORCE_JOB: '1' } : {}) },
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  const recordFile = join(workdir, 'attempted', 'self-update');
  return {
    code: r.status ?? -1,
    out,
    verdict: /VERDICT=(\w+)/.exec(out)?.[1] ?? 'none',
    recorded: existsSync(recordFile) ? readFileSync(recordFile, 'utf8').trim() : undefined,
  };
}

const h = history(mkdtempSync(join(tmpdir(), 'deploy-filter-')));
const release = (sha: string) => `/opt/ia/releases/${sha}`;

describe('deploy-prod filters against what production last tried', () => {
  it('a site-only tip over a backend commit deploys — the tip alone would have skipped', () => {
    const r = run(h, { mode: 'prod', sha: h.c3, live: release(h.c1) });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('backend/a.ts');
  });

  it('a range that touches nothing it ships is skipped', () => {
    const r = run(h, { mode: 'prod', sha: h.c3, live: release(h.c2) });
    expect(r.verdict).toBe('skip');
    expect(r.out).toContain('nothing matching');
  });

  it('the sha production last tried is nothing to do', () => {
    const r = run(h, { mode: 'prod', sha: h.c3, live: release(h.c3) });
    expect(r.verdict).toBe('skip');
    expect(r.out).toContain('is what deploy-prod last tried');
  });

  it('the last-attempt file wins over the symlink: a rolled-back release is not retried by a site-only merge', () => {
    // c2 was tried, failed its health gate and was rolled back to c1; the host
    // serves c1 but last-attempt says c2. The site-only c3 behind it must not
    // try the same broken backend again.
    const r = run(h, { mode: 'prod', sha: h.c3, live: h.c2 });
    expect(r.verdict).toBe('skip');
    expect(r.out).toContain('nothing matching');
  });

  it('an older sha than the last attempt is never shipped backwards', () => {
    const r = run(h, { mode: 'prod', sha: h.c1, live: release(h.c2) });
    expect(r.verdict).toBe('skip');
    expect(r.out).toContain('not shipping backwards');
  });

  it('a forced run of an older sha ships exactly what it was asked for', () => {
    const r = run(h, { mode: 'prod', sha: h.c1, live: release(h.c2), force: true });
    expect(r.verdict).toBe('run');
  });

  it('the host records the attempt before the current symlink moves', () => {
    const block = runJob.slice(runJob.indexOf('  deploy-prod)'), runJob.indexOf('  deploy-git-host)'));
    const wrote = block.indexOf("> '$DEPLOY_ROOT/last-attempt'");
    const moved = block.indexOf("ln -sfn '$RELEASE' '$DEPLOY_ROOT/current'");
    expect(wrote).toBeGreaterThan(-1);
    expect(moved).toBeGreaterThan(wrote);
    expect(runJob).toMatch(/ssh \$FILTER_SSH_OPTS[\s\S]*ConnectTimeout|FILTER_SSH_OPTS="\$SSH_OPTS -o ConnectTimeout=/);
  });

  it('a live sha that is not an ancestor (after a rollback) still deploys when the backend differs', () => {
    // c2 changed the backend; d1 hangs off c1 and never saw it. A merge-base
    // diff would show only d1's site file and skip; the tree diff sees the
    // backend revert that has to ship.
    const r = run(h, { mode: 'prod', sha: h.d1, live: release(h.c2) });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('backend/a.ts');
  });

  it('an unreachable host deploys rather than guesses', () => {
    const r = run(h, { mode: 'prod', sha: h.c3 });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('no record of what deploy-prod last tried');
  });

  it('a missing current symlink deploys', () => {
    const r = run(h, { mode: 'prod', sha: h.c3, live: '' });
    expect(r.verdict).toBe('run');
  });

  it('a current that is not a release sha deploys', () => {
    const r = run(h, { mode: 'prod', sha: h.c3, live: '/opt/ia/current' });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('no record');
  });

  it('a live sha the clone no longer has deploys', () => {
    const r = run(h, { mode: 'prod', sha: h.c3, live: release('0123456789abcdef0123456789abcdef01234567') });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('not in this clone');
  });

  it('a forced (dispatched or coalesced) run never consults the range', () => {
    const r = run(h, { mode: 'prod', sha: h.c3, live: release(h.c3), force: true });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('forced');
  });
});

describe('the other jobs filter against what this runner last tried', () => {
  it('with no record the job runs, and records the sha', () => {
    const r = run(h, { mode: 'record', sha: h.c3 });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('no record of what self-update last tried');
    expect(r.recorded).toBe(h.c3);
  });

  it('a site-only tip over a ci-runner commit runs', () => {
    const r = run(h, { mode: 'record', sha: h.c3, record: h.c1 });
    expect(r.verdict).toBe('run');
    expect(r.out).toContain('infra/ci-runner/x.sh');
    expect(r.recorded).toBe(h.c3);
  });

  it('an empty range skips and the record still advances', () => {
    const r = run(h, { mode: 'record', sha: h.c3, record: h.c2 });
    expect(r.verdict).toBe('skip');
    expect(r.recorded).toBe(h.c3);
  });

  it('an older sha than the record is skipped, not re-installed', () => {
    const r = run(h, { mode: 'record', sha: h.c1, record: h.c3 });
    expect(r.verdict).toBe('skip');
    expect(r.out).toContain('not shipping backwards');
  });

  it('every record job records the attempt before its work, so a red run is not retried by unrelated merges', () => {
    for (const kind of ['deploy-git-host', 'machine-image', 'git-host-image', 'msg-host-image', 'copy-release', 'deploy-db-backup', 'self-update']) {
      const start = runJob.indexOf(`  ${kind})`);
      const block = runJob.slice(start, runJob.indexOf('\n    ;;', start));
      expect(block, kind).toMatch(/record_attempt\s+exit 78/);
      expect(block, kind).toMatch(/exit 78[^\n]*\n    fi\n    record_attempt/);
    }
  });
});
