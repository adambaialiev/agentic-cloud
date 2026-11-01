/**
 * Lane A: one ephemeral Fly machine per untrusted job
 * (docs/ci-two-lane-runner.md). This module is the dispatcher's side of the
 * split: create the machine, hand it runner-agent.sh, wait for the signed
 * result, destroy the machine no matter what.
 *
 * The security property this file exists for: the machine receives NO
 * platform credential beyond a read token for the one repo it builds and a
 * per-job HMAC key that can sign exactly one result. FLY_API_TOKEN, the
 * deploy key, and every other secret in /etc/ia-ci/env stay on the box that
 * never runs `npm ci` on the code under test.
 *
 * Config (all in /etc/ia-ci/env, all optional — lane A quietly disables
 * itself when unset and checks fall back to the local run-job.sh path):
 *   FLY_API_TOKEN     already present for the machine-image job
 *   LANE_A_APP        Fly app holding job machines, e.g. ia-ci-jobs
 *   LANE_A_IMAGE      image ref, e.g. registry.fly.io/ia-machine-images:sha-…
 *   LANE_A_REGION     default ams
 *   LANE_A_RESULT_URL this daemon's public /job-result URL
 *   LANE_A_TIMEOUT_MS hard wall-clock kill, default 30 minutes
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLY_API = 'https://api.machines.dev/v1';
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? '';
const APP = process.env.LANE_A_APP ?? '';
const REGION = process.env.LANE_A_REGION ?? 'ams';
// One retry, elsewhere: the sandbox client's experience is that a region
// declining a machine is a transient worth exactly one hop, and a spuriously
// red PR check costs more than a second create call.
const FALLBACK_REGION = process.env.LANE_A_FALLBACK_REGION ?? 'fra';
const RESULT_URL = process.env.LANE_A_RESULT_URL ?? '';
// The wall clock is an abuse backstop, not a budget an honest run should brush
// against. Our own checks take ~5 min on a quiet shared-4x host and took
// 13.6 min on a busy one (2026-09-04) — same tree, same steps, ~3x slower on
// stolen CPU — and the very next push was killed at 15.0 min with nothing
// red. Thirty minutes keeps 2x headroom over the worst run seen and still
// ends a runaway job well inside the hour. A suite that honestly needs more
// is a suite to shrink, not a clock to raise again.
const TIMEOUT_MS = Number(process.env.LANE_A_TIMEOUT_MS ?? 30 * 60_000);
// What a job machine is. Phase 0 (2026-08-11) measured shared-2x-2048 failing
// the suite on speed alone — a 5 s test timeout brotli-compressing the Mini
// App page, backend tests 190 s against ~48 s on real cores — so shared-4x-4096
// became the floor, and production later ran performance-4x-8192.
//
// It is performance-4x-8192, set here AND in /etc/ia-ci/env so the two cannot
// drift. Two DEDICATED cores are not two shared ones — the phase-0 failure was
// stolen CPU, which a performance core does not have — so halving the machine
// looked free, and on 2026-09-14 it was tried (note #511). It is not free.
//
// Measured that afternoon, ci_script phase, same suite, both shapes:
//   performance-4x-8192   164, 165, 167 s          (656-668 core-seconds)
//   performance-2x-4096   358, 365, 453, 454, 483  (716-966 core-seconds)
// The two-lane script (.agentbuilt/ci.sh) scales well to four cores, so
// halving them roughly doubles the wall clock — 2.2x to 2.9x — AND spends
// more core-seconds. Fly bills per core-second, so the halved hourly rate is
// handed straight back: per run the two shapes land within about 20% of each
// other, the smaller one on the wrong side at the median. The spread widens
// too (358-483 s against 164-167 s): a smaller machine has less slack to
// absorb a noisy host. Four cores is therefore the same money and ~2.5x less
// waiting for a pip, which is why it went back on 2026-09-14.
// DO NOT "SAVE MONEY" HERE BY SHRINKING THE MACHINE. It has been measured
// twice now; the lever that would actually work is fewer core-seconds — the
// deps-baked image (~2 min of installs per job), not fewer cores.
// Memory is the shape to watch after cores: the script's peak is ~1.5 GB above
// idle, and 8192 is exactly what 4 performance cores include (2 GB each), so
// it is free headroom — do not trim it without re-measuring that peak.
export const GUEST = (() => {
  const [kind, cpusX, memory] = (process.env.LANE_A_GUEST ?? 'performance-4x-8192').split('-');
  return { cpu_kind: kind, cpus: Number.parseInt(cpusX, 10), memory_mb: Number(memory) };
})();

// The stable /opt/ia-ci install dir this module runs from — NEVER the work
// checkout, which jobs reset to arbitrary SHAs (the 2026-07-31 lesson, same
// as daemon.mjs itself).
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Read once at import.
const AGENT_SCRIPT_B64 = (() => {
  try {
    return readFileSync(path.join(HERE, 'runner-agent.sh')).toString('base64');
  } catch {
    return '';
  }
})();

/**
 * Which image job machines boot. Normally the sibling `lane-a-image` file,
 * which the machine-image job rewrites every time it repoints the fleet — an
 * env pin here would quietly age while agents' machines moved on (new Node,
 * new tooling never reaching CI). Read per job, not at import, so a repoint
 * lands without a daemon restart. LANE_A_IMAGE stays honored as an explicit
 * operator override/rollback lever.
 */
