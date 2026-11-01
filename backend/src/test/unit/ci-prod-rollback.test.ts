import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * deploy-prod's safety net: a release that does not activate or does not
 * answer /api/health is rolled back to the release that was serving before,
 * by the job itself. Exercised by running the real shell — the prod activation
 * block and roll_back_prod lifted out of run-job.sh — against a fake `ssh`
 * that records what it was asked and a fake `curl` that answers a fixed code.
 * Reading the script for the right words would not catch a wrong exit path.
 */
const RUN_JOB = fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url));
const runJob = readFileSync(RUN_JOB, 'utf8');

function lift(): { fn: string; block: string } {
  const fnStart = runJob.indexOf('roll_back_prod() {');
  const fnEnd = runJob.indexOf('\n}\n', fnStart) + 3;
  // Indented 4, not 6: the block stopped being the `else` half of an
  // if/else on $KIND when the dev lane was retired (note #343, 2026-09-05).
  const blockStart = runJob.indexOf('    prod_activated=1');
  const tail = '      exit 1\n    fi\n';
  const blockEnd = runJob.indexOf(tail, blockStart) + tail.length;
  if (fnStart < 0 || blockStart < 0 || blockEnd < tail.length) throw new Error('prod rollback block not found');
  const block = runJob.slice(blockStart, blockEnd).split('\n')
    .map((l) => (l.startsWith('    ') ? l.slice(4) : l)).join('\n');
  return { fn: runJob.slice(fnStart, fnEnd), block };
}

interface Scenario {
  enabled?: boolean;
  activates?: boolean;
  health?: string;
  rollbackOk?: boolean;
  prev?: string;
}

function run(s: Scenario): { code: number; out: string; ssh: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'prod-rollback-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'ssh.log');
  writeFileSync(join(bin, 'ssh'), [
    '#!/usr/bin/env bash',
    'cmd="${@: -1}"',
    `printf '%s\\n' "$cmd" >> '${log}'`,
    `case "$cmd" in *is-enabled*) exit ${s.enabled === false ? 1 : 0};; *ia-rollback*) exit ${s.rollbackOk === false ? 1 : 0};; *) exit 0;; esac`,
  ].join('\n'));
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\necho '${s.health ?? '000'}'\nexit 22\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const { fn, block } = lift();
  const script = [
    'set -uo pipefail',
    'SSH_OPTS="-i key"; PROD_HOST=prod; HOST=prod; DEPLOY_ROOT=/opt/ia; SHA=newsha',
    'RELEASE=/opt/ia/releases/newsha',
    `PREV_RELEASE='${s.prev ?? '/opt/ia/releases/oldsha'}'`,
    `install_prod_backend_units() { return ${s.activates === false ? 1 : 0}; }`,
    'sleep() { :; }',
    fn,
    block,
  ].join('\n');
  writeFileSync(join(dir, 'run.sh'), script);
  writeFileSync(log, '');
  const r = spawnSync('bash', [join(dir, 'run.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  return {
    code: r.status ?? -1,
    out: `${r.stdout}${r.stderr}`,
    ssh: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

describe('deploy-prod rolls a bad release back on its own', () => {
  it('a healthy release passes and touches nothing', () => {
    const r = run({ health: '200' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('prod healthy');
    expect(r.ssh.some((c) => c.includes('ia-rollback'))).toBe(false);
  });

  it('a release that never answers 200 is rolled back to the previous sha, and its dir removed', () => {
    const r = run({ health: '502' });
    expect(r.code).toBe(1);
    expect(r.ssh).toContain("ia-rollback 'oldsha'");
    expect(r.ssh).toContain("rm -rf '/opt/ia/releases/newsha'");
    expect(r.out).toContain('back on oldsha');
  });

  it('a release that fails to activate is rolled back too, and a failed rollback asks for a human', () => {
    const r = run({ activates: false, rollbackOk: false });
    expect(r.code).toBe(1);
    expect(r.ssh).toContain("ia-rollback 'oldsha'");
    expect(r.ssh.some((c) => c.startsWith('rm -rf'))).toBe(false);
    expect(r.out).toContain('needs a human');
  });

  it('a dormant (disabled) service is not polled and not rolled back', () => {
    const r = run({ enabled: false, health: '502' });
    expect(r.code).toBe(0);
    expect(r.ssh.some((c) => c.includes('ia-rollback'))).toBe(false);
  });

  it('with nothing to go back to, the failure is reported and nothing is flipped', () => {
    const r = run({ health: '502', prev: '' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('no previous release');
    expect(r.ssh.some((c) => c.includes('ia-rollback'))).toBe(false);
  });
});
