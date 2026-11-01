import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The cutover switch (docs/platform-on-own-git.md step 4): one env variable,
 * PLATFORM_REPO, moves the platform's whole pipeline from GitHub-signed
 * deliveries to our own host's. Extracted-source tests, like ci-daemon.test.ts:
 * the routing table under test is the routing table that ships.
 *
 * What must hold, forever:
 *  - unarmed, nothing changes: agentgit pushes queue exactly ci-script, and
 *    GitHub pushes queue the full main set;
 *  - armed, an agentgit push to the platform repo's main queues the same set
 *    in the same order (self-update first), every job platform-tagged, plus
 *    the mirror;
 *  - armed, GitHub deliveries are IGNORED — the mirror's own pushes fire that
 *    webhook, and an echo must not deploy twice;
 *  - armed, other users' repos are completely unaffected.
 */
const DAEMON = fileURLToPath(new URL('../../../../infra/ci-runner/daemon.mjs', import.meta.url));

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

const PLATFORM = 'tg_owner/infinite-agents';

function load(env: Record<string, string>) {
  const source = readFileSync(DAEMON, 'utf8');
  const queued: Array<Record<string, unknown>> = [];
  const body = [grab(source, 'repoOf'), grab(source, 'handleEvent')].join('\n');
  const factory = new Function('enqueue', 'laneAConfigured', 'process',
    `${body}\n; return handleEvent;`);
  const handleEvent = factory(
    (job: Record<string, unknown>) => queued.push(job),
    () => true,
    { env },
  ) as (event: string, payload: unknown, opts?: { platform?: boolean }) => string;
  return { handleEvent, queued };
}

const push = (owner: string, name: string, branch: string) => ({
  ref: `refs/heads/${branch}`,
  after: 'a'.repeat(40),
  repository: { name, owner },
});

describe('the cutover switch', () => {
  it('unarmed: an agentgit push queues exactly ci-script, whoever pushes', () => {
    const { handleEvent, queued } = load({});
    handleEvent('push', push('tg_owner', 'infinite-agents', 'main'), { platform: true });
    expect(queued.map((j) => j.kind)).toEqual(['ci-script']);
  });

  it('armed: the platform repo\'s main queues the GitHub set, same order, platform-tagged, plus the mirror', () => {
    const { handleEvent, queued } = load({ PLATFORM_REPO: PLATFORM });
    handleEvent('push', push('tg_owner', 'infinite-agents', 'main'), { platform: true });
    expect(queued.map((j) => j.kind)).toEqual([
      'ci-script', 'self-update', 'deploy-prod', 'deploy-site',
      'deploy-git-host', 'deploy-db-backup', 'machine-image', 'git-host-image', 'msg-host-image', 'copy-release', 'mirror-github',
    ]);
    for (const job of queued) expect(job.platform).toBe(true);
    // Contexts must match what the GitHub path filed, or required-checks and
    // the Mini App pips would split one history into two.
    expect(queued.find((j) => j.kind === 'deploy-prod')?.context).toBe('deploy/prod');
  });

  it('armed: a feature-branch push gets checks and the mirror, no deploys', () => {
    const { handleEvent, queued } = load({ PLATFORM_REPO: PLATFORM });
    handleEvent('push', push('tg_owner', 'infinite-agents', 'agent/some-work'), { platform: true });
    expect(queued.map((j) => j.kind)).toEqual(['ci-script', 'mirror-github']);
  });

  it('armed: `dev` is an ordinary branch — the dev lane is retired', () => {
    // The dev host was deleted on 2026-09-05 (note #343): we merge straight to
    // main. A branch named `dev` must therefore deploy nowhere, exactly like
    // any other feature branch — not queue a job for a box that is gone.
    const { handleEvent, queued } = load({ PLATFORM_REPO: PLATFORM });
    handleEvent('push', push('tg_owner', 'infinite-agents', 'dev'), { platform: true });
    expect(queued.map((j) => j.kind)).toEqual(['ci-script', 'mirror-github']);
  });

  it('armed: GitHub deliveries are ignored — the mirror\'s echo must not deploy twice', () => {
    const { handleEvent, queued } = load({ PLATFORM_REPO: PLATFORM });
    const outcome = handleEvent('push', push('owner', 'infinite-agents', 'main'));
    expect(outcome).toContain('mirror');
    expect(queued).toEqual([]);
    const pr = handleEvent('pull_request', { action: 'opened', number: 1 });
    expect(pr).toContain('mirror');
    expect(queued).toEqual([]);
  });

  it('armed: every OTHER user\'s repo behaves exactly as before', () => {
    const { handleEvent, queued } = load({ PLATFORM_REPO: PLATFORM });
    handleEvent('push', push('tg_someone_else', 'their-app', 'main'), { platform: true });
    expect(queued.map((j) => j.kind)).toEqual(['ci-script']);
  });

  it('unarmed: the GitHub path still queues its full main set', () => {
    const { handleEvent, queued } = load({});
    handleEvent('push', push('owner', 'infinite-agents', 'main'));
    expect(queued.map((j) => j.kind)).toEqual([
      'self-update', 'checks', 'deploy-prod', 'deploy-site',
      'deploy-git-host', 'deploy-db-backup', 'machine-image', 'git-host-image', 'msg-host-image', 'copy-release',
    ]);
  });
});
