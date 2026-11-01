import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// backend/src/test/unit → repo root is four levels up.
const HOST_SCRIPT = fileURLToPath(new URL('../../../../infra/git-host/git-host.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../../../../infra/git-host/hooks/pre-receive', import.meta.url));
const POST_RECEIVE = fileURLToPath(new URL('../../../../infra/git-host/hooks/post-receive', import.meta.url));
const PROVISION = fileURLToPath(new URL('../../../../infra/git-host/provision.sh', import.meta.url));
const MAINTAIN = fileURLToPath(new URL('../../../../infra/git-host/maintain-repos.sh', import.meta.url));

const SECRET = 'test-host-secret';
const TOKEN = 'agb1.test-token';
/** Same user, but the stub answers it with a 1-byte repo quota. */
const TINY_QUOTA_TOKEN = 'agb1.tiny-quota';
/** Same user, answered with a CI clone-token scope: one repo, read-only. */
const SCOPED_TOKEN = 'cit1.test-scoped';
/** Stubbed human key whose verified namespace follows the requested clone URL. */
const MULTI_NAMESPACE_TOKEN = 'hum1.test-multi-org';
/** The break-glass token — the host verifies it from ENV, never the backend. */
const RECOVERY_TOKEN = 'grt1.test-recovery-token';
const USER = 'user-1';
/** Git's empty tree — the base a decided first proposal is compared against. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The stub backend runs as its OWN PROCESS on purpose. The tests drive git
 * synchronously (execFileSync), and the host calls the backend *during* a
 * push — an in-process stub would be blocked by the very call it has to
 * answer, deadlocking every push.
 *
 * Quota is keyed by token rather than mutated between tests, because the host
 * caches positive verifications for 60s: a mutated stub would answer a cached
 * question and the test would silently assert nothing.
 */
