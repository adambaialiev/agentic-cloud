import { describe, expect, it, vi } from 'vitest';
// The host-side module, imported straight from infra: the retention math is
// exactly the code that rots silently, so it is tested here where every push
// runs it — not trusted to a script only a live host executes.
// eslint-disable-next-line import/no-relative-packages
import { isoWeekKey, pruneList } from '../../../../infra/git-host/backup.mjs';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { OrgGitBackupService, ORG_GIT_BACKUP_CREDS_SECRET, describeOrgGitSweep } from '../../services/org-git-backup.js';
import { orgGitAppName } from '../../services/org-git-host.js';

describe('backup retention (the central discipline, ported)', () => {
  const now = new Date('2026-08-23T12:00:00Z');

  it('names ISO weeks the way the calendar does', () => {
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(new Date('2026-08-23T00:00:00Z'))).toBe('2026-W34');
    // Jan 1 2027 is a Friday of 2026's last ISO week.
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });

  it('keeps every daily inside the window and thins older ones to ISO weeks', () => {
    const dates = [
      '2026-08-22', '2026-08-15', '2026-08-10', // inside 14 days: kept
      '2026-08-05', '2026-08-04', '2026-08-03', // W32: 05 kept as its week's newest
      '2026-07-01', // ~7.5 weeks old, its week's only bundle: kept
      '2026-06-01', // ~12 weeks old: beyond the 8 weekly weeks — pruned
    ];
    expect(pruneList(dates, now)).toEqual(['2026-06-01', '2026-08-03', '2026-08-04']);
  });

  it('NEVER prunes the newest bundle, whatever its age — the rule that makes skip-unchanged safe', () => {
    expect(pruneList(['2025-01-01'], now)).toEqual([]);
    expect(pruneList(['2025-01-01', '2024-12-01'], now)).toEqual(['2024-12-01']);
  });

  it('an empty listing prunes nothing', () => {
    expect(pruneList([], now)).toEqual([]);
  });
});

async function build(args?: { withBackup?: boolean; credsLost?: boolean }) {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'admin-1' });
  await orgStorage.updateOrg(org.orgId, {
    git: {
      namespaceId: org.orgId,
      host: { app: 'iagit-x', flycastIp: 'fdaa::1', volumeId: 'vol_1' },
      ...(args?.withBackup
        ? { backup: { addOnName: 'iagit-x-bk', bucket: 'bkt', endpoint: 'https://t3.storage.dev' } }
        : {}),
    },
  });
  const secrets = new Map<string, string>();
  if (args?.withBackup && !args.credsLost) {
    secrets.set(`${org.orgId}:${ORG_GIT_BACKUP_CREDS_SECRET}`, JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }));
  }
  const runBackup = vi.fn(async () => ({ repos: 2, uploaded: 1, uploadedBytes: 10, unchanged: 1, pruned: 0, failed: [] as Array<{ repo: string; error: string }> }));
  const fly = {
    resolveOrganizationId: vi.fn(async () => 'org_gql_id'),
    createTigrisBucket: vi.fn(async () => ({
      bucket: 'fresh-bucket', endpoint: 'https://t3.storage.dev', accessKeyId: 'NEWAK', secretAccessKey: 'NEWSK', region: 'auto',
    })),
    deleteAddOn: vi.fn(async () => {}),
  };
  const service = new OrgGitBackupService({
    orgStorage,
    orgSecrets: {
      setOrgSecret: vi.fn(async (orgId: string, name: string, value: string) => { secrets.set(`${orgId}:${name}`, value); }),
      getOrgSecret: vi.fn(async (orgId: string, name: string) => secrets.get(`${orgId}:${name}`) ?? null),
    } as never,
    orgFly: { resolveOrgFlyContext: vi.fn(async () => ({ source: 'org' as const, orgSlug: 'acme', apiToken: 't' })) } as never,
    orgGitHost: { clientFor: vi.fn(async () => ({ runBackup })) } as never,
    makeFlyClient: () => fly as never,
  });
  return { service, orgStorage, org, fly, secrets, runBackup };
}

