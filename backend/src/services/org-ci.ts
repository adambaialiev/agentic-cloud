import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { FlyClient } from './fly-client.js';
import { mintCiCloneToken, CI_CLONE_TOKEN_DEFAULT_TTL_MS } from './ci-clone-token.js';
import { orgGitAppName } from './org-git-host.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';
import type { OrgFlyService } from './org-fly.js';
import type { OrgGitHostService } from './org-git-host.js';
import type { GitRepoStorage } from './git-repo-storage.js';
import type { GitCommitStatusStorage } from './git-commit-status-storage.js';
import type { SecretStorage } from './secret-storage.js';
import type { DeploymentStorage } from './deployment-storage.js';
import { ciRunGrant, type CiRunGrant } from './ci-run-grant.js';
import { loadCiVerdicts, type PublishOutcome } from './ci-verdicts.js';
import type { GitCommitStatusState } from '../types/git-commit-status.js';
import { GIT_COMMIT_STATUS_LOG_TAIL_MAX_BYTES } from '../types/git-commit-status.js';

/**
 * CI in the client's org (byo-git-design slice 5): a client repo's
 * `.agentbuilt/ci.sh` executes on a throwaway machine in the CLIENT'S OWN
 * Fly account — their code never runs on any box of ours, not even the
 * untrusted lane, and the machine bills their card like everything else
 * they run.
 *
 * The shape is lane A's, deliberately: the same runner script rides in as
 * machine env, the same per-job HMAC signs the one result the machine may
 * report, the same auto_destroy takes the machine down when it exits. What
 * moved is WHO boots it (the backend, through the org-resolved Fly context —
 * the ia-ci-runner dispatcher keeps the platform repo's deploys and nothing
 * else) and where the clone comes from (the org's own git host, over the
 * org's own private network — which also makes every client CI run a living
 * proof of in-org connectivity).
 *
 * The webhook is the org host's post-receive hook exactly as on the central
 * host; it signs with the org's own host secret, and the payload's owner —
 * the namespace, an orgId on a client host — names which secret to check.
 */

export const ORG_CI_CONTEXT = 'ci/checks';
const ORG_CI_TIMEOUT_MS = Number(process.env.ORG_CI_TIMEOUT_MS || 15 * 60_000);
const ORG_CI_QUEUE_MAX = 5;
const ORG_CI_DEFAULT_GUEST = { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 };

export interface OrgCiServiceDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'getOrgByNamespace'>;
  orgSecrets: Pick<OrgSecretsService, 'getOrgSecret'>;
  orgFly: Pick<OrgFlyService, 'resolveOrgFlyContext' | 'resolveHostingContext'>;
  orgGitHost: Pick<OrgGitHostService, 'resolveContext' | 'clientFor'>;
  gitRepoStorage: Pick<GitRepoStorage, 'getByName' | 'get'>;
  gitCommitStatusStorage: Pick<GitCommitStatusStorage, 'get' | 'upsert'>;
  /** The workplace's secrets: what `repo ci-secrets` grants from, and so
   *  what a run receives (note #1161 — not the operator store). */
  secretStorage?: SecretStorage;
  /** Sites, for publishing on approval (`repo publish`). */
  deploymentStorage?: Pick<DeploymentStorage, 'get'>;
  /** Keys cit1 clone tokens — the same secret the central lane mints with. */
  ciStatusSecret: string;
  /** The public agent image; a client org can pull it, and it carries node,
   *  git and bash — everything `.agentbuilt/ci.sh` was promised. */
  machineImage?: string;
  /** The public API origin the machine reports its result to. */
  backendUrl?: string;
  region: string;
  /** The runner script's bytes (assets/ci-runner-agent.sh), base64. */
  runnerScriptB64?: string;
  guest?: { cpu_kind: string; cpus: number; memory_mb: number };
  makeFlyClient?: (apiToken: string) => Pick<FlyClient, 'createApp' | 'createMachine' | 'deleteMachine' | 'listMachines'>;
  log?: (line: string) => void;
  /**
   * A private copy (note #804): its ONE git host is the central one and its
   * Fly account is the customer's own, so a workplace there has neither a git
   * host of its own nor a cloud of its own, and its checks still run here, in
   * that account. The central host signs its deliveries with this secret.
   * Unset everywhere else, where the central host's CI is our own lane.
   */
  privateCopyCentralHost?: { secret: string };
}

