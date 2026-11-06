#!/usr/bin/env node
/**
 * Webhook-driven CI/CD daemon — replaces GitHub Actions for the everyday
 * pipelines (Actions is frozen account-wide when hosted minutes are unpaid;
 * webhooks and the commit-status API stay free).
 *
 * Runs on ia-ci-runner as a systemd service (see ia-ci-daemon.service).
 * GitHub POSTs push/pull_request events to :8787/webhook (HMAC-signed);
 * jobs are serialized through a single queue, each one:
 *   1. posts a `pending` commit status,
 *   2. fetches the exact SHA into the work checkout,
 *   3. runs `run-job.sh <kind> <sha>` (checks / deploy-prod / …),
 *   4. posts success/failure with a link to the log file.
 *
 * Env (systemd EnvironmentFile=/etc/ia-ci/env):
 *   GH_TOKEN        repo-scoped token: clone auth + commit statuses
 *   WEBHOOK_SECRET  shared with the GitHub webhook (HMAC-SHA256)
 *   REPO            e.g. <owner>/infinite-agents (required)
 *   WORKDIR         checkout dir (default /home/runner/ci-work)
 *   PORT            default 8787
 *   DEPLOY_PROD_QUIET_MS  main deploy debounce (default 30000; 0 disables)
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acceptArtifact, artifactJobPending, cancelLaneAJob, handleJobResult,
  laneAConfigured, laneARoutes, runLaneAJob, usablePublish,
  GUEST,
} from './lane-a.mjs';

// Required, with no default: a fallback repo name is a placeholder that reads
// like a value, and the one that used to sit here would have posted every
// commit status into a repository that does not exist.
const REPO = process.env.REPO ?? (() => {
  throw new Error('REPO unset in /etc/ia-ci/env — e.g. REPO=<owner>/infinite-agents');
})();
const PORT = Number(process.env.PORT ?? 8787);
const WORKDIR = process.env.WORKDIR ?? '/home/runner/ci-work';
const LOG_DIR = process.env.LOG_DIR ?? '/home/runner/ci-logs';
const SECRET = process.env.WEBHOOK_SECRET ?? '';
const TOKEN = process.env.GH_TOKEN ?? '';
// The job script MUST live outside WORKDIR/repo: jobs `git checkout --force`
// that checkout to arbitrary SHAs, so a copy living inside it vanishes the
// moment a job builds a commit that predates this file. Deployed to a stable
// path (/opt/ia-ci) alongside daemon.mjs; see README → "updating the daemon".
const SCRIPT = process.env.RUNJOB ?? '/opt/ia-ci/run-job.sh';
// Dropped by the self-update job when it replaces daemon.mjs; consumed when
// the queue next goes idle. Lives beside the daemon, not in the work checkout
// that jobs reset to arbitrary SHAs.
const RESTART_FLAG = path.join(path.dirname(SCRIPT), '.restart-requested');

if (!SECRET || !TOKEN) {
  console.error('WEBHOOK_SECRET and GH_TOKEN are required');
  process.exit(1);
}
mkdirSync(LOG_DIR, { recursive: true });

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function verifySignature(body, header) {
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GitHub's status API accepts only error|failure|pending|success, so our
 * richer states are mapped on the way out while the ingest below carries the
 * true one. `skipped` reads as success-with-honest-words; `superseded` keeps
 * the `error` it has always posted there — GitHub is a read-only mirror, and
 * the pip that decides anything is ours.
 */
const GITHUB_STATE = { skipped: 'success', superseded: 'error' };

async function postStatus(sha, context, state, description) {
  state = GITHUB_STATE[state] ?? state;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/statuses/${sha}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ia-ci-daemon',
      },
      body: JSON.stringify({ state, context, description: description.slice(0, 140) }),
    });
    if (!res.ok) log(`status post failed ${res.status} for ${context}@${sha.slice(0, 7)}`);
  } catch (error) {
    log(`status post error: ${error.message}`);
  }
}

// Second home for every verdict: the platform backend, which renders checks
// in the Mini App (docs/ci-status-miniapp.md). Optional — unset, GitHub stays
// the only reader. The backend drops statuses for repos it does not host, so
// posting unconditionally is correct for both GitHub-slug and platform jobs.
const STATUS_INGEST_URL = process.env.STATUS_INGEST_URL ?? '';
const CI_STATUS_SECRET = process.env.CI_STATUS_SECRET ?? '';

// Platform repos (our own git host). A push there arrives signed as
// x-agentgit-* and routes to lane A only — lane B never builds another
// user's repo, by design (docs/ci-two-lane-runner.md → Lane B rule 1).
// The clone-token endpoint is the ingest's sibling route, same secret.
const PLATFORM_GIT_BASE = process.env.PLATFORM_GIT_BASE ?? 'https://git.agentbuilt.app';
const CLONE_TOKEN_URL = process.env.CLONE_TOKEN_URL
  ?? (STATUS_INGEST_URL ? STATUS_INGEST_URL.replace(/\/statuses$/, '/ci-clone-token') : '');
const CI_SECRETS_URL = process.env.CI_SECRETS_URL
  ?? (STATUS_INGEST_URL ? STATUS_INGEST_URL.replace(/\/statuses$/, '/ci-secrets') : '');

/**
 * The ladder a clone-token mint climbs before the job is given up on: ~52s
 * over five attempts. The mint is asked the moment a push arrives, and a
 * merge's push is exactly when the backend may be restarting under the
 * previous commit's deploy, answering 502 from the proxy for a few seconds.
 * Without it one 502 dropped the push's whole ci/checks run in 0 s
 * (6d4753f1 on 27 Oct, 0a93bd3b on 28 Oct).
 */
const CLONE_TOKEN_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];
const CLONE_TOKEN_TIMEOUT_MS = 15000;

/**
 * Mint a read-only single-repo token for one platform job. `{ error }`
 * means the job cannot run — the caller files an error status saying why
 * rather than paying for a machine that would only fail to clone.
 *
 * 5xx and a fetch that throws (refused, reset, timed out: a backend
 * mid-restart) climb the ladder; any other refusal is final at once, since
 * asking again gets the same answer.
 */
async function platformCloneCreds(job) {
  if (!CLONE_TOKEN_URL || !CI_STATUS_SECRET || !job.repo) return { error: 'this runner has no clone-token service configured' };
  const label = `${job.repo.owner}/${job.repo.name}`;
  const delays = CLONE_TOKEN_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delays.length;
    const tries = attempt > 0 ? ` after ${attempt + 1} tries` : '';
    let failure;
    try {
      const res = await fetch(CLONE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ci-status-secret': CI_STATUS_SECRET },
        body: JSON.stringify({ owner: job.repo.owner, repo: job.repo.name, ttlSeconds: 3600 }),
        signal: AbortSignal.timeout(CLONE_TOKEN_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json();
        if (!body?.token) {
          log(`clone token mint for ${label} answered without a token`);
          return { error: 'the backend answered without a token' };
        }
        if (attempt > 0) log(`clone token mint recovered for ${label} after ${attempt + 1} tries`);
        return {
          cloneToken: body.token,
          repoUrl: `${PLATFORM_GIT_BASE}/${job.repo.owner}/${job.repo.name}.git`,
        };
      }
      if (res.status < 500) {
        log(`clone token mint refused ${res.status} for ${label}`);
        return { error: `the backend refused it (${res.status})` };
      }
      failure = `the backend answered ${res.status}`;
    } catch (error) {
      failure = 'the backend did not answer';
      log(`clone token mint for ${label}: ${error.message}`);
    }
    if (last) {
      log(`clone token mint failed for ${label}: ${failure}${tries}`);
      return { error: `${failure}${tries}` };
    }
    log(`clone token mint for ${label}: ${failure} — retrying in ${delays[attempt] / 1000}s`);
    await sleep(delays[attempt]);
  }
}

