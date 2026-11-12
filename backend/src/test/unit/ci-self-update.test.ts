import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The dispatcher's `self-update` job (run-job.sh) replaces the code our own
 * releases ship with, so a mistake there is the one CI cannot fix by itself.
 * Note #1166 item 3 adds a file to what it installs (ci-verdicts.mjs, which
 * lane-a.mjs will import), and the old loop died on a file the box did not
 * have yet (`cp -a` of a missing file under `set -e`).
 *
 * Exercised by running the REAL case body lifted out of run-job.sh against a
 * temporary /opt/ia-ci, with the path filter stubbed to "changed". Reading the
 * script for the right words would not catch a wrong exit path.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CI_RUNNER = join(HERE, '../../../../infra/ci-runner');
const RUN_JOB = join(CI_RUNNER, 'run-job.sh');
const runJob = readFileSync(RUN_JOB, 'utf8');

function selfUpdateBody(): string {
  const start = runJob.indexOf('\n  self-update)\n');
  const end = runJob.indexOf('\n    ;;\n', start);
  if (start < 0 || end < 0) throw new Error('self-update case not found in run-job.sh');
  return runJob.slice(start + '\n  self-update)\n'.length, end);
}

function selfFiles(): string[] {
  const m = /^\s*SELF_FILES="([^"]+)"/m.exec(selfUpdateBody());
  if (!m) throw new Error('SELF_FILES not found in the self-update case');
  return m[1].split(/\s+/);
}

/** A temporary repo checkout (infra/ci-runner = this tree's files) and /opt/ia-ci. */
function stage(): { root: string; src: string; opt: string } {
  const root = mkdtempSync(join(tmpdir(), 'self-update-'));
  const src = join(root, 'repo', 'infra', 'ci-runner');
  mkdirSync(src, { recursive: true });
  cpSync(CI_RUNNER, src, { recursive: true });
  const opt = join(root, 'opt-ia-ci');
  mkdirSync(opt);
  return { root, src, opt };
}

function run(s: { root: string; opt: string }): { code: number; out: string } {
  const body = selfUpdateBody();
  if (!body.includes('OPT=/opt/ia-ci\n')) throw new Error('OPT=/opt/ia-ci not found in the self-update case');
  const script = [
    'set -euo pipefail',
    `REPO_DIR='${join(s.root, 'repo')}'`,
    'changed_since() { return 0; }; last_attempted() { :; }; record_attempt() { :; }',
    body.replace('OPT=/opt/ia-ci\n', `OPT='${s.opt}'\n`),
    'echo SELF-UPDATE-DONE',
  ].join('\n');
  const file = join(s.root, 'run.sh');
  writeFileSync(file, script);
  const r = spawnSync('bash', [file], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('self-update installs every file the daemon runs from /opt/ia-ci', () => {
  it('installs ci-verdicts.mjs on a box that never had it — nothing to keep, nothing dies', () => {
    const s = stage();
    // The box as it stands before note #1166: the four old files, current.
    for (const f of ['daemon.mjs', 'lane-a.mjs', 'run-job.sh', 'runner-agent.sh']) cpSync(join(s.src, f), join(s.opt, f));
    const r = run(s);
    expect(r.out).toContain('SELF-UPDATE-DONE');
    expect(r.code).toBe(0);
    expect(readFileSync(join(s.opt, 'ci-verdicts.mjs'), 'utf8')).toBe(readFileSync(join(s.src, 'ci-verdicts.mjs'), 'utf8'));
    expect(existsSync(join(s.opt, 'ci-verdicts.mjs.previous'))).toBe(false);
    expect(r.out).toContain('installed ci-verdicts.mjs (new here — no previous copy)');
    expect(r.out).toContain('daemon.mjs unchanged');
    // The daemon imports it (or will), so it must come back on it.
    expect(existsSync(join(s.opt, '.restart-requested'))).toBe(true);
  });

  it('keeps the previous copy of a file it replaces, and asks no restart for run-job.sh alone', () => {
    const s = stage();
    for (const f of selfFiles()) cpSync(join(s.src, f), join(s.opt, f));
    writeFileSync(join(s.opt, 'run-job.sh'), '#!/usr/bin/env bash\necho old\n');
    const r = run(s);
    expect(r.code).toBe(0);
    expect(readFileSync(join(s.opt, 'run-job.sh.previous'), 'utf8')).toBe('#!/usr/bin/env bash\necho old\n');
    expect(readFileSync(join(s.opt, 'run-job.sh'), 'utf8')).toBe(runJob);
    expect(existsSync(join(s.opt, '.restart-requested'))).toBe(false);
  });

  it('refuses a ci-verdicts.mjs that will not parse, before replacing anything', () => {
    const s = stage();
    for (const f of ['daemon.mjs', 'lane-a.mjs', 'run-job.sh', 'runner-agent.sh']) cpSync(join(s.src, f), join(s.opt, f));
    writeFileSync(join(s.opt, 'run-job.sh'), '#!/usr/bin/env bash\necho old\n');
    writeFileSync(join(s.src, 'ci-verdicts.mjs'), 'export function publishVerdict( {\n');
    const r = run(s);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('SELF-UPDATE-DONE');
    expect(readdirSync(s.opt).sort()).toEqual(['daemon.mjs', 'lane-a.mjs', 'run-job.sh', 'runner-agent.sh']);
    expect(readFileSync(join(s.opt, 'run-job.sh'), 'utf8')).toBe('#!/usr/bin/env bash\necho old\n');
  });

  it('every file the daemon loads beside itself is on the install list, and in the image seed', () => {
    const list = selfFiles();
    const siblings = new Set(readdirSync(CI_RUNNER));
    const loaded = new Set<string>(['daemon.mjs', 'run-job.sh']);
    // Follow what each installed module imports or reads by name from its own
    // directory: a relative import, or a sibling file named in a string.
    const queue = ['daemon.mjs'];
    while (queue.length) {
      const file = queue.shift()!;
      const source = readFileSync(join(CI_RUNNER, file), 'utf8');
      const names = [
        ...[...source.matchAll(/from\s+'\.\/([^']+)'/g)].map((m) => m[1]),
        ...[...source.matchAll(/import\(\s*'\.\/([^']+)'\s*\)/g)].map((m) => m[1]),
        ...[...source.matchAll(/'([\w.-]+\.(?:mjs|sh))'/g)].map((m) => m[1]),
      ].filter((n) => siblings.has(n) && n !== 'ia-rollback.sh');
      for (const n of names) {
        if (!loaded.has(n)) {
          loaded.add(n);
          if (n.endsWith('.mjs')) queue.push(n);
        }
      }
    }
    expect(loaded.has('lane-a.mjs')).toBe(true);
    expect(loaded.has('runner-agent.sh')).toBe(true);
    for (const n of loaded) expect(list, `${n} is loaded by the daemon but self-update does not install it`).toContain(n);
    expect(list).toContain('ci-verdicts.mjs');
    // A module's imports come before it, so one run never leaves an importer
    // beside a missing file.
    expect(list.indexOf('ci-verdicts.mjs')).toBeLessThan(list.indexOf('lane-a.mjs'));

    const dockerfile = readFileSync(join(CI_RUNNER, '../ci-fly/Dockerfile'), 'utf8');
    const seed = /^COPY (.+) \/opt\/ia-ci-seed\/$/m.exec(dockerfile);
    expect(seed, 'the image seed COPY line').not.toBeNull();
    expect(seed![1].split(/\s+/).map((p) => p.replace(/^ci-runner\//, '')).sort()).toEqual([...list].sort());
  });
});
