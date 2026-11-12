import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Note #1174: the public GitHub copy of agentic-cloud. The old mirror,
 * adambaialiev/infinite-agents, holds the PRIVATE history, and this job
 * pushes with --force --prune — so what it may push, and where, is tested by
 * running the REAL run-job.sh: our host is a local bare repository, github.com
 * is redirected to local bare repositories (git's url.insteadOf, from env),
 * and `curl` is a stub that answers GitHub's "what is this repository?".
 */
const RUN_JOB = fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url));

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

interface World { root: string; work: string; bin: string; source: string; github: string; clone: string }

/** Our host's agentic-cloud with main, an agent's branch and a tag; an empty public GitHub repo. */
function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'gh-mirror-'));
  const source = join(root, 'host', 'ns', 'agentic-cloud.git');
  mkdirSync(source, { recursive: true });
  sh(source, 'init', '-q', '--bare', '-b', 'main');
  const clone = join(root, 'clone');
  sh(root, 'clone', '-q', source, clone);
  writeFileSync(join(clone, 'README.md'), 'one\n');
  sh(clone, 'add', '-A'); sh(clone, 'commit', '-qm', 'one');
  sh(clone, 'push', '-q', 'origin', 'HEAD:main');
  sh(clone, 'tag', 'v1'); sh(clone, 'push', '-q', 'origin', 'v1');
  sh(clone, 'checkout', '-qb', 'agent/work');
  writeFileSync(join(clone, 'wip.txt'), 'wip\n');
  sh(clone, 'add', '-A'); sh(clone, 'commit', '-qm', 'wip');
  sh(clone, 'push', '-q', 'origin', 'agent/work');
  sh(clone, 'checkout', '-q', 'main');
  const github = join(root, 'github');
  for (const name of ['adambaialiev/agentic-cloud', 'adambaialiev/infinite-agents']) {
    mkdirSync(join(github, `${name}.git`), { recursive: true });
    sh(join(github, `${name}.git`), 'init', '-q', '--bare');
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // curl: answers the repository lookup from STUB_* env, and records which
  // tokens the netrc it was handed holds (by sentinel, never a real token).
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
netrc=""; url=""
while [ $# -gt 0 ]; do case "$1" in --netrc-file) netrc="$2"; shift 2;; -H|--max-time) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
{ echo "url=$url"; grep -q mirror-token-sentinel "$netrc" && echo "netrc=mirror-token"; grep -q broad-token-sentinel "$netrc" && echo "netrc=BROAD-TOKEN"; } >> "$STUB_LOG"
[ "\${STUB_STATUS:-200}" = 200 ] || exit 22
printf '{"full_name":"%s","private":%s}' "\${STUB_FULL_NAME:-\${url#*/repos/}}" "\${STUB_PRIVATE:-false}"
`);
  chmodSync(join(bin, 'curl'), 0o755);
  const work = join(root, 'work');
  mkdirSync(work);
  return { root, work, bin, source, github, clone };
}

function run(w: World, env: Record<string, string | undefined>): { code: number; out: string; curl: string } {
  const log = join(w.root, `curl-${Math.random().toString(36).slice(2)}.log`);
  const base: Record<string, string> = {
    PATH: `${w.bin}:${process.env.PATH}`, HOME: w.work, WORKDIR: w.work,
    IA_PROD_HOST: 'prod.invalid', IA_GIT_HOST_HOST: 'git.invalid',
    PLATFORM_REPO: 'ns/agentic-cloud', PLATFORM_GIT_BASE: `file://${join(w.root, 'host')}`,
    RECOVERY_GIT_TOKEN: 'recovery-sentinel', GH_TOKEN: 'broad-token-sentinel',
    REPO: 'adambaialiev/infinite-agents',
    GITHUB_MIRROR_REPO: 'adambaialiev/agentic-cloud', GITHUB_MIRROR_TOKEN: 'mirror-token-sentinel',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${w.github}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/',
    STUB_LOG: log,
  };
  const merged: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k]; else merged[k] = v;
  }
  const r = spawnSync('bash', [RUN_JOB, 'mirror-github', '0'.repeat(40)], { env: merged, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, curl: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

const refs = (bare: string): string => sh(bare, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).sort().join(' ');

describe('mirror-github pushes main and tags to the named public repository only (note #1174)', () => {
  it('copies main and tags — never an agent branch — with its own token, never the broad one', () => {
    const w = world();
    const r = run(w, {});
    expect(r.out).toContain('main + tags -> github.com/adambaialiev/agentic-cloud');
    expect(r.code).toBe(0);
    const gh = join(w.github, 'adambaialiev/agentic-cloud.git');
    expect(refs(gh)).toBe('refs/heads/main refs/tags/v1');
    expect(sh(gh, 'rev-parse', 'main')).toBe(sh(w.source, 'rev-parse', 'main'));
    expect(r.curl).toContain('url=https://api.github.com/repos/adambaialiev/agentic-cloud');
    expect(r.curl).toContain('netrc=mirror-token');
    expect(r.curl).not.toContain('BROAD-TOKEN');
    // The old private mirror, named by REPO, is never touched.
    expect(refs(join(w.github, 'adambaialiev/infinite-agents.git'))).toBe('');
  });

  it('follows main forward and drops a deleted tag on the next run', () => {
    const w = world();
    expect(run(w, {}).code).toBe(0);
    writeFileSync(join(w.clone, 'README.md'), 'two\n');
    sh(w.clone, 'commit', '-qam', 'two');
    sh(w.clone, 'push', '-q', 'origin', 'HEAD:main');
    sh(w.clone, 'push', '-q', 'origin', ':refs/tags/v1');
    const r = run(w, {});
    expect(r.code).toBe(0);
    const gh = join(w.github, 'adambaialiev/agentic-cloud.git');
    expect(refs(gh)).toBe('refs/heads/main');
    expect(sh(gh, 'rev-parse', 'main')).toBe(sh(w.source, 'rev-parse', 'main'));
  });

  it('pushes nothing when no target is named — REPO is never a fallback', () => {
    const w = world();
    const r = run(w, { GITHUB_MIRROR_REPO: undefined });
    expect(r.code).toBe(78);
    expect(r.out).toContain('GITHUB_MIRROR_REPO unset');
    expect(r.curl).toBe('');
    expect(refs(join(w.github, 'adambaialiev/infinite-agents.git'))).toBe('');
  });

  it('refuses the old private mirror by name, before any network', () => {
    const w = world();
    for (const target of ['adambaialiev/infinite-agents', 'AdamBaialiev/Infinite-Agents', 'adambaialiev/retired-github-mirror']) {
      const r = run(w, { GITHUB_MIRROR_REPO: target });
      expect(r.code, target).toBe(1);
      expect(r.out).toContain('old private mirror');
      expect(r.curl).toBe('');
    }
    expect(refs(join(w.github, 'adambaialiev/infinite-agents.git'))).toBe('');
  });

  it('never pushes to a private repository, whatever its name', () => {
    const w = world();
    const r = run(w, { STUB_PRIVATE: 'true' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('is private');
    expect(refs(join(w.github, 'adambaialiev/agentic-cloud.git'))).toBe('');
  });

  it('refuses a repository GitHub resolves to another name (a rename), and one it cannot read', () => {
    const w = world();
    const renamed = run(w, { STUB_FULL_NAME: 'adambaialiev/infinite-agents' });
    expect(renamed.code).toBe(1);
    expect(renamed.out).toContain('did not name');
    const unreadable = run(w, { STUB_STATUS: '404' });
    expect(unreadable.code).toBe(1);
    expect(unreadable.out).toContain('nothing pushed');
    expect(refs(join(w.github, 'adambaialiev/agentic-cloud.git'))).toBe('');
    expect(refs(join(w.github, 'adambaialiev/infinite-agents.git'))).toBe('');
  });

  it('needs its own token: without GITHUB_MIRROR_TOKEN it fails rather than borrow GH_TOKEN', () => {
    const w = world();
    const r = run(w, { GITHUB_MIRROR_TOKEN: undefined });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('GITHUB_MIRROR_TOKEN unset');
    expect(r.curl).toBe('');
  });

  it('GITHUB_MIRROR=off still wins over everything', () => {
    const w = world();
    const r = run(w, { GITHUB_MIRROR: 'off' });
    expect(r.code).toBe(78);
    expect(r.curl).toBe('');
  });
});
