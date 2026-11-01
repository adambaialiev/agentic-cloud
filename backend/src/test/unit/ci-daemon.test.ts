import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CI daemon is a long-running process that binds a port the moment it is
 * imported, so it cannot be require()'d into a test. Its status ingest is worth
 * testing anyway — a lost verdict leaves a commit looking untested forever, and
 * that is precisely the failure this retry ladder exists for.
 *
 * So we lift the real function's SOURCE out of the file and run it with its
 * collaborators injected. Not a copy — the text under test is the text that
 * ships, and a change to the loop changes what these assertions see. Only the
 * delay ladder is swapped, for a suite that finishes in milliseconds.
 */
const DAEMON = fileURLToPath(new URL('../../../../infra/ci-runner/daemon.mjs', import.meta.url));

/** Pull one `async function name(...) { ... }` out by brace-matching. */
function grab(source: string, name: string): string {
  let start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} not found in daemon.mjs`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  // Step over the parameter list before looking for the body. A destructured
  // parameter — `handleEvent(event, payload, { platform = false } = {})` —
  // carries braces of its own, and matching from the first one truncates the
  // function at the end of its own signature: valid-looking text that will not
  // parse, which reads as "the daemon is broken" rather than "the test is".
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

type Attempt = { body: Record<string, unknown> };

/**
 * Build the real postIngest with stubbed collaborators. `responses` is consumed
 * one per attempt: a number is an HTTP status, an Error is a thrown fetch (the
 * shape of a backend mid-restart).
 */
function loadPostIngest(responses: Array<number | Error>, delays = [1, 1, 1, 1, 1]) {
  const attempts: Attempt[] = [];
  const logs: string[] = [];
  const slept: number[] = [];
  const source = grab(readFileSync(DAEMON, 'utf8'), 'postIngest');

  const fetchStub = async (_url: string, init: { body: string }) => {
    const next = responses[attempts.length] ?? responses[responses.length - 1];
    attempts.push({ body: JSON.parse(init.body) });
    if (next instanceof Error) throw next;
    return { ok: next >= 200 && next < 300, status: next };
  };

  const factory = new Function(
    'STATUS_INGEST_URL', 'CI_STATUS_SECRET', 'INGEST_RETRY_DELAYS_MS', 'INGEST_TIMEOUT_MS',
    'sleep', 'log', 'fetch',
    `${source}; return postIngest;`,
  );
  const postIngest = factory(
    'https://api.test/git/statuses',
    'secret',
    delays,
    15000,
    async (ms: number) => { slept.push(ms); },
    (line: string) => { logs.push(line); },
    fetchStub,
  ) as (job: unknown, state: string, description: string, logTail?: string) => Promise<void>;

  const job = { repo: { owner: 'user-1', name: 'ci-rehearsal' }, sha: 'a'.repeat(40), context: 'ci/checks' };
  return { postIngest, job, attempts, logs, slept };
}

describe('CI daemon status ingest', () => {
  it('rides out a backend that is restarting, and says that it did', async () => {
    // The real failure: `deploy/prod@b44a1ca` was lost to a 502 thrown by the
    // deploy of the very commit it was reporting on.
    const h = loadPostIngest([502, 502, 200]);
    await h.postIngest(h.job, 'success', 'all checks passed');

    expect(h.attempts.length).toBe(3);
    expect(h.slept.length).toBe(2);
    expect(h.logs.at(-1)).toMatch(/recovered .* after 3 attempts/);
    // Same verdict every time — a retry must not become a different status.
    expect(new Set(h.attempts.map((a) => a.body.state))).toEqual(new Set(['success']));
    expect(h.attempts[0].body).toMatchObject({
      owner: 'user-1', repo: 'ci-rehearsal', context: 'ci/checks', state: 'success',
    });
  });

  it('treats a thrown fetch the same as a 5xx', async () => {
    // Connection refused is what a restart looks like from this side.
    const h = loadPostIngest([new Error('fetch failed'), 200]);
    await h.postIngest(h.job, 'failure', 'tests failed');

    expect(h.attempts.length).toBe(2);
    expect(h.logs.at(-1)).toMatch(/recovered/);
  });

  it('never retries a pending — it would overwrite the verdict it precedes', async () => {
    // The store upserts on (sha, context), last write wins. A pending that
    // rode out a restart could land AFTER the success it came before and turn
    // a finished check into one that spins forever.
    const h = loadPostIngest([502, 200]);
    await h.postIngest(h.job, 'pending', 'Running in an ephemeral VM');

    expect(h.attempts.length).toBe(1);
    expect(h.slept).toEqual([]);
  });

  it('never retries a 4xx: the same request earns the same refusal', async () => {
    // 401 is the wrong secret and 400 is a payload built identically next time.
    for (const status of [400, 401, 403, 404]) {
      const h = loadPostIngest([status, 200]);
      await h.postIngest(h.job, 'success', 'all checks passed');
      expect(h.attempts.length, `${status} must not be retried`).toBe(1);
      expect(h.logs.at(-1)).toMatch(new RegExp(`failed ${status}`));
    }
  });

  it('gives up after the ladder, and the log says how many tries it took', async () => {
    const h = loadPostIngest([502]);
    await h.postIngest(h.job, 'error', 'runner exploded');

    // One immediate attempt plus one per rung.
    expect(h.attempts.length).toBe(6);
    expect(h.slept.length).toBe(5);
    expect(h.logs.at(-1)).toMatch(/gave up after 6 attempts/);
  });

  it('stays silent when the ingest is not configured', async () => {
    const source = grab(readFileSync(DAEMON, 'utf8'), 'postIngest');
    const factory = new Function(
      'STATUS_INGEST_URL', 'CI_STATUS_SECRET', 'INGEST_RETRY_DELAYS_MS', 'INGEST_TIMEOUT_MS',
      'sleep', 'log', 'fetch',
      `${source}; return postIngest;`,
    );
    let called = false;
    const postIngest = factory('', '', [1], 1, async () => {}, () => {}, async () => { called = true; }) as
      (job: unknown, state: string, description: string) => Promise<void>;

    await postIngest({ repo: { owner: 'u', name: 'r' }, sha: 'b'.repeat(40), context: 'ci/checks' },
      'success', 'fine');
    expect(called).toBe(false);
  });

  it('the ladder is sized for a real restart, not a blink', async () => {
    // Pinned because the whole point is riding out a deploy: if someone trims
    // this to two quick retries the bug comes back quietly.
    const source = readFileSync(DAEMON, 'utf8');
    const ladder = source.match(/const INGEST_RETRY_DELAYS_MS = \[([^\]]*)\]/)?.[1];
    const total = ladder!.split(',').reduce((sum, n) => sum + Number(n.trim()), 0);
    expect(total).toBeGreaterThanOrEqual(90_000);
  });
});

/**
 * Lane B's own reporting, in the order it happens.
 *
 * A deploy is the check most worth watching while it runs, and it was the only
 * one you could not: lane A filed a `pending` the moment it started, lane B
 * filed nothing until its verdict. So `deploy/prod` had no row at all for the
 * ~95 seconds it built and then appeared already green — a merged proposal read
 * as "nothing is deploying" at the exact moment it was.
 *
 * Order is the whole subject here. The store upserts on (sha, context), last
 * write winning, so a spinner that lands after its own verdict leaves a
 * finished check spinning forever. The pending is therefore AWAITED, and that
 * is what these tests hold: not that a pending is sent, but that nothing else
 * happens until it has been.
 */
describe('CI daemon lane B reporting', () => {
  type FakeChild = { on: (event: string, cb: (code: number) => void) => void };

  function loadDrainB(job: Record<string, unknown>, { now = 10_000 } = {}) {
    const events: string[] = [];
    let releasePending: (() => void) | undefined;
    let close: ((code: number) => void) | undefined;
    let childEnv: Record<string, string> | undefined;
    const queue = [job];

    const fakeChild = (): FakeChild & { stdout: unknown; stderr: unknown } => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: (code: number) => void) => { if (event === 'close') close = cb; },
    });

    const source = grab(readFileSync(DAEMON, 'utf8'), 'drainB');
    const factory = new Function(
      'runningB', 'runningBJob', 'queueB', 'logFileFor', 'postStatus', 'postIngest', 'log',
      'spawn', 'SCRIPT', 'process', 'appendFileSync', 'path', 'logTailB64Of', 'jobFinished',
      'trackIngest', 'scheduleLaneBDrain', 'Date', 'laneBDrainTimer', 'clearTimeout',
      `${source}; return { drainB, runningJob: () => runningBJob };`,
    );
    const loaded = factory(
      false,
      null,
      queue,
      () => '/tmp/ci-job.log',
      async (_sha: string, _context: string, state: string) => { events.push(`github:${state}`); },
      (_job: unknown, state: string, description: string) => {
        events.push(`ingest:${state}`);
        if (state !== 'pending') return Promise.resolve();
        // Held open on purpose: an unresolved pending is how we see whether the
        // daemon waits for it or races past it.
        events.push(`said:${description}`);
        return new Promise<void>((resolve) => { releasePending = resolve; });
      },
      () => {},
      (_command: string, _args: string[], options: { env: Record<string, string> }) => {
        childEnv = options.env;
        events.push('spawn');
        return fakeChild();
      },
      '/opt/ia-ci/run-job.sh',
      { env: {} },
      () => {},
      { basename: (p: string) => p },
      () => 'log-tail',
      () => { events.push('finished'); },
      // The real one counts the verdict in flight so the daemon cannot exit
      // through it (see daemon.mjs → trackIngest). Here it only has to be
      // transparent: these tests are about ORDER, and the exit invariant has
      // its own test below.
      (promise: Promise<void>) => { void promise; },
      (notBefore: number) => { events.push(`scheduled:${notBefore}`); },
      { now: () => now },
      undefined,
      () => {},
    ) as { drainB: () => Promise<void>; runningJob: () => Record<string, unknown> | null };

    return {
      events,
      start: () => { void loaded.drainB(); return new Promise((r) => setImmediate(r)); },
      releasePending: () => { releasePending?.(); return new Promise((r) => setImmediate(r)); },
      exit: (code: number) => { close?.(code); return new Promise((r) => setImmediate(r)); },
      spawned: () => events.includes('spawn'),
      queueLength: () => queue.length,
      childEnv: () => childEnv,
      runningJob: loaded.runningJob,
    };
  }

  const platformJob = {
    kind: 'deploy-prod', ref: 'main', sha: 'd'.repeat(40), context: 'deploy/prod', platform: true,
    repo: { owner: 'tg_owner', name: 'infinite-agents' },
  };

  it('says a deploy is running BEFORE it starts running', async () => {
    const h = loadDrainB({ ...platformJob });
    await h.start();

    // The pending is out, and the job has not begun: if this ever inverts, the
    // Mini App can see a verdict before the spinner that precedes it.
    expect(h.events).toEqual(['ingest:pending', 'said:Running on ia-ci-runner']);
    expect(h.spawned(), 'the job must not start before its spinner is filed').toBe(false);
    expect(h.runningJob()).toMatchObject({ sha: platformJob.sha });

    await h.releasePending();
    expect(h.spawned()).toBe(true);
  });

  it('files the verdict after the spinner, and only then', async () => {
    const h = loadDrainB({ ...platformJob });
    await h.start();
    await h.releasePending();
    await h.exit(0);

    expect(h.events.filter((e) => e.startsWith('ingest:')))
      .toEqual(['ingest:pending', 'ingest:success']);
    expect(h.events.at(-1)).toBe('finished');
  });

  it('a skipped job still gets a spinner first — it is a row either way', async () => {
    // The common case, and the tightest race: a path-filtered deploy exits in
    // ~200ms, comfortably inside one slow POST.
    const h = loadDrainB({ ...platformJob });
    await h.start();
    await h.releasePending();
    await h.exit(78);

    expect(h.events.filter((e) => e.startsWith('ingest:')))
      .toEqual(['ingest:pending', 'ingest:skipped']);
  });

  it('a platform job tells the Mini App and not GitHub', async () => {
    // Its sha reaches GitHub only when the mirror lands it there, so a status
    // posted about it now would be about a commit GitHub has never heard of.
    const h = loadDrainB({ ...platformJob });
    await h.start();
    await h.releasePending();
    await h.exit(0);

    expect(h.events.some((e) => e.startsWith('github:'))).toBe(false);
  });

  it('a GitHub-era job posts both, the ingest still gated on the same await', async () => {
    const h = loadDrainB({ ...platformJob, platform: false });
    await h.start();

    expect(h.events).toEqual(['github:pending', 'ingest:pending', 'said:Running on ia-ci-runner']);
    expect(h.spawned()).toBe(false);
  });

  it('leaves a debounced production deploy queued until its quiet deadline', async () => {
    const h = loadDrainB({ ...platformJob, notBefore: 12_000 }, { now: 10_000 });
    await h.start();

    expect(h.events).toEqual(['scheduled:12000']);
    expect(h.queueLength()).toBe(1);
    expect(h.spawned()).toBe(false);
  });

  it('forces the final path check when one deploy represents a whole burst', async () => {
    const h = loadDrainB({ ...platformJob, coalesced: true });
    await h.start();
    await h.releasePending();

    expect(h.childEnv()?.IA_FORCE_JOB).toBe('1');
  });

  it('arms one unrefed timer for the remaining quiet period and wakes lane B', () => {
    const source = grab(readFileSync(DAEMON, 'utf8'), 'scheduleLaneBDrain');
    let callback: (() => void) | undefined;
    let delay: number | undefined;
    let unrefed = false;
    let drains = 0;
    const factory = new Function(
      'laneBDrainTimer', 'clearTimeout', 'setTimeout', 'drainB', 'Date',
      `${source}; return scheduleLaneBDrain;`,
    );
    const schedule = factory(
      undefined,
      () => {},
      (fn: () => void, ms: number) => {
        callback = fn;
        delay = ms;
        return { unref: () => { unrefed = true; } };
      },
      () => { drains += 1; },
      { now: () => 10_000 },
    ) as (notBefore: number) => void;

    schedule(12_500);
    expect(delay).toBe(2_500);
    expect(unrefed).toBe(true);
    callback?.();
    expect(drains).toBe(1);
  });
});

/**
 * What a push to main is supposed to set off. Pinned because the list is the
 * only place a deploy exists: a job nobody queues is a box nobody updates, and
 * the git host spent its whole life in exactly that state — no pipeline, every
 * change copied in by hand, and eventually a ~30s outage for every user when
 * one of those copies landed with the wrong owner and mode.
 */
describe('CI daemon job routing', () => {
  const loadHandleEvent = ({ laneA = true } = {}) => {
    const queued: Array<{ kind: string; context: string; sha: string; ref: string }> = [];
    const source = grab(readFileSync(DAEMON, 'utf8'), 'handleEvent');
    const factory = new Function('repoOf', 'enqueue', 'laneAConfigured', `${source}; return handleEvent;`);
    const handleEvent = factory(
      (payload: { repository?: { name?: string; owner?: string } }) =>
        (payload.repository?.name ? { owner: payload.repository.owner, name: payload.repository.name } : null),
      (job: { kind: string; context: string; sha: string; ref: string }) => { queued.push(job); },
      () => laneA,
    ) as (event: string, payload: unknown, opts?: { platform?: boolean }) => string;
    return { handleEvent, queued };
  };

  const SHA = 'c'.repeat(40);

  it('a push to main deploys the git host, alongside the backend and the site', () => {
    const h = loadHandleEvent();
    h.handleEvent('push', { ref: 'refs/heads/main', after: SHA });

    const gitHost = h.queued.find((j) => j.kind === 'deploy-git-host');
    expect(gitHost, 'a main push must queue the git host deploy').toBeTruthy();
    expect(gitHost!.context).toBe('deploy/git-host');
    expect(gitHost!.sha).toBe(SHA);
    // Every deploy on this box carries its own context, or two of them
    // overwrite each other's status on the same commit.
    const contexts = h.queued.map((j) => j.context);
    expect(new Set(contexts).size).toBe(contexts.length);
  });

  it('nothing but main deploys anything', () => {
    for (const branch of ['dev', 'feature-x']) {
      const h = loadHandleEvent();
      h.handleEvent('push', { ref: `refs/heads/${branch}`, after: SHA });
      expect(h.queued.some((j) => j.kind === 'deploy-git-host'), `${branch} must not deploy`).toBe(false);
    }
    // A user's platform repo pushes through the same handler and must never
    // reach a deploy of ours — it gets its own committed script, nothing else.
    const platform = loadHandleEvent();
    platform.handleEvent('push', { ref: 'refs/heads/main', after: SHA, repository: { name: 'r', owner: 'u' } },
      { platform: true });
    expect(platform.queued.map((j) => j.kind)).toEqual(['ci-script']);
  });

  it('the git host deploy is lane B, where the key to that box lives', () => {
    // Lane A is a throwaway Fly machine holding no platform credential. A job
    // that SSHes into ia-media as root cannot ever run there.
    const source = grab(readFileSync(fileURLToPath(new URL('../../../../infra/ci-runner/lane-a.mjs', import.meta.url)), 'utf8'), 'laneARoutes');
    const laneARoutes = new Function(`${source}; return laneARoutes;`)() as (kind: string) => boolean;

    expect(laneARoutes('deploy-git-host')).toBe(false);
    expect(laneARoutes('deploy-prod')).toBe(false);
    expect(laneARoutes('checks')).toBe(true);
    expect(laneARoutes('ci-script')).toBe(true);
  });

  it('the wall clock leaves headroom over the slowest honest run seen', () => {
    // 2026-09-04: our own checks passed in 13.6 min on a busy shared host and
    // the next push of the same tree was killed at the 15-minute wall — an
    // error with nothing red, once per busy morning. The default is a backstop
    // against runaway jobs and must not sit on top of an honest run's
    // variance. Lowering it again means re-measuring a busy host first.
    const source = readFileSync(fileURLToPath(new URL('../../../../infra/ci-runner/lane-a.mjs', import.meta.url)), 'utf8');
    const minutes = Number(source.match(/LANE_A_TIMEOUT_MS \?\? (\d+) \* 60_000/)?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(30);
  });
});

describe('production backend deploy resilience', () => {
  const runJob = readFileSync(
    fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url)),
    'utf8',
  );
  const service = readFileSync(
    fileURLToPath(new URL('../../../../infra/backend-host/infinite-agents-backend.service', import.meta.url)),
    'utf8',
  );
  const socket = readFileSync(
    fileURLToPath(new URL('../../../../infra/backend-host/infinite-agents-backend.socket', import.meta.url)),
    'utf8',
  );

  it('keeps the public listener in systemd and hands the named fd to Node', () => {
    expect(socket).toContain('ListenStream=[::1]:3001');
    expect(socket).toContain('FileDescriptorName=backend-http');
    expect(socket).toContain('Backlog=4096');
    expect(service).toContain('Requires=infinite-agents-backend.socket');
    expect(service).toContain('Sockets=infinite-agents-backend.socket');
  });

  it('validates and adopts the socket without restarting it on later deploys', () => {
    expect(runJob).toContain('systemd-analyze verify "$stage/$service" "$stage/$socket"');
    expect(runJob).toMatch(/if \[ "\$socket_active" = 1 \]; then\s+systemctl restart "\$service"/);
    expect(runJob).toContain('https://api.agenticcloudcomputer.com/api/health');
    expect(runJob).toMatch(/curl -fsS --max-time 3/);
  });

  it('filters against the release production last tried, and a forced run skips the filter', () => {
    // The range is live..sha, never one commit against its parent: a
    // fast-forwarded branch ending in a site commit used to skip the backend
    // commits under it (2026-09-07). The forced path is the collapse's second
    // guarantee. Behaviour is exercised in ci-deploy-filter-range.test.ts.
    expect(runJob).toContain('LAST_TRIED=$(prod_last_attempt)');
    expect(runJob).toMatch(/changed_since "\$LAST_TRIED" '\^\(backend\/\|infra\/ci-runner\/\|infra\/backend-host\/\(infinite-agents-backend\\\.\(service\|socket\)\|set-machine-image\)\$\)'/);
    expect(runJob).toContain('if [ "${IA_FORCE_JOB:-}" = "1" ]; then');
    expect(runJob).not.toContain('"$SHA~1" "$SHA"');
  });
});

/**
 * The deploy script itself. It runs on a box with the root key to every other
 * box, so the things worth pinning are the ones that turn a bad deploy into a
 * failed status instead of an outage.
 */
describe('git host deploy job', () => {
  const RUN_JOB = fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url));
  const job = () => {
    const source = readFileSync(RUN_JOB, 'utf8');
    const start = source.indexOf('  deploy-git-host)');
    expect(start, 'run-job.sh has no deploy-git-host case').toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n    ;;', start));
  };

  it('skips when no git-host file changed since the job last tried', () => {
    // 78 is the daemon's "skipped", not a green tick on a deploy that did
    // nothing — the same shape deploy-prod and machine-image already use. The
    // range runs from the runner's own record, not from the tip's parent.
    expect(job()).toMatch(/changed_since "\$\(last_attempted\)" '\^infra\/git-host\/'/);
    expect(job()).toMatch(/record_attempt\s+exit 78/);
  });

  it('validates before it replaces, on names node can actually check', () => {
    expect(job()).toMatch(/node --check "\$SRC\/git-host\.mjs"/);
    // Every check target must be a name node can read a module type off.
    // `node --check foo.mjs.new` dies with ERR_UNKNOWN_FILE_EXTENSION, so a
    // staged file named that way is never really checked — which is exactly
    // how the bad copy got past a hand deploy that looked careful.
    const targets = [...job().matchAll(/node --check "([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const target of targets) {
      expect(/\.mjs$|post-receive$/.test(target), `${target} is a name node cannot check`).toBe(true);
    }
  });

  it('sets ownership and mode explicitly — the whole reason it exists', () => {
    expect(job()).toMatch(/chown agentgit:agentgit "\$ROOT\/git-host\.staged\.mjs"/);
    expect(job()).toMatch(/chmod 755 "\$ROOT\/git-host\.staged\.mjs"/);
  });

  it('ships the hooks with the server', () => {
    // They are read at startup and re-copied into every repo on each push, so
    // a server-only deploy leaves a hook fix inert where it was needed.
    expect(job()).toMatch(/hooks\.staged/);
  });

  it('proves the host SERVES before calling it a success, and rolls back if not', () => {
    // systemd reported `activating` all through the crash-loop, so "is-active"
    // alone would have called that outage a good deploy.
    expect(job()).toMatch(/http:\/\/127\.0\.0\.1:\$PORT\//);
    expect(job()).toMatch(/"\$code" = "404"/);
    expect(job()).toMatch(/rolling back/);
    expect(job()).toMatch(/mv -f "\$ROOT\/git-host\.mjs\.previous" "\$ROOT\/git-host\.mjs"/);
    expect(job()).toMatch(/exit 1/);
  });

  it('never sources the env file that holds the host secret', () => {
    // Sourcing it would put GIT_HOST_SECRET in the deploy shell, and from
    // there into any error it prints into a CI log.
    const text = job();
    expect(text).not.toMatch(/(^|\s)(\.|source)\s+\/etc\/agentgit\/agentgit\.env/m);
    expect(text).toMatch(/sed -n 's\/\^PORT=/);
  });
});

/**
 * WHY THIS EXISTS: the git-host image was built and pushed on every change for
 * two months while production's FLY_GIT_HOST_IMAGE still named the image of
 * 23 August 2026 — and a code host started from that one refuses every push
 * from a current backend (note #809). A green build now repoints the setting,
 * through the same root helper the agent image uses — and since note #819 the
 * messaging-host image's build does the same for FLY_MSG_HOST_IMAGE.
 */
describe('host image jobs repoint production', () => {
  const RUN_JOB = fileURLToPath(new URL('../../../../infra/ci-runner/run-job.sh', import.meta.url));
  const HELPER = fileURLToPath(new URL('../../../../infra/backend-host/set-machine-image', import.meta.url));
  const job = (kind: string) => {
    const source = readFileSync(RUN_JOB, 'utf8');
    const start = source.indexOf(`  ${kind})`);
    expect(start, `run-job.sh has no ${kind} case`).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n    ;;', start));
  };

  for (const family of ['git-host', 'msg-host']) {
    it(`${family}-image repoints only after the smoke test passed and the push landed`, () => {
      const text = job(`${family}-image`);
      const smoke = text.indexOf(`./infra/${family}-image/smoke-test.sh`);
      const push = text.indexOf('docker push "$PUBLIC_IMAGE_REF"');
      const repoint = text.indexOf(`/usr/local/bin/set-machine-image --${family} '$PUBLIC_IMAGE_REF'`);
      expect(smoke).toBeGreaterThan(-1);
      expect(push).toBeGreaterThan(smoke);
      expect(repoint).toBeGreaterThan(push);
    });
  }

  // The helper itself, run for real on a sandboxed copy: its two paths point
  // into a temp dir, and systemctl, curl and chown are stubs, so it runs
  // unprivileged and restarts nothing.
  const helper = (args: string[], env = 'A=1\nFLY_MACHINE_IMAGE=ghcr.io/acme/ia-machine-images:sha-111111111111\nFLY_GIT_HOST_IMAGE=ghcr.io/acme/ia-machine-images:git-host-sha-222222222222\nFLY_MSG_HOST_IMAGE=ghcr.io/acme/ia-machine-images:msg-host-sha-555555555555\n') => {
    const dir = mkdtempSync(join(tmpdir(), 'set-machine-image-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, body] of [['systemctl', 'exit 0'], ['curl', 'printf 200'], ['chown', 'exit 0']]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${dir}/calls'\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(dir, 'ghcr-owner'), 'acme\n');
    writeFileSync(join(dir, 'backend.env'), env);
    const script = readFileSync(HELPER, 'utf8')
      .replace(/^ENV_FILE=.*$/m, `ENV_FILE='${dir}/backend.env'`)
      .replace(/^OWNER_FILE=.*$/m, `OWNER_FILE='${dir}/ghcr-owner'`)
      .replace(/^(\s*)sleep 2$/m, '$1sleep 0');
    writeFileSync(join(dir, 'helper'), script);
    const r = spawnSync('bash', [join(dir, 'helper'), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
    return { code: r.status, out: `${r.stdout}${r.stderr}`, env: readFileSync(join(dir, 'backend.env'), 'utf8'), calls };
  };

  it('--git-host writes FLY_GIT_HOST_IMAGE alone, then restarts and waits for health', () => {
    const r = helper(['--git-host', 'ghcr.io/acme/ia-machine-images:git-host-sha-333333333333']);
    expect(r.code, r.out).toBe(0);
    expect(r.env).toContain('FLY_GIT_HOST_IMAGE=ghcr.io/acme/ia-machine-images:git-host-sha-333333333333\n');
    expect(r.env).toContain('FLY_MACHINE_IMAGE=ghcr.io/acme/ia-machine-images:sha-111111111111\n');
    expect(r.calls).toContain('systemctl restart infinite-agents-backend');
  });

  it('--git-host is a no-op when the setting already names that image', () => {
    const r = helper(['--git-host', 'ghcr.io/acme/ia-machine-images:git-host-sha-222222222222']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('nothing to do');
    expect(r.calls).not.toContain('restart');
  });

  it('--git-host refuses an agent tag, the Fly registry and a foreign account, leaving the env as it was', () => {
    for (const ref of [
      'ghcr.io/acme/ia-machine-images:sha-333333333333',
      'registry.fly.io/ia-machine-images:git-host-sha-333333333333',
      'ghcr.io/evil/ia-machine-images:git-host-sha-333333333333',
      'ghcr.io/acme/ia-machine-images:git-host-sha-3;reboot',
    ]) {
      const r = helper(['--git-host', ref]);
      expect(r.code, ref).toBe(1);
      expect(r.env, ref).toContain('FLY_GIT_HOST_IMAGE=ghcr.io/acme/ia-machine-images:git-host-sha-222222222222\n');
      expect(r.calls, ref).not.toContain('restart');
    }
  });

  it('--msg-host writes FLY_MSG_HOST_IMAGE alone, and refuses every other family and registry', () => {
    const ok = helper(['--msg-host', 'ghcr.io/acme/ia-machine-images:msg-host-sha-666666666666']);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.env).toContain('FLY_MSG_HOST_IMAGE=ghcr.io/acme/ia-machine-images:msg-host-sha-666666666666\n');
    expect(ok.env).toContain('FLY_GIT_HOST_IMAGE=ghcr.io/acme/ia-machine-images:git-host-sha-222222222222\n');
    expect(ok.env).toContain('FLY_MACHINE_IMAGE=ghcr.io/acme/ia-machine-images:sha-111111111111\n');
    expect(ok.calls).toContain('systemctl restart infinite-agents-backend');
    const same = helper(['--msg-host', 'ghcr.io/acme/ia-machine-images:msg-host-sha-555555555555']);
    expect(same.code, same.out).toBe(0);
    expect(same.calls).not.toContain('restart');
    for (const ref of [
      'ghcr.io/acme/ia-machine-images:git-host-sha-666666666666',
      'ghcr.io/acme/ia-machine-images:sha-666666666666',
      'registry.fly.io/ia-machine-images:msg-host-sha-666666666666',
      'ghcr.io/evil/ia-machine-images:msg-host-sha-666666666666',
    ]) {
      const r = helper(['--msg-host', ref]);
      expect(r.code, ref).toBe(1);
      expect(r.env, ref).toContain('FLY_MSG_HOST_IMAGE=ghcr.io/acme/ia-machine-images:msg-host-sha-555555555555\n');
      expect(r.calls, ref).not.toContain('restart');
    }
    // And the code-host form will not take a messaging tag either.
    const crossed = helper(['--git-host', 'ghcr.io/acme/ia-machine-images:msg-host-sha-666666666666']);
    expect(crossed.code).toBe(1);
    expect(crossed.env).toContain('FLY_GIT_HOST_IMAGE=ghcr.io/acme/ia-machine-images:git-host-sha-222222222222\n');
  });

  it('the plain form still repoints agent machines, and refuses a host image as one', () => {
    const ok = helper(['registry.fly.io/ia-machine-images:sha-444444444444']);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.env).toContain('FLY_MACHINE_IMAGE=registry.fly.io/ia-machine-images:sha-444444444444\n');
    for (const ref of [
      'ghcr.io/acme/ia-machine-images:git-host-sha-333333333333',
      'ghcr.io/acme/ia-machine-images:msg-host-sha-333333333333',
    ]) {
      const refused = helper([ref]);
      expect(refused.code, ref).toBe(1);
      expect(refused.env, ref).toContain('FLY_MACHINE_IMAGE=ghcr.io/acme/ia-machine-images:sha-111111111111\n');
    }
  });
});

/**
 * WHY THIS EXISTS: on 2026-08-14 the ci/checks pip for 0aec229 stayed
 * "Running in an ephemeral VM" with a live clock on a run that had exited 0.
 * The job's verdict POST and the self-update `process.exit(0)` were FIVE
 * MILLISECONDS apart — the request died in flight, so the store kept the
 * 'pending' row the job started with and the Mini App had nothing newer to
 * render. A verdict that never arrives is worse than a red one: it reads as
 * "still working" forever.
 *
 * The fix is an invariant, not a patch at one call site: the daemon does not
 * exit while a verdict is in the air. These tests hold that invariant on the
 * real source of maybeRestart.
 */
describe('CI daemon self-update restart', () => {
  function loadMaybeRestart(opts: { inFlight: number; idle?: boolean }) {
    const exits: number[] = [];
    const source = grab(readFileSync(DAEMON, 'utf8'), 'maybeRestart');
    const factory = new Function(
      'queueA', 'queueB', 'runningA', 'runningB', 'ingestsInFlight',
      'existsSync', 'rmSync', 'log', 'process', 'RESTART_FLAG',
      `${source}; return maybeRestart;`,
    );
    return {
      exits,
      maybeRestart: factory(
        [], [], opts.idle === false ? 1 : 0, false, opts.inFlight,
        () => true,              // the restart flag is present
        () => {},
        () => {},
        { exit: (code: number) => { exits.push(code); } },
        '/opt/ia-ci/.restart-requested',
      ) as () => void,
    };
  }

  it('does not exit while a verdict is still in flight', () => {
    const h = loadMaybeRestart({ inFlight: 1 });
    h.maybeRestart();
    // Exiting here is the 0aec229 bug: the POST carrying "passed" dies with
    // the process and the pip spins forever.
    expect(h.exits).toEqual([]);
  });

  it('exits once the last verdict has landed', () => {
    const h = loadMaybeRestart({ inFlight: 0 });
    h.maybeRestart();
    expect(h.exits).toEqual([0]);
  });

  it('still waits for a busy lane, in-flight verdicts or not', () => {
    const h = loadMaybeRestart({ inFlight: 0, idle: false });
    h.maybeRestart();
    expect(h.exits).toEqual([]);
  });
});

/**
 * What a SUPERSEDE means, which is not one thing (found 2026-08-15, after it
 * locked a proposal's approve button three times in a row).
 *
 * A per-branch job's collapse key is the branch, so losing the slot means a
 * newer commit replaced this one: the sha is stale, it will never be built,
 * and a required-checks repo is right to hold it.
 *
 * A repo-wide job's key covers every ref, so losing the slot means the newer
 * run does this commit's work too. Filing `superseded` there told the merge
 * gate there was no verdict for a commit nothing was ever going to judge
 * separately — and since ANY push by ANYONE takes that slot, the proposal
 * that lost the race could never be merged at all.
 */
describe('CI daemon supersede', () => {
  const loadEnqueue = (runningBJob: Record<string, unknown> | null = null) => {
    let now = 1_000;
    const filed: Array<{ sha: string; context: string; state: string; note: string; via: string }> = [];
    const source = grab(readFileSync(DAEMON, 'utf8'), 'enqueue');
    const factory = new Function(
      'isLaneA', 'runningBJob', 'log', 'postStatus', 'trackIngest', 'postIngest', 'cancelLaneAJob', 'drainA', 'drainB',
      'DEPLOY_PROD_QUIET_MS', 'Date',
      `const queueA = []; const queueB = [];\n${source}\n; return { enqueue, queueA, queueB };`,
    );
    const record = (via: string) =>
      (job: { sha: string; context: string }, state: string, note: string) => {
        filed.push({ sha: job.sha, context: job.context, state, note, via });
      };
    const handle = factory(
      () => false, runningBJob, () => {},
      // postStatus takes the sha and context loose, not a job.
      (sha: string, context: string, state: string, note: string) => {
        filed.push({ sha, context, state, note, via: 'github' });
      },
      (value: unknown) => value,
      record('ingest'),
      () => false, () => {}, () => {},
      30_000,
      { now: () => now },
    ) as { enqueue: (job: unknown) => void; queueB: Array<Record<string, unknown>> };
    return { ...handle, filed, setNow: (value: number) => { now = value; } };
  };

  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  const NEWER = 'c'.repeat(40);

  it('a repo-wide job that loses its slot is SKIPPED — its work got done anyway', () => {
    const h = loadEnqueue();
    const mirror = (sha: string) => ({
      kind: 'mirror-github', ref: 'platform-mirror', sha,
      context: 'deploy/mirror-github', platform: true, repoWide: true,
    });
    h.enqueue(mirror(OLD));
    h.enqueue(mirror(NEW));

    expect(h.filed).toEqual([{
      sha: OLD,
      context: 'deploy/mirror-github',
      state: 'skipped',
      note: 'A newer push did this job for every ref, this commit included.',
      via: 'ingest',
    }]);
    // `skipped` is what the merge gate counts as passing, which is the whole
    // point: the commit is not unjudged, it is simply not this job's business
    // any more.
    expect(h.queueB).toHaveLength(1);
  });

  it('a per-branch job that loses its slot is still SUPERSEDED — that sha is stale', () => {
    const h = loadEnqueue();
    const checks = (sha: string) => ({
      kind: 'ci-script', ref: 'my-branch', branch: 'my-branch', sha,
      context: 'ci/checks', platform: true,
    });
    h.enqueue(checks(OLD));
    h.enqueue(checks(NEW));

    expect(h.filed.map((f) => f.state)).toEqual(['superseded']);
    expect(h.filed[0]!.sha).toBe(OLD);
  });

  it('a GitHub-slug repo hears about it on GitHub too, with the same verdict', () => {
    const h = loadEnqueue();
    const job = (sha: string) => ({ kind: 'checks', ref: 'main', sha, context: 'ci/checks' });
    h.enqueue(job(OLD));
    h.enqueue(job(NEW));
    expect(h.filed.map((f) => `${f.via}:${f.state}`)).toEqual(['github:superseded', 'ingest:superseded']);
  });

  it('resets the production quiet window and marks the final deploy cumulative', () => {
    const h = loadEnqueue();
    const deploy = (sha: string) => ({
      kind: 'deploy-prod', ref: 'main', sha, context: 'deploy/prod', platform: true,
    });

    h.enqueue(deploy(OLD));
    expect(h.queueB[0]).toMatchObject({ sha: OLD, notBefore: 31_000 });

    h.setNow(5_000);
    h.enqueue(deploy(NEW));
    expect(h.queueB).toHaveLength(1);
    expect(h.queueB[0]).toMatchObject({ sha: NEW, notBefore: 35_000, coalesced: true });
  });

  it('queues a new delivery behind every remaining job in the active delivery', () => {
    const active = {
      kind: 'deploy-prod', ref: 'main', sha: OLD, context: 'deploy/prod', platform: true,
    };
    const h = loadEnqueue(active);
    const site = (sha: string) => ({
      kind: 'deploy-site', ref: 'main-site', sha, context: 'deploy/site', platform: true,
    });

    // OLD's production job is already running. Its site job is queued and is
    // therefore part of the same in-process delivery, not stale work a newer
    // merge may take away.
    h.enqueue(site(OLD));
    h.enqueue({ ...active });
    h.enqueue(site(OLD));
    h.enqueue(site(NEW));
    expect(h.queueB.map((job) => job.sha)).toEqual([OLD, NEW]);
    expect(h.filed).toEqual([]);

    // The waiting delivery has not started, so a third merge may still fold
    // into it. OLD stays first and receives its own verdict; only NEW is
    // superseded by NEWER.
    h.enqueue(site(NEWER));
    expect(h.queueB.map((job) => job.sha)).toEqual([OLD, NEWER]);
    expect(h.filed.map((filed) => [filed.sha, filed.state]))
      .toEqual([[NEW, 'superseded']]);
  });

  it('does not debounce a forced production re-run', () => {
    const h = loadEnqueue();
    h.enqueue({
      kind: 'deploy-prod', ref: 'dispatch-deploy-prod', sha: NEW,
      context: 'deploy/prod', platform: true, force: true,
    });

    expect(h.queueB[0]?.notBefore).toBeUndefined();
  });

  it('the mirror is the repo-wide job, and says so where it is queued', () => {
    const source = readFileSync(DAEMON, 'utf8');
    const queued = source.match(/kind: 'mirror-github'[^}]*}/)![0];
    expect(queued).toContain('repoWide: true');
    // Nothing else claims it: a job whose key IS its branch must not, or a
    // stale sha would start reading as passing.
    expect((source.match(/repoWide: true/g) ?? [])).toHaveLength(1);
  });
});

/**
 * The counter is only load-bearing if every verdict actually goes through it.
 * A future `void postIngest(...)` would compile, run, and silently reopen the
 * exact hole — so this reads the source and holds the rule.
 */
describe('CI daemon verdict tracking', () => {
  it('routes every non-pending ingest through trackIngest', () => {
    const source = readFileSync(DAEMON, 'utf8');
    // Fire-and-forget is allowed ONLY for the pending spinner: losing it costs
    // a missing spinner, not a frozen one, and it cannot race the exit anyway
    // (its lane is still running at that point).
    const untracked = source.match(/void postIngest\([^)]*/g) ?? [];
    expect(untracked.filter((call) => !call.includes("'pending'"))).toEqual([]);
    expect(source).toContain('trackIngest(postIngest(');
  });
});

/**
 * The clone-token mint a platform job asks for the moment its push lands.
 * A merge's push is exactly when the backend may be restarting under the
 * previous deploy, and one 502 used to drop the push's whole ci/checks run
 * in 0 s (6d4753f1 on 27 Oct, 0a93bd3b on 28 Oct). The real function's
 * source, run with its collaborators injected, as for postIngest above.
 */
describe('CI daemon clone-token mint', () => {
  type Answer = number | Error | { status: number; token?: string };
  function loadMint(answers: Answer[], delays = [1, 1, 1, 1]) {
    const calls: Array<{ url: string; body: Record<string, unknown>; secret: string }> = [];
    const logs: string[] = [];
    const slept: number[] = [];
    const source = grab(readFileSync(DAEMON, 'utf8'), 'platformCloneCreds');
    const fetchStub = async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const next = answers[calls.length] ?? answers[answers.length - 1]!;
      calls.push({ url, body: JSON.parse(init.body), secret: init.headers['x-ci-status-secret']! });
      if (next instanceof Error) throw next;
      const { status, token } = typeof next === 'number' ? { status: next, token: 'tok-1' } : next;
      return { ok: status >= 200 && status < 300, status, json: async () => (token ? { token } : {}) };
    };
    const factory = new Function(
      'CLONE_TOKEN_URL', 'CI_STATUS_SECRET', 'PLATFORM_GIT_BASE', 'CLONE_TOKEN_RETRY_DELAYS_MS', 'CLONE_TOKEN_TIMEOUT_MS',
      'sleep', 'log', 'fetch',
      `${source}; return platformCloneCreds;`,
    );
    const mint = factory(
      'https://api.test/git/ci-clone-token', 'secret', 'https://git.test', delays, 15000,
      async (ms: number) => { slept.push(ms); },
      (line: string) => { logs.push(line); },
      fetchStub,
    ) as (job: unknown) => Promise<{ cloneToken?: string; repoUrl?: string; error?: string }>;
    const job = { repo: { owner: 'user-1', name: 'infinite-agents' }, sha: 'b'.repeat(40), context: 'ci/checks' };
    return { mint, job, calls, logs, slept };
  }

  it('rides out a backend restart: 502 and a refused connection, then the token', async () => {
    const { mint, job, calls, logs, slept } = loadMint([502, new Error('connect ECONNREFUSED'), 200], [2000, 5000, 15000, 30000]);
    const creds = await mint(job);
    expect(creds).toEqual({ cloneToken: 'tok-1', repoUrl: 'https://git.test/user-1/infinite-agents.git' });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ url: 'https://api.test/git/ci-clone-token', secret: 'secret', body: { owner: 'user-1', repo: 'infinite-agents', ttlSeconds: 3600 } });
    expect(slept).toEqual([2000, 5000]);
    expect(logs.at(-1)).toBe('clone token mint recovered for user-1/infinite-agents after 3 tries');
  });

  it('gives up after the ladder with a reason the error status can carry', async () => {
    const { mint, job, calls, slept } = loadMint([502]);
    const creds = await mint(job);
    expect(calls).toHaveLength(5);
    expect(slept).toEqual([1, 1, 1, 1]);
    expect(creds).toEqual({ error: 'the backend answered 502 after 5 tries' });
    const unanswered = await loadMint([new Error('timeout')]).mint(job);
    expect(unanswered).toEqual({ error: 'the backend did not answer after 5 tries' });
  });

  it('does not retry a refusal, and says when the answer has no token', async () => {
    const refused = loadMint([401, 200]);
    expect(await refused.mint(refused.job)).toEqual({ error: 'the backend refused it (401)' });
    expect(refused.calls).toHaveLength(1);
    expect(refused.slept).toEqual([]);
    const empty = loadMint([{ status: 200 }]);
    expect(await empty.mint(empty.job)).toEqual({ error: 'the backend answered without a token' });
  });

  it('files the reason on the dropped job, short enough to read whole', () => {
    const source = readFileSync(DAEMON, 'utf8');
    expect(source).toContain("trackIngest(postIngest(job, 'error', `Could not obtain a clone token: ${creds.error}. Push again to re-run.`));");
    const longest = 'Could not obtain a clone token: the backend did not answer after 5 tries. Push again to re-run.';
    expect(longest.length).toBeLessThanOrEqual(140);
  });
});