function currentImage() {
  if (process.env.LANE_A_IMAGE) return process.env.LANE_A_IMAGE;
  try {
    return readFileSync(path.join(HERE, 'lane-a-image'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function laneAConfigured() {
  return Boolean(FLY_TOKEN && APP && currentImage() && RESULT_URL && AGENT_SCRIPT_B64);
}

/** Jobs lane A takes off the WEBHOOK. Deploys and self-update are lane B
 *  forever, by design — and the build kinds are not routable either: they are
 *  asked for by a running deploy over the daemon's localhost /build, never by
 *  an event delivery. */
export function laneARoutes(kind) {
  return kind === 'checks' || kind === 'ci-script';
}

/** Kinds whose success is a tarball, not just a verdict. */
export function buildKind(kind) {
  return kind === 'build-backend' || kind === 'build-site';
}

async function fly(method, pathname, body) {
  const res = await fetch(`${FLY_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${FLY_TOKEN}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`fly ${method} ${pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** jobId → { token, resolve } while a machine is out running. */
const pending = new Map();

/** `${kind}:${ref}` → cancel fn for each in-flight job, so a superseding push
 *  can abandon the stale build instead of paying for a result nobody can use. */
const cancellers = new Map();

export function cancelLaneAJob(kind, ref) {
  const cancel = cancellers.get(`${kind}:${ref}`);
  if (!cancel) return false;
  cancel();
  return true;
}

/**
 * The daemon's /job-result endpoint hands raw body + signature header here.
 * Per-job HMAC: a machine can report its own job and nothing else, and a
 * result arriving twice (or after the watchdog gave up) is dropped.
 */
export function handleJobResult(rawBody, signatureHeader) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error: 'unparseable body' };
  }
  const job = pending.get(String(parsed?.jobId ?? ''));
  if (!job) return { ok: false, status: 404, error: 'no such pending job' };
  const expected = 'sha256=' + createHmac('sha256', job.token).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader ?? ''));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'bad signature' };
  }
  const publish = parsed.publish && typeof parsed.publish === 'object' ? parsed.publish : null;
  job.resolve({
    kind: 'reported',
    exitCode: Number(parsed.exitCode),
    totalSeconds: Number(parsed.totalSeconds) || 0,
    phases: Array.isArray(parsed.phases) ? parsed.phases : [],
    logTail: Buffer.from(String(parsed.logTailB64 ?? ''), 'base64').toString('utf8'),
    // The publish step's own outcome (`agentbuilt repo publish`), present
    // only when the run carried a key and its ci.sh passed.
    ...(publish ? {
      publish: {
        exitCode: Number(publish.exitCode),
        logTail: Buffer.from(String(publish.logTailB64 ?? ''), 'base64').toString('utf8'),
      },
    } : {}),
  });
  return { ok: true, status: 200 };
}