describe('OrgGitBackupService', () => {
  it('creates the bucket ONCE, stores the mint-once keys, and reuses them forever after', async () => {
    const { service, org, fly, secrets, orgStorage } = await build();
    const target = await service.ensureBackupTarget(org.orgId);
    expect(target).toEqual({ endpoint: 'https://t3.storage.dev', bucket: 'fresh-bucket', accessKeyId: 'NEWAK', secretAccessKey: 'NEWSK' });
    expect(secrets.get(`${org.orgId}:${ORG_GIT_BACKUP_CREDS_SECRET}`)).toContain('NEWAK');
    expect((await orgStorage.getOrg(org.orgId))?.git?.backup?.bucket).toBe('fresh-bucket');

    await service.ensureBackupTarget(org.orgId);
    expect(fly.createTigrisBucket).toHaveBeenCalledTimes(1);
  });

  it('a pointed bucket with lost credentials fails loudly — never a second bucket', async () => {
    const { service, org, fly } = await build({ withBackup: true, credsLost: true });
    await expect(service.ensureBackupTarget(org.orgId)).rejects.toThrow(/credentials secret is missing/);
    expect(fly.createTigrisBucket).not.toHaveBeenCalled();
  });

  it('a failed secret write unwinds the bucket it can no longer sign for', async () => {
    const { service, org, fly } = await build();
    (service as unknown as { deps: { orgSecrets: { setOrgSecret: () => Promise<never> } } })
      .deps.orgSecrets.setOrgSecret = async () => { throw new Error('store down'); };
    await expect(service.ensureBackupTarget(org.orgId)).rejects.toThrow('store down');
    expect(fly.deleteAddOn).toHaveBeenCalledWith(`${orgGitAppName(org.orgId)}-bk`);
  });

  it('the sweep visits orgs WITH hosts and reports each honestly', async () => {
    const { service, org, runBackup } = await build({ withBackup: true });
    const summaries = await service.sweep();
    expect(summaries).toEqual([expect.objectContaining({ orgId: org.orgId, ok: true })]);
    expect(summaries[0]!.detail).toContain('1 uploaded');
    expect(runBackup).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'bkt', accessKeyId: 'AK' }));

    runBackup.mockResolvedValueOnce({ repos: 1, uploaded: 0, uploadedBytes: 0, unchanged: 0, pruned: 0, failed: [{ repo: 'x/y', error: 'boom' }] });
    const [failedSummary] = await service.sweep();
    expect(failedSummary!.ok).toBe(false);
    expect(failedSummary!.detail).toContain('x/y (boom)');
  });

  it('the sweep stamps each run on the org — the per-org fact the Workspace reads', async () => {
    const { service, org, orgStorage, runBackup } = await build({ withBackup: true });
    await service.sweep();
    const stamped = (await orgStorage.getOrg(org.orgId))?.git?.backup?.last;
    expect(stamped?.ok).toBe(true);
    expect(stamped?.detail).toContain('1 uploaded');
    expect(Date.parse(stamped?.at ?? '')).not.toBeNaN();

    // A failed run overwrites honestly — the screen says FAILED, not stale-ok.
    runBackup.mockResolvedValueOnce({ repos: 1, uploaded: 0, uploadedBytes: 0, unchanged: 0, pruned: 0, failed: [{ repo: 'x/y', error: 'boom' }] });
    await service.sweep();
    const failed = (await orgStorage.getOrg(org.orgId))?.git?.backup?.last;
    expect(failed?.ok).toBe(false);
    expect(failed?.detail).toContain('x/y (boom)');
  });

  it('the FIRST sweep of a fresh org stamps too — the run itself just made the pointer', async () => {
    const { service, org, orgStorage } = await build();
    await service.sweep();
    const stamped = (await orgStorage.getOrg(org.orgId))?.git?.backup;
    expect(stamped?.bucket).toBe('fresh-bucket');
    expect(stamped?.last?.ok).toBe(true);
  });

  it('an org without a git host is not swept', async () => {
    const { service, orgStorage, org } = await build();
    await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
    expect(await service.sweep()).toEqual([]);
  });
});

describe('what a sweep tells the backup monitor', () => {
  it('an EMPTY sweep is a successful run, not a silence', () => {
    // The bug this exists for: reporting nothing froze the heartbeat at the
    // last host's final word, so retiring the last self-hosting org left the
    // ops bot repeating "BACKUP STALE — org-git" every day about an org that
    // had been deleted, with no run that could ever clear it (2026-09-07).
    expect(describeOrgGitSweep([])).toEqual({
      status: 'ok',
      detail: 'no org hosts its own git — nothing to back up',
    });
  });

  it('names every org it visited, shortened, and is ok only when all of them are', () => {
    const ok = { orgId: '87c99fa5-26a3-49b9-b676-d5bf667854dc', ok: true, detail: '1 repos · 0 uploaded (0 B) · 1 unchanged' };
    const bad = { orgId: 'ec4c119f-94f4-4880-affa-07828b90291c', ok: false, detail: 'fetch failed' };
    expect(describeOrgGitSweep([ok])).toEqual({ status: 'ok', detail: '87c99fa5: 1 repos · 0 uploaded (0 B) · 1 unchanged' });
    expect(describeOrgGitSweep([ok, bad])).toEqual({
      status: 'fail',
      detail: '87c99fa5: 1 repos · 0 uploaded (0 B) · 1 unchanged | ec4c119f: fetch failed',
    });
  });
});
