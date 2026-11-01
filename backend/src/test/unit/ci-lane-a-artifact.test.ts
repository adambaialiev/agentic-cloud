import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * lane-a.mjs's artifact acceptance is the trust boundary for deploy artifacts:
 * a tarball it lets through is extracted and rsync'd onto the production host.
 * Same technique as ci-daemon.test.ts — the function's SOURCE is lifted out
 * and run with collaborators injected, so the text under test is the text
 * that ships. What must hold, forever:
 *   - only a job the dispatcher is actually waiting on can deliver
 *   - the body must hash to the sha the sender claims (a truncated or
 *     tampered upload dies here, not on the prod host)
 *   - the claim must be signed with the per-job token (a machine can deliver
 *     its own job's artifact and nothing else)
 *   - a refused upload leaves no file behind
 */
const LANE_A = fileURLToPath(new URL('../../../../infra/ci-runner/lane-a.mjs', import.meta.url));

function grab(source: string, name: string): string {
  let start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} not found in lane-a.mjs`);
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

const SHA_A = 'a'.repeat(64);

function load(pendingJobs: Record<string, { token: string }>) {
  const source = readFileSync(LANE_A, 'utf8');
  const factory = new Function(
    'pending', 'createHmac', 'timingSafeEqual', 'Buffer', 'path', 'renameSync', 'rmSync',
    `${grab(source, 'acceptArtifact')}; return acceptArtifact;`,
  );
  const renames: Array<[string, string]> = [];
  const removals: string[] = [];
  const accept = factory(
    new Map(Object.entries(pendingJobs)),
    createHmac,
    (a: Buffer, b: Buffer) => a.equals(b),
    Buffer,
    path,
    (from: string, to: string) => renames.push([from, to]),
    (p: string) => removals.push(p),
  ) as (args: Record<string, unknown>) => { ok: boolean; status: number; error?: string; path?: string };
  return { accept, renames, removals };
}

function sign(token: string, jobId: string, sha256: string): string {
  return 'sha256=' + createHmac('sha256', token).update(`${jobId}:${sha256}`).digest('hex');
}

const base = {
  jobId: 'build-backend-abc1234-deadbeef',
  computedSha256: SHA_A,
  claimedSha256: SHA_A,
  tmpPath: '/tmp/x.part',
  artifactDir: '/tmp/artifacts',
};

describe('lane A artifact acceptance', () => {
  it('accepts a correctly signed artifact and renames it into place', () => {
    const { accept, renames, removals } = load({ [base.jobId]: { token: 'tok' } });
    const outcome = accept({ ...base, signatureHeader: sign('tok', base.jobId, SHA_A) });
    expect(outcome.ok).toBe(true);
    expect(outcome.path).toBe(path.join(base.artifactDir, `${base.jobId}.tar.gz`));
    expect(renames).toEqual([[base.tmpPath, outcome.path]]);
    expect(removals).toEqual([]);
  });

  it('refuses a job nobody is waiting on, and deletes the spool', () => {
    const { accept, removals } = load({});
    const outcome = accept({ ...base, signatureHeader: sign('tok', base.jobId, SHA_A) });
    expect(outcome).toMatchObject({ ok: false, status: 404 });
    expect(removals).toEqual([base.tmpPath]);
  });

  it('refuses a body that does not hash to its claim — a tampered upload dies here', () => {
    const { accept, renames, removals } = load({ [base.jobId]: { token: 'tok' } });
    const outcome = accept({
      ...base,
      computedSha256: 'b'.repeat(64),
      signatureHeader: sign('tok', base.jobId, SHA_A),
    });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    expect(renames).toEqual([]);
    expect(removals).toEqual([base.tmpPath]);
  });

  it('refuses a signature from the wrong job token — one machine, one job', () => {
    const { accept, renames, removals } = load({ [base.jobId]: { token: 'tok' } });
    const outcome = accept({ ...base, signatureHeader: sign('other-token', base.jobId, SHA_A) });
    expect(outcome).toMatchObject({ ok: false, status: 401 });
    expect(renames).toEqual([]);
    expect(removals).toEqual([base.tmpPath]);
  });

  it('refuses a malformed sha claim before doing any crypto', () => {
    const { accept } = load({ [base.jobId]: { token: 'tok' } });
    const outcome = accept({ ...base, claimedSha256: 'not-a-sha', signatureHeader: 'sha256=xx' });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
  });
});

describe('runner-agent build kinds', () => {
  const agent = readFileSync(
    fileURLToPath(new URL('../../../../infra/ci-runner/runner-agent.sh', import.meta.url)),
    'utf8',
  );

  it('uploads BEFORE reporting, so a green result implies the artifact arrived', () => {
    // The dispatcher relies on this ordering: on exit 0 it treats a missing
    // artifact as an upload-path bug, not a race.
    for (const kind of ['build-backend)', 'build-site)']) {
      const section = agent.slice(agent.indexOf(kind));
      const upload = section.indexOf('upload_artifact');
      expect(upload).toBeGreaterThan(-1);
      expect(upload).toBeLessThan(section.indexOf(';;'));
    }
    expect(agent.indexOf('upload_artifact')).toBeLessThan(agent.indexOf('report "$CODE"'));
  });

  it('build steps mirror the deploy build half of run-job.sh', () => {
    // The artifact replaces a local build byte-for-byte in spirit: same
    // steps, same .release layout. If run-job.sh's fallback and this drift
    // apart, deploys behave differently depending on which path built them.
    expect(agent).toContain('npm prune --omit=dev');
    expect(agent).toContain(
      'cp -R backend/dist backend/node_modules backend/assets backend/scripts',
    );
    expect(agent).toContain('RELEASE_SHA');
  });
});