const STUB_SOURCE = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const SECRET = ${JSON.stringify(SECRET)};
const TOKEN = ${JSON.stringify(TOKEN)};
const TINY = ${JSON.stringify(TINY_QUOTA_TOKEN)};
const SCOPED = ${JSON.stringify(SCOPED_TOKEN)};
const MULTI = ${JSON.stringify(MULTI_NAMESPACE_TOKEN)};
const USER = ${JSON.stringify(USER)};
const REPORTS = process.env.REPORTS_FILE;
const WEBHOOKS = process.env.WEBHOOKS_FILE;
createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const payload = raw ? JSON.parse(raw) : {};
    if (req.url.endsWith('/git/verify')) {
      if (req.headers['x-git-host-secret'] !== SECRET) { res.writeHead(401); return res.end('{}'); }
      if (payload.token === '' && payload.repo === 'public-repo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          userId: req.headers['x-git-namespace'], agentId: 'public',
          scope: { repo: 'public-repo', readOnly: true },
        }));
      }
      if (payload.token !== TOKEN && payload.token !== TINY && payload.token !== SCOPED && payload.token !== MULTI) { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (payload.token === MULTI) {
        return res.end(JSON.stringify({
          userId: req.headers['x-git-namespace'], agentId: 'owner',
          quota: { repoMaxBytes: 0, userMaxBytes: 0, userUsedBytes: 0 },
        }));
      }
      if (payload.token === SCOPED) {
        // Cross-room grants need the parsed repository name too (note #108).
        // The same request shape carries CI tokens, so this existing scoped
        // clone proves the host forwarded it rather than only the namespace.
        if (!payload.repo) { res.writeHead(400); return res.end('{}'); }
        // The shape /git/verify answers for a CI clone token (ci-clone-token.ts).
        return res.end(JSON.stringify({
          userId: USER, agentId: 'ci', scope: { repo: 'scoped-repo', readOnly: true },
        }));
      }
      const quota = payload.token === TINY
        ? { repoMaxBytes: 1, userMaxBytes: 0, userUsedBytes: 0 }
        : { repoMaxBytes: 0, userMaxBytes: 0, userUsedBytes: 0 };
      return res.end(JSON.stringify({ userId: USER, agentId: 'agent-a', quota }));
    }
    if (req.url.endsWith('/git/pushed')) {
      appendFileSync(REPORTS, raw + '\\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    // Stands in for the CI daemon's /webhook. Records the signature and event
    // headers as well as the body, because an unsigned or unlabelled delivery
    // would be rejected by the real receiver while looking fine here.
    if (req.url.endsWith('/webhook')) {
      appendFileSync(WEBHOOKS, JSON.stringify({
        signature: req.headers['x-agentgit-signature-256'] || null,
        event: req.headers['x-agentgit-event'] || null,
        body: raw,
      }) + '\\n');
      res.writeHead(202); return res.end('queued');
    }
    res.writeHead(404); res.end('{}');
  });
}).listen(0, '127.0.0.1', function () { console.log('stub on ' + this.address().port); });
`;

/** Wait for a child's startup line, so tests never race the listener. */
function waitForLine(child: ChildProcess, pattern: RegExp, what: string): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not start`)), 15_000);
    let buffered = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const match = pattern.exec(buffered);
      if (match) { clearTimeout(timer); resolve(match); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${what} exited early (${code})`)); });
  });
}

describe('git-host service', () => {
  let dir: string;
  let reposRoot: string;
  let reportsFile: string;
  let webhooksFile: string;
  let host: ChildProcess;
  let stub: ChildProcess;
  let hostUrl: string;
  let stubUrl: string;

  const control = async (path: string, body: unknown, secret = SECRET) => {
    const response = await fetch(`${hostUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-git-host-secret': secret },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  /** A clone URL carrying credentials — how git authenticates against the host. */
  const cloneUrl = (name: string, token = TOKEN, user = USER) => (
    `${hostUrl.replace('http://', `http://agent:${encodeURIComponent(token)}@`)}/${user}/${name}.git`
  );

  const git = (args: string[], cwd: string) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25_000,
    env: {
      ...process.env,
      // No prompting, no inherited credential helpers: a test that blocks on
      // an interactive prompt hangs the whole suite.
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });

  const pushReports = (): Array<Record<string, unknown>> => (
    existsSync(reportsFile)
      ? readFileSync(reportsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
  );

  const webhookDeliveries = (): Array<{ signature: string | null; event: string | null; body: string }> => (
    existsSync(webhooksFile)
      ? readFileSync(webhooksFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
  );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'git-host-'));
    reposRoot = join(dir, 'repos');
    reportsFile = join(dir, 'reports.jsonl');
    webhooksFile = join(dir, 'webhooks.jsonl');
    const stubPath = join(dir, 'stub-backend.mjs');
    writeFileSync(stubPath, STUB_SOURCE);

    // NODE_OPTIONS carries vitest's own loader; a child that inherits it tries
    // to bootstrap the test runner instead of the program under test.
    const { NODE_OPTIONS: _ignored, ...cleanEnv } = process.env;

    stub = spawn(process.execPath, [stubPath], {
      env: { ...cleanEnv, REPORTS_FILE: reportsFile, WEBHOOKS_FILE: webhooksFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stubMatch = await waitForLine(stub, /stub on (\d+)/, 'stub backend');
    stubUrl = `http://127.0.0.1:${stubMatch[1]}`;

    host = spawn(process.execPath, [HOST_SCRIPT], {
      env: {
        ...cleanEnv,
        PORT: '0',
        REPOS_ROOT: reposRoot,
        GIT_HOST_SECRET: SECRET,
        BACKEND_URL: `http://127.0.0.1:${stubMatch[1]}`,
        // The one dispatcher a repo may notify. Held by the HOST, never
        // accepted from a caller — `repo ci enable` sends only a boolean.
        CI_WEBHOOK_URL: `http://127.0.0.1:${stubMatch[1]}/webhook`,
        CI_WEBHOOK_SECRET: 'host-ci-secret',
        RECOVERY_TOKEN_SHA256: createHash('sha256').update(RECOVERY_TOKEN, 'utf8').digest('hex'),
        RECOVERY_TOKEN_OWNER: USER,
        RECOVERY_TOKEN_REPO: 'rescue',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hostMatch = await waitForLine(host, /listening on 127\.0\.0\.1:(\d+)/, 'git-host');
    hostUrl = `http://127.0.0.1:${hostMatch[1]}`;
  }, 40_000);

  afterAll(() => {
    host?.kill();
    stub?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A working repo with one commit on `main`, reused by the push tests. */
  const seedWorkTree = (name: string) => {
    const work = join(dir, name);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    writeFileSync(join(work, 'README.md'), `# ${name}\n`);
    git(['add', '.'], work);
    git(['commit', '-qm', 'first'], work);
    return work;
  };

  it('creates a bare repo idempotently, and installs the hook', async () => {
    const first = await control('/internal/repos', { userId: USER, name: 'api' });
    expect(first.body).toEqual({ created: true });
    expect(existsSync(join(reposRoot, USER, 'api.git', 'hooks', 'pre-receive'))).toBe(true);

    // A retried create must never re-init a directory that may hold commits.
    const second = await control('/internal/repos', { userId: USER, name: 'api' });
    expect(second.body).toEqual({ created: false });
  });

  it('refuses control calls without the shared secret', async () => {
    const result = await control('/internal/repos', { userId: USER, name: 'nope' }, 'wrong');
    expect(result.status).toBe(401);
    expect(existsSync(join(reposRoot, USER, 'nope.git'))).toBe(false);
  });

  it('refuses a name that would escape the namespace', async () => {
    const result = await control('/internal/repos', { userId: USER, name: '../escape' });
    expect(result.status).toBe(400);
  });

  it('round-trips a real push and clone, and reports the push to the backend', async () => {
    await control('/internal/repos', { userId: USER, name: 'roundtrip' });
    const work = seedWorkTree('roundtrip-work');

    git(['push', cloneUrl('roundtrip'), 'main'], work);

    const clone = join(dir, 'roundtrip-clone');
    git(['clone', '-q', cloneUrl('roundtrip'), clone], dir);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toContain('roundtrip-work');

    // The size/branch report is what keeps `repo list` and the quota honest.
    const last = pushReports().at(-1)!;
    expect(last).toMatchObject({ userId: USER, name: 'roundtrip', defaultBranch: 'main' });
    expect(Number(last.sizeBytes)).toBeGreaterThan(0);
  }, 40_000);

  it('clones a public repo without credentials but never accepts an anonymous push', async () => {
    await control('/internal/repos', { userId: USER, name: 'public-repo' });
    const work = seedWorkTree('public-repo-work');
    git(['push', cloneUrl('public-repo'), 'main'], work);

    const publicUrl = `${hostUrl}/${USER}/public-repo.git`;
    const clone = join(dir, 'public-repo-clone');
    git(['clone', '-q', publicUrl, clone], dir);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toContain('public-repo-work');

    writeFileSync(join(clone, 'visitor.txt'), 'must not land\n');
    git(['add', '.'], clone);
    git(['commit', '-qm', 'visitor write'], clone);
    expect(() => git(['push', publicUrl, 'main'], clone)).toThrow(/401|Authentication|terminal prompts disabled/i);

    // A private URL with the same anonymous shape still challenges for a key.
    expect(() => git(['clone', '-q', `${hostUrl}/${USER}/api.git`, join(dir, 'private-no-key')], dir))
      .toThrow(/401|Authentication|terminal prompts disabled/i);
  }, 40_000);

  it('rejects a token the backend does not recognise', () => {
    const work = seedWorkTree('badtoken-work');
    expect(() => git(['push', cloneUrl('api', 'wrong-token'), 'main'], work))
      .toThrow(/401|Authentication|denied/i);
  }, 30_000);

  it('refuses a token that is valid for a DIFFERENT user namespace', async () => {
    await control('/internal/repos', { userId: 'user-2', name: 'theirs' });
    const work = seedWorkTree('crossuser-work');
    // A good token, someone else's namespace: this is the entire
    // authorization rule, so it gets its own test.
    expect(() => git(['push', cloneUrl('theirs', TOKEN, 'user-2'), 'main'], work))
      .toThrow(/403|forbidden|namespace/i);
  }, 30_000);

  it('verifies and caches one human key independently for simultaneous namespaces', async () => {
    await control('/internal/repos', { userId: USER, name: 'multi-one' });
    await control('/internal/repos', { userId: 'user-2', name: 'multi-two' });
    const work = seedWorkTree('multi-namespace-work');

    git(['push', cloneUrl('multi-one', MULTI_NAMESPACE_TOKEN, USER), 'main'], work);
    git(['push', cloneUrl('multi-two', MULTI_NAMESPACE_TOKEN, 'user-2'), 'main'], work);

    expect(existsSync(join(reposRoot, USER, 'multi-one.git', 'refs', 'heads', 'main'))).toBe(true);
    expect(existsSync(join(reposRoot, 'user-2', 'multi-two.git', 'refs', 'heads', 'main'))).toBe(true);
  }, 40_000);

  it('a scoped read-only token reaches its one repo and nothing else', async () => {
    await control('/internal/repos', { userId: USER, name: 'scoped-repo' });
    const work = seedWorkTree('scoped-work');
    git(['push', cloneUrl('scoped-repo'), 'main'], work);

    // The one thing the token is FOR: cloning the repo it names.
    const clone = join(dir, 'scoped-clone');
    git(['clone', '-q', cloneUrl('scoped-repo', SCOPED_TOKEN), clone], dir);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toContain('scoped-work');

    // Same user's OTHER repo: the namespace rule passes, the scope refuses.
    expect(() => git(['clone', '-q', cloneUrl('api', SCOPED_TOKEN), join(dir, 'scoped-clone-2')], dir))
      .toThrow(/403|forbidden|scoped/i);

    // Read-only: receive-pack is refused at ref discovery, before any bytes.
    expect(() => git(['push', cloneUrl('scoped-repo', SCOPED_TOKEN), 'main'], clone))
      .toThrow(/403|forbidden|read-only/i);
  }, 40_000);

  it('404s a repo that was never created, rather than creating one on push', () => {
    const work = seedWorkTree('missing-work');
    expect(() => git(['push', cloneUrl('never-made'), 'main'], work)).toThrow();
    expect(existsSync(join(reposRoot, USER, 'never-made.git'))).toBe(false);
  }, 30_000);

  // ── post-receive → CI webhook ─────────────────────────────────────────────
  //
  // This is what lets a push to our own host drive builds the way a GitHub
  // webhook does. Every failure here is quiet: an unsigned delivery is
  // rejected by the real daemon, a missing one just means the build never
  // starts, and both look exactly like "CI is a bit slow today".

  /** Deliveries are fire-and-forget: the merge answers before one lands. */
  const waitForDelivery = async (was: number) => {
    const deadline = Date.now() + 10_000;
    while (webhookDeliveries().length === was && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const configureWebhook = (repo: string, secret: string | null) => {
    const gitDir = join(reposRoot, USER, `${repo}.git`);
    execFileSync('git', ['--git-dir', gitDir, 'config', 'agentgit.webhookUrl', `${stubUrl}/webhook`]);
    if (secret) {
      execFileSync('git', ['--git-dir', gitDir, 'config', 'agentgit.webhookSecret', secret]);
    }
  };

  it('signs a push notification to the CI daemon', async () => {
    await control('/internal/repos', { userId: USER, name: 'ci-hooked' });
    configureWebhook('ci-hooked', 'ci-secret');
    const work = seedWorkTree('ci-hooked-work');

    git(['push', cloneUrl('ci-hooked'), 'main'], work);

    const delivery = webhookDeliveries().at(-1)!;
    expect(delivery.event).toBe('push');

    const payload = JSON.parse(delivery.body);
    // The daemon's push handler reads exactly these two fields; everything
    // else is for the log line.
    expect(payload.ref).toBe('refs/heads/main');
    expect(payload.after).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.deleted).toBe(false);
    expect(payload.repository).toMatchObject({ name: 'ci-hooked', owner: USER });
    expect(payload.head_commit.message).toBe('first');

    // Signed with the repo's own secret, in the form the daemon verifies.
    const expected = 'sha256=' + createHmac('sha256', 'ci-secret').update(delivery.body).digest('hex');
    expect(delivery.signature).toBe(expected);
  }, 30_000);

  it('turns CI on and off from a boolean, filling the URL in itself', async () => {
    await control('/internal/repos', { userId: USER, name: 'ci-selfserve' });
    const work = seedWorkTree('ci-selfserve-work');

    // Off by default: the state every repo has always started in.
    const before = webhookDeliveries().length;
    git(['push', cloneUrl('ci-selfserve'), 'HEAD:main'], work);
    expect(webhookDeliveries().length).toBe(before);

    const on = await control('/internal/repos/ci', { userId: USER, name: 'ci-selfserve', enabled: true });
    expect(on.body).toEqual({ ci: true });

    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'after enabling'], work);
    git(['push', cloneUrl('ci-selfserve'), 'HEAD:main'], work);

    // The delivery is signed with the HOST's secret — the enable call never
    // sent one, and could not have.
    const delivery = webhookDeliveries().at(-1)!;
    expect(delivery.event).toBe('push');
    expect(delivery.signature)
      .toBe('sha256=' + createHmac('sha256', 'host-ci-secret').update(delivery.body).digest('hex'));
    expect(JSON.parse(delivery.body).repository).toMatchObject({ name: 'ci-selfserve', owner: USER });

    // …and stat reports the state without ever naming the URL.
    const stat = await control('/internal/repos/stat', { userId: USER, name: 'ci-selfserve' });
    expect(stat.body).toMatchObject({ ci: true });
    expect(JSON.stringify(stat.body)).not.toContain('/webhook');

    // Off again: unlike protection, CI is reversible — it grants nothing.
    const off = await control('/internal/repos/ci', { userId: USER, name: 'ci-selfserve', enabled: false });
    expect(off.body).toEqual({ ci: false });
    const quiet = webhookDeliveries().length;
    writeFileSync(join(work, 'a.txt'), 'two\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'after disabling'], work);
    git(['push', cloneUrl('ci-selfserve'), 'HEAD:main'], work);
    expect(webhookDeliveries().length).toBe(quiet);
  }, 40_000);

  it('refuses a CI enable that tries to name its own destination', async () => {
    await control('/internal/repos', { userId: USER, name: 'ci-ssrf' });
    // The shape an SSRF attempt would take. `enabled` is not a boolean, so
    // this is a 400 before anything is written — and even a well-formed
    // call carries no URL field for the host to honour.
    const res = await control('/internal/repos/ci', {
      userId: USER, name: 'ci-ssrf', enabled: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(res.status).toBe(400);

    const stat = await control('/internal/repos/stat', { userId: USER, name: 'ci-ssrf' });
    expect(stat.body).toMatchObject({ ci: false });
  }, 30_000);

  it('tells CI when the first approved merge CREATES a protected branch', async () => {
    // A protected branch that has never existed — since note #759 never the
    // default, which starts empty at creation, but a second one like
    // `release` — is created by the merge. That is a landing like any other,
    // and the one most likely to be a deploy.
    await control('/internal/repos', { userId: USER, name: 'first-merge', protectedBranches: ['main', 'release'] });
    configureWebhook('first-merge', 'ci-secret');
    const work = seedWorkTree('first-merge-work');
    git(['push', cloneUrl('first-merge'), 'HEAD:from-agent'], work);
    const before = webhookDeliveries().length;

    const merged = await control('/internal/repos/merge', {
      userId: USER, name: 'first-merge', base: 'release', head: 'from-agent', message: 'PR #1',
    });
    expect(merged.body).toMatchObject({ status: 'merged', fastForward: true });

    await waitForDelivery(before);
    const payload = JSON.parse(webhookDeliveries().at(-1)!.body);
    expect(payload.ref).toBe('refs/heads/release');
    // 40 zeros: what git itself puts in `before` for a ref being created, so
    // the receiver sees one shape whether a branch was pushed or merged into
    // existence.
    expect(payload.before).toBe('0'.repeat(40));
    expect(payload.after).toBe((merged.body as { mergeCommitSha: string }).mergeCommitSha);
    expect(payload.deleted).toBe(false);
  }, 30_000);

  it('says nothing for a repo with no webhook configured', async () => {
    await control('/internal/repos', { userId: USER, name: 'ci-silent' });
    const work = seedWorkTree('ci-silent-work');
    const before = webhookDeliveries().length;

    git(['push', cloneUrl('ci-silent'), 'main'], work);

    // The ordinary agent repo: no config, no delivery, no cost.
    expect(webhookDeliveries().length).toBe(before);
  }, 30_000);

  it('refuses to send unsigned when a URL is set but a secret is not', async () => {
    await control('/internal/repos', { userId: USER, name: 'ci-nosecret' });
    configureWebhook('ci-nosecret', null);
    const work = seedWorkTree('ci-nosecret-work');
    const before = webhookDeliveries().length;

    // The push itself must still succeed — a notification problem is not a
    // reason to reject code that is already valid.
    git(['push', cloneUrl('ci-nosecret'), 'main'], work);

    expect(webhookDeliveries().length).toBe(before);
    expect(existsSync(join(reposRoot, USER, 'ci-nosecret.git', 'refs', 'heads', 'main'))).toBe(true);
  }, 30_000);

  it('still lands the push when the CI daemon is unreachable', async () => {
    await control('/internal/repos', { userId: USER, name: 'ci-down' });
    const gitDir = join(reposRoot, USER, 'ci-down.git');
    // Port 1 is reserved and refuses instantly, so this asserts the failure
    // path without waiting out the hook's 5s timeout.
    execFileSync('git', ['--git-dir', gitDir, 'config', 'agentgit.webhookUrl', 'http://127.0.0.1:1/webhook']);
    execFileSync('git', ['--git-dir', gitDir, 'config', 'agentgit.webhookSecret', 'ci-secret']);
    const work = seedWorkTree('ci-down-work');

    expect(() => git(['push', cloneUrl('ci-down'), 'main'], work)).not.toThrow();
    expect(existsSync(join(gitDir, 'refs', 'heads', 'main'))).toBe(true);
  }, 30_000);

  it('installs hooks into a repo that predates them', async () => {
    await control('/internal/repos', { userId: USER, name: 'ci-legacy' });
    const gitDir = join(reposRoot, USER, 'ci-legacy.git');
    // Every repo created before post-receive existed looks like this. Removing
    // pre-receive too proves the gate is restored, not just the new hook.
    rmSync(join(gitDir, 'hooks', 'post-receive'));
    rmSync(join(gitDir, 'hooks', 'pre-receive'));
    configureWebhook('ci-legacy', 'ci-secret');
    const work = seedWorkTree('ci-legacy-work');
    const before = webhookDeliveries().length;

    git(['push', cloneUrl('ci-legacy'), 'main'], work);

    expect(existsSync(join(gitDir, 'hooks', 'pre-receive'))).toBe(true);
    expect(webhookDeliveries().length).toBe(before + 1);
  }, 30_000);

  it('serves nothing but the three git endpoints', async () => {
    for (const path of ['/', `/${USER}`, `/${USER}/api.git/config`, `/${USER}/api.git/HEAD`]) {
      const response = await fetch(`${hostUrl}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it('refuses a push to the protected branch, and allows a feature branch', async () => {
    await control('/internal/repos', { userId: USER, name: 'guarded', protectedBranch: 'main' });
    const work = seedWorkTree('guarded-work');

    // Since note #759 `main` exists from creation, so git itself refuses an
    // unrelated `main` before the hook is asked; --force puts it in front of
    // the hook, which is the gate under test.
    expect(() => git(['push', cloneUrl('guarded'), 'main'], work)).toThrow();
    expect(() => git(['push', '--force', cloneUrl('guarded'), 'main'], work)).toThrow(/is protected/);
    // The escape hatch the hook's own message advertises must actually work.
    expect(() => git(['push', cloneUrl('guarded'), 'HEAD:my-change'], work)).not.toThrow();
  }, 40_000);

  it('leaves a clonable HEAD when only a feature branch was ever pushed', async () => {
    // With the gate on, the FIRST push is always a branch. Before note #759
    // `main` did not exist yet, and an unreconciled HEAD gave "remote HEAD
    // refers to nonexistent ref" (found on the first live push). Now `main`
    // is there from creation, empty, and HEAD stays on it: a clone lands on
    // what was approved — nothing yet — and the work is one checkout away.
    await control('/internal/repos', { userId: USER, name: 'headonly', protectedBranch: 'main' });
    const work = seedWorkTree('headonly-work');
    git(['push', cloneUrl('headonly'), 'HEAD:feature-x'], work);

    const clone = join(dir, 'headonly-clone');
    const output = git(['clone', cloneUrl('headonly'), clone], dir);
    expect(output).not.toContain('nonexistent ref');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim()).toBe('main');
    expect(git(['log', '--format=%s', 'main'], clone).trim()).toBe('Nothing approved yet');
    expect(existsSync(join(clone, 'README.md'))).toBe(false);
    git(['checkout', '-q', 'feature-x'], clone);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toContain('headonly-work');

    // And the report tells the backend the default branch, which exists.
    expect(pushReports().at(-1)).toMatchObject({ name: 'headonly', defaultBranch: 'main' });
  }, 40_000);

  it('a protected repo is never without its protected branch: main exists from creation, before any push (note #759)', async () => {
    // Three repos in Adam's Demonstrations workplace sat with no `main` for
    // days: the first push went to a branch, HEAD followed it, and the
    // note-linked `pr create` — which fetches `main` first — refused, so the
    // work could not be proposed at all.
    await control('/internal/repos', { userId: USER, name: 'born-with-main', protectedBranch: 'main' });
    const refs = git(['ls-remote', '--symref', cloneUrl('born-with-main')], dir);
    expect(refs).toMatch(/^ref: refs\/heads\/main\tHEAD$/m);
    expect(refs).toMatch(/^[0-9a-f]{40}\trefs\/heads\/main$/m);
    const start = /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(refs)![1]!;
    // Empty and parentless: nothing an agent wrote, nothing anyone approved.
    const gitDir = join(reposRoot, USER, 'born-with-main.git');
    expect(execFileSync('git', ['--git-dir', gitDir, 'show', '-s', '--format=%T|%P|%an', start], { encoding: 'utf8' }).trim())
      .toBe(`${EMPTY_TREE_SHA}||Agentic Cloud Computer`);
    expect(execFileSync('git', ['--git-dir', gitDir, 'fsck', '--no-dangling'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toBe('');

    // A first push to a branch leaves it where it is, and HEAD on it.
    const work = seedWorkTree('born-with-main-work');
    git(['push', cloneUrl('born-with-main'), 'HEAD:typespeed-v1'], work);
    const after = git(['ls-remote', '--symref', cloneUrl('born-with-main')], dir);
    expect(after).toMatch(/^ref: refs\/heads\/main\tHEAD$/m);
    expect(after).toContain(`${start}\trefs/heads/main`);
    // An unprotected repo is left as it always was: nothing until a push.
    await control('/internal/repos', { userId: USER, name: 'free-for-all' });
    expect(git(['ls-remote', cloneUrl('free-for-all')], dir).trim()).toBe('');
  }, 40_000);

  it('repairs a protected repo made before note #759 on first contact, and tells CI nothing', async () => {
    await control('/internal/repos', { userId: USER, name: 'made-before', protectedBranch: 'main' });
    configureWebhook('made-before', 'ci-secret');
    const work = seedWorkTree('made-before-work');
    git(['push', cloneUrl('made-before'), 'HEAD:launch-calendar'], work);
    // The state the three repos were in: no main, HEAD on the first branch.
    const gitDir = join(reposRoot, USER, 'made-before.git');
    execFileSync('git', ['--git-dir', gitDir, 'update-ref', '-d', 'refs/heads/main']);
    execFileSync('git', ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', 'refs/heads/launch-calendar']);
    const before = webhookDeliveries().length;

    // The fetch a note-linked `pr create` starts with is what finds it.
    const fetched = join(dir, 'made-before-fetch');
    execFileSync('git', ['clone', '-q', '-b', 'launch-calendar', cloneUrl('made-before'), fetched]);
    expect(() => git(['fetch', '-q', 'origin', 'main'], fetched)).not.toThrow();
    expect(git(['log', '--format=%s', 'origin/main'], fetched).trim()).toBe('Nothing approved yet');
    expect(execFileSync('git', ['--git-dir', gitDir, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('main');
    // The branch is untouched, and nothing landed, so nothing was told.
    expect(git(['rev-parse', 'origin/launch-calendar'], fetched).trim()).toBe(git(['rev-parse', 'HEAD'], work).trim());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(webhookDeliveries().length).toBe(before);
  }, 40_000);

  it('the first landing over the empty start takes the branch whole and keeps both parents, squash or not (note #759)', async () => {
    for (const squash of [false, true]) {
      const name = squash ? 'first-squash' : 'first-plain';
      await control('/internal/repos', { userId: USER, name, protectedBranch: 'main' });
      configureWebhook(name, 'ci-secret');
      const work = seedWorkTree(`${name}-work`);
      writeFileSync(join(work, 'app.js'), 'go()\n');
      git(['add', '.'], work);
      git(['commit', '-qm', 'second'], work);
      git(['push', cloneUrl(name), 'HEAD:feature'], work);
      const head = git(['rev-parse', 'HEAD'], work).trim();
      const start = git(['ls-remote', cloneUrl(name), 'refs/heads/main'], dir).split('\t')[0]!;

      // What the reader is shown: every file and commit is new.
      const compared = await control('/internal/repos/compare', { userId: USER, name, base: 'main', head: 'feature' });
      expect(compared.body).toMatchObject({ baseExists: true, baseSha: start, diffStat: { files: 2 } });
      expect((compared.body as { commits: unknown[] }).commits).toHaveLength(2);

      const before = webhookDeliveries().length;
      const merged = await control('/internal/repos/merge', {
        userId: USER, name, base: 'main', head: 'feature', message: 'PR #1', squash,
      });
      expect(merged.body).toMatchObject({ status: 'merged', fastForward: false });
      const landed = (merged.body as { mergeCommitSha: string }).mergeCommitSha;

      const clone = join(dir, `${name}-clone`);
      git(['clone', '-q', cloneUrl(name), clone], dir);
      expect(git(['rev-parse', 'HEAD'], clone).trim()).toBe(landed);
      expect(readFileSync(join(clone, 'app.js'), 'utf8')).toBe('go()\n');
      expect(git(['rev-parse', 'HEAD^{tree}'], clone).trim()).toBe(git(['rev-parse', 'HEAD^{tree}'], work).trim());
      // Both parents: the start, and the agent's own branch — so its next
      // branch grows from what was approved.
      expect(git(['rev-list', '--parents', '-1', 'HEAD'], clone).trim()).toBe(`${landed} ${start} ${head}`);
      git(['fetch', '-q', cloneUrl(name), 'main'], work);
      expect(() => git(['merge-base', '--is-ancestor', head, 'FETCH_HEAD'], work)).not.toThrow();

      // A landing like any other: CI hears it, from the start's sha.
      await waitForDelivery(before);
      const payload = JSON.parse(webhookDeliveries().at(-1)!.body);
      expect(payload).toMatchObject({ ref: 'refs/heads/main', before: start, after: landed });

      // The decided proposal's frozen pair still shows everything it added.
      const frozen = await control('/internal/repos/compare', { userId: USER, name, base: start, head: landed });
      expect((frozen.body as { diffStat: { files: number } }).diffStat.files).toBe(2);
    }
  }, 60_000);

  it('protects several branches at once, and stat reports the list', async () => {
    await control('/internal/repos', { userId: USER, name: 'multi', protectedBranches: ['main', 'dev'] });
    const work = seedWorkTree('multi-work');

    expect(() => git(['push', '--force', cloneUrl('multi'), 'main'], work)).toThrow(/is protected/);
    expect(() => git(['push', cloneUrl('multi'), 'HEAD:dev'], work)).toThrow(/is protected/);
    expect(() => git(['push', cloneUrl('multi'), 'HEAD:feature'], work)).not.toThrow();

    const stat = await control('/internal/repos/stat', { userId: USER, name: 'multi' });
    expect(stat.body.protectedBranches).toEqual(['main', 'dev']);
  }, 40_000);

  it('adds protection to an existing branch — and never doubles an entry', async () => {
    await control('/internal/repos', { userId: USER, name: 'growing', protectedBranch: 'main' });
    const work = seedWorkTree('growing-work');
    // Before protection, `dev` is an ordinary branch.
    expect(() => git(['push', cloneUrl('growing'), 'HEAD:dev'], work)).not.toThrow();

    const first = await control('/internal/repos/protect', { userId: USER, name: 'growing', branches: ['dev'] });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ branches: ['main', 'dev'] });
    // A retried protect answers the same list rather than stacking values.
    const again = await control('/internal/repos/protect', { userId: USER, name: 'growing', branches: ['dev'] });
    expect(again.body).toEqual({ branches: ['main', 'dev'] });

    writeFileSync(join(work, 'more.txt'), 'more\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'more'], work);
    expect(() => git(['push', cloneUrl('growing'), 'HEAD:dev'], work)).toThrow(/is protected/);
  }, 40_000);

  it('refuses to protect a repo created unprotected — that flag is permanent', async () => {
    await control('/internal/repos', { userId: USER, name: 'scratch-repo' });
    const result = await control('/internal/repos/protect', { userId: USER, name: 'scratch-repo', branches: ['main'] });
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/permanent/);
  });

  it('keeps existing tags immovable in a protected repo, while new tags land', async () => {
    await control('/internal/repos', { userId: USER, name: 'tagged', protectedBranch: 'main' });
    const work = seedWorkTree('tagged-work');
    git(['push', cloneUrl('tagged'), 'HEAD:feature'], work);
    git(['tag', 'v1'], work);
    expect(() => git(['push', cloneUrl('tagged'), 'v1'], work)).not.toThrow();

    // Move the tag to a new commit and force-push: the old sha is non-zero,
    // so the hook must refuse — and a delete is the same rule.
    writeFileSync(join(work, 'more.txt'), 'more\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'more'], work);
    git(['tag', '-f', 'v1'], work);
    expect(() => git(['push', '--force', cloneUrl('tagged'), 'v1'], work)).toThrow(/permanent/);
    expect(() => git(['push', cloneUrl('tagged'), ':v1'], work)).toThrow(/permanent/);

    git(['tag', 'v2'], work);
    expect(() => git(['push', cloneUrl('tagged'), 'v2'], work)).not.toThrow();
  }, 40_000);

  it('leaves tags free in an unprotected repo', async () => {
    await control('/internal/repos', { userId: USER, name: 'untagged' });
    const work = seedWorkTree('untagged-work');
    git(['tag', 'v1'], work);
    git(['push', cloneUrl('untagged'), 'main'], work);
    git(['push', cloneUrl('untagged'), 'v1'], work);
    expect(() => git(['push', cloneUrl('untagged'), ':v1'], work)).not.toThrow();
  }, 40_000);

  it('refuses a push that would exceed the per-repo quota', async () => {
    await control('/internal/repos', { userId: USER, name: 'tiny' });
    const work = seedWorkTree('tiny-work');
    // The tiny-quota token gets a 1-byte repo cap from the stub.
    expect(() => git(['push', cloneUrl('tiny', TINY_QUOTA_TOKEN), 'main'], work))
      .toThrow(/the limit is/);
  }, 40_000);

  it('merges an approved proposal: fast-forward, real merge, conflict, and stale', async () => {
    // Unprotected on purpose: this test is about merge MECHANICS, and the
    // gate (tested above) would rightly refuse the direct pushes used to set
    // up a base and a diverged branch.
    await control('/internal/repos', { userId: USER, name: 'merges' });
    const work = seedWorkTree('merges-work');
    // A base to merge into.
    git(['push', cloneUrl('merges'), 'HEAD:main'], work);

    // ── fast-forward ──
    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'add a'], work);
    git(['push', cloneUrl('merges'), 'HEAD:feature-ff'], work);
    const headFf = git(['rev-parse', 'HEAD'], work).trim();

    const ff = await control('/internal/repos/merge', {
      userId: USER, name: 'merges', base: 'main', head: 'feature-ff',
      expectedHead: headFf, message: 'PR #1',
    });
    expect(ff.body).toMatchObject({ status: 'merged', fastForward: true });

    // ── stale: approval was for a sha the branch has moved past ──
    writeFileSync(join(work, 'a.txt'), 'two\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'change a again'], work);
    git(['push', cloneUrl('merges'), 'HEAD:feature-ff'], work);
    const stale = await control('/internal/repos/merge', {
      userId: USER, name: 'merges', base: 'main', head: 'feature-ff',
      expectedHead: headFf, message: 'PR #2',
    });
    // The user approved a diff, not a branch name.
    expect((stale.body as { status: string }).status).toBe('stale');

    // ── real merge: both sides moved, no overlap ──
    const side = join(dir, 'merges-side');
    git(['clone', '-q', '-b', 'main', cloneUrl('merges'), side], dir);
    writeFileSync(join(side, 'from-main.txt'), 'main moved\n');
    git(['add', '.'], side);
    git(['commit', '-qm', 'main moves'], side);
    git(['push', cloneUrl('merges'), 'HEAD:main'], side);

    const merged = await control('/internal/repos/merge', {
      userId: USER, name: 'merges', base: 'main', head: 'feature-ff', message: 'PR #3',
    });
    expect(merged.body).toMatchObject({ status: 'merged', fastForward: false });

    // ── conflict: both sides changed the same line ──
    await control('/internal/repos', { userId: USER, name: 'clash' });
    const cwork = seedWorkTree('clash-work');
    git(['push', cloneUrl('clash'), 'HEAD:main'], cwork);
    writeFileSync(join(cwork, 'README.md'), 'theirs\n');
    git(['add', '.'], cwork);
    git(['commit', '-qm', 'theirs'], cwork);
    git(['push', cloneUrl('clash'), 'HEAD:main'], cwork);
    git(['reset', '-q', '--hard', 'HEAD~1'], cwork);
    writeFileSync(join(cwork, 'README.md'), 'ours\n');
    git(['add', '.'], cwork);
    git(['commit', '-qm', 'ours'], cwork);
    git(['push', cloneUrl('clash'), 'HEAD:ours'], cwork);

    const conflict = await control('/internal/repos/merge', {
      userId: USER, name: 'clash', base: 'main', head: 'ours', message: 'PR #1',
    });
    // Never auto-resolved: that is the whole reason a human is in this loop.
    expect((conflict.body as { status: string }).status).toBe('conflict');
    const after = await control('/internal/repos/compare', {
      userId: USER, name: 'clash', base: 'main', head: 'main',
    });
    expect((after.body as { diffStat: { files: number } }).diffStat.files).toBe(0);
  }, 60_000);

  it('squashes when asked: one commit, one parent, the branch author kept', async () => {
    await control('/internal/repos', { userId: USER, name: 'squashes' });
    const work = seedWorkTree('squashes-work');
    git(['push', cloneUrl('squashes'), 'HEAD:main'], work);

    // ── base merely behind: two commits of branch noise land as ONE ──
    writeFileSync(join(work, 's.txt'), 'one\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'wip'], work);
    writeFileSync(join(work, 's.txt'), 'two\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'fix the wip'], work);
    git(['push', cloneUrl('squashes'), 'HEAD:feature'], work);

    const squashed = await control('/internal/repos/merge', {
      userId: USER, name: 'squashes', base: 'main', head: 'feature',
      message: 'Add s (#1)', squash: true,
    });
    expect(squashed.body).toMatchObject({ status: 'merged', fastForward: false });

    const clone = join(dir, 'squashes-clone');
    git(['clone', '-q', '-b', 'main', cloneUrl('squashes'), clone], dir);
    // The seed commit plus ONE squash commit — the wip pair never reaches
    // main's history, though its final tree does, verbatim.
    expect(git(['log', '--format=%s', 'main'], clone).trim().split('\n')).toEqual(['Add s (#1)', 'first']);
    expect(readFileSync(join(clone, 's.txt'), 'utf8')).toBe('two\n');
    // A single parent: a squash is not a merge commit.
    expect(git(['rev-list', '--parents', '-1', 'main'], clone).trim().split(' ')).toHaveLength(2);
    // The squash REPLACES the branch's commits, so the one that remains keeps
    // their author; the committer stays the platform, as on every merge.
    expect(git(['log', '-1', '--format=%an|%cn', 'main'], clone).trim()).toBe('Test|Agentic Cloud Computer');

    // ── diverged: a squash still three-way merges, still one parent ──
    writeFileSync(join(clone, 'from-main.txt'), 'main moved\n');
    git(['add', '.'], clone);
    git(['commit', '-qm', 'main moves'], clone);
    git(['push', cloneUrl('squashes'), 'HEAD:main'], clone);
    writeFileSync(join(work, 'branch-only.txt'), 'branch\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'more branch work'], work);
    git(['push', cloneUrl('squashes'), 'HEAD:feature'], work);

    const diverged = await control('/internal/repos/merge', {
      userId: USER, name: 'squashes', base: 'main', head: 'feature',
      message: 'More work (#2)', squash: true,
    });
    expect(diverged.body).toMatchObject({ status: 'merged', fastForward: false });

    const clone2 = join(dir, 'squashes-clone-2');
    git(['clone', '-q', '-b', 'main', cloneUrl('squashes'), clone2], dir);
    expect(git(['log', '--format=%s', 'main'], clone2).trim().split('\n'))
      .toEqual(['More work (#2)', 'main moves', 'Add s (#1)', 'first']);
    expect(git(['rev-list', '--parents', '-1', 'main'], clone2).trim().split(' ')).toHaveLength(2);
    // Both sides of the divergence are in the tree.
    expect(readFileSync(join(clone2, 'from-main.txt'), 'utf8')).toBe('main moved\n');
    expect(readFileSync(join(clone2, 'branch-only.txt'), 'utf8')).toBe('branch\n');
  }, 60_000);

  /**
   * The merge path writes the ref itself, so receive-pack never runs and no
   * hook fires. A fast-forward does not care — main lands on a sha CI judged
   * when the branch was pushed. A real merge does: `commit-tree` mints a commit
   * whose tree exists nowhere else, it lands on the protected branch, and
   * before this it carried no status ever, with nothing to notice it was
   * missing.
   */
  it('tells CI about every landing on the base, fast-forward included', async () => {
    await control('/internal/repos', { userId: USER, name: 'merge-ci' });
    configureWebhook('merge-ci', 'ci-secret');
    const work = seedWorkTree('merge-ci-work');
    git(['push', cloneUrl('merge-ci'), 'HEAD:main'], work);
    // Where the REMOTE's main sits before the merge — the local branch of the
    // same name moves on below, and is not the same thing.
    const mainBeforeFf = git(['rev-parse', 'HEAD'], work).trim();

    // ── fast-forward ──
    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'add a'], work);
    git(['push', cloneUrl('merge-ci'), 'HEAD:feature'], work);
    // The push that CI already answered — and the delivery every merge
    // delivery below is measured against.
    const pushPayload = JSON.parse(webhookDeliveries().at(-1)!.body);
    const beforeMerges = webhookDeliveries().length;

    const ff = await control('/internal/repos/merge', {
      userId: USER, name: 'merge-ci', base: 'main', head: 'feature', message: 'PR #1',
    });
    expect(ff.body).toMatchObject({ status: 'merged', fastForward: true });

    // A fast-forward moves the PROTECTED branch onto a sha whose only run
    // happened on the source branch — which is unprotected, so that run got
    // none of the owner's granted secrets. Skipping the delivery here is
    // what made a deploy silently not happen (found by rehearsal,
    // 2026-08-13); most PRs fast-forward, so this is the common path.
    await waitForDelivery(beforeMerges);
    expect(webhookDeliveries().length).toBe(beforeMerges + 1);
    const ffPayload = JSON.parse(webhookDeliveries().at(-1)!.body);
    expect(ffPayload.ref).toBe('refs/heads/main');
    expect(ffPayload.before).toBe(mainBeforeFf);
    expect(ffPayload.after).toBe((ff.body as { mergeCommitSha: string }).mergeCommitSha);

    // A second identical tap moves nothing, so it says nothing: the guard is
    // "did the ref move", not "was this a merge".
    const settled = webhookDeliveries().length;
    const again = await control('/internal/repos/merge', {
      userId: USER, name: 'merge-ci', base: 'main', head: 'feature', message: 'PR #1 again',
    });
    expect(again.body).toMatchObject({ status: 'merged' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(webhookDeliveries().length).toBe(settled);

    // ── real merge: both sides moved ──
    writeFileSync(join(work, 'a.txt'), 'two\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'change a'], work);
    git(['push', cloneUrl('merge-ci'), 'HEAD:feature'], work);
    const side = join(dir, 'merge-ci-side');
    git(['clone', '-q', '-b', 'main', cloneUrl('merge-ci'), side], dir);
    writeFileSync(join(side, 'from-main.txt'), 'main moved\n');
    git(['add', '.'], side);
    git(['commit', '-qm', 'main moves'], side);
    git(['push', cloneUrl('merge-ci'), 'HEAD:main'], side);
    const mainBefore = git(['rev-parse', 'HEAD'], side).trim();
    // Both branch pushes delivered; from here only the merge can add one.
    const beforeRealMerge = webhookDeliveries().length;

    const merged = await control('/internal/repos/merge', {
      userId: USER, name: 'merge-ci', base: 'main', head: 'feature', message: 'PR #3',
    });
    expect(merged.body).toMatchObject({ status: 'merged', fastForward: false });

    // The send is fire-and-forget — the merge is answered before it lands.
    await waitForDelivery(beforeRealMerge);
    // Settle, so a late second delivery is caught rather than raced past.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Exactly one: the merge's.
    expect(webhookDeliveries().length).toBe(beforeRealMerge + 1);

    const delivery = webhookDeliveries().at(-1)!;
    expect(delivery.event).toBe('push');
    const payload = JSON.parse(delivery.body);
    expect(payload.ref).toBe('refs/heads/main');
    expect(payload.before).toBe(mainBefore);
    expect(payload.after).toBe((merged.body as { mergeCommitSha: string }).mergeCommitSha);
    expect(payload.deleted).toBe(false);
    expect(payload.repository).toMatchObject({ name: 'merge-ci', owner: USER });
    // The SUBJECT, as a push delivery carries — not the whole merge message.
    expect(payload.head_commit).toMatchObject({ id: payload.after, message: 'PR #3' });

    // Signed with the repo's secret, in the form the daemon verifies.
    expect(delivery.signature)
      .toBe('sha256=' + createHmac('sha256', 'ci-secret').update(delivery.body).digest('hex'));

    // The drift pin. The hook is copied byte-for-byte into each bare repo, so
    // the merge path cannot import it and the two payloads are built twice.
    // The daemon has ONE push handler: they must stay the same shape.
    expect(Object.keys(payload).sort()).toEqual(Object.keys(pushPayload).sort());
    expect(Object.keys(payload.repository).sort()).toEqual(Object.keys(pushPayload.repository).sort());
    expect(Object.keys(payload.head_commit).sort()).toEqual(Object.keys(pushPayload.head_commit).sort());
  }, 60_000);

  it('merges without a CI webhook configured, and says nothing', async () => {
    // The ordinary agent repo: a real merge, no config, no delivery, no cost.
    await control('/internal/repos', { userId: USER, name: 'merge-silent' });
    const work = seedWorkTree('merge-silent-work');
    git(['push', cloneUrl('merge-silent'), 'HEAD:main'], work);
    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'add a'], work);
    git(['push', cloneUrl('merge-silent'), 'HEAD:feature'], work);
    const side = join(dir, 'merge-silent-side');
    git(['clone', '-q', '-b', 'main', cloneUrl('merge-silent'), side], dir);
    writeFileSync(join(side, 'from-main.txt'), 'main moved\n');
    git(['add', '.'], side);
    git(['commit', '-qm', 'main moves'], side);
    git(['push', cloneUrl('merge-silent'), 'HEAD:main'], side);
    const before = webhookDeliveries().length;

    const merged = await control('/internal/repos/merge', {
      userId: USER, name: 'merge-silent', base: 'main', head: 'feature', message: 'PR #1',
    });

    expect(merged.body).toMatchObject({ status: 'merged', fastForward: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(webhookDeliveries().length).toBe(before);
  }, 60_000);

  it('compares a first branch against the empty start of main, and merging it fills main', async () => {
    await control('/internal/repos', { userId: USER, name: 'firstpr', protectedBranch: 'main' });
    const work = seedWorkTree('firstpr-work');
    git(['push', cloneUrl('firstpr'), 'HEAD:feature-1'], work);

    // The very first proposal has no `main` to diff against; the empty tree
    // stands in, so the user still sees what they are approving.
    const result = await control('/internal/repos/compare', {
      userId: USER, name: 'firstpr', base: 'main', head: 'feature-1',
    });
    const body = result.body as {
      baseExists: boolean; diffStat: { files: number };
      commits: Array<{ sha: string; subject: string; at: string }>;
    };
    // Since note #759 `main` exists from creation, empty: it reads the same
    // as no base at all.
    expect(body.baseExists).toBe(true);
    expect(body.diffStat.files).toBe(1);
    expect(body.commits).toHaveLength(1);
    // Sha, subject AND date — the proposal screen dates every commit row off
    // the last of these.
    expect(body.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.commits[0]!.subject).toBe('first');
    expect(Number.isNaN(Date.parse(body.commits[0]!.at))).toBe(false);

    // And merging it fills the protected branch.
    const merged = await control('/internal/repos/merge', {
      userId: USER, name: 'firstpr', base: 'main', head: 'feature-1', message: 'PR #1',
    });
    expect(merged.body).toMatchObject({ status: 'merged' });

    // ── after the merge ──
    // The live compare is now empty, and correctly so: the branch IS main.
    // That is exactly why the Mini App stops asking it once a proposal is
    // decided — a merged proposal that shows no diff shows nothing at all.
    const live = await control('/internal/repos/compare', {
      userId: USER, name: 'firstpr', base: 'main', head: 'feature-1',
    });
    expect((live.body as { diffStat: { files: number } }).diffStat.files).toBe(0);

    // The frozen pair the decided proposal carries still answers in full. A
    // first proposal has no base sha — nothing existed to branch from — so
    // the empty tree stands in, and the host reads it the same way it reads a
    // base branch that is not there yet: all of it is new.
    const frozen = await control('/internal/repos/compare', {
      userId: USER, name: 'firstpr', base: EMPTY_TREE_SHA, head: (merged.body as { mergeCommitSha: string }).mergeCommitSha,
    });
    expect((frozen.body as { diffStat: { files: number; insertions: number } }).diffStat)
      .toMatchObject({ files: 1, insertions: 1 });
    expect((frozen.body as { patch: string }).patch).toContain('+# firstpr-work');
  }, 60_000);

  it('browses the default branch: a tree, a file, and the traversal guards', async () => {
    await control('/internal/repos', { userId: USER, name: 'browse', protectedBranch: 'main' });
    const work = seedWorkTree('browse-work');
    execFileSync('mkdir', ['-p', join(work, 'src')]);
    writeFileSync(join(work, 'src', 'app.js'), 'console.log("hi")\n');
    writeFileSync(join(work, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(work, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    git(['add', '.'], work);
    git(['commit', '-qm', 'add files'], work);
    // The gate is on, so the browse branch IS the default via a merge to main.
    git(['push', cloneUrl('browse'), 'HEAD:feature'], work);
    await control('/internal/repos/merge', {
      userId: USER, name: 'browse', base: 'main', head: 'feature', message: 'PR #1',
    });

    // Root listing: folders and files, with sizes on the blobs.
    const root = await control('/internal/repos/tree', { userId: USER, name: 'browse', path: '' });
    expect(root.status).toBe(200);
    const rootBody = root.body as { branch: string; entries: Array<Record<string, unknown>> };
    expect(rootBody.branch).toBe('main');
    expect(rootBody.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'src', type: 'dir' }),
      expect.objectContaining({ name: 'README.md', type: 'file' }),
      expect.objectContaining({ name: 'logo.png', type: 'file' }),
    ]));

    // A subfolder.
    const sub = await control('/internal/repos/tree', { userId: USER, name: 'browse', path: 'src' });
    expect((sub.body as { entries: Array<{ name: string }> }).entries)
      .toEqual([expect.objectContaining({ name: 'app.js', type: 'file' })]);

    // A text file comes back with content.
    const file = await control('/internal/repos/file', { userId: USER, name: 'browse', path: 'src/app.js' });
    expect(file.body).toMatchObject({ branch: 'main', content: 'console.log("hi")\n' });

    // A binary file that is not an image is flagged, never streamed as
    // garbled text.
    const bin = await control('/internal/repos/file', { userId: USER, name: 'browse', path: 'blob.bin' });
    expect(bin.body).toMatchObject({ binary: true });
    expect((bin.body as { content?: string }).content).toBeUndefined();

    // An image is neither: it comes back as bytes the page can render.
    const png = await control('/internal/repos/file', { userId: USER, name: 'browse', path: 'logo.png' });
    expect(png.body).toMatchObject({ branch: 'main', image: { mime: 'image/png' } });
    expect((png.body as { binary?: boolean }).binary).toBeUndefined();

    // Traversal is refused before it reaches git.
    const escape = await control('/internal/repos/tree', { userId: USER, name: 'browse', path: '../../etc' });
    expect(escape.status).toBe(400);
    const escapeFile = await control('/internal/repos/file', { userId: USER, name: 'browse', path: '../config' });
    expect(escapeFile.status).toBe(400);

    // A directory is not a file.
    const asFile = await control('/internal/repos/file', { userId: USER, name: 'browse', path: 'src' });
    expect(asFile.status).toBe(404);
  }, 60_000);

  it('hands images back as their own bytes, by name, whatever is inside them', async () => {
    await control('/internal/repos', { userId: USER, name: 'pics' });
    const work = seedWorkTree('pics-work');
    // Real PNG bytes (a 1×1 transparent pixel), so the round trip proves the
    // page would get something a browser can actually decode.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(work, 'pixel.png'), png);
    // Text that is still a picture — the NUL heuristic would call this a file
    // to read, and it is a file to look at.
    writeFileSync(join(work, 'mark.SVG'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    // A dotfile is not an extension: `.png` is a config file called .png.
    writeFileSync(join(work, '.png'), 'not an image\n');
    // Past the image cap: answered with its facts, like any oversized blob.
    writeFileSync(join(work, 'huge.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
    git(['add', '.'], work);
    git(['commit', '-qm', 'add pictures'], work);
    git(['push', cloneUrl('pics'), 'main'], work);

    const pixel = await control('/internal/repos/file', { userId: USER, name: 'pics', path: 'pixel.png' });
    const image = (pixel.body as { image: { mime: string; base64: string } }).image;
    expect(image.mime).toBe('image/png');
    // The bytes on the wire are the bytes in the repo — not re-encoded, not
    // truncated, not run through a text decoder on the way out.
    expect(Buffer.from(image.base64, 'base64').equals(png)).toBe(true);

    // The extension decides, case and all.
    const svg = await control('/internal/repos/file', { userId: USER, name: 'pics', path: 'mark.SVG' });
    expect(svg.body).toMatchObject({ image: { mime: 'image/svg+xml' } });

    const dotfile = await control('/internal/repos/file', { userId: USER, name: 'pics', path: '.png' });
    expect(dotfile.body).toMatchObject({ content: 'not an image\n' });
    expect((dotfile.body as { image?: unknown }).image).toBeUndefined();

    const huge = await control('/internal/repos/file', { userId: USER, name: 'pics', path: 'huge.png' });
    expect(huge.body).toMatchObject({ tooLarge: true });
    expect((huge.body as { image?: unknown }).image).toBeUndefined();
  }, 60_000);

  it('lists recent commits on the default branch, newest first', async () => {
    await control('/internal/repos', { userId: USER, name: 'history' });
    const work = seedWorkTree('history-work');
    // A subject carrying the characters a naive format string would break on.
    writeFileSync(join(work, 'a.txt'), 'a\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'second: tabs\tand "quotes" and | pipes'], work);
    writeFileSync(join(work, 'b.txt'), 'b\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'third'], work);
    git(['push', cloneUrl('history'), 'main'], work);

    const log = await control('/internal/repos/log', { userId: USER, name: 'history' });
    expect(log.status).toBe(200);
    const body = log.body as {
      branch: string;
      commits: Array<{ sha: string; subject: string; authorName: string; at: string }>;
    };
    expect(body.branch).toBe('main');
    expect(body.commits.map((c) => c.subject))
      .toEqual(['third', 'second: tabs\tand "quotes" and | pipes', 'first']);
    expect(body.commits[0].authorName).toBe('Test');
    expect(body.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    // A real date, not a git-format leftover.
    expect(Number.isNaN(Date.parse(body.commits[0].at))).toBe(false);

    // A limit is honoured…
    const one = await control('/internal/repos/log', { userId: USER, name: 'history', limit: 1 });
    expect((one.body as { commits: unknown[] }).commits).toHaveLength(1);
    // …clamped rather than refused…
    const many = await control('/internal/repos/log', { userId: USER, name: 'history', limit: 5000 });
    expect((many.body as { commits: unknown[] }).commits).toHaveLength(3);
    // …and never anything but a whole number, which is what reaches `git log`.
    for (const limit of [0, -1, 1.5, '10', '3; rm -rf /']) {
      const bad = await control('/internal/repos/log', { userId: USER, name: 'history', limit });
      expect(bad.status, `limit ${JSON.stringify(limit)}`).toBe(400);
    }

    const missing = await control('/internal/repos/log', { userId: USER, name: 'no-such-repo' });
    expect(missing.status).toBe(404);
  }, 60_000);

  /**
   * ONE commit's diff — the route `compare` cannot answer, because naming a
   * commit's parent takes `sha^` and the branch validator refuses a caret.
   */
  it('reads one commit and what it changed, root commits and merges included', async () => {
    await control('/internal/repos', { userId: USER, name: 'onecommit' });
    const work = seedWorkTree('onecommit-work');
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'second: adds two lines\n\nAnd a body that says why.'], work);
    git(['push', cloneUrl('onecommit'), 'main'], work);
    // A branch that diverges, merged back with a real merge commit.
    git(['checkout', '-qb', 'side'], work);
    writeFileSync(join(work, 'b.txt'), 'from the side\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'side work'], work);
    git(['checkout', '-q', 'main'], work);
    git(['merge', '--no-ff', '-q', '-m', 'merge side', 'side'], work);
    git(['push', cloneUrl('onecommit'), 'main'], work);

    const log = await control('/internal/repos/log', { userId: USER, name: 'onecommit' });
    const commits = (log.body as { commits: Array<{ sha: string; subject: string }> }).commits;
    const bySubject = (s: string) => commits.find((c) => c.subject === s)!.sha;

    const second = await control('/internal/repos/commit',
      { userId: USER, name: 'onecommit', sha: bySubject('second: adds two lines') });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      subject: 'second: adds two lines',
      body: 'And a body that says why.',
      diffStat: { files: 1, insertions: 2, deletions: 0 },
      patchTruncated: false,
    });
    expect((second.body as { patch: string }).patch).toContain('+two');
    expect((second.body as { parents: string[] }).parents).toHaveLength(1);

    // The ROOT commit: no parent, so the diff is from the empty tree — every
    // line an addition, not an error.
    const root = await control('/internal/repos/commit',
      { userId: USER, name: 'onecommit', sha: bySubject('first') });
    expect(root.status).toBe(200);
    expect((root.body as { parents: string[] }).parents).toEqual([]);
    expect((root.body as { diffStat: { files: number } }).diffStat.files).toBeGreaterThan(0);

    // A MERGE: diffed against its first parent, which is what "what did this
    // merge bring in" means — `git show` alone would answer with nothing.
    const merge = await control('/internal/repos/commit',
      { userId: USER, name: 'onecommit', sha: bySubject('merge side') });
    expect((merge.body as { parents: string[] }).parents).toHaveLength(2);
    expect((merge.body as { patch: string }).patch).toContain('from the side');

    // A short sha is a sha: git resolves it, and the answer names it in full.
    const short = await control('/internal/repos/commit',
      { userId: USER, name: 'onecommit', sha: bySubject('side work').slice(0, 8) });
    expect((short.body as { sha: string }).sha).toBe(bySubject('side work'));

    // Nothing but a sha reaches git: no ref expressions, no options, no
    // traversal — and a well-formed sha that is not here is simply not found.
    for (const sha of ['HEAD', 'main', `${bySubject('side work')}^`, 'main..side', '--output=/tmp/x', '', 42]) {
      const bad = await control('/internal/repos/commit', { userId: USER, name: 'onecommit', sha });
      expect(bad.status, `sha ${JSON.stringify(sha)}`).toBe(400);
    }
    const absent = await control('/internal/repos/commit',
      { userId: USER, name: 'onecommit', sha: 'a'.repeat(40) });
    expect(absent.status).toBe(404);
    const noRepo = await control('/internal/repos/commit',
      { userId: USER, name: 'no-such-repo', sha: 'a'.repeat(40) });
    expect(noRepo.status).toBe(404);
  }, 60_000);

  it('reports an empty branch for a repo with no commits', async () => {
    await control('/internal/repos', { userId: USER, name: 'nocommits' });
    const tree = await control('/internal/repos/tree', { userId: USER, name: 'nocommits', path: '' });
    expect(tree.body).toEqual({ branch: null, entries: [] });
    // Same answer from the history: nothing has happened here yet, which is
    // not an error and must not read as one.
    const log = await control('/internal/repos/log', { userId: USER, name: 'nocommits' });
    expect(log.status).toBe(200);
    expect(log.body).toEqual({ branch: null, commits: [] });

    // A protected repo has its branch from the start (note #759): empty, and
    // its one commit says so.
    await control('/internal/repos', { userId: USER, name: 'nocommits-guarded', protectedBranch: 'main' });
    const guardedTree = await control('/internal/repos/tree', { userId: USER, name: 'nocommits-guarded', path: '' });
    expect(guardedTree.body).toEqual({ branch: 'main', entries: [] });
    const guardedLog = await control('/internal/repos/log', { userId: USER, name: 'nocommits-guarded' });
    expect(guardedLog.body).toMatchObject({ branch: 'main', commits: [expect.objectContaining({ subject: 'Nothing approved yet' })] });
  });

  it('reports disk usage on /health', async () => {
    const response = await fetch(`${hostUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; diskUsedPercent: number };
    expect(body.ok).toBe(true);
    expect(body.diskUsedPercent).toBeGreaterThanOrEqual(0);
  });

  /**
   * The knowledge base (docs/agent-knowledge-pages.md): a bare repo in the
   * user's namespace that NO git request can reach, written only by these
   * three control calls. The last test in this block is the fence — if a
   * knowledge base ever becomes clonable, the approval gate is bypassable by
   * pushing to it, and every other test here would still pass.
   */
  describe('knowledge pages', () => {
    const page = (name: string, text: string) =>
      `<!doctype html><title>${name}</title><meta name="description" content="${text}"><p>${text}</p>`;

    it('creates the base on the first commit and reads the page back byte-for-byte', async () => {
      const html = page('Runbook', 'How the deploy goes.');
      const commit = await control('/internal/knowledge/commit', {
        userId: USER,
        writes: [
          { path: 'pages/deploy-runbook.html', content: html },
          { path: 'index.json', content: '{"pages":{}}\n' },
        ],
        message: 'Add the runbook',
      });
      expect(commit.status).toBe(200);
      expect((commit.body as { status: string }).status).toBe('committed');

      const read = await control('/internal/knowledge/read', { userId: USER, page: 'deploy-runbook' });
      expect((read.body as { content: string }).content).toBe(html);

      const listed = await control('/internal/knowledge/list', { userId: USER });
      const body = listed.body as { pages: Array<{ name: string; sha: string }>; index: string };
      expect(body.pages.map((entry) => entry.name)).toEqual(['deploy-runbook']);
      expect(body.index).toBe('{"pages":{}}\n');
      // The sha is git's own blob id, which is what a proposal pins against.
      expect(body.pages[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('lands several pages as ONE commit, and removes one', async () => {
      await control('/internal/knowledge/commit', {
        userId: USER,
        writes: [
          { path: 'pages/one.html', content: page('One', 'First.') },
          { path: 'pages/two.html', content: page('Two', 'Second.') },
        ],
        message: 'Two pages',
      });
      const before = await control('/internal/knowledge/list', { userId: USER });
      expect((before.body as { pages: unknown[] }).pages.length).toBeGreaterThanOrEqual(3);

      await control('/internal/knowledge/commit', {
        userId: USER,
        deletes: ['pages/one.html'],
        message: 'Remove one',
      });
      const after = await control('/internal/knowledge/list', { userId: USER });
      const names = (after.body as { pages: Array<{ name: string }> }).pages.map((entry) => entry.name);
      expect(names).not.toContain('one');
      expect(names).toContain('two');
      // Removing what is already gone is a no-op, not a failure: an approval
      // that lands twice must be harmless.
      const again = await control('/internal/knowledge/commit', {
        userId: USER, deletes: ['pages/one.html'], message: 'Remove one again',
      });
      expect((again.body as { status: string }).status).toBe('committed');
    });

    it('reports a commit that changes nothing as unchanged rather than piling up empty history', async () => {
      const html = page('Stable', 'Unchanged.');
      await control('/internal/knowledge/commit', {
        userId: USER, writes: [{ path: 'pages/stable.html', content: html }], message: 'Add',
      });
      const repeat = await control('/internal/knowledge/commit', {
        userId: USER, writes: [{ path: 'pages/stable.html', content: html }], message: 'Add again',
      });
      expect(repeat.body).toMatchObject({ status: 'committed', unchanged: true });
    });

    it('refuses a write outside the pages the base may hold', async () => {
      for (const path of ['../escape.html', 'hooks/post-receive', 'pages/../../x.html', 'pages/Bad Name.html']) {
        const result = await control('/internal/knowledge/commit', {
          userId: USER, writes: [{ path, content: 'x' }], message: 'nope',
        });
        expect(result.status, path).toBe(409);
      }
    });

    it('answers `stale` when the base moved under the caller', async () => {
      const result = await control('/internal/knowledge/commit', {
        userId: USER,
        writes: [{ path: 'pages/anchored.html', content: page('A', 'A.') }],
        message: 'Anchored',
        expectedHead: 'f'.repeat(40),
      });
      expect((result.body as { status: string }).status).toBe('stale');
    });

    it('permanently removes a room knowledge base only through the authenticated control route', async () => {
      const base = join(reposRoot, USER, '_knowledge.git');
      expect(existsSync(base)).toBe(true);
      const forged = await control('/internal/knowledge/delete', { userId: USER }, 'wrong');
      expect(forged.status).toBe(401);
      expect(existsSync(base)).toBe(true);

      const removed = await control('/internal/knowledge/delete', { userId: USER });
      expect(removed.body).toEqual({ deleted: true });
      expect(existsSync(base)).toBe(false);
      const listed = await control('/internal/knowledge/list', { userId: USER });
      expect(listed.body).toEqual({ pages: [], index: null });
    });

    it('is NOT reachable over git — no clone, no push, no way around the gate', async () => {
      const workdir = mkdtempSync(join(dir, 'knowledge-clone-'));
      expect(() => git(['clone', cloneUrl('_knowledge'), 'kb'], workdir)).toThrow();
      // And the control API refuses to treat it as an ordinary repo either:
      // the repo endpoints validate the name, and this one cannot pass.
      const stat = await control('/internal/repos/stat', { userId: USER, name: '_knowledge' });
      expect(stat.status).toBe(400);
    });
  });

  /**
   * The admin surface (docs/agent-git-project-repos.md slice 5). What these
   * are really asserting: no verb here reaches `rm`. A delete is a move into
   * the trash, a restore is the move back, and a rename is a move within the
   * namespace — so the bytes are somewhere on disk after every one of them.
   */
  describe('delete / restore / rename', () => {
    const trashRoot = () => join(dir, 'trash');

    it('a delete MOVES the repo to the trash — history, protection and all', async () => {
      await control('/internal/repos', { userId: USER, name: 'doomed', protectedBranches: ['main'] });
      const work = seedWorkTree('doomed-work');
      git(['remote', 'add', 'origin', cloneUrl('doomed')], work);
      git(['push', '-q', 'origin', 'HEAD:feature'], work);

      const deleted = await control('/internal/repos/delete', { userId: USER, name: 'doomed' });
      expect(deleted.status).toBe(200);
      const { deleted: didDelete, trashedAs } = deleted.body as { deleted: boolean; trashedAs: string };
      expect(didDelete).toBe(true);
      expect(trashedAs).toMatch(/^doomed\.\d{8}T\d{6}Z\.git$/);

      expect(existsSync(join(reposRoot, USER, 'doomed.git'))).toBe(false);
      const entry = join(trashRoot(), USER, trashedAs);
      expect(existsSync(entry)).toBe(true);
      // The commits are still there, and so is the gate: protection lives in
      // the repo's own config, so it travelled with the directory.
      expect(execFileSync('git', ['--git-dir', entry, 'rev-parse', 'refs/heads/feature'], { encoding: 'utf8' }).trim())
        .toHaveLength(40);
      expect(execFileSync('git', ['--git-dir', entry, 'config', '--get-all', 'agentgit.protectedBranch'], { encoding: 'utf8' }).trim())
        .toBe('main');

      // And it stops being servable the moment it moves.
      expect(() => git(['ls-remote', cloneUrl('doomed')], dir)).toThrow();
    });

    it('stamps the trash entry with the DELETE time, not the last push', async () => {
      // The purge ages entries by mtime, and rename(2) does not touch it — so
      // without an explicit stamp a repo nobody had pushed to for a month
      // would arrive in the trash already past a 14-day window and be swept
      // on the next weekly run. Caught on the first live delete: the entry's
      // name said 07:33, its mtime said 07:09.
      await control('/internal/repos', { userId: USER, name: 'idle' });
      const live = join(reposRoot, USER, 'idle.git');
      execFileSync('touch', ['-d', '40 days ago', live]);
      expect(Date.now() - statSync(live).mtimeMs).toBeGreaterThan(30 * 86_400_000);

      const { body } = await control('/internal/repos/delete', { userId: USER, name: 'idle' });
      const entry = join(dir, 'trash', USER, (body as { trashedAs: string }).trashedAs);

      // Fresh: this entry has its full window ahead of it, not behind it.
      expect(Date.now() - statSync(entry).mtimeMs).toBeLessThan(60_000);
    });

    it('deleting what is already gone answers the state, and points at the entry it made', async () => {
      await control('/internal/repos', { userId: USER, name: 'twice' });
      const first = await control('/internal/repos/delete', { userId: USER, name: 'twice' });
      const again = await control('/internal/repos/delete', { userId: USER, name: 'twice' });

      expect(again.status).toBe(200);
      // A retried delete — the bookkeeping failed the first time — must still
      // learn where the bytes went, or it tombstones a repo it cannot restore.
      expect(again.body).toMatchObject({
        deleted: false,
        missing: true,
        trashedAs: (first.body as { trashedAs: string }).trashedAs,
      });
    });

    it('a restore brings the repo back, servable, with its history', async () => {
      await control('/internal/repos', { userId: USER, name: 'oops', protectedBranches: ['main'] });
      const work = seedWorkTree('oops-work');
      git(['remote', 'add', 'origin', cloneUrl('oops')], work);
      git(['push', '-q', 'origin', 'HEAD:feature'], work);
      const sha = git(['rev-parse', 'HEAD'], work).trim();
      const { body } = await control('/internal/repos/delete', { userId: USER, name: 'oops' });

      const restored = await control('/internal/repos/restore', {
        userId: USER, name: 'oops', trashedAs: (body as { trashedAs: string }).trashedAs,
      });

      expect(restored.status).toBe(200);
      expect(existsSync(join(reposRoot, USER, 'oops.git'))).toBe(true);
      expect(git(['ls-remote', cloneUrl('oops'), 'refs/heads/feature'], dir)).toContain(sha);
      const stat = await control('/internal/repos/stat', { userId: USER, name: 'oops' });
      expect((stat.body as { protectedBranches: string[] }).protectedBranches).toEqual(['main']);
    });

    it('refuses a restore of an entry that is not there, and one whose name is taken again', async () => {
      await control('/internal/repos', { userId: USER, name: 'retaken' });
      const { body } = await control('/internal/repos/delete', { userId: USER, name: 'retaken' });
      const trashedAs = (body as { trashedAs: string }).trashedAs;

      const purged = await control('/internal/repos/restore', {
        userId: USER, name: 'retaken', trashedAs: 'retaken.20200101T000000Z.git',
      });
      expect(purged.status).toBe(409);

      // A path, not a name: anything that is not the shape this host writes.
      const traversal = await control('/internal/repos/restore', {
        userId: USER, name: 'retaken', trashedAs: '../../repos/user-1/retaken.git',
      });
      expect(traversal.status).toBe(409);
      expect((traversal.body as { error: string }).error).toContain('invalid');

      await control('/internal/repos', { userId: USER, name: 'retaken' });
      const taken = await control('/internal/repos/restore', { userId: USER, name: 'retaken', trashedAs });
      expect(taken.status).toBe(409);
      expect((taken.body as { error: string }).error).toContain('exists');
    });

    it('a rename keeps the repo whole: history, protection, CI config, new URL', async () => {
      await control('/internal/repos', { userId: USER, name: 'oldname', protectedBranches: ['main'] });
      await control('/internal/repos/ci', { userId: USER, name: 'oldname', enabled: true });
      const work = seedWorkTree('rename-work');
      git(['remote', 'add', 'origin', cloneUrl('oldname')], work);
      git(['push', '-q', 'origin', 'HEAD:feature'], work);
      const sha = git(['rev-parse', 'HEAD'], work).trim();

      const renamed = await control('/internal/repos/rename', { userId: USER, name: 'oldname', newName: 'newname' });

      expect(renamed.status).toBe(200);
      expect(existsSync(join(reposRoot, USER, 'oldname.git'))).toBe(false);
      expect(git(['ls-remote', cloneUrl('newname'), 'refs/heads/feature'], dir)).toContain(sha);
      const stat = await control('/internal/repos/stat', { userId: USER, name: 'newname' });
      expect(stat.body).toMatchObject({ exists: true, protectedBranches: ['main'], ci: true });
      // The old URL is not a redirect — it is nothing.
      expect(() => git(['ls-remote', cloneUrl('oldname')], dir)).toThrow();
    });

    it('refuses a rename onto a name in use, and an unsafe one, and 409s on a repo that is not there', async () => {
      await control('/internal/repos', { userId: USER, name: 'movable' });
      await control('/internal/repos', { userId: USER, name: 'occupied' });

      const collision = await control('/internal/repos/rename', { userId: USER, name: 'movable', newName: 'occupied' });
      expect(collision.status).toBe(409);
      expect(existsSync(join(reposRoot, USER, 'movable.git'))).toBe(true);

      const unsafe = await control('/internal/repos/rename', { userId: USER, name: 'movable', newName: '../escape' });
      expect(unsafe.status).toBe(400);
      expect(existsSync(join(dir, 'escape.git'))).toBe(false);

      const missing = await control('/internal/repos/rename', { userId: USER, name: 'ghost', newName: 'anything' });
      expect(missing.status).toBe(409);
    });

    // Moving a repo BETWEEN namespaces is how a repository changes rooms
    // (note #88) — the fourth member of the rename family, and the same
    // atomic rename(2) inside the repos root.
    it('a move to another namespace keeps the repo whole, under a new clone URL', async () => {
      await control('/internal/repos', { userId: USER, name: 'movable-repo', protectedBranches: ['main'] });
      await control('/internal/repos/ci', { userId: USER, name: 'movable-repo', enabled: true });
      const work = seedWorkTree('move-work');
      git(['remote', 'add', 'origin', cloneUrl('movable-repo')], work);
      git(['push', '-q', 'origin', 'HEAD:feature'], work);
      const sha = git(['rev-parse', 'HEAD'], work).trim();

      // 'user-2' stands in for the destination ROOM's namespace, which may
      // never have held a repo before — the directory has to be made.
      const moved = await control('/internal/repos/move', { userId: USER, name: 'movable-repo', toUserId: 'user-2' });

      expect(moved.status).toBe(200);
      expect(existsSync(join(reposRoot, USER, 'movable-repo.git'))).toBe(false);
      // Same history, same protection, same CI — at the new address.
      expect(git(['ls-remote', cloneUrl('movable-repo', MULTI_NAMESPACE_TOKEN, 'user-2'), 'refs/heads/feature'], dir))
        .toContain(sha);
      const stat = await control('/internal/repos/stat', { userId: 'user-2', name: 'movable-repo' });
      expect(stat.body).toMatchObject({ exists: true, protectedBranches: ['main'], ci: true });
      // And the old address is nothing at all — the clone anybody holds is stale.
      expect(() => git(['ls-remote', cloneUrl('movable-repo')], dir)).toThrow();
    }, 30_000);

    it('refuses a move onto an occupied name, an unsafe namespace, and a repo that is not there', async () => {
      await control('/internal/repos', { userId: USER, name: 'mover' });
      await control('/internal/repos', { userId: 'user-2', name: 'mover' });

      const collision = await control('/internal/repos/move', { userId: USER, name: 'mover', toUserId: 'user-2' });
      expect(collision.status).toBe(409);
      expect(existsSync(join(reposRoot, USER, 'mover.git'))).toBe(true);

      // A namespace is a path segment: unchecked, it walks out of the root.
      const unsafe = await control('/internal/repos/move', { userId: USER, name: 'mover', toUserId: '../escape' });
      expect(unsafe.status).toBe(400);
      expect(existsSync(join(dir, 'escape'))).toBe(false);
      expect(existsSync(join(reposRoot, USER, 'mover.git'))).toBe(true);

      const missing = await control('/internal/repos/move', { userId: USER, name: 'ghost', toUserId: 'user-2' });
      expect(missing.status).toBe(409);
    });

    it('needs the host secret, like every other control route', async () => {
      await control('/internal/repos', { userId: USER, name: 'guarded' });
      const forged = await control('/internal/repos/delete', { userId: USER, name: 'guarded' }, 'wrong');
      expect(forged.status).toBe(401);
      expect(existsSync(join(reposRoot, USER, 'guarded.git'))).toBe(true);
    });
  });

  describe('the break-glass token (docs/platform-on-own-git.md)', () => {
    it('clones its one repo — and still does when the backend is unreachable', async () => {
      await control('/internal/repos', { userId: USER, name: 'rescue' });
      const work = seedWorkTree('rescue-work');
      git(['push', cloneUrl('rescue'), 'main'], work);

      // Through the normal host first: the token opens exactly this door.
      const normal = join(dir, 'rescue-clone');
      git(['clone', '-q', cloneUrl('rescue', RECOVERY_TOKEN), normal], dir);
      expect(readFileSync(join(normal, 'README.md'), 'utf8')).toContain('rescue-work');

      // Now the day it exists for: a host whose backend is DOWN (a port
      // nothing listens on). Same repos on disk. The agent token fails
      // closed; the recovery token still reads.
      const { NODE_OPTIONS: _ignored, ...spawnEnv } = process.env;
      const deadHost = spawn(process.execPath, [HOST_SCRIPT], {
        env: {
          ...spawnEnv,
          PORT: '0',
          REPOS_ROOT: reposRoot,
          GIT_HOST_SECRET: SECRET,
          BACKEND_URL: 'http://127.0.0.1:9',
          RECOVERY_TOKEN_SHA256: createHash('sha256').update(RECOVERY_TOKEN, 'utf8').digest('hex'),
          RECOVERY_TOKEN_OWNER: USER,
          RECOVERY_TOKEN_REPO: 'rescue',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        const match = await waitForLine(deadHost, /listening on 127\.0\.0\.1:(\d+)/, 'dead-backend host');
        const deadUrl = (name: string, token: string) => (
          `http://agent:${encodeURIComponent(token)}@127.0.0.1:${match[1]}/${USER}/${name}.git`
        );
        expect(() => git(['clone', '-q', deadUrl('rescue', TOKEN), join(dir, 'no-clone')], dir))
          .toThrow(/503|cannot verify/i);
        const rescued = join(dir, 'rescue-clone-dead');
        git(['clone', '-q', deadUrl('rescue', RECOVERY_TOKEN), rescued], dir);
        expect(readFileSync(join(rescued, 'README.md'), 'utf8')).toContain('rescue-work');
      } finally {
        deadHost.kill();
      }
    }, 40_000);

    it('cannot push, and cannot read any other repo', async () => {
      const work = seedWorkTree('rescue-push-attempt');
      expect(() => git(['push', cloneUrl('rescue', RECOVERY_TOKEN), 'main'], work))
        .toThrow(/403|read-only/i);
      expect(() => git(['clone', '-q', cloneUrl('api', RECOVERY_TOKEN), join(dir, 'rescue-overreach')], dir))
        .toThrow(/403|scoped/i);
    }, 30_000);
  });
});


describe('git-host standalone mode (byo-git slice 7, the off-boarding switch)', () => {
  /**
   * GIT_HOST_STANDALONE=1 is what off-boarding flips: the host stops calling
   * anyone and serves its org's private network directly. These tests run a
   * REAL host with a DEAD backend URL — every promise below holds only if
   * the host genuinely dials nobody.
   */
  let dir: string;
  let host: ChildProcess;
  let hostUrl: string;

  const git = (args: string[], cwd: string) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'git-host-standalone-'));
    const { NODE_OPTIONS: _ignored, ...cleanEnv } = process.env;
    host = spawn(process.execPath, [HOST_SCRIPT], {
      env: {
        ...cleanEnv,
        PORT: '0',
        REPOS_ROOT: join(dir, 'repos'),
        GIT_HOST_SECRET: SECRET,
        // A dead port on purpose: standalone must never need it. The CI
        // webhook env dying with the backend is the same story — the hooks
        // must stay silent rather than stall every push on a timeout.
        BACKEND_URL: 'http://127.0.0.1:9',
        CI_WEBHOOK_URL: 'http://127.0.0.1:9/webhook',
        CI_WEBHOOK_SECRET: 'gone-with-us',
        GIT_HOST_STANDALONE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = await waitForLine(host, /listening on 127\.0\.0\.1:(\d+)/, 'standalone git-host');
    hostUrl = `http://127.0.0.1:${match[1]}`;

    // Seed a repo WITH a protected branch and CI enabled — the exact state a
    // client org's repo is in on the day they leave.
    await fetch(`${hostUrl}/internal/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-git-host-secret': SECRET },
      body: JSON.stringify({ userId: USER, name: 'kept', protectedBranches: ['main'] }),
    });
    await fetch(`${hostUrl}/internal/repos/ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-git-host-secret': SECRET },
      body: JSON.stringify({ userId: USER, name: 'kept', enabled: true }),
    });
  }, 40_000);

  afterAll(() => {
    host?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says so on /health — the one honest signal an operator checks after the flip', async () => {
    const health = await (await fetch(`${hostUrl}/health`)).json() as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.standalone).toBe(true);
  });

  it('serves an unauthenticated push ONTO A PROTECTED BRANCH, with CI on and the backend dead, inside one push timeout', async () => {
    const work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    writeFileSync(join(work, 'README.md'), 'kept\n');
    git(['add', '.'], work);
    git(['commit', '-qm', 'first'], work);
    // No credentials in the URL; main is protected; the repo's CI hook is
    // configured. None of it may matter now: the gates and the dispatcher
    // left with the platform, and a dead webhook must cost nothing — the
    // 25s git timeout above is the watchdog.
    git(['push', '-q', `${hostUrl}/${USER}/kept.git`, 'main'], work);

    const clone = join(dir, 'clone');
    git(['clone', '-q', `${hostUrl}/${USER}/kept.git`, clone], dir);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('kept\n');
  });

  it('still accepts a stale clone URL that carries an old token — accepted and ignored', async () => {
    const clone2 = join(dir, 'clone2');
    git(['clone', '-q', `${hostUrl.replace('http://', 'http://agent:agb1.long-revoked@')}/${USER}/kept.git`, clone2], dir);
    expect(existsSync(join(clone2, 'README.md'))).toBe(true);
  });
});

describe('git-host start (note #759)', () => {
  it('gives every protected repo without its protected branch an empty start when the service starts, and leaves every other repo alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-host-start-'));
    const run = (args: string[], cwd = dir) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    let host: ChildProcess | undefined;
    try {
      // Built the way the host built repos before: protected, a branch pushed
      // first, HEAD on it, no main.
      const work = join(dir, 'work');
      run(['init', '-q', '-b', 'typespeed-v1', work]);
      writeFileSync(join(work, 'index.html'), '<h1>typespeed</h1>\n');
      run(['add', '.'], work);
      run(['commit', '-qm', 'typespeed v1'], work);
      const repos = join(dir, 'repos', USER);
      const legacy = join(repos, 'typespeed.git');
      const free = join(repos, 'notes.git');
      const guardedAlready = join(repos, 'bishkek-3d.git');
      for (const bare of [legacy, free, guardedAlready]) run(['init', '-q', '--bare', '-b', 'main', bare]);
      run(['--git-dir', legacy, 'config', 'agentgit.protectedBranch', 'main']);
      run(['--git-dir', guardedAlready, 'config', 'agentgit.protectedBranch', 'main']);
      run(['push', '-q', legacy, 'typespeed-v1'], work);
      run(['--git-dir', legacy, 'symbolic-ref', 'HEAD', 'refs/heads/typespeed-v1']);
      run(['push', '-q', free, 'typespeed-v1'], work);
      run(['push', '-q', guardedAlready, 'typespeed-v1:main'], work);
      const approved = run(['--git-dir', guardedAlready, 'rev-parse', 'main']).trim();

      const { NODE_OPTIONS: _ignored, ...cleanEnv } = process.env;
      host = spawn(process.execPath, [HOST_SCRIPT], {
        env: { ...cleanEnv, PORT: '0', REPOS_ROOT: join(dir, 'repos'), GIT_HOST_SECRET: SECRET, BACKEND_URL: 'http://127.0.0.1:9' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const said = await waitForLine(host, /started the protected branch of a repo that had none (\{.*\})/, 'git-host start pass');
      expect(said[1]).toContain('typespeed.git');

      expect(run(['--git-dir', legacy, 'log', '--format=%s', 'main']).trim()).toBe('Nothing approved yet');
      expect(run(['--git-dir', legacy, 'symbolic-ref', '--short', 'HEAD']).trim()).toBe('main');
      // The work is exactly where it was.
      expect(run(['--git-dir', legacy, 'rev-parse', 'typespeed-v1']).trim()).toBe(run(['rev-parse', 'HEAD'], work).trim());
      // An unprotected repo gets nothing; a protected one with main keeps it.
      expect(() => run(['--git-dir', free, 'rev-parse', '--verify', '-q', 'refs/heads/main'])).toThrow();
      expect(run(['--git-dir', guardedAlready, 'rev-parse', 'main']).trim()).toBe(approved);
    } finally {
      host?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('git-host shell scripts', () => {
  it('the pre-receive hook passes sh -n', () => {
    expect(() => execFileSync('sh', ['-n', HOOK])).not.toThrow();
  });

  it('the post-receive hook parses as JavaScript', () => {
    // It runs inside a push, where a syntax error would surface only as a
    // build that never starts.
    expect(() => execFileSync(process.execPath, ['--check', POST_RECEIVE])).not.toThrow();
  });

  it('provision.sh passes bash -n', () => {
    expect(() => execFileSync('bash', ['-n', PROVISION])).not.toThrow();
  });

  /**
   * The trash purge is the product's "restorable for 14 days" promise, and
   * this job is the only thing that keeps it — nothing else deletes a repo's
   * bytes. So it is tested against real directories and real mtimes.
   */
  it('maintain-repos.sh purges trash past the window and leaves fresh entries alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-maint-'));
    try {
      const repos = join(root, 'repos');
      const trash = join(root, 'trash', 'user-1');
      const old = join(trash, 'old.20260101T000000Z.git');
      const fresh = join(trash, 'fresh.20260813T000000Z.git');
      for (const path of [join(repos, 'user-1'), old, fresh]) {
        execFileSync('mkdir', ['-p', path]);
      }
      // 20 days ago: past a 14-day window, and past the 15 this run is given.
      execFileSync('touch', ['-d', '20 days ago', old]);

      execFileSync('bash', [MAINTAIN], {
        env: {
          ...process.env,
          REPOS_ROOT: repos,
          TRASH_ROOT: join(root, 'trash'),
          TRASH_KEEP_DAYS: '15',
          MAINT_LOCK_FILE: join(root, 'maintenance.lock'),
          MAINT_NOTIFY: join(root, 'no-notify'),
        },
        encoding: 'utf8',
      });

      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      // The live repos root is not what this walks — a repo is never purged.
      expect(existsSync(join(repos, 'user-1'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provision.sh leaves the media store alone and keeps the control API private', () => {
    const script = readFileSync(PROVISION, 'utf8');
    // This box's first job is storage: no executable line may touch MinIO's
    // data. Comments may name the path; commands may not.
    const executable = script.split('\n').filter((line) => !line.trim().startsWith('#'));
    expect(executable.some((line) => line.includes('/srv/'))).toBe(false);
    // The control API is reachable by the backend only — secret AND source IP.
    expect(script).toContain('path /internal/*');
    expect(script).toContain('respond @internal_foreign 404');
  });
});