/**
 * The secrets riding this platform job, `{NAME: value}`. The BACKEND holds
 * the whole rule (owner opted the repo in, and the pushed ref is a protected
 * branch — code the owner approved); this caller just relays the answer. An
 * empty object is the ordinary case, not an error.
 *
 * Degrades to `{}` on any failure, deliberately: a deploy job missing its
 * secrets fails in its OWN log with the variable named ("CF_API_TOKEN:
 * unbound variable"), which the repo's owner can read and retry — a lane
 * that refuses to run at all whenever the backend hiccups is strictly worse,
 * and would take every plain checks job down with it.
 */
async function platformCiSecrets(job) {
  const none = { secrets: {}, publish: null };
  if (!CI_SECRETS_URL || !CI_STATUS_SECRET || !job.repo || !job.branch) return none;
  try {
    const res = await fetch(CI_SECRETS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ci-status-secret': CI_STATUS_SECRET },
      // The sha is what a publish key is minted for (`agentbuilt repo
      // publish`); a backend from before that ignores it.
      body: JSON.stringify({ owner: job.repo.owner, repo: job.repo.name, ref: job.branch, sha: job.sha }),
    });
    // 404 also covers a backend from before this endpoint — run plain.
    if (!res.ok) {
      if (res.status !== 404) log(`ci-secrets fetch ${res.status} for ${job.repo.owner}/${job.repo.name}#${job.branch} — running without`);
      return none;
    }
    const body = await res.json();
    const secrets = body?.secrets;
    return {
      secrets: secrets && typeof secrets === 'object' ? secrets : {},
      // Null for anything malformed: no key, no publish step, no check.
      publish: usablePublish(body?.publish),
    };
  } catch (error) {
    log(`ci-secrets fetch error: ${error.message} — running without`);
    return none;
  }
}

/**
 * The ladder a VERDICT climbs before it is given up on: ~112s of waiting over
 * six attempts, which is sized for the thing that actually knocks the ingest
 * over — the backend restarting under a deploy, answering 502 from the proxy
 * until it is back. That is not hypothetical: `deploy/prod@b44a1ca` was lost
 * exactly that way, by the deploy of the very commit it was reporting on.
 */
const INGEST_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];
/** Long enough for a slow write, short enough that the ladder still means
 *  something. A repeat is safe: the ingest upserts on (sha, context). */
const INGEST_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * File one status with the backend.
 *
 * `pending` deliberately gets ONE attempt and no ladder. It is a spinner, and
 * the post that follows it is the verdict — the only thing anyone reads. Worse,
 * the store upserts on (sha, context) with last write winning, so a `pending`
 * retried across a restart could land AFTER the `success` it preceded and turn
 * a finished check back into one that spins forever. Dropping it costs a few
 * seconds of missing spinner; retrying it could cost the truth.
 *
 * A verdict is the opposite. Nothing follows it, nothing re-derives it, and
 * nothing anywhere notices it is missing — the commit simply looks untested,
 * permanently. So it gets the ladder.
 *
 * 4xx is never retried: 401 is the wrong secret, 400 is a payload this daemon
 * will build identically next time. Repeating either just writes the same
 * refusal to the log five more times.
 */
async function postIngest(job, state, description, logTailB64, machineGuest) {
  if (!STATUS_INGEST_URL || !CI_STATUS_SECRET || !job.repo) return;
  const label = `${job.context}@${job.sha.slice(0, 7)}`;
  const body = JSON.stringify({
    owner: job.repo.owner,
    repo: job.repo.name,
    sha: job.sha,
    context: job.context,
    state,
    description: description.slice(0, 140),
    ...(logTailB64 ? { logTailB64 } : {}),
    // Lane A only: the shape its job machine is created at, so the backend
    // can price the run's minutes on the cloud spending screen. Lane B runs
    // on this host and has no machine to price.
    ...(machineGuest ? { machineGuest } : {}),
  });
  const delays = state === 'pending' ? [] : INGEST_RETRY_DELAYS_MS;

  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delays.length;
    try {
      const res = await fetch(STATUS_INGEST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ci-status-secret': CI_STATUS_SECRET },
        body,
        signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
      });
      if (res.ok) {
        // Worth a line: it says the ladder earned its keep, and it is the only
        // way to tell a ride-out from a status that was never in danger.
        if (attempt > 0) log(`status ingest recovered for ${label} after ${attempt + 1} attempts`);
        return;
      }
      if (res.status < 500 || last) {
        log(`status ingest failed ${res.status} for ${label}`
          + (attempt > 0 ? ` (gave up after ${attempt + 1} attempts)` : ''));
        return;
      }
      log(`status ingest ${res.status} for ${label} — retrying in ${delays[attempt] / 1000}s`);
    } catch (error) {
      // Connection refused, DNS, timeout: the shape of a backend mid-restart.
      if (last) {
        log(`status ingest error for ${label}: ${error.message}`
          + (attempt > 0 ? ` (gave up after ${attempt + 1} attempts)` : ''));
        return;
      }
      log(`status ingest error for ${label}: ${error.message} — retrying in ${delays[attempt] / 1000}s`);
    }
    await sleep(delays[attempt]);
  }
}

/** Last 64 KB of a job log, base64 — what the ingest carries for the Mini App. */
function logTailB64Of(logFile) {
  try {
    const buf = readFileSync(logFile);
    return buf.subarray(Math.max(0, buf.length - 64 * 1024)).toString('base64');
  } catch {
    return undefined;
  }
}

/**
 * Two queues, two disciplines (docs/ci-two-lane-runner.md):
 *
 * Lane B (deploys, self-update — this box) is STRICTLY SERIAL: deploys must
 * never interleave, and that has nothing to do with load — it is about the
 * hosts they touch.
 *
 * Lane A (checks — a throwaway Fly machine each) runs CONCURRENTLY up to
 * LANE_A_MAX_CONCURRENT. Those jobs never touch this box or each other, so
 * serializing them only made PR bursts queue behind strangers and made every
 * deploy wait out a remote job it shared nothing with.
 */
