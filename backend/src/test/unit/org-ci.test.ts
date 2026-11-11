import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemoryGitCommitStatusStorage } from '../../services/git-commit-status-storage.js';
import { OrgCiService, ORG_CI_CONTEXT } from '../../services/org-ci.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { SHARED_USER_SECRET_SCOPE, UserSecretsService } from '../../services/user-secrets.js';
import { verifyCiDeployToken } from '../../services/ci-deploy-token.js';

/**
 * CI in the client's org (byo-git slice 5): the webhook authenticates as the
 * org it claims to be, jobs boot in THAT org's Fly account with lane A's
 * exact env contract, granted secrets ride only protected branches, and the
 * machine's one report is verified against its own per-job token.
 */

const SHA = 'a'.repeat(40);

async function build(args?: { ci?: boolean; protectedBranch?: string; publish?: boolean; statFails?: boolean }) {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin-1' });
  await orgStorage.updateOrg(org.orgId, {
    git: { namespaceId: org.orgId, host: { app: 'iagit-x', flycastIp: 'fdaa::7', volumeId: 'v' } },
  });
  const gitRepoStorage = new InMemoryGitRepoStorage();
  const repo = await gitRepoStorage.create({
    userId: org.orgId, orgId: org.orgId, name: 'api', createdByAgentId: 'a1',
    sizeBytes: 0, protectDefaultBranch: true,
    ...(args?.ci !== false ? { ci: true } : {}),
    ciSecrets: ['DEPLOY_KEY'],
  } as never);
  // The workplace's own shared secret: what `repo ci-secrets` grants from
  // (note #1161). The operator store below holds a DIFFERENT value under the
  // same name, so a test can tell which store a run was given.
  const secretStorage = new InMemorySecretStorage();
  await new UserSecretsService(secretStorage)
    .setSecret(org.orgId, 'DEPLOY_KEY', 'dk-workplace-value', SHARED_USER_SECRET_SCOPE, 'Deploy key');
  const deploymentStorage = new InMemoryDeploymentStorage();
  const site = await deploymentStorage.create({
    userId: org.orgId, orgId: org.orgId, agentId: 'a1', name: 'docs-site', preset: 'static', status: 'live',
  } as never);
  if (args?.publish) {
    await gitRepoStorage.update(repo.id, {
      publishTo: { siteId: site.id, site: 'docs-site', byAgentId: 'a1', byUserId: 'admin-1', at: 't' },
    });
  }
  const statuses = new InMemoryGitCommitStatusStorage();
  const machines: unknown[] = [];
  const deleted: string[] = [];
  const fly = {
    createApp: vi.fn(async () => {}),
    createMachine: vi.fn(async (_app: string, config: unknown) => {
      machines.push(config);
      return { id: 'mach_ci_1' } as never;
    }),
    deleteMachine: vi.fn(async (_app: string, id: string) => { deleted.push(id); }),
    listMachines: vi.fn(async () => [] as never),
  };
  const secrets = new Map<string, string>([
    [`${org.orgId}:GIT_HOST_SECRET`, 'org-host-secret'],
    [`${org.orgId}:DEPLOY_KEY`, 'dk-operator-value'],
  ]);
  const service = new OrgCiService({
    orgStorage,
    orgSecrets: { getOrgSecret: async (orgId: string, name: string) => secrets.get(`${orgId}:${name}`) ?? null } as never,
    orgFly: { resolveOrgFlyContext: async () => ({ source: 'org' as const, orgSlug: 'acme', apiToken: 'tok' }) } as never,
    orgGitHost: {
      resolveContext: async () => ({ source: 'org' as const, baseUrl: 'http://[fdaa::7]:8080', controlUrl: 'http://[fdaa::7]:8080', secret: 's' }),
      clientFor: async () => ({
        statRepo: async () => {
          if (args?.statFails) throw new Error('host down');
          return { exists: true, sizeBytes: 0, protectedBranches: [args?.protectedBranch ?? 'main'] };
        },
      }),
    } as never,
    gitRepoStorage,
    gitCommitStatusStorage: statuses,
    secretStorage,
    deploymentStorage,
    ciStatusSecret: 'status-secret',
    machineImage: 'ghcr.io/example/images:sha-agent',
    backendUrl: 'https://api.example.test',
    region: 'ams',
    runnerScriptB64: Buffer.from('#!/bin/bash\necho hi\n').toString('base64'),
    makeFlyClient: () => fly as never,
  });
  return { service, org, repo, site, statuses, fly, machines, deleted, orgStorage, gitRepoStorage };
}

