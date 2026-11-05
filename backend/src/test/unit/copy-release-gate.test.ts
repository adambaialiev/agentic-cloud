/**
 * The offer gate (note #1008): infra/copy-release/gate.sh tries a release on
 * the standing test copy, both drills and then the upgrade, and offers it only
 * when every step passed. Run for real here with stand-ins for the installer,
 * the offer and flyctl, which record what they were asked.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GATE = path.resolve(__dirname, '../../../../infra/copy-release/gate.sh');

function run({ failOn }: { failOn?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-'));
  const calls = path.join(dir, 'calls.txt');
  writeFileSync(path.join(dir, 'acc-testcopy-copy.json'), JSON.stringify({ prefix: 'acc-testcopy', org: 'scratch-org' }));
  // The installer: records its arguments and the token it ran with, and fails on one step when told.
  writeFileSync(path.join(dir, 'installer.mjs'), `
    import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2).join(' ');
    appendFileSync(${JSON.stringify(calls)}, 'install ' + args + ' token=' + process.env.FLY_API_TOKEN + '\\n');
    if (${JSON.stringify(failOn ?? '')} && args.includes(${JSON.stringify(failOn ?? '')})) process.exit(1);
  `);
  writeFileSync(path.join(dir, 'offer.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(calls)}, 'offer ' + process.argv.slice(2).join(' ') + ' token=' + process.env.FLY_API_TOKEN + ' repo=' + process.env.RELEASE_REPO + '\\n');
  `);
  const flyDir = path.join(dir, 'fly');
  spawnSync('mkdir', ['-p', flyDir]);
  writeFileSync(path.join(flyDir, 'flyctl'), '#!/bin/sh\n[ "$1" = wireguard ] && [ "$2" = list ] && echo "[]"\nexit 0\n');
  chmodSync(path.join(flyDir, 'flyctl'), 0o755);
  const result = spawnSync('bash', [GATE], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: dir, VERSION: '2026.11.10.0', COPY_TEST_FLY_TOKEN: 'scratch-token', FLY_API_TOKEN: 'our-token',
      COPY_TEST_STATE_DIR: dir, COPY_TEST_FLYCTL_DIR: flyDir, COPY_TEST_INSTALLER: path.join(dir, 'installer.mjs'),
      COPY_TEST_OFFER: path.join(dir, 'offer.mjs'), RELEASE_REPO: 'acc-copy-releases', GATE_RUN: 'abc123',
    },
  });
  return { ...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

describe('the offer gate script (note #1008)', () => {
  it('runs the backend drill, the drill and the upgrade with the test copy\'s token, then offers with ours', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      'install upgrade --name acc-testcopy --release 2026.11.10.0 --drill backend --json token=scratch-token',
      'install upgrade --name acc-testcopy --release 2026.11.10.0 --drill --json token=scratch-token',
      'install upgrade --name acc-testcopy --release 2026.11.10.0 --json token=scratch-token',
      `install status --state ${r.calls[3]!.split('--state ')[1]!.split(' ')[0]} --json token=scratch-token`,
      'offer 2026.11.10.0 --gate passed --run abc123 token=our-token repo=acc-copy-releases',
    ]);
    expect(r.stdout).toContain('GATE PASSED for 2026.11.10.0');
  });

  it('stops at the first failure and offers nothing', () => {
    const r = run({ failOn: '--drill backend' });
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls.some((call) => call.startsWith('offer'))).toBe(false);
    expect(r.stdout).toContain('GATE FAILED: release 2026.11.10.0 is built but NOT offered. Companies keep the release they were offered.');
    expect(r.stdout).toContain('offer.mjs 2026.11.10.0 --override --by <who> --reason');
  });

  it('a failed upgrade after both drills passed still offers nothing', () => {
    const r = run({ failOn: '--release 2026.11.10.0 --json' });
    expect(r.status).toBe(1);
    expect(r.calls.map((call) => call.split(' token=')[0])).toEqual([
      'install upgrade --name acc-testcopy --release 2026.11.10.0 --drill backend --json',
      'install upgrade --name acc-testcopy --release 2026.11.10.0 --drill --json',
      'install upgrade --name acc-testcopy --release 2026.11.10.0 --json',
    ]);
  });
});

describe('the CI runner wires the gate in (note #1008)', () => {
  const RUNNER = path.resolve(__dirname, '../../../../infra/ci-runner');
  it('copy-release runs the gate right after the build, and copy-release-gate runs it alone', () => {
    const job = readFileSync(path.join(RUNNER, 'run-job.sh'), 'utf8');
    const release = job.slice(job.indexOf('\n  copy-release)'), job.indexOf('\n  copy-release-gate)'));
    expect(release.indexOf('./infra/copy-release/build.sh')).toBeGreaterThan(0);
    expect(release.indexOf('run_copy_release_gate')).toBeGreaterThan(release.indexOf('./infra/copy-release/build.sh'));
    const alone = job.slice(job.indexOf('\n  copy-release-gate)'));
    expect(alone.slice(0, alone.indexOf(';;'))).toContain('run_copy_release_gate');
    // The function is defined before the jobs, after the checkout, with the gate's own settings.
    const fn = job.indexOf('run_copy_release_gate() {');
    expect(fn).toBeGreaterThan(job.indexOf('git checkout --quiet --force "$SHA"'));
    expect(fn).toBeLessThan(job.indexOf('case "$KIND" in'));
    expect(job.slice(fn, job.indexOf('\n}\n', fn))).toContain('./infra/copy-release/gate.sh');
  });

  it('copy-release-gate can be dispatched', () => {
    const daemon = readFileSync(path.join(RUNNER, 'daemon.mjs'), 'utf8');
    expect(daemon).toMatch(/const DISPATCHABLE = new Set\(\[[^\]]*'copy-release-gate'/);
  });
});