const queueB = [];
let runningB = false;
let runningBJob = null;
let laneBDrainTimer;
const queueA = [];
let runningA = 0;
const LANE_A_MAX = Number(process.env.LANE_A_MAX_CONCURRENT ?? 3);
const quietMs = Number(process.env.DEPLOY_PROD_QUIET_MS ?? 30_000);
const DEPLOY_PROD_QUIET_MS = Number.isFinite(quietMs) && quietMs >= 0 ? quietMs : 30_000;

/** Lane routing is a function of the job kind alone, so each kind's dupes
 *  live in exactly one queue and supersede logic needn't search both. */
function isLaneA(job) {
  return laneAConfigured() && laneARoutes(job.kind);
}

function enqueue(job) {
  const lane = isLaneA(job) ? queueA : queueB;
  const sameSlot = (candidate) => candidate.kind === job.kind && candidate.ref === job.ref;
  // Webhook delivery is at-least-once. Replaying the same event must not make
  // an active deploy run twice or make a queued job supersede itself.
  if (lane === queueB && runningBJob?.sha === job.sha && sameSlot(runningBJob)) {
    log(`ignoring duplicate running ${job.kind}@${job.sha.slice(0, 7)}`);
    return;
  }
  if (lane.some((candidate) => candidate.sha === job.sha && sameSlot(candidate))) {
    log(`ignoring duplicate queued ${job.kind}@${job.sha.slice(0, 7)}`);
    return;
  }
  // Collapse duplicates (same kind+ref): only the newest SHA of a burst
  // matters, and skipping stale ones keeps the queue short. Once one job in a
  // lane B delivery has started, however, the rest of that SHA's delivery is
  // no longer part of the burst: it is committed work. Leave those queued
  // jobs in place and let the newer delivery wait behind them. If an even
  // newer delivery arrives while it waits, its duplicate is still collapsible.
  const dup = lane.findIndex((j) => (
    sameSlot(j)
    && !(lane === queueB && runningBJob?.sha === j.sha)
  ));
  if (dup !== -1) {
    const [stale] = lane.splice(dup, 1);
    log(`superseding queued ${stale.kind}@${stale.sha.slice(0, 7)} with ${job.sha.slice(0, 7)}`);
    // What a supersede MEANS depends on the collapse key, and conflating the
    // two locked proposals shut (found 2026-08-15, three times on one change).
    //
    // A per-branch job (`ref` is the branch): a newer commit replaced this one
    // on the branch this job was going to build. This sha is stale, it will
    // never be built, and `superseded` is right — the merge gate holds it
    // because there is genuinely no verdict for it.
    //
    // A REPO-WIDE job (`repoWide`, today only the GitHub mirror): its key
    // covers every ref, so the newer run does this commit's work too — it
    // pushes every ref, this one included. Nothing about this sha is stale,
    // and filing `superseded` made a required-checks repo refuse to merge a
    // perfectly good commit, permanently, because any push to any branch by
    // anyone could take the slot. `skipped` is both truthful and passing:
    // there was nothing left for THIS job to do.
    const staleState = stale.repoWide ? 'skipped' : 'superseded';
    const staleNote = stale.repoWide
      ? 'A newer push did this job for every ref, this commit included.'
      : 'Superseded by a newer commit before running.';
    if (!stale.platform) {
      void postStatus(stale.sha, stale.context, staleState, staleNote);
    }
    trackIngest(postIngest(stale, staleState, staleNote));
    // The newest main deploy contains every earlier commit in this burst.
    // run-job's filter now diffs from what production is serving, so it sees
    // them on its own; the collapse is still remembered so a coalesced run is
    // forced outright — belt and braces, not the thing that ships the burst.
    if (lane === queueB && job.kind === 'deploy-prod' && job.ref === 'main' && !job.force) {
      job.coalesced = true;
    }
  }
  // A lane A duplicate that is already RUNNING is cancelled too — its machine
  // is destroyed and its slot freed, because a build of a sha nobody can merge
  // anymore is pure spend. Lane B never cancels: interrupting a deploy is
  // strictly worse than finishing it.
  if (isLaneA(job) && cancelLaneAJob(job.kind, job.ref)) {
    log(`cancelling running ${job.kind} ${job.ref} — superseded by ${job.sha.slice(0, 7)}`);
  }
  // A normal main deployment waits for a short quiet period. Each replacement
  // resets the deadline, turning several rapid merges into one restart. Manual
  // forced re-runs use a distinct ref and intentionally start immediately.
  if (lane === queueB && job.kind === 'deploy-prod' && job.ref === 'main'
      && !job.force && DEPLOY_PROD_QUIET_MS > 0) {
    job.notBefore = Date.now() + DEPLOY_PROD_QUIET_MS;
  }
  lane.push(job);
  log(`queued ${job.kind} ${job.ref} @ ${job.sha.slice(0, 7)} (A:${queueA.length} B:${queueB.length})`);
  void drainA();
  void drainB();
}

/**
 * Verdicts still in the air. `postIngest` is deliberately fire-and-forget at
 * most call sites — a finished job should not wait on the store to release
 * its lane — but "not awaited" and "safe to exit through" are different
 * things: `process.exit()` kills the request mid-flight, the store keeps the
 * 'pending' row the job STARTED with, and the Mini App shows a job that
 * passed minutes ago as still running, forever, with a ticking clock.
 *
 * That is exactly what happened to ci/checks on 0aec229 (2026-08-14): the
 * verdict POST and the self-update exit were FIVE MILLISECONDS apart, and the
 * pip never went green on a run that exited 0.
 *
 * So the counter, not an await at each call site: one invariant — the daemon
 * does not exit while a verdict is in flight — that a future fire-and-forget
 * ingest inherits for free. Bounded: postIngest's ladder tops out around 112s
 * and it never throws, so this can delay a restart, never block it.
 */
let ingestsInFlight = 0;
function trackIngest(promise) {
  ingestsInFlight += 1;
  void promise.finally(() => {
    ingestsInFlight -= 1;
    maybeRestart();
  });
}

/**
 * The self-update restart, honored only when BOTH lanes are fully idle: a
 * self-update job that replaced daemon.mjs leaves this flag, and exiting
 * cleanly IS the restart (systemd has Restart=always). Waiting for idle means
 * nothing already accepted — queued or mid-machine — is dropped.
 */
function maybeRestart() {
  if (queueA.length || queueB.length || runningA || runningB) return;
  if (ingestsInFlight) return;
  if (!existsSync(RESTART_FLAG)) return;
  try {
    rmSync(RESTART_FLAG);
  } catch { /* best effort: a stale flag would only cost one extra restart */ }
  log('daemon.mjs was updated — exiting so systemd restarts on the new code');
  process.exit(0);
}

