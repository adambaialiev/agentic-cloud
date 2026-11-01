#!/usr/bin/env node
// git-host — the platform's internal git server (docs/agent-git-phase1.md).
//
// Runs on ia-media beside MinIO, serving bare repos from the filesystem over
// git's smart HTTP protocol. Single file, zero dependencies, Node >= 20: this
// box's job is to hold bytes, and an npm dependency tree is not worth adding
// to it.
//
// Division of labour with the backend: this process owns bytes on disk, the
// backend owns every authorization decision. Nothing here has a database, a
// user list, or a copy of the quota rules — one call to /git/verify answers
// identity, namespace and quota together.
//
// Env:
//   PORT                 listen port (default 3002)
//   HOST                 bind address (default 127.0.0.1 — behind Caddy on
//                        ia-media; the Fly image sets :: so the org's private
//                        network and the proxy can both reach it directly)
//   REPOS_ROOT           bare repos live at <root>/<userId>/<name>.git
//   TRASH_ROOT           deleted repos wait here (default <REPOS_ROOT>/../trash)
//   GIT_HOST_SECRET      shared secret for /internal/* and backend callbacks
//   BACKEND_URL          e.g. https://api.example.com
//   DISK_MAX_USED_PERCENT   refuse NEW repos above this (default 80)
//   CI_WEBHOOK_URL       the ONE dispatcher a repo's CI may notify
//   CI_WEBHOOK_SECRET    shared secret it signs those deliveries with
//   COMMIT_EMAIL         the address on commits the host makes itself
//                        (default noreply@agentbuilt.app; a copy's own, note #807)
//   RECOVERY_TOKEN_SHA256  sha256 hex of the break-glass clone token
//   RECOVERY_TOKEN_OWNER   the userId whose namespace it may read
//   RECOVERY_TOKEN_REPO    the ONE repo it may read (read-only, no backend)
//   GIT_HOST_STANDALONE  '1' after off-boarding: serve git to whoever can
//                        reach this address, calling nobody — no token
//                        verification, no push reports, no CI webhooks, no
//                        protected branches. ONLY safe because a client-org
//                        host has no public address: its flycast IP answers
//                        inside the org's own private network alone.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, statfsSync, renameSync, utimesSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const REPOS_ROOT = process.env.REPOS_ROOT || '/var/lib/agentgit/repos';
/**
 * Where a deleted repo waits out its window (docs/agent-git-project-repos.md
 * slice 5). A SIBLING of REPOS_ROOT, for two reasons: the move is a rename on
 * one filesystem, so a delete cannot half-happen; and every loop that walks
 * repos — backups, gc, the size sweep — globs REPOS_ROOT and therefore steps
 * over the trash without being taught about it.
 *
 * Nothing here purges: maintain-repos.sh owns that, so the retention window is
 * one number in one place and a restart of this daemon can never shorten it.
 */
const TRASH_ROOT = process.env.TRASH_ROOT || path.join(path.dirname(REPOS_ROOT), 'trash');
const SECRET = process.env.GIT_HOST_SECRET || '';
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
// The address on commits the host makes itself (merges, the empty main): ours,
// or a private copy's own (note #807).
const PLATFORM_COMMIT_EMAIL = (process.env.COMMIT_EMAIL || '').trim() || 'noreply@agentbuilt.app';
// Set on per-org hosts (byo-git-design slice 2b): names which org's secret
// signs this host's callbacks, so one backend can serve N hosts each holding
// its own secret. Unset on the central host — the platform secret applies.
const GIT_HOST_ORG = (process.env.GIT_HOST_ORG || '').trim();
// The off-boarding switch (byo-git-design "Custody and off-boarding"): the
// verify dependency is correct while the platform operates this host and
// exactly wrong the day the client leaves. Flipped, the host stops calling
// anyone and serves its org's private network directly — the bytes and the
// history stay, the approval gates leave with the platform.
const STANDALONE = process.env.GIT_HOST_STANDALONE === '1';
const backendHeaders = (namespaceId) => ({
  'content-type': 'application/json',
  'x-git-host-secret': SECRET,
  ...(GIT_HOST_ORG ? { 'x-git-host-org': GIT_HOST_ORG } : {}),
  ...(namespaceId ? { 'x-git-namespace': namespaceId } : {}),
});
const DISK_MAX_USED_PERCENT = Number(process.env.DISK_MAX_USED_PERCENT || 80);
/**
 * The CI dispatcher, held HERE rather than accepted from a caller. That is
 * the whole security argument for self-serve CI: this process sits inside the
 * private network, so a caller-supplied webhook URL would make it an SSRF
 * proxy — point it anywhere and it POSTs there. A repo's owner does not need
 * to name a destination; there is exactly one legitimate value, and the box
 * that runs this daemon is the thing that knows it. So the API is a BOOLEAN,
 * and these two fill in the rest. Unset → `/internal/repos/ci` refuses, and
 * every repo stays as silent as it was before.
 */
const CI_WEBHOOK_URL = process.env.CI_WEBHOOK_URL || '';
const CI_WEBHOOK_SECRET = process.env.CI_WEBHOOK_SECRET || '';
/**
 * Hooks copied into every bare repo. Read once at startup and re-checked on
 * each push, so an edited hook reaches repos that already exist — copying only
 * at creation meant a fix to pre-receive silently applied to new repos alone,
 * and the repos that mattered kept the old copy forever.
 */
const HOOK_NAMES = ['pre-receive', 'post-receive'];
const HOOK_SOURCES = new Map(
  HOOK_NAMES.map((name) => [
    name,
    readFileSync(fileURLToPath(new URL(`./hooks/${name}`, import.meta.url))),
  ]),
);

/** Same rules the backend validates against; enforced again here because this
 *  process turns these strings into filesystem paths. */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,61}$/;
/** A trash entry: a repo name, the stamp this file appends, `.git`. */
const TRASH_ENTRY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,61}\.\d{8}T\d{6}Z(-\d+)?\.git$/;
/** Just the appended part, for matching an entry against a known name. */
const TRASH_STAMP_TAIL = /^\d{8}T\d{6}Z(-\d+)?\.git$/;
const SAFE_PATHS = new Set(['/info/refs', '/git-upload-pack', '/git-receive-pack']);

