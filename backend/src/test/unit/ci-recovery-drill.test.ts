import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The escape-road drill and the GitHub mirror (docs/platform-on-own-git.md).
 * Same source-extraction technique as ci-daemon.test.ts for the daemon's
 * functions; the shell half is pinned by reading the script, because what
 * matters there is structure a syntax check cannot see: the double arming
 * gate, and credentials never entering argv.
 */
const DAEMON = fileURLToPath(new URL('../../../../infra/ci-runner/daemon.mjs', import.meta.url));
const RUN_JOB = fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url));

function grab(source: string, name: string): string {
  let start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} not found in daemon.mjs`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let i = source.indexOf('(', start);
  for (let parens = 0; i < source.length; i++) {
    if (source[i] === '(') parens++;
    else if (source[i] === ')' && --parens === 0) { i++; break; }
  }
  let depth = 0;
  for (i = source.indexOf('{', i); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const daemonSource = readFileSync(DAEMON, 'utf8');
const runJob = readFileSync(RUN_JOB, 'utf8');

describe('the recovery drill clock', () => {
  const DAY = 24 * 60 * 60_000;
  const due = new Function('DRILL_EVERY_MS',
    `${grab(daemonSource, 'recoveryDrillDue')}; return recoveryDrillDue;`)(DAY) as
    (stamp: string | undefined, nowMs: number) => boolean;
  const now = Date.parse('2026-08-13T12:00:00Z');

  it('runs when there is no stamp, a garbage stamp, or a day has passed', () => {
    expect(due(undefined, now)).toBe(true);
    expect(due('', now)).toBe(true);
    expect(due('not-a-date', now)).toBe(true);
    expect(due('2026-08-12T11:59:00Z', now)).toBe(true);
  });

  it('waits when the last attempt is younger than a day', () => {
    expect(due('2026-08-13T02:00:00Z', now)).toBe(false);
    // The stamp marks ATTEMPTS: a failing drill must not retry hourly.
    expect(due('2026-08-12T12:00:01Z', now)).toBe(false);
  });
});

describe('the drill and the mirror keep credentials out of argv', () => {
  it('the drill clones with a netrc under a throwaway HOME, never a token in the URL', () => {
    const drill = grab(daemonSource, 'runRecoveryDrill');
    expect(drill).toContain('.netrc');
    expect(drill).toContain('HOME: home');
    // The URL passed to git is the bare env value — no credential spliced in.
    expect(drill).not.toMatch(/RECOVERY_GIT_TOKEN.*@/);
  });

  it('the mirror job writes both tokens into a 077-umask netrc', () => {
    const section = runJob.slice(runJob.indexOf('mirror-github)'), runJob.indexOf('self-update)'));
    expect(section).toContain('umask 077');
    expect(section).toContain('.netrc');
    // Neither token may appear on a git command line.
    for (const line of section.split('\n').filter((l) => l.includes('git '))) {
      expect(line).not.toContain('TOKEN');
    }
  });
});

describe('the mirror is armed only by the flip', () => {
  it('run-job.sh exits 78 (skipped) when PLATFORM_REPO is unset', () => {
    const section = runJob.slice(runJob.indexOf('mirror-github)'), runJob.indexOf('self-update)'));
    expect(section).toMatch(/PLATFORM_REPO:-.*\}/s);
    expect(section).toContain('exit 78');
  });

  it('GITHUB_MIRROR=off skips the mirror before any credential or network is touched (note #936)', () => {
    // After the switch the platform repo is the public agentic-cloud, and the
    // GitHub copy holds the PRIVATE old history: a --prune --force push of the
    // new repository there would replace it. Run the real script: with the
    // switch off it must exit 78 with no RECOVERY_GIT_TOKEN set at all.
    const work = mkdtempSync(join(tmpdir(), 'mirror-off-'));
    try {
      const run = spawnSync('bash', [RUN_JOB, 'mirror-github', '0'.repeat(40)], {
        env: { PATH: process.env.PATH, HOME: work, WORKDIR: work, PLATFORM_REPO: 'ns/agentic-cloud', GITHUB_MIRROR: 'off', IA_PROD_HOST: 'prod.invalid', IA_GIT_HOST_HOST: 'git.invalid' },
        encoding: 'utf8',
      });
      expect(run.status).toBe(78);
      expect(run.stdout).toContain('GITHUB_MIRROR=off');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('the daemon queues a mirror only for THE repo named in its own env', () => {
    // The full behavioural coverage lives in ci-platform-pipeline.test.ts
    // (armed vs unarmed queue shapes); this pins only that the gate compares
    // against the daemon's OWN env, never anything from the payload.
    const handler = grab(daemonSource, 'handleEvent');
    expect(handler).toContain('`${repo.owner}/${repo.name}` === process.env.PLATFORM_REPO');
  });

  it('the mirror job skips the GitHub checkout its sha cannot satisfy yet', () => {
    // The preamble fetches $SHA from GitHub; the mirror's sha reaches GitHub
    // only when the mirror itself runs. The guard is what breaks the cycle.
    expect(runJob).toContain('if [ "$KIND" != "mirror-github" ]; then');
  });
});

describe('a transient GitHub error does not make the mirror lie', () => {
  const section = () => runJob.slice(runJob.indexOf('mirror-github)'), runJob.indexOf('self-update)'));

  it('retries the push instead of going red on the first answer', () => {
    // 2026-09-23: GitHub answered a mirror push with "Internal Server Error"
    // and applied both ref updates anyway. One attempt is not a verdict.
    expect(section()).toMatch(/for attempt in 1 2 3; do/);
    expect(section()).toContain('push attempt $attempt failed');
  });

  it('judges the run by the refs on GitHub, not by git\'s exit code', () => {
    // The status rides the sha whose push triggered the run, so a stale red
    // paints a failing pip on whatever proposal that sha heads and makes the
    // backend refuse its `pr ready`. Matching refs mean the copy is the copy.
    expect(section()).toContain("ls-remote \"$1\" refs/heads/main 'refs/tags/*'");
    expect(section()).toMatch(/diff -q "\$MIRROR_HOME\/ours\.refs" "\$MIRROR_HOME\/theirs\.refs"/);
  });

  it('a listing it cannot read is a failure, never a false all-clear', () => {
    expect(section()).toContain("could not read github.com/$TARGET's refs after 3 failed push attempts");
    expect(section()).toMatch(/still differs from \$INTERNAL_URL after 3 push attempts/);
  });
});