function logFileFor(job) {
  return path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${job.kind}-${job.sha.slice(0, 7)}.log`);
}

/** Untrusted lane: fill free machine slots. Each job settles independently. */
function drainA() {
  while (runningA < LANE_A_MAX && queueA.length > 0) {
    const job = queueA.shift();
    runningA += 1;
    void runOneLaneA(job).finally(() => {
      runningA -= 1;
      maybeRestart();
      void drainA();
    });
  }
}

async function runOneLaneA(job) {
  const logFile = logFileFor(job);
  // Platform jobs have no GitHub side: their sha exists only on our git
  // host, and their statuses live in the backend's store alone.
  const creds = job.platform
    ? await platformCloneCreds(job)
    : { cloneToken: TOKEN, repoUrl: `https://github.com/${REPO}.git` };
  if (creds.error) {
    log(`no clone credentials for ${job.repo?.owner}/${job.repo?.name} — ${job.kind} @ ${job.sha.slice(0, 7)} dropped`);
    trackIngest(postIngest(job, 'error', `Could not obtain a clone token: ${creds.error}. Push again to re-run.`));
    return;
  }
  // Owner-granted secrets, protected-branch runs only — `{}` everywhere else.
  // And, on a repository linked to a site, the key that publishes it.
  const { secrets, publish } = job.platform ? await platformCiSecrets(job) : { secrets: {}, publish: null };
  // Its own check on the same sha (`deploy/<site>`), filed pending NOW so a
  // `repo checks --wait` after a merge waits for the publish too, rather
  // than settling the moment ci/checks does.
  const publishJob = publish ? { ...job, context: `deploy/${publish.site}` } : null;
  if (!job.platform) {
    await postStatus(job.sha, job.context, 'pending', `Running in an ephemeral VM → ${path.basename(logFile)}`);
  }
  if (publishJob) void postIngest(publishJob, 'pending', `Publishes ${publish.site} once the checks pass`);
  void postIngest(job, 'pending', 'Running in an ephemeral VM', undefined, GUEST);
  log(`start ${job.kind} @ ${job.sha.slice(0, 7)} → lane A (${logFile})${publish ? ` — publishes ${publish.site} on success` : ''}`);
  const result = await runLaneAJob(job, { ...creds, secrets, publish, log });
  if (result.logTail) appendFileSync(logFile, result.logTail);
  if (result.publish?.logTail) appendFileSync(logFile, `\n=== publish ===\n${result.publish.logTail}`);
  if (!job.platform) {
    // postStatus maps the states GitHub has no word for; the ingest below
    // carries the real one (same as lane B).
    await postStatus(job.sha, job.context, result.state, result.description);
  }
  // The publish verdict first: a wait that sees ci/checks settle should
  // find deploy/<site> already settled beside it, never still pending.
  if (publishJob) {
    // Never left pending: a run that came back without its publish verdict
    // still says the site was not published, rather than going red at the
    // stale-pending horizon half an hour later with no reason given.
    const published = result.publish
      ?? { state: 'error', description: `Not published — the run did not report on ${publish.site}`, logTail: '' };
    await postIngest(publishJob, published.state, published.description,
      published.logTail ? Buffer.from(published.logTail).toString('base64') : undefined);
  }
  trackIngest(postIngest(job, result.state, result.description,
    result.logTail ? Buffer.from(result.logTail).toString('base64') : undefined, GUEST));
}

/** Trusted lane: one at a time, on this box. */
function jobFinished() {
  runningB = false;
  runningBJob = null;
  maybeRestart();
  void drainB();
}

