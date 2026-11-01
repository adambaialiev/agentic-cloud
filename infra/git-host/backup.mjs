// Org-host backups (byo-git-design slice 4): one verified git bundle per
// repo, uploaded to the ORG'S OWN S3-compatible bucket, with the central
// host's retention discipline — 14 dailies, then one per ISO week for 8
// weeks, and NEVER a repo's newest bundle, which is the rule that makes
// skipping unchanged repos safe.
//
// Runs on the org git host, invoked by its control API (the backend's
// per-org sweep is the clock — a machine that sleeps between pushes fires no
// timers of its own, so the schedule lives on the control plane). Zero
// dependencies: git does the bundling and verifying, curl does the S3 talk
// with its own SigV4 signing (`--aws-sigv4`, proven live 2026-08-23), and
// the credentials ride a stdin config so they never appear on an argv.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  });
}

/** curl against the bucket, credentials over stdin (`-K -`), never argv. */
async function s3(target, extraArgs, { stdin } = {}) {
  const config = [
    `user = "${target.accessKeyId}:${target.secretAccessKey}"`,
    'aws-sigv4 = "aws:amz:auto:s3"',
    'silent',
    'show-error',
  ].join('\n');
  return exec('curl', ['-K', '-', ...extraArgs], { stdin: config + '\n' + (stdin ?? '') });
}

/** Every ref and where it points — the repo's backup fingerprint. */
async function refsFingerprint(repoDir, target) {
  const refs = await exec('git', ['-C', repoDir, 'for-each-ref', '--format=%(refname) %(objectname)']);
  if (refs.code !== 0) return null;
  return createHash('sha256')
    .update(`${target.endpoint}/${target.bucket}\n${refs.stdout}`)
    .digest('hex');
}

/** ISO week key (YYYY-Www), the unit the weekly retention thins to. */
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Which dated bundles to DELETE. Keep: the newest whatever its age (the rule
 * that makes skip-unchanged safe), every daily younger than `dailyDays`, and
 * the newest bundle of each ISO week younger than `weeklyWeeks` weeks.
 * Exported for the tests — date math is exactly what rots silently.
 */
export function pruneList(dates, now, { dailyDays = 14, weeklyWeeks = 8 } = {}) {
  const sorted = [...dates].sort();
  const newest = sorted[sorted.length - 1];
  const weeklies = new Map();
  for (const date of sorted) {
    weeklies.set(isoWeekKey(new Date(`${date}T00:00:00Z`)), date); // later dates overwrite: newest of the week wins
  }
  const keptWeeklies = new Set(weeklies.values());
  const doomed = [];
  for (const date of sorted) {
    if (date === newest) continue;
    const ageMs = now.getTime() - new Date(`${date}T00:00:00Z`).getTime();
    if (ageMs <= dailyDays * DAY_MS) continue;
    if (keptWeeklies.has(date) && ageMs <= weeklyWeeks * 7 * DAY_MS) continue;
    doomed.push(date);
  }
  return doomed;
}

async function listBundleDates(target, prefix) {
  const url = `${target.endpoint}/${target.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const res = await s3(target, [url]);
  if (res.code !== 0) throw new Error(`listing ${prefix} failed: ${res.stderr.trim() || res.code}`);
  // The only thing read out of the XML is the object keys; a full parser for
  // one tag would be the only dependency this file has.
  const dates = [];
  for (const match of res.stdout.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const m = /(\d{4}-\d{2}-\d{2})\.bundle$/.exec(match[1]);
    if (m) dates.push(m[1]);
  }
  return dates;
}

/**
 * The whole run. `target` carries endpoint/bucket/credentials; `reposRoot`
 * is walked two levels deep for `*.git`, the knowledge base included.
 */
export async function runBackup({ reposRoot, stateFile, target, now = new Date(), log = () => {} }) {
  const state = await readFile(stateFile, 'utf8').then(JSON.parse).catch(() => ({}));
  const summary = { repos: 0, uploaded: 0, uploadedBytes: 0, unchanged: 0, pruned: 0, failed: [] };
  const day = now.toISOString().slice(0, 10);

  const namespaces = await readdir(reposRoot, { withFileTypes: true }).catch(() => []);
  for (const nsEntry of namespaces) {
    if (!nsEntry.isDirectory()) continue;
    const nsDir = path.join(reposRoot, nsEntry.name);
    for (const repoEntry of await readdir(nsDir, { withFileTypes: true }).catch(() => [])) {
      if (!repoEntry.isDirectory() || !repoEntry.name.endsWith('.git')) continue;
      summary.repos += 1;
      const repoDir = path.join(nsDir, repoEntry.name);
      const shortName = repoEntry.name.slice(0, -'.git'.length);
      const key = `${nsEntry.name}/${shortName}`;
      try {
        const fingerprint = await refsFingerprint(repoDir, target);
        if (!fingerprint) throw new Error('could not read refs');
        if (state[key] === fingerprint) {
          summary.unchanged += 1;
          continue;
        }
        const scratch = await mkdtemp(path.join(tmpdir(), 'agentgit-backup-'));
        try {
          const bundlePath = path.join(scratch, 'repo.bundle');
          const bundle = await exec('git', ['-C', repoDir, 'bundle', 'create', bundlePath, '--all']);
          if (bundle.code !== 0) throw new Error(`bundle failed: ${bundle.stderr.trim()}`);
          const verify = await exec('git', ['-C', repoDir, 'bundle', 'verify', bundlePath]);
          if (verify.code !== 0) throw new Error(`bundle failed verification: ${verify.stderr.trim()}`);
          const objectKey = `git/${key}/${day}.bundle`;
          const put = await s3(target, ['-T', bundlePath, `${target.endpoint}/${target.bucket}/${objectKey}`, '-o', '/dev/null', '-w', '%{http_code}']);
          if (put.code !== 0 || !put.stdout.trim().startsWith('2')) {
            throw new Error(`upload failed: HTTP ${put.stdout.trim() || put.stderr.trim()}`);
          }
          summary.uploaded += 1;
          summary.uploadedBytes += (await readFile(bundlePath)).length;
          state[key] = fingerprint;
        } finally {
          // This host's disk is the constraint the whole design guards, so a
          // run never holds more than one bundle at a time.
          await rm(scratch, { recursive: true, force: true });
        }
        for (const date of pruneList(await listBundleDates(target, `git/${key}/`), now)) {
          const del = await s3(target, ['-X', 'DELETE', `${target.endpoint}/${target.bucket}/git/${key}/${date}.bundle`, '-o', '/dev/null', '-w', '%{http_code}']);
          // A prune that fails is disk on the far end, never a failed backup.
          if (del.code === 0 && del.stdout.trim().startsWith('2')) summary.pruned += 1;
        }
      } catch (error) {
        summary.failed.push({ repo: key, error: error instanceof Error ? error.message : String(error) });
        log(`backup of ${key} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  await writeFile(stateFile, JSON.stringify(state, null, 1)).catch((error) => {
    // A lost state file costs a full re-upload next run, never data.
    log(`could not persist backup state: ${error instanceof Error ? error.message : error}`);
  });
  return summary;
}