function log(message, extra) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[git-host] ${message}${suffix}`);
}

function secretMatches(presented) {
  const a = Buffer.from(String(presented || ''), 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  return SECRET.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function isSafeSegment(value) {
  return typeof value === 'string' && SEGMENT.test(value) && !value.includes('..');
}

/**
 * Branch names are looser than repo names (slashes are idiomatic: `feat/x`),
 * but they still become git arguments, so: no leading dash, no `..`, no
 * whitespace, no ref-magic characters.
 */
function isSafeBranch(value) {
  return typeof value === 'string'
    && value.length > 0 && value.length <= 200
    && /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(value)
    && !value.includes('..')
    && !value.endsWith('/')
    && !value.endsWith('.lock');
}

function repoPath(userId, name) {
  return path.join(REPOS_ROOT, userId, `${name}.git`);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Bytes on disk for a repo. `du -s -b` over the whole bare repo dir. */
function repoSizeBytes(dir) {
  try {
    const out = execFileSync('du', ['-s', '-b', dir], { encoding: 'utf8' });
    return Number(out.split(/\s+/)[0]) || 0;
  } catch {
    return 0;
  }
}

function branchExists(dir, branch) {
  try {
    execFileSync('git', ['--git-dir', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every protected branch, in the order they were configured — the first one
 * is the repo's default. Multi-valued config (`--add`), read with --get-all;
 * repos from before multi-branch protection hold a single value and read
 * identically.
 */
function protectedBranchesOf(dir) {
  try {
    return execFileSync('git', ['--git-dir', dir, 'config', '--get-all', 'agentgit.protectedBranch'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Keep HEAD pointing at a branch that EXISTS.
 *
 * A fresh repo's HEAD is `main`, but with the approval gate on, the first push
 * is always a feature branch — so `main` never exists yet and `git clone`
 * lands on nothing: "remote HEAD refers to nonexistent ref" and an empty
 * working tree. (Observed on the very first live push, 2026-08-07.)
 *
 * The protected branch wins as soon as it exists, so an approved merge to
 * `main` silently takes HEAD back.
 */
function reconcileHead(dir) {
  const [defaultProtected] = protectedBranchesOf(dir);
  if (defaultProtected && branchExists(dir, defaultProtected)) {
    execFileSync('git', ['--git-dir', dir, 'symbolic-ref', 'HEAD', `refs/heads/${defaultProtected}`], { stdio: 'ignore' });
    return;
  }
  const head = defaultBranchOf(dir);
  if (head && branchExists(dir, head)) return;
  try {
    const first = execFileSync('git', ['--git-dir', dir, 'for-each-ref', '--count=1', '--format=%(refname:short)', 'refs/heads/'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (first) {
      execFileSync('git', ['--git-dir', dir, 'symbolic-ref', 'HEAD', `refs/heads/${first}`], { stdio: 'ignore' });
    }
  } catch {
    // An empty repo has no branch to point at yet — nothing to reconcile.
  }
}

function defaultBranchOf(dir) {
  try {
    const ref = execFileSync('git', ['--git-dir', dir, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a protected repo's default branch STARTS on (note #759): one commit
 * with no parents and git's empty tree, written by the platform — never by an
 * agent, who cannot push the branch. It used to be absent until the first
 * approved merge created it, and a protected repo with no protected branch
 * looked broken from every side: `ls-remote` showed no `main`, HEAD pointed
 * at a feature branch, and a note-linked `pr create` (which fetches `main`
 * first) refused, so the work could not be proposed at all.
 *
 * It holds nothing, so it changes no diff: a compare against it reads like a
 * compare against no base, and the first landing over it takes the branch's
 * tree whole (mergeBranch). Nothing about it is remembered anywhere — any tip
 * with no parents and the empty tree is one.
 */
const PLACEHOLDER_MESSAGE = 'Nothing approved yet\n\n'
  + 'This protected branch starts empty. Work in progress lives on other branches;\n'
  + 'the first proposal your user approves fills it.\n';

function isPlaceholder(dir, sha) {
  if (!sha) return false;
  try {
    const [tree, parents] = execFileSync('git', ['--git-dir', dir, 'show', '-s', '--format=%T%x00%P', sha], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\u0000');
    return tree === EMPTY_TREE && !parents;
  } catch {
    return false;
  }
}

/**
 * Make sure a protected repo's default branch exists (note #759): at
 * creation, before every git request, and once for every repo when this
 * service starts — which is what repaired the repos made before it. A repo
 * with no protection, or whose branch exists, is left exactly as it is.
 * Created only where nothing is (`update-ref` against the zero sha), so a
 * landing that races it wins. Tells nobody: nothing was approved, nothing
 * lands, and CI has nothing to judge.
 */
function ensureProtectedDefault(dir) {
  // Off-boarded, the approval gate left with the platform and people push
  // the branch themselves; an empty start would only be in their way.
  if (STANDALONE) return false;
  const [branch] = protectedBranchesOf(dir);
  if (!branch || branchExists(dir, branch)) return false;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Agentic Cloud Computer', GIT_AUTHOR_EMAIL: PLATFORM_COMMIT_EMAIL,
    GIT_COMMITTER_NAME: 'Agentic Cloud Computer', GIT_COMMITTER_EMAIL: PLATFORM_COMMIT_EMAIL,
  };
  try {
    // Written, not assumed: an empty tree git only knows of in memory is a
    // missing object to fsck and to a pack.
    const tree = execFileSync('git', ['--git-dir', dir, 'mktree'], { input: '', encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['--git-dir', dir, 'commit-tree', tree, '-m', PLACEHOLDER_MESSAGE], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(dir, ['update-ref', `refs/heads/${branch}`, sha, ZERO_SHA]);
  } catch (error) {
    if (branchExists(dir, branch)) return false;
    log('could not start the protected branch', { dir, branch, error: String(error) });
    return false;
  }
  reconcileHead(dir);
  return true;
}

/** Every repo's protected branch, once at start (note #759). Never fatal. */
function ensureProtectedDefaultsEverywhere() {
  let owners = [];
  try {
    owners = readdirSync(REPOS_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return;
  }
  for (const owner of owners) {
    let repos = [];
    try {
      repos = readdirSync(path.join(REPOS_ROOT, owner.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.git'));
    } catch {
      continue;
    }
    for (const repo of repos) {
      const dir = path.join(REPOS_ROOT, owner.name, repo.name);
      if (ensureProtectedDefault(dir)) log('started the protected branch of a repo that had none', { dir });
    }
  }
}

/** The sha a branch points at, or null while it has no commits. */
function branchTipOf(dir, branch) {
  if (!branch) return null;
  try {
    return execFileSync('git', ['--git-dir', dir, 'rev-parse', '--verify', `refs/heads/${branch}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function diskUsedPercent() {
  try {
    const stat = statfsSync(REPOS_ROOT);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    if (!total) return 0;
    return Math.round(((total - free) / total) * 100);
  } catch {
    return 0;
  }
}

// ── Backend calls ───────────────────────────────────────────────────────────

/**
 * Positive verifications cache briefly so a `git clone` of many refs isn't a
 * storm of identical questions. Failures are NEVER cached: a rotated token
 * must start working the moment it is minted, and a revoked one must stop.
 */
const verifyCache = new Map();
const VERIFY_TTL_MS = 60_000;

/**
 * The break-glass token (docs/platform-on-own-git.md): verified from this
 * host's OWN env, no backend call — the day it exists for is the day the
 * backend cannot answer. Scoped harder than anything else here: one named
 * repo, read-only, and the sha256-hex comparison means the env file never
 * holds the credential itself. Everything else keeps failing closed exactly
 * as before; this opens one door to one room, for reading.
 */
const RECOVERY_TOKEN_SHA256 = process.env.RECOVERY_TOKEN_SHA256 || '';
const RECOVERY_TOKEN_OWNER = process.env.RECOVERY_TOKEN_OWNER || '';
const RECOVERY_TOKEN_REPO = process.env.RECOVERY_TOKEN_REPO || '';

function recoveryAuth(token) {
  if (!RECOVERY_TOKEN_SHA256 || !RECOVERY_TOKEN_OWNER || !RECOVERY_TOKEN_REPO) return null;
  const presented = createHash('sha256').update(token, 'utf8').digest();
  const expected = Buffer.from(RECOVERY_TOKEN_SHA256, 'hex');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return {
    userId: RECOVERY_TOKEN_OWNER,
    agentId: 'recovery',
    scope: { repo: RECOVERY_TOKEN_REPO, readOnly: true },
  };
}

async function verifyToken(token, namespaceId, repoName) {
  // Before the cache and before the network: the recovery path must not
  // depend on anything that can be down.
  const recovery = token ? recoveryAuth(token) : null;
  if (recovery) return recovery;
  // One human key may be used in several org checkouts simultaneously. Cache
  // the answer per URL namespace or one clone would lend its identity to the
  // next clone for the TTL.
  // A room-shared grant is one-repository wide (note #108), so the repository
  // belongs in the cache key too. Reusing `api`'s answer for `payroll` in the
  // same home namespace would widen the grant for the whole TTL.
  const cacheKey = `${token}\0${namespaceId}\0${repoName}`;
  // Anonymous authority is revoked by one admin tap. Never cache it: a clone
  // costs two tiny verify calls, and making a repository private must close
  // the door on the very next request rather than after the token TTL.
  const cached = token ? verifyCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(`${BACKEND_URL}/api/agent-cli/git/verify`, {
    method: 'POST',
    headers: backendHeaders(namespaceId),
    body: JSON.stringify({ token, repo: repoName }),
  });
  if (!response.ok) return null;
  const value = await response.json();
  if (token) verifyCache.set(cacheKey, { value, expiresAt: Date.now() + VERIFY_TTL_MS });
  return value;
}

/** Fire-and-forget: a failed report costs a stale size, never a failed push. */
async function reportPush(userId, name, dir) {
  if (STANDALONE) return; // nobody to tell, and nobody waiting to hear
  try {
    const defaultBranch = defaultBranchOf(dir);
    await fetch(`${BACKEND_URL}/api/agent-cli/git/pushed`, {
      method: 'POST',
      headers: backendHeaders(),
      body: JSON.stringify({
        userId,
        name,
        sizeBytes: repoSizeBytes(dir),
        defaultBranch,
        // The default branch's tip, so the backend can see whether THIS
        // branch moved — "pushed to main" must only ever be said of a push
        // that actually landed there, and most pushes to a protected repo
        // land on feature branches instead. Null when the branch has no
        // commits yet.
        defaultBranchTip: branchTipOf(dir, defaultBranch),
      }),
    });
  } catch (error) {
    log('push report failed', { userId, name, error: String(error) });
  }
}

// ── Control API (backend → host) ────────────────────────────────────────────

/**
 * Copies the hooks into a bare repo, writing only what differs.
 *
 * Called at creation and again before every push, so a hook edited in this
 * repository reaches repos that already exist. Cheap in the steady state: two
 * small reads and two buffer comparisons, no writes.
 */
function ensureHooks(dir) {
  for (const [name, source] of HOOK_SOURCES) {
    const target = path.join(dir, 'hooks', name);
    try {
      if (existsSync(target) && readFileSync(target).equals(source)) continue;
      writeFileSync(target, source);
      chmodSync(target, 0o755);
      log('installed hook', { dir, hook: name });
    } catch (error) {
      // A hook we could not write must not take the push down with it — but
      // pre-receive is a gate, so losing it silently would be worse than
      // noisy. git-http-backend still enforces whatever copy is on disk.
      log('hook install failed', { dir, hook: name, error: String(error) });
    }
  }
}

function createRepo(userId, name, protectedBranches) {
  const dir = repoPath(userId, name);
  if (existsSync(dir)) {
    // Idempotent: never re-init a directory that may already hold commits.
    return { created: false };
  }
  const used = diskUsedPercent();
  if (used >= DISK_MAX_USED_PERCENT) {
    throw new Error(`disk is ${used}% full — refusing to create new repos above ${DISK_MAX_USED_PERCENT}%`);
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir], { stdio: 'ignore' });
  // The gate lives in the repo, not in this process: a push that arrives while
  // the service is restarting still meets the hook.
  ensureHooks(dir);
  // Protection lives in the repo's own config, not in this process's memory or
  // in the push environment: the hook then reads it directly, and a repo stays
  // protected across restarts, backups and manual moves. One value per
  // branch; the FIRST is the default the clone lands on (reconcileHead).
  for (const branch of protectedBranches) {
    execFileSync('git', ['--git-dir', dir, 'config', '--add', 'agentgit.protectedBranch', branch], { stdio: 'ignore' });
  }
  // A protected repo is never without its protected branch (note #759).
  ensureProtectedDefault(dir);
  return { created: true };
}

/**
 * ADD branches to a repo's protection. Strictly one-way, mirroring the
 * product rule that an agent may narrow what it can do but never widen it:
 * there is no unprotect here, and a repo created unprotected stays that way —
 * protection appearing later would surprise every agent already pushing to it,
 * and the "--unprotected is permanent" promise is documented on every machine.
 */