async function drainB() {
  if (runningB) return;
  const job = queueB[0];
  if (!job) return;
  if (job.notBefore && job.notBefore > Date.now()) {
    scheduleLaneBDrain(job.notBefore);
    return;
  }
  if (laneBDrainTimer) {
    clearTimeout(laneBDrainTimer);
    laneBDrainTimer = undefined;
  }
  queueB.shift();
  runningB = true;
  runningBJob = job;
  const logFile = logFileFor(job);

  // Platform jobs (today: the mirror) have no GitHub side to post to — their
  // sha reaches GitHub only when the mirror job itself succeeds.
  if (!job.platform) {
    await postStatus(job.sha, job.context, 'pending', `Running on ${process.env.CI_HOST_LABEL || 'ia-ci-runner'} → ${path.basename(logFile)}`);
  }
  // Lane A files a pending the moment it starts; lane B used to file nothing
  // until its verdict, so for the minutes a deploy ran the Mini App had no row
  // for it at all — and then it appeared already green. A deploy is the check
  // most worth watching while it happens, and it was the only one you could not.
  //
  // AWAITED, like the GitHub post above it, for the reason `pending` is denied
  // the retry ladder (see postIngest): the store upserts on (sha, context) with
  // last write winning, so a spinner that lands after its own verdict turns a
  // finished check into one that spins forever. Nothing below starts until this
  // settles, so those two posts cannot invert. It costs the job one failed POST
  // of latency (15s at worst, no ladder) on a backend that is already sick.
  await postIngest(job, 'pending', `Running on ${process.env.CI_HOST_LABEL || 'ia-ci-runner'}`);
  log(`start ${job.kind} @ ${job.sha.slice(0, 7)} → ${logFile}`);
  const started = Date.now();
  const child = spawn('bash', [SCRIPT, job.kind, job.sha], {
    // IA_FORCE_JOB tells a job to skip its own "did the relevant paths change
    // since I last shipped?" filter. A dispatch needs it because the trigger
    // was outside the repo; a coalesced deploy is forced as a second guarantee
    // that a burst ships (the filter's range already covers it).
    env: { ...process.env, CI: 'true', ...((job.force || job.coalesced) ? { IA_FORCE_JOB: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const write = (chunk) => appendFileSync(logFile, chunk);
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('close', (code) => {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    // 78 is the "skipped" convention (BSD EX_NOPERM territory is long dead;
    // GitHub Actions' neutral exit was 78 too): the job looked at everything
    // since it last shipped and found nothing to do. GitHub's status API has no such state, so
    // it gets success-with-honest-words there; the platform ingest carries
    // the real 'skipped' and the Mini App renders it grey, not green.
    const skipped = code === 78;
    const ok = code === 0 || skipped;
    log(`done ${job.kind} @ ${job.sha.slice(0, 7)}: ${skipped ? 'skipped' : ok ? 'success' : `exit ${code}`} in ${mins}m`);
    const description = skipped ? 'Skipped — nothing this job deploys changed since it last shipped'
      : ok ? `Passed in ${mins}m on ${process.env.CI_HOST_LABEL || 'ia-ci-runner'}`
        : `Failed (exit ${code}) in ${mins}m — log: ${path.basename(logFile)}`;
    trackIngest(postIngest(job, skipped ? 'skipped' : ok ? 'success' : 'failure', description,
      ok ? undefined : logTailB64Of(logFile)));
    if (job.platform) {
      jobFinished();
      return;
    }
    void postStatus(job.sha, job.context, ok ? 'success' : 'failure', description)
      .finally(jobFinished);
  });
}

/** Wake lane B at the current head job's deadline, replacing any stale timer. */
function scheduleLaneBDrain(notBefore) {
  if (laneBDrainTimer) clearTimeout(laneBDrainTimer);
  laneBDrainTimer = setTimeout(() => {
    laneBDrainTimer = undefined;
    void drainB();
  }, Math.max(0, notBefore - Date.now()));
  laneBDrainTimer.unref();
}

/**
 * Remote builds for lane B deploys (docs/platform-on-own-git.md → "the
 * controller stops executing repo code"). A running deploy job asks this
 * daemon — over localhost only, run-job.sh is the single caller — to build
 * its artifact on a throwaway lane A machine; the machine pushes the tarball
 * to /job-artifact (per-job HMAC over its sha256), and the deploy polls
 * /build/<id> until it can extract and release. Builds bypass the lane A
 * QUEUE on purpose: lane B is serial and is BLOCKED inside the very job that
 * is asking, so a build queued behind that job's own lane would deadlock
 * nothing but still steal a checks slot; a separate two-slot cap keeps a
 * build burst from starving checks instead.
 */
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? '/home/runner/ci-artifacts';
const ARTIFACT_MAX_BYTES = Number(process.env.ARTIFACT_MAX_BYTES ?? 512 * 1024 * 1024);
const BUILD_KINDS = new Set(['build-backend', 'build-site']);
const BUILD_MAX = 2;
/** buildId → { state: 'running'|'success'|'failure'|'error', description,
 *  artifactPath, logTail, startedAt } */
const builds = new Map();
let runningBuilds = 0;

// A daemon start has no pending jobs, so anything here is an orphan of a
// previous life. Sweep the dir now and each entry two hours after it settles.
mkdirSync(ARTIFACT_DIR, { recursive: true });
rmSync(ARTIFACT_DIR, { recursive: true, force: true });
mkdirSync(ARTIFACT_DIR, { recursive: true });

function handleBuildRequest(payload) {
  const kind = String(payload?.kind ?? '');
  const sha = String(payload?.sha ?? '');
  if (!BUILD_KINDS.has(kind) || !/^[0-9a-f]{40}$/.test(sha)) {
    return { code: 400, body: { error: `bad build request: ${kind}` } };
  }
  if (!laneAConfigured()) return { code: 503, body: { error: 'lane A not configured' } };
  if (runningBuilds >= BUILD_MAX) return { code: 429, body: { error: 'build slots busy' } };
  const buildId = `${kind}-${sha.slice(0, 7)}-${randomBytes(4).toString('hex')}`;
  const entry = { state: 'running', description: '', artifactPath: null, logTail: '', startedAt: Date.now() };
  builds.set(buildId, entry);
  runningBuilds += 1;
  log(`build ${buildId} started (lane A)`);
  const secrets = {};
  // A deploy build fetches the sha the deploy is FOR — and once the platform
  // host is the source of truth, a fresh main merge reaches GitHub only when
  // the mirror job (queued LAST) pushes it. Building from the mirror is a
  // race the build loses every time (2026-08-14: deploy-prod and deploy-site
  // both died "not our ref" on a sha the mirror hadn't landed yet). Armed,
  // fetch from our host with the recovery token; unarmed, GitHub still IS
  // the source of truth.
  const creds = process.env.PLATFORM_REPO && RECOVERY_GIT_TOKEN
    ? { cloneToken: RECOVERY_GIT_TOKEN, repoUrl: `${PLATFORM_GIT_BASE}/${process.env.PLATFORM_REPO}.git` }
    : { cloneToken: TOKEN, repoUrl: `https://github.com/${REPO}.git` };
  void runLaneAJob(
    { kind, sha, ref: buildId, context: `build/${kind}` },
    {
      ...creds,
      secrets,
      log,
      artifactDir: ARTIFACT_DIR,
    },
  ).then((result) => {
    // A build artifact is either produced or it is not: 'skipped' and
    // 'superseded' both mean no artifact exists, so a deploy must not read
    // them as something it can ship.
    entry.state = ['skipped', 'superseded'].includes(result.state) ? 'error' : result.state;
    entry.description = result.description;
    entry.artifactPath = result.artifactPath ?? null;
    entry.logTail = result.logTail ?? '';
    log(`build ${buildId}: ${entry.state}`);
  }).catch((error) => {
    entry.state = 'error';
    entry.description = String(error?.message ?? error).slice(0, 140);
    log(`build ${buildId} threw: ${entry.description}`);
  }).finally(() => {
    runningBuilds -= 1;
    // The consumer deletes the artifact file it extracted; this collects the
    // record and any file nobody came back for (a deploy killed mid-poll).
    setTimeout(() => {
      const stale = builds.get(buildId);
      if (stale?.artifactPath) rmSync(stale.artifactPath, { force: true });
      builds.delete(buildId);
    }, 2 * 60 * 60 * 1000).unref();
  });
  return { code: 202, body: { buildId } };
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * A build machine delivering its tarball. Streamed to a temp file, hashed as
 * it lands, capped — then lane-a verifies the per-job HMAC over the digest
 * and renames it into place. Public route: auth is the per-job token, same
 * as /job-result, and the pre-flight check refuses to spool bytes for a job
 * nobody is waiting on.
 */
function handleArtifactUpload(req, res) {
  const jobId = String(req.headers['x-ia-job-id'] ?? '');
  if (!artifactJobPending(jobId) || !/^[A-Za-z0-9-]+$/.test(jobId)) {
    req.resume();
    res.writeHead(404).end('no such pending job');
    return;
  }
  const tmpPath = path.join(ARTIFACT_DIR, `.${jobId}.part`);
  const hash = createHash('sha256');
  const out = createWriteStream(tmpPath, { mode: 0o600 });
  let size = 0;
  let failed = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > ARTIFACT_MAX_BYTES) {
      failed = true;
      req.destroy();
      out.destroy();
      rmSync(tmpPath, { force: true });
      log(`artifact for ${jobId} over ${ARTIFACT_MAX_BYTES} bytes — refused`);
      return;
    }
    hash.update(chunk);
    out.write(chunk);
  });
  req.on('error', () => {
    failed = true;
    out.destroy();
    rmSync(tmpPath, { force: true });
  });
  req.on('end', () => {
    if (failed) return;
    out.end(() => {
      const outcome = acceptArtifact({
        jobId,
        computedSha256: hash.digest('hex'),
        claimedSha256: String(req.headers['x-ia-artifact-sha256'] ?? ''),
        signatureHeader: req.headers['x-ia-artifact-signature'],
        tmpPath,
        artifactDir: ARTIFACT_DIR,
      });
      if (!outcome.ok) log(`artifact for ${jobId} rejected: ${outcome.error}`);
      else log(`artifact for ${jobId} accepted (${size} bytes)`);
      res.writeHead(outcome.status).end(outcome.ok ? 'ok' : outcome.error);
    });
  });
}

/**
 * Drive on the escape road (docs/platform-on-own-git.md): once a DAY, clone
 * the platform repo using the RECOVERY token and nothing else, and report
 * through the backup heartbeat. The break-glass path must rot on a boring
 * Tuesday — where a red alert fixes it — not during the outage it exists
 * for. Daily rather than the doc's "weekly is enough" because daily needs no
 * backend change at all: the staleness monitor's default 48h rule covers a
 * daily job the same way it covers the nightly backups (its job list is the
 * BACKUP_MONITOR_JOBS env). A failed drill reports `fail`, which the monitor
 * deliberately does not count as life — two bad days in a row alert.
 *
 * All four env values or the drill stays off:
 *   RECOVERY_GIT_TOKEN       the break-glass token itself
 *   RECOVERY_DRILL_URL       the platform repo's clone URL on our host
 *   BACKUP_HEARTBEAT_URL     same pair the backup jobs use
 *   BACKUP_HEARTBEAT_SECRET
 */
const RECOVERY_GIT_TOKEN = process.env.RECOVERY_GIT_TOKEN ?? '';
const RECOVERY_DRILL_URL = process.env.RECOVERY_DRILL_URL ?? '';
const HEARTBEAT_URL = process.env.BACKUP_HEARTBEAT_URL ?? '';
const HEARTBEAT_SECRET = process.env.BACKUP_HEARTBEAT_SECRET ?? '';
const DRILL_STAMP = path.join(path.dirname(SCRIPT), '.recovery-drill-last');
const DRILL_EVERY_MS = 24 * 60 * 60_000;

function recoveryDrillConfigured() {
  return Boolean(RECOVERY_GIT_TOKEN && RECOVERY_DRILL_URL && HEARTBEAT_URL && HEARTBEAT_SECRET);
}

/** Due when the stamp is absent, unparseable, or a day old. The stamp marks
 *  ATTEMPTS, not successes — a broken drill must not retry hourly forever;
 *  the monitor's success clock is what a failure leaves unrefreshed. */
function recoveryDrillDue(stampIso, nowMs) {
  const last = Date.parse(String(stampIso ?? ''));
  return !Number.isFinite(last) || nowMs - last >= DRILL_EVERY_MS;
}

async function postHeartbeat(job, status, detail) {
  try {
    const res = await fetch(HEARTBEAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-backup-heartbeat-secret': HEARTBEAT_SECRET },
      body: JSON.stringify({ job, status, detail: String(detail ?? '').slice(0, 500) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log(`recovery drill heartbeat refused: ${res.status}`);
  } catch (error) {
    // The monitor exists to notice silence; a failed report becomes exactly
    // the silence it notices. Nothing more to do here.
    log(`recovery drill heartbeat failed: ${error.message}`);
  }
}

async function runRecoveryDrill() {
  const started = Date.now();
  // Token as DATA in a 0600 netrc under a throwaway HOME — never argv, where
  // `ps` and error messages would print it.
  const home = mkdtempSync(path.join(tmpdir(), 'recovery-drill-'));
  try {
    const host = new URL(RECOVERY_DRILL_URL).host;
    writeFileSync(path.join(home, '.netrc'),
      `machine ${host} login x-access-token password ${RECOVERY_GIT_TOKEN}\n`, { mode: 0o600 });
    const clone = path.join(home, 'clone');
    const code = await new Promise((resolve) => {
      const child = spawn('git', ['clone', '-q', '--depth', '1', RECOVERY_DRILL_URL, clone], {
        env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      child.on('close', (exit) => resolve({ exit, err }));
      setTimeout(() => child.kill('SIGKILL'), 10 * 60_000).unref();
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    if (code.exit === 0) {
      const head = spawnHeadSha(clone);
      log(`recovery drill: cloned ${head.slice(0, 7)} in ${seconds}s with the break-glass token`);
      await postHeartbeat('recovery-drill', 'ok', `cloned ${head.slice(0, 7)} in ${seconds}s`);
    } else {
      // The stderr tail, minus any URL line that could carry credentials —
      // ours never do (netrc), but the rule costs nothing.
      const tail = String(code.err).split('\n').filter((l) => !l.includes('://')).slice(-3).join(' ').slice(0, 300);
      log(`recovery drill FAILED (exit ${code.exit}): ${tail}`);
      await postHeartbeat('recovery-drill', 'fail', `clone exit ${code.exit}: ${tail}`);
    }
  } catch (error) {
    log(`recovery drill errored: ${error.message}`);
    await postHeartbeat('recovery-drill', 'fail', String(error.message ?? error).slice(0, 300));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function spawnHeadSha(clone) {
  try {
    return execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

if (recoveryDrillConfigured()) {
  const check = () => {
    let stamp = '';
    try {
      stamp = readFileSync(DRILL_STAMP, 'utf8').trim();
    } catch { /* first run */ }
    if (!recoveryDrillDue(stamp, Date.now())) return;
    try {
      writeFileSync(DRILL_STAMP, new Date().toISOString());
    } catch (error) {
      log(`cannot stamp the recovery drill (${error.message}) — skipping rather than looping`);
      return;
    }
    void runRecoveryDrill();
  };
  // A couple of minutes after boot rather than immediately: deploys restart
  // this daemon, and the stamp already makes the check idempotent — the
  // delay just keeps drill traffic out of the restart's busiest moment.
  setTimeout(check, 2 * 60_000).unref();
  setInterval(check, 60 * 60_000).unref();
  log(`recovery drill armed: daily clone of ${new URL(RECOVERY_DRILL_URL).pathname} with the break-glass token`);
}

/**
 * Jobs that can be asked for outside a push. Only the image build: it is the
 * one whose input lives OUTSIDE the repo (the CLI pin in the backend's config
 * store), so a pin bump has to be able to say "rebuild" without a commit.
 * Everything else is a function of a SHA and already runs when that SHA lands.
 */
// deploy-prod / deploy-site joined 2026-08-14: a deploy that fails for a
// transient reason (the mirror race, a host briefly down) had no sanctioned
// re-run short of SSHing into this box and running run-job.sh by hand. A
// dispatch rebuilds main's HEAD — same guardrails as a push, minus the commit.
// copy-release-gate joined 2026-11-05 (note #1008): the offer gate again, for a release already built.
const DISPATCHABLE = new Set(['machine-image', 'git-host-image', 'msg-host-image', 'copy-release', 'copy-release-gate', 'deploy-prod', 'deploy-site']);

/** Head SHA of a branch — a dispatched job builds the same code a push would. */
async function resolveHeadSha(ref) {
  // Armed = our host is the source of truth, so a dispatch must build what
  // OUR main says, not what the mirror last managed to copy. ls-remote with
  // the recovery token (read-only, this one repo — resolving a ref is
  // exactly its job description), netrc under a throwaway HOME.
  if (process.env.PLATFORM_REPO && RECOVERY_GIT_TOKEN) {
    const url = `${PLATFORM_GIT_BASE}/${process.env.PLATFORM_REPO}.git`;
    const home = mkdtempSync(path.join(tmpdir(), 'resolve-ref-'));
    try {
      writeFileSync(path.join(home, '.netrc'),
        `machine ${new URL(url).host} login x-access-token password ${RECOVERY_GIT_TOKEN}\n`, { mode: 0o600 });
      const out = execFileSync('git', ['ls-remote', url, `refs/heads/${ref}`], {
        encoding: 'utf8', env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000,
      });
      const sha = out.split(/\s+/)[0];
      if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`no branch ${ref} on ${process.env.PLATFORM_REPO}`);
      return sha;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ia-ci-daemon',
    },
  });
  if (!res.ok) throw new Error(`could not resolve ${ref}: HTTP ${res.status}`);
  const sha = (await res.json()).sha;
  if (!sha) throw new Error(`no sha for ${ref}`);
  return sha;
}

async function handleDispatch(payload) {
  const kind = payload.kind;
  if (!DISPATCHABLE.has(kind)) {
    return { code: 400, body: `not dispatchable: ${kind ?? '(none)'}` };
  }
  const ref = payload.ref ?? 'main';
  const sha = await resolveHeadSha(ref);
  // `force` because the path filter is the wrong question here: nothing in the
  // repo changed, the PIN did (or a transient failure needs the same sha run
  // again). Distinct `ref` so a dispatch and a push-triggered build never
  // supersede one another in the queue.
  //
  // The context must match what a push files — 'deploy/prod', never
  // 'deploy/deploy-prod' — or the re-run writes a NEW pip beside the failed
  // one instead of turning it green. And when armed, a dispatch is a platform
  // job like the push it re-runs: its status belongs in the backend's store,
  // and its sha may not have reached the GitHub mirror at all.
  const armed = process.env.PLATFORM_REPO ?? '';
  const [pOwner, pName] = armed.split('/');
  enqueue({
    kind,
    ref: `dispatch-${kind}`,
    sha,
    context: `deploy/${kind.replace(/^deploy-/, '')}`,
    force: true,
    ...(armed && pOwner && pName ? { platform: true, repo: { owner: pOwner, name: pName } } : {}),
  });
  return { code: 202, body: `${kind} queued @ ${sha.slice(0, 7)} (forced)` };
}

/**
 * Repo identity from the DELIVERY, not the REPO constant: GitHub sends
 * `repository.owner.login`, our git host's post-receive sends
 * `repository.owner` (the platform userId) — and carrying it on the job is
 * what lets a status be filed against the right repo in the backend's store.
 */
function repoOf(payload) {
  const r = payload.repository;
  if (!r?.name) return null;
  const owner = typeof r.owner === 'string' ? r.owner : (r.owner?.login ?? r.owner?.name ?? null);
  return owner ? { owner, name: r.name } : null;
}

function handleEvent(event, payload, { platform = false } = {}) {
  if (event === 'ping') return 'pong';
  const repo = repoOf(payload);
  const q = (job) => enqueue({ ...job, ...(repo ? { repo } : {}) });
  // A platform repo's push gets exactly one job: its own committed
  // `.agentbuilt/ci.sh`, on a throwaway machine, for EVERY branch — the push
  // that creates a proposal branch is what puts a pip on the proposal card,
  // so no separate pull_request delivery is needed. Nothing here may reach
  // lane B: deploys, self-update and the GitHub-repo branch rules below are
  // ours alone.
  if (platform) {
    if (event !== 'push') return `platform ${event} — ignored`;
    const sha = payload.after;
    if (!sha || /^0+$/.test(sha)) return 'branch deleted — ignored';
    if (!repo) return 'platform push without repository — ignored';
    if (!laneAConfigured()) return 'platform push — lane A not configured, ignored';
    const branch = payload.ref?.replace('refs/heads/', '') ?? '?';
    q({
      kind: 'ci-script',
      ref: `${repo.owner}/${repo.name}#${branch}`,
      // The plain branch name too: the secrets ask needs the ref as the git
      // host spells it, not this queue's collapse key.
      branch,
      sha,
      context: 'ci/checks',
      platform: true,
    });
    // After the flip (docs/platform-on-own-git.md step 4): THE platform repo
    // is one of the repos on our host, and its pushes carry the deploys that
    // GitHub's used to. The env is the arming switch — the payload never
    // decides trust — and until it is set none of this queues anything.
    if (process.env.PLATFORM_REPO && `${repo.owner}/${repo.name}` === process.env.PLATFORM_REPO) {
      if (branch === 'main') {
        // The same set, same order and same contexts as the GitHub main path
        // below — self-update first so a ci-runner fix reaches the very push
        // that merged it. `platform: true` on every one: their statuses live
        // in the backend's store (the Mini App), and their sha reaches
        // GitHub only when the mirror lands it there.
        q({ kind: 'self-update', ref: 'main-selfupdate', sha, context: 'ci/self-update', platform: true });
        q({ kind: 'deploy-prod', ref: 'main', sha, context: 'deploy/prod', platform: true });
        q({ kind: 'deploy-site', ref: 'main-site', sha, context: 'deploy/site', platform: true });
        q({ kind: 'deploy-git-host', ref: 'main-git-host', sha, context: 'deploy/git-host', platform: true });
        q({ kind: 'deploy-db-backup', ref: 'main-db-backup', sha, context: 'deploy/db-backup', platform: true });
        q({ kind: 'machine-image', ref: 'main-image', sha, context: 'deploy/machine-image', platform: true });
      q({ kind: 'git-host-image', ref: 'main-git-host-image', sha, context: 'deploy/git-host-image', platform: true });
        q({ kind: 'msg-host-image', ref: 'main-msg-host-image', sha, context: 'deploy/msg-host-image', platform: true });
        // A private-copy release (note #811). Self-skips unless
        // infra/copy-release/VERSION changed: a release is cut on purpose.
        q({ kind: 'copy-release', ref: 'main-copy-release', sha, context: 'deploy/copy-release', platform: true });
      }
      // Every ref move refreshes the read-only GitHub mirror. One collapse
      // key for the whole repo: mirroring pushes every ref anyway, so only
      // the newest run of a burst matters. `repoWide` says exactly that to
      // the supersede path — a newer run covers this commit rather than
      // replacing it, so losing the slot must not read as an unbuilt sha.
      q({
        kind: 'mirror-github', ref: 'platform-mirror', sha,
        context: 'deploy/mirror-github', platform: true, repoWide: true,
      });
      return `platform ${repo.owner}/${repo.name} ${branch}: ci-script + platform pipeline queued`;
    }
    return `platform ${repo.owner}/${repo.name} ${branch}: ci-script queued`;
  }
  // Once the platform repo lives on our host, GitHub is a read-only copy the
  // mirror job itself pushes to — and every one of those pushes fires this
  // webhook. Without this gate the mirror's own delivery would queue a second
  // full deploy of a sha that just deployed: an echo, not an event.
  if (process.env.PLATFORM_REPO && (event === 'push' || event === 'pull_request')) {
    return `${event} from GitHub ignored — the platform repo lives on our git host; GitHub is the mirror`;
  }
  if (event === 'push') {
    const branch = payload.ref?.replace('refs/heads/', '');
    const sha = payload.after;
    if (!sha || /^0+$/.test(sha)) return 'branch deleted — ignored';
    if (branch === 'main') {
      // First, so a fix to this directory takes effect for the very push that
      // merged it: run-job.sh is spawned per job, so the jobs queued below
      // already run the new copy. Self-skips when no ci-runner file changed.
      q({ kind: 'self-update', ref: 'main-selfupdate', sha, context: 'ci/self-update' });
      q({ kind: 'checks', ref: 'push-main', sha, context: 'ci/checks' });
      q({ kind: 'deploy-prod', ref: 'main', sha, context: 'deploy/prod' });
      // Site and backend ship from the same push, so the live pages never
      // advertise a model the live backend doesn't run (mirrors the frozen
      // deploy-cloudflare.yml, which also fired on every main push).
      q({ kind: 'deploy-site', ref: 'main-site', sha, context: 'deploy/site' });
      // The git host is on ANOTHER box (ia-media) and had no pipeline at all
      // until this: every change to it was a file copied by hand, which is how
      // a root-owned 0600 scp took every user's clones and pushes down for ~30s
      // on 2026-08-11. Lane B by definition — it holds the key to that box.
      // Self-skips when the commit touched no git-host file, like the two above.
      q({ kind: 'deploy-git-host', ref: 'main-git-host', sha, context: 'deploy/git-host' });
      // The database's own off-box backup, on ia-backend rather than ia-media.
      // Its own lane and not part of deploy-prod, even though it is the same
      // box: deploy-prod ships the backend, and a backup job that fails to
      // install must not roll back a release — nor a bad release take the
      // backups down with it. Self-skips when no db-backup file changed.
      q({ kind: 'deploy-db-backup', ref: 'main-db-backup', sha, context: 'deploy/db-backup' });
      // Queued on every main push and self-skipping when the commit touched no
      // machine-image file — the same shape as deploy-prod's backend filter.
      // It runs last on purpose: it is the slowest job (docker build + a boot
      // smoke test) and the only one whose effect is on machines not yet
      // created, so nothing waits behind it.
      q({ kind: 'machine-image', ref: 'main-image', sha, context: 'deploy/machine-image' });
      // The git-host image for client-org machines (byo-git-design slice 2).
      // Self-skips unless infra/git-host{,-image} changed; a green build
      // repoints production's FLY_GIT_HOST_IMAGE at itself (note #809).
      q({ kind: 'git-host-image', ref: 'main-git-host-image', sha, context: 'deploy/git-host-image' });
      // The messaging-host image (note #608). Self-skips unless
      // infra/msg-host{,-image} changed; a green build repoints production's
      // FLY_MSG_HOST_IMAGE at itself (note #819).
      q({ kind: 'msg-host-image', ref: 'main-msg-host-image', sha, context: 'deploy/msg-host-image' });
      // A private-copy release (note #811), cut only when VERSION changes.
      q({ kind: 'copy-release', ref: 'main-copy-release', sha, context: 'deploy/copy-release' });
      return 'main: checks + deploys queued';
    }
    return `push to ${branch} — ignored`;
  }
  if (event === 'pull_request') {
    const action = payload.action;
    if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action)) {
      return `pr ${action} — ignored`;
    }
    const base = payload.pull_request?.base?.ref;
    if (base !== 'main') return `pr into ${base} — ignored`;
    const sha = payload.pull_request.head.sha;
    q({ kind: 'checks', ref: `pr-${payload.number}`, sha, context: 'ci/checks' });
    return `pr #${payload.number}: checks queued`;
  }
  return `${event} — ignored`;
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end(JSON.stringify({
      ok: true,
      // The original two fields keep their meaning for anything already
      // reading them; the per-lane split is the useful view now.
      queued: queueA.length + queueB.length,
      running: runningB || runningA > 0,
      laneA: { queued: queueA.length, running: runningA, max: LANE_A_MAX },
      laneB: { queued: queueB.length, running: runningB },
    }));
    return;
  }
  // Build status for a waiting deploy — localhost only, like the request
  // that started it: the caller is run-job.sh on this same box, and nothing
  // outside it has any business reading build state.
  if (req.method === 'GET' && req.url?.startsWith('/build/')) {
    if (!isLocalRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    const entry = builds.get(req.url.slice('/build/'.length));
    if (!entry) {
      res.writeHead(404).end(JSON.stringify({ error: 'no such build' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      state: entry.state,
      description: entry.description,
      ...(entry.artifactPath ? { artifact: entry.artifactPath } : {}),
      ...(entry.state === 'failure' || entry.state === 'error'
        ? { logTailB64: Buffer.from(entry.logTail ?? '').toString('base64') }
        : {}),
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/job-artifact') {
    // Streamed, never buffered — artifacts run to hundreds of MB.
    handleArtifactUpload(req, res);
    return;
  }
  const isWebhook = req.url === '/webhook';
  const isDispatch = req.url === '/dispatch';
  const isJobResult = req.url === '/job-result';
  const isBuild = req.url === '/build';
  if (req.method !== 'POST' || (!isWebhook && !isDispatch && !isJobResult && !isBuild)) {
    res.writeHead(404).end();
    return;
  }
  if (isBuild && !isLocalRequest(req)) {
    res.writeHead(403).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (isBuild) {
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: 'bad json' }));
        return;
      }
      const { code, body: outcome } = handleBuildRequest(payload);
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(outcome));
      return;
    }
    if (isJobResult) {
      // A lane A machine reporting in. NOT the webhook secret: each job
      // carries its own single-use HMAC key, minted at machine create, so a
      // hostile job can report only itself (lane-a.mjs verifies).
      const outcome = handleJobResult(body.toString('utf8'), req.headers['x-ia-job-signature']);
      if (!outcome.ok) log(`job-result rejected: ${outcome.error}`);
      res.writeHead(outcome.status).end(outcome.ok ? 'ok' : outcome.error);
      return;
    }
    // Two senders, one auth story: GitHub signs as x-hub-signature-256, our
    // own git host's post-receive hook as x-agentgit-signature-256. Same
    // algorithm and same shared secret, so accepting both costs nothing and
    // lets the repo move hosts without a flag day.
    const signature = req.headers['x-hub-signature-256'] ?? req.headers['x-agentgit-signature-256'];
    if (!verifySignature(body, signature)) {
      log('rejected: bad signature');
      res.writeHead(401).end('bad signature');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    // Same secret, same HMAC, same header as the GitHub webhook — one auth
    // story for the whole listener, and nothing new to rotate.
    if (isDispatch) {
      handleDispatch(payload)
        .then(({ code, body: outcome }) => {
          log(`dispatch: ${outcome}`);
          res.writeHead(code).end(outcome);
        })
        .catch((error) => {
          log(`dispatch failed: ${error.message}`);
          res.writeHead(502).end(error.message);
        });
      return;
    }
    const event = req.headers['x-github-event'] ?? req.headers['x-agentgit-event'];
    // Which header carried the event decides the routing table: our git
    // host's deliveries build the pushed repo, GitHub's build ours. The
    // header is inside the same HMAC trust as the payload — both senders
    // hold the secret, and neither imitates the other.
    const outcome = handleEvent(event, payload, {
      platform: Boolean(req.headers['x-agentgit-event']),
    });
    log(`event ${event}: ${outcome}`);
    res.writeHead(202).end(outcome);
  });
}).listen(PORT, () => log(`ia-ci-daemon listening on :${PORT} for ${REPO}`));