/** Cheap pre-flight for the daemon's /job-artifact: worth answering before it
 *  streams a body to disk for a job nobody is waiting on. */
export function artifactJobPending(jobId) {
  return pending.has(String(jobId ?? ''));
}

/**
 * Accept an uploaded artifact the daemon has already streamed to `tmpPath`,
 * hashing as it wrote. Same trust model as the result: the per-job HMAC
 * (here over `jobId:sha256`) proves the sender is the machine this job
 * created, and the daemon's own digest proves the bytes survived the trip —
 * a build machine can only ever deliver its own job's artifact, intact.
 */
export function acceptArtifact({ jobId, computedSha256, claimedSha256, signatureHeader, tmpPath, artifactDir }) {
  const finish = (outcome) => {
    if (!outcome.ok) rmSync(tmpPath, { force: true });
    return outcome;
  };
  const job = pending.get(String(jobId ?? ''));
  if (!job) return finish({ ok: false, status: 404, error: 'no such pending job' });
  if (!/^[0-9a-f]{64}$/.test(String(claimedSha256 ?? ''))) {
    return finish({ ok: false, status: 400, error: 'bad sha256 header' });
  }
  if (computedSha256 !== claimedSha256) {
    return finish({ ok: false, status: 400, error: 'body does not match its sha256' });
  }
  const expected = 'sha256=' + createHmac('sha256', job.token).update(`${jobId}:${claimedSha256}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader ?? ''));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return finish({ ok: false, status: 401, error: 'bad signature' });
  }
  const dest = path.join(artifactDir, `${jobId}.tar.gz`);
  renameSync(tmpPath, dest);
  return { ok: true, status: 200, path: dest };
}

/** A site name as the backend issues them; anything else is not a publish. */
const PUBLISH_SITE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The publish key's three facts, or null when the backend sent none or
 * something malformed — a daemon must not trust even a friend with env
 * injection, and a status context is built from the site's name.
 */
export function usablePublish(publish) {
  if (!publish || typeof publish !== 'object') return null;
  const { token, site, apiUrl } = publish;
  if (typeof token !== 'string' || !token || typeof site !== 'string' || !PUBLISH_SITE.test(site)) return null;
  if (typeof apiUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(apiUrl)) return null;
  return { token, site, apiUrl };
}

/**
 * The deploy/<site> verdict of a run that carried a publish key. Its own
 * check, so a failed publish is never mistaken for failed tests, and a
 * passing suite is never mistaken for a site that went live.
 */
export function publishVerdict(outcome, site) {
  const words = (text) => text.slice(0, 140);
  if (outcome.kind === 'reported') {
    const step = outcome.publish;
    if (!step) {
      // The runner publishes only after ci.sh exits 0, so no step means the
      // checks did not pass (or never ran) — except a 0 with no step, which
      // is a runner that lost it.
      return outcome.exitCode === 0
        ? { state: 'error', description: words(`The checks passed but the publish step did not report — ${site} was not published`), logTail: '' }
        : { state: 'skipped', description: words(`Not published — the checks did not pass, so ${site} still serves the last approved change`), logTail: '' };
    }
    if (step.exitCode === 0) {
      return { state: 'success', description: words(`Published ${site}`), logTail: step.logTail };
    }
    if (step.exitCode === 78) {
      return { state: 'skipped', description: words('Not published — commit a .agentbuilt/deploy.sh to publish on approval'), logTail: step.logTail };
    }
    return {
      state: 'failure',
      description: words(`Publishing ${site} failed (exit ${step.exitCode}) — read this check's log`),
      logTail: step.logTail,
    };
  }
  if (outcome.kind === 'cancelled') {
    return { state: 'superseded', description: words('Not published — a newer approved change publishes instead'), logTail: '' };
  }
  return { state: 'error', description: words(`Not published — the job ended before it could publish ${site}`), logTail: '' };
}