function protectBranches(dir, branches) {
  const current = protectedBranchesOf(dir);
  if (current.length === 0) {
    return { error: 'this repo was created unprotected — that is permanent' };
  }
  for (const branch of branches) {
    if (current.includes(branch)) continue;
    execFileSync('git', ['--git-dir', dir, 'config', '--add', 'agentgit.protectedBranch', branch], { stdio: 'ignore' });
    current.push(branch);
  }
  return { branches: current };
}

/**
 * Turn a repo's CI on or off — the self-serve half of what used to be an
 * operator with a shell (docs/ci-two-lane-runner.md phase 2 called this "the
 * allow-list for now"). The caller sends a BOOLEAN and nothing else; the URL
 * and secret come from this process's own env, so enabling CI can never aim
 * the host at an address the caller chose.
 *
 * Unlike protection, this is reversible in both directions: it grants no
 * authority and moves no branch — a repo with CI off is a repo that was
 * never told about a build, which is exactly where all of them started.
 */
function setRepoCi(dir, enabled) {
  if (enabled && (!CI_WEBHOOK_URL || !CI_WEBHOOK_SECRET)) {
    return { error: 'this host has no CI dispatcher configured' };
  }
  if (enabled) {
    execFileSync('git', ['--git-dir', dir, 'config', 'agentgit.webhookUrl', CI_WEBHOOK_URL], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', dir, 'config', 'agentgit.webhookSecret', CI_WEBHOOK_SECRET], { stdio: 'ignore' });
    return { ci: true };
  }
  // --unset-all, not --unset: a repo configured by hand before this route
  // existed may hold more than one value, and `--unset` fails on those.
  for (const key of ['agentgit.webhookUrl', 'agentgit.webhookSecret']) {
    try {
      execFileSync('git', ['--git-dir', dir, 'config', '--unset-all', key], { stdio: 'ignore' });
    } catch {
      // Exit 5 = the key was not set. Already off is the state we wanted.
    }
  }
  return { ci: false };
}

/**
 * The three admin moves, and the one property they share: **no rm.** A delete
 * is a rename into the trash, a restore is the rename back, and a repo rename
 * is a rename within the namespace. Every one of them is a single atomic
 * `rename(2)` on one filesystem, so a crash mid-call leaves the repo at one
 * end or the other — never half a repo, never a directory of loose objects
 * that belongs to nothing.
 *
 * That is also why the bytes outlive the record: the backend forgets a deleted
 * repo immediately (its user asked for it gone), while the disk keeps it until
 * maintain-repos.sh purges the window. Anything short of that would make
 * "delete" the one verb in this system with no way back.
 */
function trashEntryPath(userId, name, stamp) {
  return path.join(TRASH_ROOT, userId, `${name}.${stamp}.git`);
}

/** `20260813T044500Z` — sorts chronologically and survives a name that
 *  already contains dots, which repo names may. */
function trashStamp(at = new Date()) {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The most recent trash entry for a name, or null. The stamp sorts, so this
 *  is a sort — no stat() per entry, and no clock to disagree with. */
function newestTrashEntry(userId, name) {
  const dir = path.join(TRASH_ROOT, userId);
  if (!existsSync(dir)) return null;
  const prefix = `${name}.`;
  const match = readdirSync(dir)
    // The tail has to be the STAMP and nothing else: repo names may contain
    // dots, so a prefix match alone would let `foo.bar`'s trash answer for
    // `foo`.
    .filter((entry) => entry.startsWith(prefix) && TRASH_STAMP_TAIL.test(entry.slice(prefix.length)))
    .sort()
    .pop();
  return match ? { trashedAs: match } : null;
}

function deleteRepo(userId, name) {
  const dir = repoPath(userId, name);
  if (!existsSync(dir)) {
    // Already gone — the state the caller asked for, so not an error. It
    // answers with the newest trash entry for that name all the same: a
    // delete whose bookkeeping failed after the move is retried here, and
    // without this the retry would tombstone a repo it could never restore.
    return { deleted: false, missing: true, ...(newestTrashEntry(userId, name) ?? {}) };
  }
  const stamp = trashStamp();
  let target = trashEntryPath(userId, name, stamp);
  // Two deletes of the same name in the same second (a retry, mostly): keep
  // both rather than overwrite, because the older one is the one with the
  // commits somebody may want back.
  for (let attempt = 2; existsSync(target); attempt += 1) {
    target = trashEntryPath(userId, name, `${stamp}-${attempt}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(dir, target);
  // STAMP THE DIRECTORY, because rename(2) does not. Its mtime is still the
  // last write to the repo, and the purge in maintain-repos.sh ages entries
  // by mtime — so without this line a repo nobody had pushed to for a month
  // would arrive in the trash already older than the window and be swept on
  // the next weekly run. The retention promise would break for exactly the
  // repos most likely to be deleted: the idle ones. (Found by looking at a
  // real entry after the first live delete: stamp 07:33, mtime 07:09.)
  const now = new Date();
  utimesSync(target, now, now);
  log('repo moved to trash', { userId, name, trashedAs: path.basename(target) });
  return { deleted: true, trashedAs: path.basename(target) };
}

/**
 * Move a trashed repo back under its original name. `trashedAs` is the entry
 * the deleting call reported: restoring the exact directory the user was told
 * about, rather than the newest match, keeps two deletes of one name from
 * resolving to whichever the filesystem lists first.
 */
function restoreRepo(userId, name, trashedAs) {
  // Its own shape, not isSafeSegment's: this string is a name plus the stamp
  // this file wrote, and it becomes a path — so it is matched whole rather
  // than trimmed into something that passes.
  if (typeof trashedAs !== 'string' || !TRASH_ENTRY.test(trashedAs) || trashedAs.includes('..')) {
    return { error: 'invalid trash entry' };
  }
  const source = path.join(TRASH_ROOT, userId, trashedAs);
  if (!existsSync(source)) {
    // Purged, or never there. The window is the product's promise, so the
    // words matter more than the status code the backend picks.
    return { error: 'that repo is no longer in the trash' };
  }
  const dir = repoPath(userId, name);
  if (existsSync(dir)) {
    return { error: `a repo named "${name}" exists again — rename it first` };
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  renameSync(source, dir);
  // The hooks in a restored repo are whatever they were at delete time; a
  // pushed fix to pre-receive would otherwise reach it only on its next push.
  ensureHooks(dir);
  log('repo restored from trash', { userId, name, trashedAs });
  return { restored: true };
}

/**
 * Rename within one user's namespace. Protection, CI config and every hook
 * ride along inside the directory — the whole reason those live in the repo's
 * own config rather than in this process — so a renamed repo is the same repo
 * under a new clone URL, with the gate still closed.
 */
function renameRepo(userId, name, newName) {
  const dir = repoPath(userId, name);
  if (!existsSync(dir)) return { error: 'no such repo' };
  const target = repoPath(userId, newName);
  if (existsSync(target)) return { error: `a repo named "${newName}" already exists` };
  renameSync(dir, target);
  log('repo renamed', { userId, name, newName });
  return { renamed: true };
}

/**
 * Move a repo to ANOTHER namespace, keeping its name (note #88: rooms own
 * namespaces, so moving a repo between rooms is moving it between these
 * directories). The fourth member of the rename family and the same shape as
 * the other three: one `rename(2)` inside REPOS_ROOT, so it is atomic and the
 * repo is only ever at one end or the other.
 *
 * Protection, CI config and hooks ride along inside the directory, exactly as
 * they do for a rename. What does NOT ride along is the clone URL: it carries
 * the namespace, so every clone anybody already has points at the old path
 * and must be re-pointed. That is the caller's story to tell.
 */
function moveRepo(userId, name, toUserId) {
  const dir = repoPath(userId, name);
  if (!existsSync(dir)) return { error: 'no such repo' };
  const target = repoPath(toUserId, name);
  if (existsSync(target)) return { error: `a repo named "${name}" already exists there` };
  // The destination namespace may never have held a repo before.
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(dir, target);
  log('repo moved between namespaces', { userId, name, toUserId });
  return { moved: true };
}

// ── Compare + merge (phase 2's approval gate) ───────────────────────────────

/** git's empty tree, so a first PR can diff against "nothing" without a base. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** What git puts in a hook's `before` field when a ref is being CREATED. The
 *  merge path sends the same, so a created branch and a pushed one are one
 *  shape to the receiver. */
const ZERO_SHA = '0'.repeat(40);
const MAX_PATCH_BYTES = 512 * 1024;

function git(dir, args, opts = {}) {
  return execFileSync('git', ['--git-dir', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/** Is `older` reachable from `newer`? False after a force-push or a rebase,
 *  which is exactly when a delta must not be trusted. */
function isAncestor(dir, older, newer) {
  try {
    git(dir, ['merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch {
    return false;
  }
}

function revParse(dir, ref) {
  try {
    return git(dir, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    return null;
  }
}

/**
 * What a PR would change: the diff from the merge base to the head, which is
 * what a reviewer means by "this branch's changes" — a plain base..head diff
 * would also show everything the base gained meanwhile.
 */
function compare(userId, name, base, head) {
  const dir = repoPath(userId, name);
  const headSha = revParse(dir, head);
  if (!headSha) throw new Error(`no such branch: ${head}`);
  const baseSha = revParse(dir, base);
  let from = EMPTY_TREE;
  if (baseSha) {
    try {
      from = git(dir, ['merge-base', baseSha, headSha]).trim() || baseSha;
    } catch {
      from = baseSha;
    }
  }

  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of git(dir, ['diff', '--numstat', from, headSha]).split('\n')) {
    if (!line.trim()) continue;
    const [added, removed] = line.split('\t');
    files += 1;
    // `-` for binary files: counted as changed, not as lines.
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }

  // Separator-packed, exactly as `readLog` does it, and for the same reason: a
  // subject is arbitrary user text, so any printable delimiter is one commit
  // message away from shifting every field after it. `%aI` rides along because
  // a proposal's commit list says how long ago each commit landed.
  const commits = git(dir, ['log', '--format=%H%x1f%aI%x1f%s%x1e', `${from}..${headSha}`])
    .split('\x1e')
    // git ends each record with a newline of its own, after the separator.
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, at, subject] = record.split('\x1f');
      return { sha, at, subject: subject ?? '' };
    });

  let patch = git(dir, ['diff', from, headSha]);
  const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
  if (truncated) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n… truncated …\n`;

  return {
    headSha,
    baseSha: baseSha || null,
    baseExists: Boolean(baseSha),
    diffStat: { files, insertions, deletions },
    commits,
    patch,
    patchTruncated: truncated,
  };
}

/** The same hard stop hooks/post-receive gives a receiver. Nothing waits on
 *  this — the merge is answered before it resolves either way — so the number
 *  only bounds how long a dead daemon keeps a socket of ours. */
const WEBHOOK_TIMEOUT_MS = 5000;

/** A repo's own git config, the way the hooks read it. Exit 1 means "not set",
 *  which is the answer for every ordinary agent repo. */
function repoConfigValue(dir, key) {
  try {
    return git(dir, ['config', '--get', key]).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Tell the CI daemon a branch moved, in the shape hooks/post-receive sends for
 * a push.
 *
 * A merge made here never goes through receive-pack: `mergeBranch` writes the
 * tree and moves the ref itself, so no hook runs and nothing tells CI. So
 * every path that MOVES the branch calls this — fast-forward included.
 *
 * Fast-forwards used to be skipped, on the reasoning that the new tip is a
 * commit that was already pushed and already judged, so a delivery would buy
 * nothing but a second identical run. That was true while CI only produced
 * checks. It stopped being true when jobs on a protected branch started
 * receiving the owner's secrets: the earlier verdict came from a run on the
 * SOURCE branch, which is unprotected and therefore got none, so the run
 * that was supposed to deploy never happened — and nothing looked wrong,
 * because the branch moved and the sha was green. Found by rehearsing the
 * secrets path end to end, 2026-08-13; most PRs fast-forward, so this was
 * the common case, not the edge.
 *
 * The cost of the fix is one duplicate checks run per fast-forward merge.
 * That is the right trade: a duplicate run is visible and cheap, a deploy
 * that silently does not happen is neither. The one path that still says
 * nothing is base-already-equals-head, where no ref moved at all.
 *
 * Body, headers and signature are the hook's, field for field: the daemon has
 * one push handler, and it must not grow a second shape to understand. The
 * hook cannot simply be imported — it is copied byte-for-byte into every bare
 * repo (HOOK_SOURCES) and runs there with GIT_DIR set, so a shared module
 * would not resolve from where it ends up living. git-host.test.ts pins the
 * two deliveries against each other instead, which is the part that can drift.
 *
 * Never throws, never retries: the merge has already landed and the caller has
 * already answered it. A missed delivery costs a build — the same price the
 * hook pays for the same failure.
 */
async function notifyRefMoved(dir, { owner, name, ref, before, after }) {
  const url = repoConfigValue(dir, 'agentgit.webhookUrl');
  if (!url) return;
  const secret = repoConfigValue(dir, 'agentgit.webhookSecret');
  if (!secret) {
    // The hook's refusal, for the hook's reason: a receiver that accepted
    // unsigned deliveries would build whatever anyone reaching the port asked.
    log('merge webhook configured without a secret — not sending', { repo: `${owner}/${name}` });
    return;
  }
  // Read back rather than reuse the message we passed to commit-tree: a push
  // delivery carries the SUBJECT, and a merge message can be many lines.
  let subject = '';
  try {
    subject = git(dir, ['log', '-1', '--format=%s', after]).trim();
  } catch { /* the sha is fine; a missing subject only costs a log line */ }

  const body = JSON.stringify({
    ref,
    before,
    after,
    deleted: false,
    repository: { name, owner, full_name: `${owner}/${name}` },
    head_commit: { id: after, message: subject },
  });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The one field that differs from the hook's, on purpose: both paths
        // are pushes to the daemon, and this is what says which one sent it
        // when the question is why a build did or did not start.
        'user-agent': 'agentgit-merge',
        'x-agentgit-event': 'push',
        'x-agentgit-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      log('merge webhook rejected', { repo: `${owner}/${name}`, status: response.status });
    }
  } catch (error) {
    log('merge webhook unreachable', { repo: `${owner}/${name}`, error: String(error) });
  }
}

/**
 * Merge head into base, in the bare repo, with no working tree:
 * `merge-tree --write-tree` produces the merged tree (or fails on conflict),
 * `commit-tree` seals it, and a compare-and-swap `update-ref` moves the branch.
 *
 * `expectedHead` is the approval's anchor: the user approved a diff, so if the
 * branch has moved since, this refuses rather than merging something nobody
 * read. Conflicts are never auto-resolved — that is the whole reason a human
 * is in this loop.
 *
 * `squash` lands the branch as ONE parentless-of-head commit on the base —
 * same tree a merge would produce, same conflict answer, but the branch's
 * commits are replaced rather than pointed at. Because they are replaced,
 * the squash commit keeps the branch's own author (a merge commit's author
 * is whoever merged, the originals staying reachable behind it).
 */
function mergeBranch(userId, name, { base, head, expectedHead, message, author, squash }) {
  const dir = repoPath(userId, name);
  const headSha = revParse(dir, head);
  if (!headSha) return { status: 'missing-head' };
  if (expectedHead && headSha !== expectedHead) {
    return { status: 'stale', headSha };
  }
  const baseSha = revParse(dir, base);

  // No base branch yet: a protected branch other than the default, or a repo
  // from before note #759 the service has not started on since. Creating it
  // IS the merge.
  if (!baseSha) {
    git(dir, ['update-ref', `refs/heads/${base}`, headSha]);
    reconcileHead(dir);
    void notifyRefMoved(dir, {
      owner: userId, name, ref: `refs/heads/${base}`, before: ZERO_SHA, after: headSha,
    });
    return { status: 'merged', fastForward: true, mergeCommitSha: headSha };
  }
  if (baseSha === headSha) {
    // Nothing moved, so nothing to tell anyone: this is the double-tap and
    // the already-merged re-run, not a landing.
    return { status: 'merged', fastForward: true, mergeCommitSha: baseSha };
  }
  let baseIsBehind = false;
  try {
    git(dir, ['merge-base', '--is-ancestor', baseSha, headSha]);
    baseIsBehind = true;
  } catch {
    // Diverged — a real merge (or a real squash).
  }
  if (baseIsBehind && !squash) {
    // Base is behind head: fast-forward, no merge commit, no conflict.
    git(dir, ['update-ref', `refs/heads/${base}`, headSha, baseSha]);
    reconcileHead(dir);
    void notifyRefMoved(dir, {
      owner: userId, name, ref: `refs/heads/${base}`, before: baseSha, after: headSha,
    });
    return { status: 'merged', fastForward: true, mergeCommitSha: headSha };
  }

  // The first landing on a protected branch that still holds only its empty
  // start (note #759) and a branch that never grew from it — an agent's own
  // history, pushed as it was. There is nothing on the base to merge with, so
  // the result is the branch's tree whole, and the commit keeps BOTH parents
  // even for a squash: the start stays in the branch's history (nobody's
  // clone of it is left stranded) and the agent's branch is in main's, so its
  // next branch grows from what was approved.
  const overPlaceholder = !baseIsBehind && isPlaceholder(dir, baseSha);
  let treeSha;
  if (overPlaceholder || baseIsBehind) {
    // A squash of a branch the base is simply behind: the result is head's
    // tree verbatim — there is no second side to merge.
    treeSha = git(dir, ['rev-parse', `${headSha}^{tree}`]).trim();
  } else {
    try {
      treeSha = git(dir, ['merge-tree', '--write-tree', baseSha, headSha]).trim().split('\n')[0];
    } catch (error) {
      const stdout = String(error.stdout || '');
      return { status: 'conflict', conflicts: stdout.split('\n').filter(Boolean).slice(0, 20) };
    }
  }

  // The commits a squash replaces keep their author on the one that remains;
  // the committer stays whoever performed the merge, as on every path.
  let commitAuthor = author;
  if (squash && !commitAuthor) {
    const [authorName, authorEmail] = git(dir, ['log', '-1', '--format=%an%x00%ae', headSha]).trim().split('\u0000');
    if (authorName && authorEmail) commitAuthor = { name: authorName, email: authorEmail };
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: commitAuthor?.name || 'Agentic Cloud Computer',
    GIT_AUTHOR_EMAIL: commitAuthor?.email || PLATFORM_COMMIT_EMAIL,
    GIT_COMMITTER_NAME: author?.name || 'Agentic Cloud Computer',
    GIT_COMMITTER_EMAIL: author?.email || PLATFORM_COMMIT_EMAIL,
  };
  const parents = squash && !overPlaceholder ? ['-p', baseSha] : ['-p', baseSha, '-p', headSha];
  const commitSha = execFileSync('git', [
    '--git-dir', dir, 'commit-tree', treeSha, ...parents, '-m', message || 'Merge',
  ], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  // Compare-and-swap: if the base moved while we were merging, this fails
  // rather than clobbering whatever landed there.
  git(dir, ['update-ref', `refs/heads/${base}`, commitSha, baseSha]);
  reconcileHead(dir);
  // merge-tree and commit-tree write loose objects with no receive-pack
  // behind them, so unlike a push, nothing here ever meets git's auto-gc —
  // the busiest repos would accumulate loose objects forever. Fire-and-forget
  // and detached: packing is never worth delaying the merge answer for.
  spawn('git', ['--git-dir', dir, 'gc', '--auto', '--quiet'], { detached: true, stdio: 'ignore' }).unref();
  // The ref moved with no hook behind it, and this commit exists nowhere else.
  // Fire-and-forget: the merge is done and its answer is not this daemon's to
  // wait for. Only here — the fast-forward paths above land a sha CI has
  // already judged.
  void notifyRefMoved(dir, {
    owner: userId, name, ref: `refs/heads/${base}`, before: baseSha, after: commitSha,
  });
  return { status: 'merged', fastForward: false, mergeCommitSha: commitSha };
}

// ── Read-only browsing (the Mini App's repo explorer) ───────────────────────

/** Big enough for any source file a phone can show. A cap, not a truncation:
 *  past it the response carries the facts and the clone URL is the way in. */
const MAX_BROWSE_FILE_BYTES = 512 * 1024;

/**
 * Images travel as bytes, so they get their own (larger) cap: a screenshot is
 * routinely bigger than any source file and still worth showing. Base64 in
 * JSON costs a third on top, which is the real ceiling being chosen here.
 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * The types a phone renders from a data URL, keyed by extension. The extension
 * is the ONLY source of the media type — never anything read out of the file —
 * so a blob can never name its own content type, and the map is the whole list
 * of types the page can be told to render.
 *
 * SVG is in it: as an `<img>` source it renders in the browser's secure static
 * mode, where scripts and external references do not run.
 */
const IMAGE_MIME = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['bmp', 'image/bmp'], ['ico', 'image/x-icon'], ['svg', 'image/svg+xml'],
]);

function imageMimeOf(subPath) {
  const base = subPath.slice(subPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // A leading dot is a dotfile, not an extension: `.png` is a config file.
  if (dot <= 0) return null;
  return IMAGE_MIME.get(base.slice(dot + 1).toLowerCase()) || null;
}

/** How many commits one `log` answer may carry, and how many it defaults to. */
const MAX_LOG_COMMITS = 50;
const DEFAULT_LOG_COMMITS = 20;

/**
 * A path INSIDE a repo, from the Mini App. Looser than branch names (any
 * filename git tracks should be browsable) but never a traversal: no empty,
 * `.` or `..` segments. It is only ever used after a `:` in a revision spec,
 * where git reads it as literal data, so no filename can become a flag.
 */
function isSafeTreePath(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  if (value === '') return true;
  if (value.includes('\0') || value.includes('\n')) return false;
  return value.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * List one directory of the DEFAULT branch — the branch `git clone` lands on,
 * which is `main` on every protected repo as soon as it exists. There is no
 * ref parameter on purpose: the explorer shows the repo as a clone would.
 * `branch: null` means nothing has been pushed at all.
 */
function listTree(userId, name, subPath) {
  const dir = repoPath(userId, name);
  const branch = defaultBranchOf(dir);
  if (!branch || !branchExists(dir, branch)) return { branch: null, entries: [] };
  const out = git(dir, ['ls-tree', '-z', '-l', `refs/heads/${branch}:${subPath}`]);
  const entries = out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, , size] = line.slice(0, tab).split(/ +/);
    const kind = type === 'tree' ? 'dir'
      : type === 'commit' ? 'submodule'
        : mode === '120000' ? 'symlink' : 'file';
    return {
      name: line.slice(tab + 1),
      type: kind,
      ...(kind === 'file' || kind === 'symlink' ? { sizeBytes: Number(size) || 0 } : {}),
    };
  });
  return { branch, entries };
}

/** One file of the default branch. Content only for what the app can render:
 *  text, or an image as bytes. Other binaries and oversized blobs answer with
 *  their facts instead. */
function readBlob(userId, name, subPath, atSha) {
  const dir = repoPath(userId, name);
  const branch = defaultBranchOf(dir);
  if (!branch || !branchExists(dir, branch)) throw new Error('no such file');
  // At one exact commit (note #941: the own-cloud guide pins the installer
  // that way). Only a commit the default branch already contains: what was
  // approved, never a work branch, and never a ref expression, because the
  // caller has checked it is 40 hex and nothing else.
  if (atSha) {
    try {
      git(dir, ['merge-base', '--is-ancestor', atSha, `refs/heads/${branch}`]);
    } catch {
      throw new Error('no such file');
    }
  }
  const spec = `${atSha || `refs/heads/${branch}`}:${subPath}`;
  let type;
  try {
    type = git(dir, ['cat-file', '-t', spec]).trim();
  } catch {
    throw new Error('no such file');
  }
  if (type !== 'blob') throw new Error('that is a directory, not a file');
  const sizeBytes = Number(git(dir, ['cat-file', '-s', spec]).trim()) || 0;
  // An image is decided by its NAME, before the text/binary heuristic gets a
  // vote: a PNG is bytes and an SVG is text, and both are a picture.
  const mime = imageMimeOf(subPath);
  if (mime) {
    if (sizeBytes > MAX_IMAGE_BYTES) return { branch, sizeBytes, tooLarge: true };
    const bytes = git(dir, ['cat-file', 'blob', spec], { encoding: 'buffer' });
    return { branch, sizeBytes, image: { mime, base64: bytes.toString('base64') } };
  }
  if (sizeBytes > MAX_BROWSE_FILE_BYTES) return { branch, sizeBytes, tooLarge: true };
  const buf = git(dir, ['cat-file', 'blob', spec], { encoding: 'buffer' });
  // git's own text/binary heuristic: a NUL in the first 8000 bytes.
  if (buf.subarray(0, 8000).includes(0)) return { branch, sizeBytes, binary: true };
  return { branch, sizeBytes, content: buf.toString('utf8') };
}

/**
 * Recent commits on the DEFAULT branch — the same rule the explorer browses
 * by, so the history and the files on screen always describe one branch.
 * `branch: null` means nothing has been pushed yet, exactly as in `listTree`.
 *
 * The format packs one commit per record with ASCII unit/record separators
 * rather than spaces or tabs: a subject is arbitrary user text, and any
 * printable delimiter is a subject away from shifting every field after it.
 */
function readLog(userId, name, limit) {
  const dir = repoPath(userId, name);
  const branch = defaultBranchOf(dir);
  if (!branch || !branchExists(dir, branch)) return { branch: null, commits: [] };
  const out = git(dir, [
    'log', `--max-count=${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', `refs/heads/${branch}`,
  ]);
  const commits = out.split('\x1e')
    // git ends each record with a newline of its own, after the separator.
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, authorName, at, subject] = record.split('\x1f');
      return { sha, authorName, at, subject: subject ?? '' };
    });
  return { branch, commits };
}

/**
 * Who has written this repository, and how much: commits, insertions and
 * deletions per author, on the default branch.
 *
 * `since` makes it INCREMENTAL. A full history walk is `git log --numstat`
 * over every commit — seven seconds on a repo of a couple of thousand — and
 * this runs on every push report, so the caller hands back the sha it last
 * counted to and gets only what has landed since. The guard is an ancestry
 * check: after a force-push or a rebase the old sha is no longer behind the
 * new tip, the delta would be nonsense, and the answer is a full recount.
 *
 * Merges are excluded (`--no-merges`). A merge's diff is the work of the
 * branch it merged, already counted on those commits, and counting it again
 * would credit every landing to whoever approved it — on this platform that
 * is one machine identity, which would top every list in the product.
 */
function readContributors(userId, name, since) {
  const dir = repoPath(userId, name);
  const branch = defaultBranchOf(dir);
  if (!branch || !branchExists(dir, branch)) {
    return { branch: null, tipSha: null, from: null, authors: [] };
  }
  const tipSha = revParse(dir, `refs/heads/${branch}`);
  if (!tipSha) return { branch, tipSha: null, from: null, authors: [] };
  // Nothing new: the caller's totals are already right, and the cheapest
  // possible answer is the honest one.
  if (since && since === tipSha) return { branch, tipSha, from: since, authors: [] };
  const usable = since && /^[0-9a-f]{40}$/.test(since) && isAncestor(dir, since, tipSha)
    ? since
    : null;
  const range = usable ? `${usable}..${tipSha}` : tipSha;
  const out = git(dir, [
    'log', '--no-merges', '--numstat', '--format=%x1e%an%x1f%ae', range,
  ]);
  const totals = new Map();
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [header, ...lines] = record.split('\n');
    const [authorName, email] = header.split('\x1f');
    const key = (email || authorName || '').toLowerCase();
    if (!key) continue;
    const seen = totals.get(key)
      || { name: authorName || email, email: email || '', commits: 0, insertions: 0, deletions: 0 };
    seen.commits += 1;
    for (const line of lines) {
      // "<added>\t<deleted>\t<path>", and a dash for either on a binary file.
      const [added, deleted] = line.split('\t');
      if (added === undefined || deleted === undefined) continue;
      if (added !== '-') seen.insertions += Number(added) || 0;
      if (deleted !== '-') seen.deletions += Number(deleted) || 0;
    }
    totals.set(key, seen);
  }
  return {
    branch,
    tipSha,
    // What the caller should ADD these to: its own sha when the delta was
    // usable, null when this is a full recount and the totals replace
    // whatever it had.
    from: usable,
    authors: [...totals.values()].sort((a, b) => b.commits - a.commits),
  };
}

/**
 * ONE commit, and what it changed.
 *
 * Its own route rather than a reuse of `compare`, which is branch-shaped:
 * naming a commit's parent needs `sha^`, and `isSafeBranch` refuses the caret
 * — rightly, since that validator's job is to keep shell-ish characters out
 * of a ref a user chose. Here the ref is a SHA and nothing else: the format
 * is checked before it reaches git, so there is nothing to smuggle.
 *
 * The diff is against the FIRST parent, which is what makes a merge commit
 * readable (everything the merged branch brought in) and a root commit
 * possible at all — no parent means diffing from the empty tree, exactly as
 * a proposal into an empty branch does.
 */
function readCommit(userId, name, sha) {
  const dir = repoPath(userId, name);
  const full = revParse(dir, sha);
  if (!full) return null;
  const record = git(dir, ['log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b', full]);
  const [, authorName, at, subject, ...bodyParts] = record.split('\x1f');
  // `rev-list --parents` prints the commit then its parents, space separated.
  const parents = git(dir, ['rev-list', '--parents', '-n', '1', full]).trim().split(' ').slice(1);
  const from = parents[0] || EMPTY_TREE;

  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of git(dir, ['diff', '--numstat', from, full]).split('\n')) {
    if (!line.trim()) continue;
    const [added, removed] = line.split('\t');
    files += 1;
    // `-` for binary files: counted as changed, not as lines.
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }

  let patch = git(dir, ['diff', from, full]);
  const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
  if (truncated) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n… truncated …\n`;

  return {
    sha: full,
    authorName,
    at,
    subject: subject ?? '',
    body: bodyParts.join('\x1f').replace(/\n+$/, ''),
    parents,
    diffStat: { files, insertions, deletions },
    patch,
    patchTruncated: truncated,
  };
}

// ── Git smart HTTP ──────────────────────────────────────────────────────────

// ── Knowledge pages (docs/agent-knowledge-pages.md) ────────────────────────

/**
 * The knowledge base is a bare repo like any other, in the user's own
 * namespace, under a name that starts with an underscore — and that leading
 * underscore is the whole fence: `SEGMENT` requires a leading alphanumeric, so
 * `parseRepoUrl` refuses this path and NO git request can reach it. Agents
 * cannot clone it, cannot push to it, and cannot bypass the approval gate by
 * treating it as an ordinary repo. Its name never crosses the wire either:
 * callers send a userId, and this file decides what the base is called.
 */
const KNOWLEDGE_REPO_NAME = '_knowledge';

/** What may be written into a knowledge base, checked here as well as in the
 *  backend: one HTML page per name, plus the derived index. */
const KNOWLEDGE_PATH = /^(pages\/[a-z0-9][a-z0-9-]{0,60}[a-z0-9]\.html|index\.json)$/;

function knowledgePath(userId) {
  return path.join(REPOS_ROOT, userId, `${KNOWLEDGE_REPO_NAME}.git`);
}

/** Room deletion is permanent: unlike a page proposal, there is no base to
 *  preserve and no restore window. The validated namespace plus the fixed
 *  hidden repo name keeps this removal inside the repositories root. */
function deleteKnowledge(userId) {
  const dir = knowledgePath(userId);
  rmSync(dir, { recursive: true, force: true });
  return { deleted: true };
}

/** Created on first use rather than at signup: an account that never asks for
 *  a knowledge page never gets a directory. Idempotent, like createRepo. */
function ensureKnowledgeBase(userId) {
  const dir = knowledgePath(userId);
  if (existsSync(dir)) return dir;
  const used = diskUsedPercent();
  if (used >= DISK_MAX_USED_PERCENT) {
    throw new Error(`disk is ${used}% full — refusing to create new repos above ${DISK_MAX_USED_PERCENT}%`);
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir], { stdio: 'ignore' });
  // No hooks: nothing can push here (see the name), so there is no push to
  // gate, no CI to dispatch and no size report to file.
  return dir;
}

/** Every page in the base, with the blob sha a proposal pins against. */
function knowledgeList(userId) {
  const dir = knowledgePath(userId);
  if (!existsSync(dir)) return { pages: [], index: null };
  const head = revParse(dir, 'refs/heads/main');
  if (!head) return { pages: [], index: null };
  let out = '';
  try {
    out = git(dir, ['ls-tree', '-z', '-l', 'refs/heads/main:pages']);
  } catch {
    // No `pages/` yet — an empty base, not an error.
    return { pages: [], index: readKnowledgeIndex(dir), head };
  }
  const pages = out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [, type, sha, size] = line.slice(0, tab).split(/ +/);
    if (type !== 'blob') return null;
    const file = line.slice(tab + 1);
    if (!file.endsWith('.html')) return null;
    return { name: file.slice(0, -'.html'.length), sha, sizeBytes: Number(size) || 0 };
  }).filter(Boolean);
  // `head` is what a caller pins its commit on (note #746): two agents
  // changing the shelf at once both read it, and the second commit answers
  // `stale` instead of landing on top of something nobody looked at.
  return { pages, index: readKnowledgeIndex(dir), head };
}

function readKnowledgeIndex(dir) {
  try {
    return git(dir, ['cat-file', 'blob', 'refs/heads/main:index.json']);
  } catch {
    return null;
  }
}

/** One page's source, and the sha that says which version it is. */
function knowledgeRead(userId, page) {
  const dir = knowledgePath(userId);
  const file = `pages/${page}.html`;
  if (!KNOWLEDGE_PATH.test(file)) throw new Error('invalid page name');
  if (!existsSync(dir) || !revParse(dir, 'refs/heads/main')) throw new Error('no such page');
  const spec = `refs/heads/main:${file}`;
  let sha;
  try {
    sha = git(dir, ['rev-parse', spec]).trim();
  } catch {
    throw new Error('no such page');
  }
  const content = git(dir, ['cat-file', 'blob', spec], { encoding: 'buffer' }).toString('utf8');
  return { content, sha, sizeBytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Land a set of page writes and deletes as ONE commit on `main`.
 *
 * There is no push behind this and no branch in front of it: the backend holds
 * an APPROVED proposal and asks for its content to become the base. The index
 * is built off HEAD and swapped in with a compare-and-swap `update-ref`, so two
 * approvals racing cannot lose one another's work — the loser fails and the
 * caller re-reads.
 */
function knowledgeCommit(userId, { writes = [], deletes = [], message, author, expectedHead }) {
  const dir = ensureKnowledgeBase(userId);
  for (const write of writes) {
    if (!write || !KNOWLEDGE_PATH.test(String(write.path)) || typeof write.content !== 'string') {
      throw new Error(`invalid write path: ${write && write.path}`);
    }
  }
  for (const file of deletes) {
    if (!KNOWLEDGE_PATH.test(String(file))) throw new Error(`invalid delete path: ${file}`);
  }
  const head = revParse(dir, 'refs/heads/main');
  if (expectedHead && head !== expectedHead) {
    return { status: 'stale', head };
  }
  if (!writes.length && !deletes.length) {
    return { status: 'empty', head };
  }

  // A temp index inside the repo: same filesystem, cleaned up below, and never
  // the repo's own `index` file — a bare repo has none, and borrowing it would
  // make two concurrent commits share state.
  const indexFile = path.join(dir, `knowledge-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    if (head) git(dir, ['read-tree', head], { env });
    // Every change in ONE `--index-info` stream. Not `--add` / `--force-remove`:
    // those need a work tree, which a bare repo does not have (the removal path
    // fails outright), while `--index-info` is defined against the index alone.
    // A removal is mode 0 against the null sha, and it is a no-op when the path
    // is already gone — an approval landing twice has to be harmless.
    const entries = [];
    for (const write of writes) {
      const sha = execFileSync('git', ['--git-dir', dir, 'hash-object', '-w', '--stdin'], {
        input: Buffer.from(write.content, 'utf8'),
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      }).trim();
      entries.push(`100644 ${sha}\t${write.path}`);
    }
    for (const file of deletes) {
      entries.push(`0 ${ZERO_SHA}\t${file}`);
    }
    execFileSync('git', ['--git-dir', dir, 'update-index', '--index-info'], {
      input: `${entries.join('\n')}\n`,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const tree = git(dir, ['write-tree'], { env }).trim();
    if (head && tree === git(dir, ['rev-parse', `${head}^{tree}`]).trim()) {
      // The approved content is already what the base holds — a re-run, not a
      // landing. Report the head so the caller records the same answer twice.
      return { status: 'committed', commitSha: head, unchanged: true };
    }
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: (author && author.name) || 'Agentic Cloud Computer',
      GIT_AUTHOR_EMAIL: (author && author.email) || PLATFORM_COMMIT_EMAIL,
      GIT_COMMITTER_NAME: 'Agentic Cloud Computer',
      GIT_COMMITTER_EMAIL: PLATFORM_COMMIT_EMAIL,
    };
    const commitSha = execFileSync('git', [
      '--git-dir', dir, 'commit-tree', tree,
      ...(head ? ['-p', head] : []),
      '-m', message || 'Update knowledge',
    ], { encoding: 'utf8', env: commitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    // Compare-and-swap against the head we built on.
    git(dir, ['update-ref', 'refs/heads/main', commitSha, ...(head ? [head] : ['']) ]);
    // commit-tree writes loose objects with no receive-pack behind them, so
    // nothing here ever meets git's auto-gc — the same trap the merge path
    // documents, and the same answer.
    spawn('git', ['--git-dir', dir, 'gc', '--auto', '--quiet'], { detached: true, stdio: 'ignore' }).unref();
    return { status: 'committed', commitSha };
  } finally {
    try { rmSync(indexFile, { force: true }); } catch { /* the next commit makes its own */ }
  }
}

function parseRepoUrl(pathname) {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(pathname);
  if (!match) return null;
  const [, userId, name, rest] = match;
  if (!isSafeSegment(userId) || !isSafeSegment(name)) return null;
  if (!SAFE_PATHS.has(rest)) return null;
  return { userId, name, rest };
}

function unauthorized(res, message) {
  res.writeHead(401, {
    // Without the challenge, git gives up instead of asking its credential
    // helper — the helper is the whole reason `git push` needs no setup.
    'www-authenticate': 'Basic realm="agentbuilt"',
    'content-type': 'text/plain',
  });
  res.end(`${message}\n`);
}

function basicAuthToken(req) {
  const header = req.headers.authorization || '';
  if (!/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  // `username:password` — the username is ignored; the password is the token.
  const index = decoded.indexOf(':');
  return index >= 0 ? decoded.slice(index + 1) : null;
}

function runGitBackend(req, res, { dir, userId, name, rest, auth, isPush }) {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  const quota = auth.quota || {};
  const env = {
    PATH: process.env.PATH,
    GIT_PROJECT_ROOT: path.join(REPOS_ROOT, userId),
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${name}.git${rest}`,
    QUERY_STRING: query,
    REQUEST_METHOD: req.method,
    REMOTE_USER: auth.agentId || 'agent',
    REMOTE_ADDR: req.socket.remoteAddress || '',
    ...(req.headers['content-type'] ? { CONTENT_TYPE: req.headers['content-type'] } : {}),
    ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
    // Protocol v2 negotiation is opt-in via this header; without forwarding it
    // every fetch silently falls back to v0.
    ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
    ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
    // Read by the pre-receive hook. Only meaningful on a push.
    AGENTGIT_REPO_MAX_BYTES: String(quota.repoMaxBytes ?? 0),
    AGENTGIT_USER_MAX_BYTES: String(quota.userMaxBytes ?? 0),
    AGENTGIT_USER_USED_BYTES: String(quota.userUsedBytes ?? 0),
    AGENTGIT_REPO_USED_BYTES: String(isPush ? repoSizeBytes(dir) : 0),
    // Read by both hooks: pre-receive drops the protection gates (approval
    // left with the platform), post-receive stays silent (no dispatcher to
    // notify). Set only on an off-boarded host.
    ...(STANDALONE ? { AGENTGIT_STANDALONE: '1' } : {}),
  };

  // Before the objects arrive, not after: this is the last moment the repo's
  // copy of the gate can be brought up to date for the push about to run it.
  if (isPush) ensureHooks(dir);

  const child = spawn('git', ['http-backend'], { env });
  req.pipe(child.stdin);

  // CGI: headers, blank line, body. Buffer only until the blank line, then
  // stream — a clone must not be assembled in memory.
  let head = Buffer.alloc(0);
  let headersSent = false;
  child.stdout.on('data', (chunk) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const split = head.indexOf('\r\n\r\n');
    const splitLen = split >= 0 ? 4 : -1;
    const altSplit = split >= 0 ? -1 : head.indexOf('\n\n');
    const at = split >= 0 ? split : altSplit;
    if (at < 0) return;
    const rawHeaders = head.slice(0, at).toString('utf8');
    const body = head.slice(at + (split >= 0 ? splitLen : 2));
    const headers = {};
    let status = 200;
    for (const line of rawHeaders.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === 'status') {
        status = Number.parseInt(value, 10) || 200;
        continue;
      }
      headers[key] = value;
    }
    headersSent = true;
    res.writeHead(status, headers);
    if (body.length) res.write(body);
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 2000); });

  child.on('close', (code) => {
    if (!headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('git backend failed\n');
    } else {
      res.end();
    }
    if (code !== 0 && stderr) log('git http-backend stderr', { userId, name, code, stderr });
    // Only a receive-pack changes bytes; reporting after the process exits
    // keeps the secret out of hook environments entirely.
    if (isPush && code === 0) {
      // Before reporting: the reported default branch must be one that exists.
      reconcileHead(dir);
      void reportPush(userId, name, dir);
    }
  });
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/health') {
    return json(res, 200, { ok: true, diskUsedPercent: diskUsedPercent(), ...(STANDALONE ? { standalone: true } : {}) });
  }

  if (pathname.startsWith('/internal/')) {
    if (!secretMatches(req.headers['x-git-host-secret'])) {
      return json(res, 401, { error: 'bad host secret' });
    }
    let body;
    try {
      // One knowledge commit carries whole pages, so it gets its own ceiling:
      // everything else on this API is a handful of fields.
      const limit = pathname === '/internal/knowledge/commit' ? 8 * 1024 * 1024 : undefined;
      body = JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }
    // Knowledge routes carry a userId and no repo name — the base's name is
    // this file's business, not the caller's — so they answer before the
    // repo-name check below.
    if (pathname.startsWith('/internal/knowledge/')) {
      if (!isSafeSegment(body.userId)) {
        return json(res, 400, { error: 'invalid userId' });
      }
      const owner = body.userId;
      try {
        if (pathname === '/internal/knowledge/list' && req.method === 'POST') {
          return json(res, 200, knowledgeList(owner));
        }
        if (pathname === '/internal/knowledge/read' && req.method === 'POST') {
          if (typeof body.page !== 'string') return json(res, 400, { error: 'invalid page' });
          return json(res, 200, knowledgeRead(owner, body.page));
        }
        if (pathname === '/internal/knowledge/delete' && req.method === 'POST') {
          return json(res, 200, deleteKnowledge(owner));
        }
        if (pathname === '/internal/knowledge/commit' && req.method === 'POST') {
          return json(res, 200, knowledgeCommit(owner, {
            writes: Array.isArray(body.writes) ? body.writes : [],
            deletes: Array.isArray(body.deletes) ? body.deletes : [],
            message: body.message,
            author: body.author,
            expectedHead: body.expectedHead,
          }));
        }
      } catch (error) {
        return json(res, 409, { error: String(error.message || error) });
      }
      return json(res, 404, { error: 'no such control route' });
    }

    // A backup run (byo-git slice 4): bundle-and-upload every changed repo to
    // the bucket the CALLER names — the backend's per-org sweep is the clock,
    // because a host that sleeps between pushes fires no timers of its own.
    // Credentials arrive per run and are held only for its duration.
    if (pathname === '/internal/backup/run' && req.method === 'POST') {
      const target = {
        endpoint: String(body.endpoint ?? ''),
        bucket: String(body.bucket ?? ''),
        accessKeyId: String(body.accessKeyId ?? ''),
        secretAccessKey: String(body.secretAccessKey ?? ''),
      };
      if (!/^https:\/\//.test(target.endpoint) || !target.bucket || !target.accessKeyId || !target.secretAccessKey) {
        return json(res, 400, { error: 'a backup run needs endpoint (https), bucket, accessKeyId and secretAccessKey' });
      }
      try {
        const { runBackup } = await import('./backup.mjs');
        const summary = await runBackup({
          reposRoot: REPOS_ROOT,
          stateFile: path.join(path.dirname(REPOS_ROOT), 'backup-state.json'),
          target,
          log: (line) => log(`[backup] ${line}`),
        });
        return json(res, 200, summary);
      } catch (error) {
        return json(res, 500, { error: String(error.message || error) });
      }
    }

    const { userId, name } = body;
    if (!isSafeSegment(userId) || !isSafeSegment(name)) {
      return json(res, 400, { error: 'invalid userId or name' });
    }
    if (pathname === '/internal/repos' && req.method === 'POST') {
      try {
        // Both wire shapes: `protectedBranches` (list), and the singular
        // `protectedBranch` older backends send — union, first value wins as
        // the default branch either way.
        const singular = typeof body.protectedBranch === 'string' && body.protectedBranch ? [body.protectedBranch] : [];
        const listed = Array.isArray(body.protectedBranches) ? body.protectedBranches : [];
        const protectedBranches = [...new Set([...singular, ...listed])];
        if (!protectedBranches.every(isSafeBranch)) {
          return json(res, 400, { error: 'invalid protectedBranch' });
        }
        return json(res, 200, createRepo(userId, name, protectedBranches));
      } catch (error) {
        return json(res, 507, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/protect' && req.method === 'POST') {
      const dir = repoPath(userId, name);
      if (!existsSync(dir)) {
        return json(res, 404, { error: 'no such repo' });
      }
      const branches = Array.isArray(body.branches) ? body.branches : [];
      if (branches.length === 0 || !branches.every(isSafeBranch)) {
        return json(res, 400, { error: 'invalid branches' });
      }
      const result = protectBranches(dir, branches);
      // Unprotected-is-permanent is an ANSWER about the repo, not a failure
      // of the call: 409 so the backend can hand the words to the agent.
      if (result.error) return json(res, 409, result);
      return json(res, 200, result);
    }
    if (pathname === '/internal/repos/ci' && req.method === 'POST') {
      const dir = repoPath(userId, name);
      if (!existsSync(dir)) {
        return json(res, 404, { error: 'no such repo' });
      }
      // Strictly a boolean. Note what this body CANNOT carry: a URL.
      if (typeof body.enabled !== 'boolean') {
        return json(res, 400, { error: 'pass {"enabled": true|false}' });
      }
      const result = setRepoCi(dir, body.enabled);
      // "This host has no dispatcher" is a fact about the deployment the
      // agent deserves in words, same as unprotected-is-permanent.
      if (result.error) return json(res, 409, result);
      return json(res, 200, result);
    }
    /**
     * Delete, restore, rename — the admin surface
     * (docs/agent-git-project-repos.md slice 5). WHO may call these is the
     * backend's question, as always; this end only refuses what it cannot do
     * safely. A delete of a repo that is already gone answers 200 with
     * `deleted: false`: the caller asked for a state, and that state holds.
     */
    if (pathname === '/internal/repos/delete' && req.method === 'POST') {
      try {
        return json(res, 200, deleteRepo(userId, name));
      } catch (error) {
        return json(res, 500, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/restore' && req.method === 'POST') {
      try {
        const result = restoreRepo(userId, name, body.trashedAs);
        // Purged, or the name is taken again: an ANSWER about the repo, which
        // the backend hands to the agent in words. Same shape as protect's.
        if (result.error) return json(res, 409, result);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 500, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/move' && req.method === 'POST') {
      // The destination is a PATH SEGMENT like any other: unchecked, it is a
      // traversal out of REPOS_ROOT.
      if (!isSafeSegment(body.toUserId)) {
        return json(res, 400, { error: 'invalid toUserId' });
      }
      try {
        const result = moveRepo(userId, name, body.toUserId);
        if (result.error) return json(res, 409, result);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 500, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/rename' && req.method === 'POST') {
      if (!isSafeSegment(body.newName)) {
        return json(res, 400, { error: 'invalid newName' });
      }
      try {
        const result = renameRepo(userId, name, body.newName);
        if (result.error) return json(res, 409, result);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 500, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/compare' && req.method === 'POST') {
      if (!existsSync(repoPath(userId, name))) {
        return json(res, 404, { error: 'no such repo' });
      }
      const { base, head } = body;
      if (!isSafeBranch(base) || !isSafeBranch(head)) {
        return json(res, 400, { error: 'invalid base or head' });
      }
      try {
        return json(res, 200, compare(userId, name, base, head));
      } catch (error) {
        return json(res, 409, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/merge' && req.method === 'POST') {
      if (!existsSync(repoPath(userId, name))) {
        return json(res, 404, { error: 'no such repo' });
      }
      const { base, head, expectedHead, message, author, squash } = body;
      if (!isSafeBranch(base) || !isSafeBranch(head)) {
        return json(res, 400, { error: 'invalid base or head' });
      }
      try {
        const result = mergeBranch(userId, name, { base, head, expectedHead, message, author, squash: squash === true });
        // A conflict or a moved head is an ANSWER, not a failure: the backend
        // turns each into its own user-facing outcome.
        return json(res, 200, result);
      } catch (error) {
        return json(res, 409, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/tree' && req.method === 'POST') {
      if (!existsSync(repoPath(userId, name))) {
        return json(res, 404, { error: 'no such repo' });
      }
      const treePath = body.path ?? '';
      if (!isSafeTreePath(treePath)) {
        return json(res, 400, { error: 'invalid path' });
      }
      try {
        return json(res, 200, listTree(userId, name, treePath));
      } catch {
        return json(res, 404, { error: 'no such directory' });
      }
    }
    if (pathname === '/internal/repos/file' && req.method === 'POST') {
      if (!existsSync(repoPath(userId, name))) {
        return json(res, 404, { error: 'no such repo' });
      }
      const filePath = body.path;
      if (filePath === '' || !isSafeTreePath(filePath)) {
        return json(res, 400, { error: 'invalid path' });
      }
      if (body.sha !== undefined && (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha))) {
        return json(res, 400, { error: 'invalid sha' });
      }
      try {
        return json(res, 200, readBlob(userId, name, filePath, body.sha));
      } catch (error) {
        return json(res, 404, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/log' && req.method === 'POST') {
      if (!existsSync(repoPath(userId, name))) {
        return json(res, 404, { error: 'no such repo' });
      }
      // A number, not something that merely converts into one: `Number()`
      // would take '10' — and the only caller is the backend's own client,
      // so anything else arriving here is a bug worth hearing about.
      const asked = body.limit === undefined ? DEFAULT_LOG_COMMITS : body.limit;
      if (!Number.isInteger(asked) || asked < 1) {
        return json(res, 400, { error: 'invalid limit' });
      }
      // Clamped rather than refused: a caller asking for more than a screenful
      // gets a screenful, and the number still reaches `git log` as an integer.
      const limit = Math.min(asked, MAX_LOG_COMMITS);
      try {
        return json(res, 200, readLog(userId, name, limit));
      } catch (error) {
        return json(res, 409, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/commit' && req.method === 'POST') {
      if (!existsSync(repoPath(userId, name))) {
        return json(res, 404, { error: 'no such repo' });
      }
      // A sha and nothing else — never a ref expression, so there is no `^`,
      // no `..`, and nothing for git to interpret as an option.
      if (typeof body.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(body.sha)) {
        return json(res, 400, { error: 'invalid sha' });
      }
      try {
        const commit = readCommit(userId, name, body.sha);
        if (!commit) return json(res, 404, { error: 'no such commit' });
        return json(res, 200, commit);
      } catch (error) {
        return json(res, 409, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/contributors' && req.method === 'POST') {
      if (!existsSync(repoPath(userId, name))) {
        return json(res, 404, { error: 'no such repo' });
      }
      // A sha or nothing. Anything else is a bug in the only caller there is.
      if (body.since !== undefined && (typeof body.since !== 'string' || !/^[0-9a-f]{40}$/.test(body.since))) {
        return json(res, 400, { error: 'invalid since' });
      }
      try {
        return json(res, 200, readContributors(userId, name, body.since));
      } catch (error) {
        return json(res, 409, { error: String(error.message || error) });
      }
    }
    if (pathname === '/internal/repos/stat' && req.method === 'POST') {
      const dir = repoPath(userId, name);
      const exists = existsSync(dir);
      return json(res, 200, {
        exists,
        sizeBytes: exists ? repoSizeBytes(dir) : 0,
        defaultBranch: exists ? defaultBranchOf(dir) : undefined,
        // The repo's own config is the truth about protection; the backend's
        // record is a product flag. Reading it here lets callers show the
        // real list without a second source to keep in sync.
        protectedBranches: exists ? protectedBranchesOf(dir) : [],
        // Whether a push here tells the dispatcher anything. The URL itself
        // is deliberately NOT reported: it is infrastructure, not a fact
        // about the user's repo, and nothing outside this box needs it.
        ci: exists ? Boolean(repoConfigValue(dir, 'agentgit.webhookUrl')) : false,
      });
    }
    return json(res, 404, { error: 'no such control route' });
  }

  const parsed = parseRepoUrl(pathname);
  if (!parsed) {
    // Deliberately blunt: this server serves the three git endpoints and
    // nothing else, so a repo path can never become a file listing.
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found\n');
  }

  const service = url.searchParams.get('service') || '';
  const isPush = parsed.rest === '/git-receive-pack' || service === 'git-receive-pack';

  let auth;
  if (STANDALONE) {
    // Off-boarded: whoever is inside the org's network — their people, by
    // construction — clones and pushes freely. Credentials are accepted and
    // ignored, so a clone URL that still carries an old token keeps working.
    auth = { userId: parsed.userId, agentId: 'standalone' };
  } else {
    const token = basicAuthToken(req);
    if (!token) {
      // A push never becomes anonymous, even when the repository is public.
      // A fetch asks the backend whether this exact namespace/name is open;
      // private repos receive the ordinary credential challenge below.
      if (isPush) return unauthorized(res, 'authentication required');
      try {
        auth = await verifyToken('', parsed.userId, parsed.name);
      } catch (error) {
        log('public verify call failed', { error: String(error) });
        // Challenge rather than 503: git normally tries a URL's embedded or
        // helper credential only AFTER the challenge. A backend outage must
        // not strand the host's local break-glass read credential.
        return unauthorized(res, 'authentication required');
      }
      if (!auth) return unauthorized(res, 'authentication required');
    } else {
      try {
        auth = await verifyToken(token, parsed.userId, parsed.name);
      } catch (error) {
        log('verify call failed', { error: String(error) });
        // Fail CLOSED. The backend being unreachable must not open the door.
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('cannot verify credentials right now — try again shortly\n');
      }
      if (!auth) {
        return unauthorized(res, 'invalid token');
      }
    }
    // The namespace rule: a token reaches only its own user's repos.
    if (auth.userId !== parsed.userId) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('this token cannot access that namespace\n');
    }
  }

  const dir = repoPath(parsed.userId, parsed.name);
  if (!existsSync(dir)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('no such repo — create it with `agentbuilt repo create <name>`\n');
  }

  // A `scope` in the verify answer NARROWS the namespace rule: CI clone
  // tokens are one named repo and read-only; a cross-room grant is one named
  // repo with pushes allowed. Absent scope means the namespace rule stands
  // alone.
  if (auth.scope) {
    if (auth.scope.repo && auth.scope.repo !== parsed.name) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('this token is scoped to a different repository\n');
    }
    if (auth.scope.readOnly && isPush) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('this token is read-only\n');
    }
  }
  // A repo from before note #759 gets its protected branch on first contact,
  // so even the fetch that asks for it finds it.
  ensureProtectedDefault(dir);
  return runGitBackend(req, res, { ...parsed, dir, auth, isPush });
});

server.listen(PORT, HOST, () => {
  // The bound port, not the configured one: PORT=0 (tests, and any future
  // socket-activated setup) resolves to a real port only once listening.
  const bound = server.address();
  log(`listening on ${HOST}:${typeof bound === 'object' && bound ? bound.port : PORT}`, {
    reposRoot: REPOS_ROOT,
    backend: BACKEND_URL || 'unset',
  });
  if (!SECRET) log('WARNING: GIT_HOST_SECRET is empty — every control call and verification will fail');
  ensureProtectedDefaultsEverywhere();
});