function push(orgId: string, over?: Record<string, unknown>) {
  return { ref: 'refs/heads/work', after: SHA, repository: { owner: orgId, name: 'api' }, ...over };
}

const sign = (secret: string, body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('OrgCiService.verifyWebhook', () => {
  it("accepts the org's own signature and refuses everyone else's", async () => {
    const { service, org } = await build();
    const body = Buffer.from(JSON.stringify(push(org.orgId)));
    expect(await service.verifyWebhook(body, sign('org-host-secret', body), org.orgId)).toBe(true);
    expect(await service.verifyWebhook(body, sign('some-other-secret', body), org.orgId)).toBe(false);
    expect(await service.verifyWebhook(body, sign('org-host-secret', body), 'unknown-org')).toBe(false);
  });
});

describe('OrgCiService.handlePush', () => {
  it('boots a machine in the ORG with lane A\'s env contract, token inside the clone URL', async () => {
    const { service, org, machines, statuses, repo } = await build();
    const outcome = await service.handlePush(push(org.orgId));
    expect(outcome.queued).toBe(true);
    await vi.waitFor(() => { expect(machines.length).toBe(1); });

    const config = machines[0] as { env: Record<string, string>; init: { exec: string[] }; autoDestroy: boolean; restart: { policy: string } };
    expect(config.env.CI_KIND).toBe('ci-script');
    expect(config.env.CI_SHA).toBe(SHA);
    expect(config.env.CI_REPO_URL).toContain(`x-access-token:`);
    expect(config.env.CI_REPO_URL).toContain(`[fdaa::7]:8080/${encodeURIComponent(org.orgId)}/api.git`);
    expect(config.env.CI_RESULT_URL).toBe('https://api.example.test/api/agent-cli/git/ci-result');
    expect(config.env.CI_RUNNER_B64).toBeTruthy();
    // Typed args, because extra keys are silently dropped by the client's
    // whitelist — the hang the live rehearsal found.
    expect(config.autoDestroy).toBe(true);
    expect(config.restart).toEqual({ policy: 'no' });
    expect(config.init.exec.join(' ')).toContain('runner-agent.sh');
    // work is not protected → the granted secret stays home.
    expect(config.env.DEPLOY_KEY).toBeUndefined();

    const pending = await statuses.get(repo.id, SHA, ORG_CI_CONTEXT);
    expect(pending?.state).toBe('pending');
  });

  it('hands the WORKPLACE secret that was granted, ONLY to a protected branch (note #1161)', async () => {
    const { service, org, machines } = await build({ protectedBranch: 'work' });
    await service.handlePush(push(org.orgId));
    await vi.waitFor(() => { expect(machines.length).toBe(1); });
    const config = machines[0] as { env: Record<string, string> };
    // The shared secret `repo ci-secrets` checked the name against — never
    // the operator store, which is what the run got before (confirmed live
    // on 11 Nov: "SECRET NOT PRESENT" on main).
    expect(config.env.DEPLOY_KEY).toBe('dk-workplace-value');
    expect(config.env.CI_SECRET_NAMES).toBe('DEPLOY_KEY');
  });

  it('runs without secrets or a key when protection cannot be confirmed — fails closed, still runs', async () => {
    const { service, org, machines } = await build({ protectedBranch: 'work', publish: true, statFails: true });
    await service.handlePush(push(org.orgId));
    await vi.waitFor(() => { expect(machines.length).toBe(1); });
    const config = machines[0] as { env: Record<string, string> };
    expect(config.env.DEPLOY_KEY).toBeUndefined();
    expect(config.env.CI_PUBLISH_TOKEN).toBeUndefined();
  });

  it('a push from an old room\'s namespace still finds its org and runs (notes #85, #843)', async () => {
    const { service, org, machines, orgStorage, gitRepoStorage } = await build();
    // A repository made in a room before the rooms were merged lives at that
    // room's old address, which the merge recorded on the workplace.
    await orgStorage.updateOrg(org.orgId, { roomsMerged: { mergedAt: '2026-10-30T15:00:00.000Z', namespaces: ['room-math'] } });
    await gitRepoStorage.create({
      userId: 'room-math', orgId: org.orgId, name: 'lessons', createdByAgentId: 'a2',
      sizeBytes: 0, protectDefaultBranch: true, ci: true,
    } as never);

    const outcome = await service.handlePush({
      ref: 'refs/heads/work', after: SHA, repository: { owner: 'room-math', name: 'lessons' },
    });
    // Without the reverse lookup this dies as "owner is not a workplace" —
    // CI silently over for every repository at an old address. The clone URL
    // keeps the OLD namespace: that is where the repo lives on disk.
    expect(outcome.queued).toBe(true);
    await vi.waitFor(() => { expect(machines.length).toBe(1); });
    const config = machines[0] as { env: Record<string, string> };
    expect(config.env.CI_REPO_URL).toContain('/room-math/lessons.git');
  });

  it('a repo without CI, a deleted ref, and a tag are all quiet no-ops', async () => {
    const { service, org } = await build({ ci: false });
    expect((await service.handlePush(push(org.orgId))).queued).toBe(false);
    const on = await build();
    expect((await on.service.handlePush(push(on.org.orgId, { deleted: true }))).queued).toBe(false);
    expect((await on.service.handlePush(push(on.org.orgId, { ref: 'refs/tags/v1' }))).queued).toBe(false);
  });
});

describe('OrgCiService.handleResult', () => {
  async function launched() {
    const built = await build();
    await built.service.handlePush(push(built.org.orgId));
    await vi.waitFor(() => { expect(built.machines.length).toBe(1); });
    const jobId = (built.machines[0] as { env: Record<string, string> }).env.CI_JOB_ID;
    const jobToken = (built.machines[0] as { env: Record<string, string> }).env.CI_JOB_TOKEN;
    return { ...built, jobId, jobToken };
  }

  it('a signed success lands a green status; exit 78 lands "skipped" green', async () => {
    const { service, jobId, jobToken, statuses, repo } = await launched();
    const body = Buffer.from(JSON.stringify({ jobId, exitCode: 0, totalSeconds: 61, logTailB64: Buffer.from('fine').toString('base64') }));
    expect((await service.handleResult(body, sign(jobToken, body))).ok).toBe(true);
    const doc = await statuses.get(repo.id, SHA, ORG_CI_CONTEXT);
    expect(doc?.state).toBe('success');
    expect(doc?.description).toContain('your own cloud');

    const again = await launched();
    const skip = Buffer.from(JSON.stringify({ jobId: again.jobId, exitCode: 78, totalSeconds: 2 }));
    await again.service.handleResult(skip, sign(again.jobToken, skip));
    expect((await again.statuses.get(again.repo.id, SHA, ORG_CI_CONTEXT))?.description).toContain('Skipped');
  });

  it('a bad signature and an unknown job are refused', async () => {
    const { service, jobId } = await launched();
    const body = Buffer.from(JSON.stringify({ jobId, exitCode: 0 }));
    expect((await service.handleResult(body, sign('wrong-token', body))).ok).toBe(false);
    const unknown = Buffer.from(JSON.stringify({ jobId: 'nope', exitCode: 0 }));
    expect((await service.handleResult(unknown, 'sha256=x')).ok).toBe(false);
  });

  it('a second report for the same job is refused — one machine, one verdict', async () => {
    const { service, jobId, jobToken } = await launched();
    const body = Buffer.from(JSON.stringify({ jobId, exitCode: 0 }));
    expect((await service.handleResult(body, sign(jobToken, body))).ok).toBe(true);
    expect((await service.handleResult(body, sign(jobToken, body))).ok).toBe(false);
  });
});

/**
 * A private copy (note #804): the copy's ONE git host is the central one and
 * its Fly account is the customer's, so a workplace there has neither a host
 * nor a cloud of its own — and its checks still run, in that account.
 */
describe('OrgCiService in a private copy', () => {
  async function buildCopy() {
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Theirco', createdByUserId: 'admin-1' });
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    const gitRepoStorage = new InMemoryGitRepoStorage();
    await gitRepoStorage.create({
      userId: org.orgId, orgId: org.orgId, name: 'api', createdByAgentId: 'a1',
      sizeBytes: 0, protectDefaultBranch: true, ci: true,
    } as never);
    const machines: Array<{ app: string; config: { env: Record<string, string> } }> = [];
    const hosting = vi.fn(async () => ({ source: 'platform' as const, orgSlug: 'theirco-fly', apiToken: 'their-token' }));
    const flyTokens: string[] = [];
    const service = new OrgCiService({
      orgStorage,
      orgSecrets: { getOrgSecret: async () => null } as never,
      orgFly: {
        resolveOrgFlyContext: async () => { throw new Error('org has no Fly org connected'); },
        resolveHostingContext: hosting,
      } as never,
      orgGitHost: {
        resolveContext: async () => ({ source: 'platform-env' as const, baseUrl: 'https://git.theirco.test', controlUrl: 'https://git.theirco.test', secret: 'central-secret' }),
        clientFor: async () => ({ statRepo: async () => ({ exists: true, sizeBytes: 0, protectedBranches: ['main'] }) }),
      } as never,
      gitRepoStorage,
      gitCommitStatusStorage: new InMemoryGitCommitStatusStorage(),
      ciStatusSecret: 'status-secret',
      machineImage: 'ghcr.io/example/images:sha-agent',
      backendUrl: 'https://agents.theirco.test',
      region: 'iad',
      runnerScriptB64: Buffer.from('#!/bin/bash\n').toString('base64'),
      makeFlyClient: (token: string) => {
        flyTokens.push(token);
        return {
          createApp: async () => {},
          createMachine: async (app: string, config: unknown) => { machines.push({ app, config: config as never }); return { id: 'm1' } as never; },
          deleteMachine: async () => {},
          listMachines: async () => [] as never,
        } as never;
      },
      privateCopyCentralHost: { secret: 'central-secret' },
    });
    return { service, org, machines, hosting, flyTokens };
  }

  it('accepts the central host signature for a workplace with no host of its own', async () => {
    const { service, org } = await buildCopy();
    const body = Buffer.from(JSON.stringify(push(org.orgId)));
    expect(await service.verifyWebhook(body, sign('central-secret', body), org.orgId)).toBe(true);
    expect(await service.verifyWebhook(body, sign('org-host-secret', body), org.orgId)).toBe(false);
  });

  it("runs the job in the copy's own account and clones over HTTPS from the central host", async () => {
    const { service, org, machines, hosting, flyTokens } = await buildCopy();
    expect((await service.handlePush(push(org.orgId))).queued).toBe(true);
    await vi.waitFor(() => { expect(machines.length).toBe(1); });
    expect(hosting).toHaveBeenCalledWith(org.orgId);
    expect(flyTokens).toEqual(['their-token']);
    const url = machines[0].config.env.CI_REPO_URL;
    expect(url.startsWith('https://x-access-token:')).toBe(true);
    expect(url).toContain(`@git.theirco.test/${encodeURIComponent(org.orgId)}/api.git`);
  });

  it('stays off without the switch: a hosted workplace is still "no host of its own"', async () => {
    const orgStorage = new InMemoryOrgStorage();
    const org = await orgStorage.createOrg({ name: 'Hosted', createdByUserId: 'admin-1' });
    const service = new OrgCiService({
      orgStorage,
      orgSecrets: { getOrgSecret: async () => null } as never,
      orgFly: {} as never,
      orgGitHost: {} as never,
      gitRepoStorage: new InMemoryGitRepoStorage(),
      gitCommitStatusStorage: new InMemoryGitCommitStatusStorage(),
      ciStatusSecret: 's', machineImage: 'img', backendUrl: 'https://b', region: 'ams', runnerScriptB64: 'eA==',
    });
    expect(await service.handlePush(push(org.orgId))).toEqual({ queued: false, reason: 'owner is not an org with its own git host' });
  });

});

describe('OrgCiService publishing on approval (note #1161)', () => {
  async function linked(args?: { protectedBranch?: string }) {
    const built = await build({ protectedBranch: args?.protectedBranch ?? 'work', publish: true });
    await built.service.handlePush(push(built.org.orgId));
    await vi.waitFor(() => { expect(built.machines.length).toBe(1); });
    const env = (built.machines[0] as { env: Record<string, string> }).env;
    return { ...built, env };
  }
  const report = (jobId: string, body: Record<string, unknown>) => Buffer.from(JSON.stringify({ jobId, totalSeconds: 9, ...body }));

  it('a protected-branch run of a linked repo carries a one-hour key for that site and commit, and files deploy/<site> pending', async () => {
    const { env, repo, site, statuses } = await linked();
    expect(env.CI_PUBLISH_SITE).toBe('docs-site');
    expect(env.CI_PUBLISH_API_URL).toBe('https://api.example.test');
    const scope = verifyCiDeployToken('status-secret', env.CI_PUBLISH_TOKEN);
    expect(scope).toMatchObject({ repoId: repo.id, siteId: site.id, sha: SHA });
    const pending = await statuses.get(repo.id, SHA, 'deploy/docs-site');
    expect(pending?.state).toBe('pending');
    expect(pending?.description).toContain('once the checks pass');
    // Its minutes are priced once, on the run's own check.
    expect(pending?.machine).toBeUndefined();
  });

  it('no key on a branch that is not protected', async () => {
    const { env, repo, statuses } = await linked({ protectedBranch: 'main' });
    expect(env.CI_PUBLISH_TOKEN).toBeUndefined();
    expect(await statuses.get(repo.id, SHA, 'deploy/docs-site')).toBeNull();
  });

  it('settles deploy/<site> from the runner\'s publish step, in our own lane\'s words, before ci/checks', async () => {
    const { service, env, repo, statuses } = await linked();
    const body = report(env.CI_JOB_ID, {
      exitCode: 0,
      publish: { exitCode: 0, logTailB64: Buffer.from('Live at https://docs-site.example').toString('base64') },
    });
    expect((await service.handleResult(body, sign(env.CI_JOB_TOKEN, body))).ok).toBe(true);
    const published = await statuses.get(repo.id, SHA, 'deploy/docs-site');
    expect(published?.state).toBe('success');
    expect(published?.description).toBe('Published docs-site');
    expect(published?.logTail).toContain('Live at');
    expect((await statuses.get(repo.id, SHA, ORG_CI_CONTEXT))?.state).toBe('success');
  });

  it('says why a site was not published: red checks, no deploy.sh, a failed deploy, a lost step', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ exitCode: 1 }, 'skipped', 'the checks did not pass'],
      [{ exitCode: 0, publish: { exitCode: 78, logTailB64: '' } }, 'skipped', 'commit a .agentbuilt/deploy.sh'],
      [{ exitCode: 0, publish: { exitCode: 2, logTailB64: '' } }, 'failure', 'failed (exit 2)'],
      [{ exitCode: 0 }, 'error', 'did not report'],
    ];
    for (const [result, state, words] of cases) {
      const { service, env, repo, statuses } = await linked();
      const body = report(env.CI_JOB_ID, result);
      await service.handleResult(body, sign(env.CI_JOB_TOKEN, body));
      const doc = await statuses.get(repo.id, SHA, 'deploy/docs-site');
      expect(doc?.state, JSON.stringify(result)).toBe(state);
      expect(doc?.description).toContain(words);
    }
  });
});