/**
 * Run one job on a fresh machine. Resolves (never rejects) with
 *   { state: 'success' | 'failure' | 'error', description, logTail }
 * — the same trio postStatus wants, so the daemon's call site stays one line
 * per outcome. A run handed a publish key adds `publish`: the same trio for
 * its deploy/<site> check.
 */
export async function runLaneAJob(job, { cloneToken, repoUrl, secrets, publish: publishGrant, log, artifactDir }) {
  const jobId = `${job.kind}-${job.sha.slice(0, 7)}-${randomBytes(4).toString('hex')}`;
  const jobToken = randomBytes(32).toString('hex');
  const started = Date.now();

  // Owner-granted secrets ride as plain env under their own names — that is
  // the whole product ("my deploy script reads $CF_API_TOKEN"). Names are
  // re-checked here because they become environment entries: shell-safe
  // shape, and never the runner's own CI_* contract. The backend already
  // enforces both; a daemon must not trust even a friend with env injection.
  const secretEnv = {};
  const secretNames = [];
  for (const [name, value] of Object.entries(secrets ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^CI_/i.test(name) || typeof value !== 'string') continue;
    secretEnv[name] = value;
    secretNames.push(name);
  }

  const publish = usablePublish(publishGrant);

  let machineId = null;
  const cancelKey = `${job.kind}:${job.ref}`;
  const machineConfig = {
    image: currentImage(),
    guest: GUEST,
    auto_destroy: true,
    restart: { policy: 'no' },
    env: {
      ...secretEnv,
      CI_KIND: job.kind,
      CI_SHA: job.sha,
      CI_REPO_URL: repoUrl,
      CI_CLONE_TOKEN: cloneToken,
      CI_RESULT_URL: RESULT_URL,
      CI_JOB_ID: jobId,
      CI_JOB_TOKEN: jobToken,
      CI_RUNNER_B64: AGENT_SCRIPT_B64,
      // Which env names are secrets, so the runner can mask their values out
      // of the log tail it reports back.
      ...(secretNames.length ? { CI_SECRET_NAMES: secretNames.join(',') } : {}),
      // Publishing on approval: the runner takes the key out of the env
      // before ci.sh, and hands it only to deploy.sh once ci.sh passed.
      ...(publish ? {
        CI_PUBLISH_TOKEN: publish.token,
        CI_PUBLISH_SITE: publish.site,
        CI_PUBLISH_API_URL: publish.apiUrl,
      } : {}),
    },
    // Override the image's sshd entrypoint entirely: a CI machine takes
    // no inbound connections, it dials out once. $CI_RUNNER_B64 expands
    // inside bash -c, so the script rides the create call and the image
    // needs no CI-specific build. Root is fine here — the machine IS the
    // sandbox, and it holds nothing but this one job.
    init: {
      exec: [
        '/bin/bash', '-c',
        'printf %s "$CI_RUNNER_B64" | base64 -d > /tmp/runner-agent.sh'
        + ' && exec bash /tmp/runner-agent.sh',
      ],
    },
  };

  let myCancel = null;
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), TIMEOUT_MS);
    const settle = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    pending.set(jobId, { token: jobToken, resolve: settle });
    myCancel = () => settle({ kind: 'cancelled' });
    cancellers.set(cancelKey, myCancel);

    const create = (region) => fly('POST', `/apps/${APP}/machines`, {
      name: `ci-${jobId}`,
      region,
      config: machineConfig,
    });
    create(REGION).catch((error) => {
      if (FALLBACK_REGION === REGION) throw error;
      log(`lane A: create in ${REGION} failed (${error.message}) — retrying in ${FALLBACK_REGION}`);
      return create(FALLBACK_REGION);
    }).then((machine) => {
      machineId = machine.id;
      log(`lane A: machine ${machine.id} created for ${jobId}`);
      // Death watchdog: auto_destroy means a machine whose init exited is
      // soon gone. A vanished machine with no result (runner bug, OOM kill)
      // must not sit out the whole wall clock — one grace period after the
      // machine stops answering, the job is declared dead. The result POST
      // races this and wins: it lands before the runner exits.
      const DEAD_STATES = new Set(['stopped', 'destroyed', 'failed']);
      const poll = setInterval(async () => {
        if (!pending.has(jobId)) { clearInterval(poll); return; }
        const state = await fly('GET', `/apps/${APP}/machines/${machine.id}`)
          .then((m) => m.state)
          .catch(() => 'destroyed');
        if (!DEAD_STATES.has(state)) return;
        clearInterval(poll);
        setTimeout(() => {
          const waiting = pending.get(jobId);
          if (waiting) waiting.resolve({ kind: 'died', state });
        }, 30_000);
      }, 30_000);
    }).catch((error) => {
      const job = pending.get(jobId);
      if (job) job.resolve({ kind: 'create-failed', error: String(error.message ?? error) });
    });
  });
  pending.delete(jobId);
  // Identity-guarded delete: the superseding job that cancelled us registers
  // the SAME key the moment it starts, possibly before this cleanup runs —
  // an unconditional delete would strip the new job's canceller.
  if (cancellers.get(cancelKey) === myCancel) cancellers.delete(cancelKey);

  // The machine is done reporting (or never will): destroy is unconditional.
  // auto_destroy handles the clean-exit path; this handles hangs, timeouts
  // and half-created machines. Force: a wedged init must not save itself.
  if (machineId) {
    await fly('DELETE', `/apps/${APP}/machines/${machineId}?force=true`)
      .catch((error) => log(`lane A: destroy ${machineId} failed (${error.message}) — reaper will collect it`));
  }

  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  const verdict = jobVerdict();
  return publish ? { ...verdict, publish: publishVerdict(outcome, publish.site) } : verdict;

  function jobVerdict() {
    if (outcome.kind === 'reported') {
      // 78 is the runner's "looked, nothing to run" — same convention as
      // run-job.sh path filters. The ingest carries it as-is (grey pip); the
      // daemon maps it to success-with-honest-words where GitHub is involved.
      const skipped = outcome.exitCode === 78;
      const ok = outcome.exitCode === 0;
      const phases = outcome.phases.map((p) => `${p.name} ${p.seconds}s`).join(', ');
      log(`lane A: ${jobId} reported exit ${outcome.exitCode} in ${mins}m (${phases})`);
      // A build that "passed" without delivering its tarball is a failure with
      // a green face — the runner uploads BEFORE it reports, so an exit 0 with
      // no artifact on disk means the upload path itself is broken.
      const artifactPath = artifactDir ? path.join(artifactDir, `${jobId}.tar.gz`) : null;
      if (ok && buildKind(job.kind) && artifactDir && !existsSync(artifactPath)) {
        return {
          state: 'error',
          description: `Build reported success but no artifact arrived (${jobId})`,
          logTail: outcome.logTail,
        };
      }
      return {
        state: skipped ? 'skipped' : ok ? 'success' : 'failure',
        description: skipped
          ? 'Skipped — this job had nothing to run for this commit'
          : ok
            ? `Passed in ${mins}m in an ephemeral VM`
            : `Failed (exit ${outcome.exitCode}) in ${mins}m in an ephemeral VM`,
        logTail: outcome.logTail,
        ...(ok && buildKind(job.kind) && artifactPath ? { artifactPath } : {}),
      };
    }
    if (outcome.kind === 'timeout') {
      return {
        state: 'error',
        description: `Killed at the ${Math.round(TIMEOUT_MS / 60_000)}m wall clock — job machine destroyed`,
        logTail: '',
      };
    }
    if (outcome.kind === 'died') {
      return {
        state: 'error',
        description: `Job machine ${outcome.state} without reporting after ${mins}m (crash or OOM?)`,
        logTail: '',
      };
    }
    if (outcome.kind === 'cancelled') {
      return {
        // Not an error: we stopped it on purpose because a newer commit for the
        // same branch made this build unmergeable. Nothing about the code failed.
        state: 'superseded',
        description: `Superseded by a newer commit after ${mins}m — build abandoned, machine destroyed`,
        logTail: '',
      };
    }
    return {
      state: 'error',
      description: `Could not create a job machine: ${outcome.error ?? 'unknown'}`.slice(0, 140),
      logTail: '',
    };
  }
}