interface PendingJob {
  jobToken: string;
  repoId: string;
  namespaceId: string;
  sha: string;
  appName: string;
  machineId?: string;
  flyToken: string;
  timer: NodeJS.Timeout;
  /** Set when the run carries a publish key: its deploy/<site> check. */
  publishSite?: string;
}

export class OrgCiService {
  private pending = new Map<string, PendingJob>();
  private queues = new Map<string, Array<() => Promise<void>>>();
  private running = new Set<string>();

  constructor(private readonly deps: OrgCiServiceDeps) {}

  private get log() { return this.deps.log ?? (() => {}); }

  get enabled(): boolean {
    return Boolean(this.deps.machineImage && this.deps.backendUrl && this.deps.runnerScriptB64 && this.deps.ciStatusSecret);
  }

  /**
   * Verify a webhook delivery from an org git host: the payload's owner is
   * the namespace — an orgId on a client host — and names which org's secret
   * the HMAC must match. A signature checked against anything the payload
   * did not commit to would let one host speak for another.
   */
  async verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, ownerOrgId: string): Promise<boolean> {
    const presented = String(signatureHeader ?? '');
    if (!presented.startsWith('sha256=')) return false;
    const secret = await this.deps.orgSecrets.getOrgSecret(ownerOrgId, 'GIT_HOST_SECRET').catch(() => null)
      ?? this.deps.privateCopyCentralHost?.secret
      ?? null;
    if (!secret) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async orgOfNamespace(namespaceId: string) {
    return await this.deps.orgStorage.getOrgByNamespace(namespaceId) ?? await this.deps.orgStorage.getOrg(namespaceId);
  }

  /** The one rule for "this workplace's checks run here, in its own cloud":
   *  a private copy (every workplace), or a workplace with a git host of its
   *  own (the dormant BYO path). Everywhere else our own lane runs them. */
  private runsInOrg(org: { git?: { host?: unknown } | null }): boolean {
    return Boolean(org.git?.host) || Boolean(this.deps.privateCopyCentralHost);
  }

  /** A verified push delivery. Decides whether a job runs and queues it. */
  async handlePush(payload: {
    ref?: string; after?: string; deleted?: boolean;
    repository?: { name?: string; owner?: string };
  }): Promise<{ queued: boolean; reason?: string }> {
    if (!this.enabled) return { queued: false, reason: 'org CI is not configured on this backend' };
    const owner = String(payload.repository?.owner ?? '');
    const name = String(payload.repository?.name ?? '');
    const ref = String(payload.ref ?? '');
    const sha = String(payload.after ?? '');
    if (payload.deleted || !ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) {
      return { queued: false, reason: 'not a branch update' };
    }
    // The pushed owner is a NAMESPACE: the workplace's own, or one of its old
    // rooms' (note #843), where repositories made then still live. The org
    // behind either is one reverse lookup away. Missing that lookup would
    // silently end CI for those repositories.
    const org = await this.orgOfNamespace(owner);
    if (!org) return { queued: false, reason: 'owner is not a workplace' };
    if (!this.runsInOrg(org)) {
      return { queued: false, reason: 'owner is not an org with its own git host' };
    }
    const repo = await this.deps.gitRepoStorage.getByName(owner, name);
    if (!repo?.ci) return { queued: false, reason: 'CI is not enabled on this repo' };

    // Queued and drained per ORG: one org runs one job at a time on its own bill.
    const queue = this.queues.get(org.orgId) ?? [];
    if (queue.length >= ORG_CI_QUEUE_MAX) {
      await this.writeStatus(repo.userId, repo.id, sha, 'error', 'CI queue is full for this workplace');
      return { queued: false, reason: 'queue full' };
    }
    await this.writeStatus(repo.userId, repo.id, sha, 'pending', 'Queued — runs on a machine in your own cloud');
    queue.push(() => this.runJob({
      orgId: org.orgId, repoId: repo.id, namespaceId: repo.userId, repoName: name,
      sha, branch: ref.slice('refs/heads/'.length),
    }));
    this.queues.set(org.orgId, queue);
    void this.drain(org.orgId);
    return { queued: true };
  }

  /** One org runs one job at a time — its machines, its bill, its pace. */
  private async drain(orgId: string): Promise<void> {
    if (this.running.has(orgId)) return;
    this.running.add(orgId);
    try {
      for (;;) {
        const next = this.queues.get(orgId)?.shift();
        if (!next) break;
        await next().catch((error) => this.log(`org-ci job crashed: ${error instanceof Error ? error.message : error}`));
      }
    } finally {
      this.running.delete(orgId);
    }
  }

  private async runJob(args: {
    orgId: string; repoId: string; namespaceId: string; repoName: string;
    sha: string; branch: string;
  }): Promise<void> {
    const jobId = `orgci-${args.sha.slice(0, 7)}-${randomBytes(4).toString('hex')}`;
    const jobToken = randomBytes(32).toString('hex');
    try {
      const fly = this.deps.privateCopyCentralHost
        ? await this.deps.orgFly.resolveHostingContext(args.orgId)
        : await this.deps.orgFly.resolveOrgFlyContext(args.orgId);
      if (fly.source !== 'org' && !this.deps.privateCopyCentralHost) throw new Error('org has no Fly account of its own');
      const gitContext = await this.deps.orgGitHost.resolveContext(args.orgId);
      const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(fly.apiToken);
      const appName = `iaci-${args.orgId.replace(/-/g, '').slice(0, 12)}`;
      try {
        await client.createApp({ appName, orgSlug: fly.orgSlug });
      } catch (error) {
        if (!/already|taken|exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }

      // What this run gets, by the one rule our own lane uses too
      // (ci-run-grant.ts, note #1161): granted shared secrets and, for a
      // linked repository, the key that publishes its site — both only on a
      // branch the host calls protected right now. No answer about
      // protection means neither: the run goes ahead without them.
      let grant: CiRunGrant = { secrets: {}, publish: null };
      const doc = await this.deps.gitRepoStorage.get(args.repoId).catch(() => null);
      if (doc && this.deps.secretStorage) {
        try {
          grant = await ciRunGrant({
            doc, ref: args.branch, sha: args.sha,
            secretStorage: this.deps.secretStorage,
            ...(this.deps.deploymentStorage ? { deploymentStorage: this.deps.deploymentStorage } : {}),
            ciStatusSecret: this.deps.ciStatusSecret,
            ...(this.deps.backendUrl ? { agentbuiltApiUrl: this.deps.backendUrl.replace(/\/+$/, '') } : {}),
            protectedBranches: async () => (
              await (await this.deps.orgGitHost.clientFor(args.orgId)).statRepo(args.namespaceId, args.repoName)
            ).protectedBranches ?? [],
          });
        } catch (error) {
          this.log(`org-ci ${jobId}: protection not confirmed (${error instanceof Error ? error.message : error}) — running without secrets or a publish key`);
        }
      }
      // Names re-checked because they become environment entries: shell-safe,
      // and never the runner's own CI_* contract.
      const secretEnv: Record<string, string> = {};
      const secretNames: string[] = [];
      for (const [secretName, value] of Object.entries(grant.secrets)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName) || /^CI_/i.test(secretName)) continue;
        secretEnv[secretName] = value;
        secretNames.push(secretName);
      }
      const publish = grant.publish ? (await loadCiVerdicts()).usablePublish(grant.publish) : null;

      const cloneToken = mintCiCloneToken(this.deps.ciStatusSecret, args.namespaceId, args.repoName, CI_CLONE_TOKEN_DEFAULT_TTL_MS).token;
      // The token rides INSIDE the clone URL: the runner's netrc derivation
      // does not survive a bracketed IPv6 host, and the machine holds the
      // token in its env either way — 60 minutes, one repo, read-only.
      // A private copy's central host is reached at its public HTTPS address.
      const scheme = gitContext.baseUrl.startsWith('https://') ? 'https' : 'http';
      const base = gitContext.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const repoUrl = `${scheme}://x-access-token:${encodeURIComponent(cloneToken)}@${base}/${encodeURIComponent(args.namespaceId)}/${encodeURIComponent(args.repoName)}.git`;

      const timer = setTimeout(() => { void this.timeOut(jobId); }, ORG_CI_TIMEOUT_MS);
      timer.unref();
      this.pending.set(jobId, {
        jobToken, repoId: args.repoId, namespaceId: args.namespaceId, sha: args.sha,
        appName, flyToken: fly.apiToken, timer,
        ...(publish ? { publishSite: publish.site } : {}),
      });
      // Its own check on the same sha, filed pending NOW, so a wait after a
      // merge waits for the publish too rather than settling with ci/checks.
      if (publish) {
        await this.writeStatus(args.namespaceId, args.repoId, args.sha, 'pending',
          `Publishes ${publish.site} once the checks pass`, undefined, `deploy/${publish.site}`);
      }

      const machine = await client.createMachine(appName, {
        name: `ci-${jobId}`,
        region: this.deps.region,
        image: this.deps.machineImage!,
        guest: this.deps.guest ?? ORG_CI_DEFAULT_GUEST,
        env: {
          ...secretEnv,
          CI_KIND: 'ci-script',
          CI_SHA: args.sha,
          CI_REPO_URL: repoUrl,
          CI_CLONE_TOKEN: cloneToken,
          CI_RESULT_URL: `${this.deps.backendUrl!.replace(/\/+$/, '')}/api/agent-cli/git/ci-result`,
          CI_JOB_ID: jobId,
          CI_JOB_TOKEN: jobToken,
          CI_RUNNER_B64: this.deps.runnerScriptB64!,
          ...(secretNames.length ? { CI_SECRET_NAMES: secretNames.join(',') } : {}),
          // Publishing on approval: the runner takes the key out of the env
          // before ci.sh, and hands it only to deploy.sh once ci.sh passed.
          ...(publish ? {
            CI_PUBLISH_TOKEN: publish.token,
            CI_PUBLISH_SITE: publish.site,
            CI_PUBLISH_API_URL: publish.apiUrl,
          } : {}),
        },
        autoDestroy: true,
        restart: { policy: 'no' },
        init: {
          exec: [
            '/bin/bash', '-c',
            'printf %s "$CI_RUNNER_B64" | base64 -d > /tmp/runner-agent.sh && exec bash /tmp/runner-agent.sh',
          ],
        },
      });
      const entry = this.pending.get(jobId);
      if (entry) entry.machineId = machine.id;
      await this.writeStatus(args.namespaceId, args.repoId, args.sha, 'pending', 'Running on a machine in your own cloud');
      this.log(`org-ci ${jobId}: ${args.namespaceId}/${args.repoName}@${args.sha.slice(0, 7)} on ${appName}/${machine.id}`);
    } catch (error) {
      const entry = this.pending.get(jobId);
      if (entry) { clearTimeout(entry.timer); this.pending.delete(jobId); }
      if (entry?.publishSite) await this.settlePublish(entry, { kind: 'lost' });
      const message = error instanceof Error ? error.message : String(error);
      await this.writeStatus(args.namespaceId, args.repoId, args.sha, 'error', `could not start the CI machine: ${message}`.slice(0, 140));
      this.log(`org-ci ${jobId} failed to start: ${message}`);
    }
  }

  /** The machine's one report, signed with its own job token. */
  async handleResult(rawBody: Buffer, signatureHeader: string | undefined): Promise<{ ok: boolean; error?: string }> {
    let payload: {
      jobId?: string; exitCode?: number; totalSeconds?: number; logTailB64?: string;
      publish?: { exitCode?: number; logTailB64?: string };
    };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, error: 'bad json' };
    }
    const job = payload.jobId ? this.pending.get(payload.jobId) : undefined;
    if (!job) return { ok: false, error: 'unknown job' };
    const expected = `sha256=${createHmac('sha256', job.jobToken).update(rawBody).digest('hex')}`;
    const a = Buffer.from(String(signatureHeader ?? ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'bad signature' };

    clearTimeout(job.timer);
    this.pending.delete(payload.jobId!);
    const exitCode = Number(payload.exitCode ?? 1);
    const seconds = Number(payload.totalSeconds ?? 0);
    const logTail = typeof payload.logTailB64 === 'string' && payload.logTailB64
      ? Buffer.from(payload.logTailB64, 'base64').subarray(0, GIT_COMMIT_STATUS_LOG_TAIL_MAX_BYTES).toString('utf8')
      : undefined;
    // The publish verdict first: a wait that sees ci/checks settle should
    // find deploy/<site> already settled beside it, never still pending.
    if (job.publishSite) {
      const step = payload.publish && typeof payload.publish === 'object' ? payload.publish : null;
      await this.settlePublish(job, {
        kind: 'reported',
        exitCode,
        ...(step ? {
          publish: {
            exitCode: Number(step.exitCode),
            logTail: typeof step.logTailB64 === 'string'
              ? Buffer.from(step.logTailB64, 'base64').subarray(0, GIT_COMMIT_STATUS_LOG_TAIL_MAX_BYTES).toString('utf8')
              : '',
          },
        } : {}),
      });
    }
    const state: GitCommitStatusState = exitCode === 0 || exitCode === 78 ? 'success' : 'failure';
    const description = exitCode === 0
      ? `Passed in ${Math.round(seconds / 60 * 10) / 10}m in your own cloud`
      : exitCode === 78
        ? 'Skipped — no .agentbuilt/ci.sh in this repo'
        : `Failed (exit ${exitCode}) in ${Math.round(seconds / 60 * 10) / 10}m in your own cloud`;
    await this.writeStatus(job.namespaceId, job.repoId, job.sha, state, description, logTail);
    return { ok: true };
  }

  /** A machine that never reported: fail the status, kill the machine — an
   *  unwatched runaway would bill the client until someone noticed. */
  private async timeOut(jobId: string): Promise<void> {
    const job = this.pending.get(jobId);
    if (!job) return;
    this.pending.delete(jobId);
    if (job.publishSite) await this.settlePublish(job, { kind: 'timeout' });
    await this.writeStatus(job.namespaceId, job.repoId, job.sha, 'failure', `CI timed out after ${Math.round(ORG_CI_TIMEOUT_MS / 60_000)}m`);
    if (job.machineId) {
      const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(job.flyToken);
      await client.deleteMachine(job.appName, job.machineId, { force: true }).catch((error) => {
        this.log(`org-ci ${jobId}: could not kill timed-out machine ${job.machineId}: ${error instanceof Error ? error.message : error}`);
      });
    }
  }

  /** The deploy/<site> check of a run that carried a publish key, in the
   *  words our own lane uses (infra/ci-runner/ci-verdicts.mjs). Never left
   *  pending: a run that did not say still says the site was not published. */
  private async settlePublish(job: Pick<PendingJob, 'namespaceId' | 'repoId' | 'sha' | 'publishSite'>, outcome: PublishOutcome): Promise<void> {
    const site = job.publishSite!;
    let verdict: { state: GitCommitStatusState; description: string; logTail: string };
    try {
      verdict = (await loadCiVerdicts()).publishVerdict(outcome, site);
    } catch {
      verdict = { state: 'error', description: `Not published — ${site} could not be judged`, logTail: '' };
    }
    await this.writeStatus(job.namespaceId, job.repoId, job.sha, verdict.state, verdict.description,
      verdict.logTail || undefined, `deploy/${site}`);
  }

  private async writeStatus(
    namespaceId: string, repoId: string, sha: string,
    state: GitCommitStatusState, description: string, logTail?: string,
    context: string = ORG_CI_CONTEXT,
  ): Promise<void> {
    const existing = await this.deps.gitCommitStatusStorage.get(repoId, sha, context);
    const now = new Date().toISOString();
    const guest = this.deps.guest ?? ORG_CI_DEFAULT_GUEST;
    await this.deps.gitCommitStatusStorage.upsert({
      userId: namespaceId,
      repoId,
      sha,
      context,
      state,
      description: description.slice(0, 140),
      // Inherit only a pending's start (the double-build lesson pinned on the
      // central statuses route).
      startedAt: existing?.state === 'pending' && existing.startedAt ? existing.startedAt : now,
      ...(state !== 'pending' ? { completedAt: now } : {}),
      ...(logTail ? { logTail } : {}),
      // The shape the run's machine was created at, for the spending screen
      // to price its minutes (note #319) — the same guest `createMachine` got.
      // Only on the run's own check: deploy/<site> rides the same machine,
      // and pricing it twice would double the minutes (our lane does the same).
      ...(context === ORG_CI_CONTEXT ? { machine: { cpuKind: guest.cpu_kind, cpus: guest.cpus, memoryMb: guest.memory_mb } } : {}),
    });
  }
}
