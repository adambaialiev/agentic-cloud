import { FlyClient } from './fly-client.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';
import type { OrgFlyService } from './org-fly.js';
import type { OrgGitHostService } from './org-git-host.js';
import { orgGitAppName } from './org-git-host.js';

/**
 * Backups that live with the code (byo-git-design slice 4): every org git
 * host gets its bundles shipped to a bucket in the ORG'S OWN Fly account —
 * their bill, their custody, restorable with nothing but git and the keys in
 * their own secret store.
 *
 * The clock lives HERE, not on the host: an org git host sleeps between
 * pushes and a stopped machine fires no timers, so the backend's sweep wakes
 * each host, hands it the bucket and credentials for exactly one run, and
 * records the summary. The heartbeat rides the existing backup monitor, so a
 * sweep that stops happening alerts the same way the central host's nightly
 * would.
 *
 * Bucket provisioning is the one-shot the live probe proved (2026-08-23):
 * `createAddOn` answers the S3 credentials ONCE, in the create response, and
 * never again — so they are written to the org-secret store in the same
 * breath, and a creation whose write fails is deleted rather than left as a
 * bucket nobody can ever sign for.
 */

export const ORG_GIT_BACKUP_CREDS_SECRET = 'GIT_BACKUP_CREDS';

export interface OrgBackupTarget {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface OrgBackupSummary {
  orgId: string;
  ok: boolean;
  detail: string;
}

export class OrgGitBackupError extends Error {}

export interface OrgGitBackupServiceDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'updateOrg' | 'listOrgs'>;
  orgSecrets: Pick<OrgSecretsService, 'setOrgSecret' | 'getOrgSecret'>;
  orgFly: Pick<OrgFlyService, 'resolveOrgFlyContext'>;
  orgGitHost: Pick<OrgGitHostService, 'clientFor'>;
  makeFlyClient?: (apiToken: string) => Pick<FlyClient, 'resolveOrganizationId' | 'createTigrisBucket' | 'deleteAddOn'>;
  log?: (line: string) => void;
}

export class OrgGitBackupService {
  constructor(private readonly deps: OrgGitBackupServiceDeps) {}

  private get log() { return this.deps.log ?? (() => {}); }

  /** The org's bucket and keys — created on first use, read from the org's
   *  own secret store forever after. */
  async ensureBackupTarget(orgId: string): Promise<OrgBackupTarget> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) throw new OrgGitBackupError(`org ${orgId} does not exist`);
    if (org.git?.backup) {
      const raw = await this.deps.orgSecrets.getOrgSecret(
        orgId,
        org.git.backup.credsSecretName ?? ORG_GIT_BACKUP_CREDS_SECRET,
      );
      if (!raw) {
        // Never re-create over a pointed bucket: the credentials were minted
        // once, so a lost secret is an operator conversation, not a second
        // bucket with the first one's bundles stranded in it.
        throw new OrgGitBackupError(
          `org ${orgId} points at backup bucket ${org.git.backup.bucket} but its credentials secret is missing`,
        );
      }
      const creds = JSON.parse(raw) as { accessKeyId: string; secretAccessKey: string };
      return {
        endpoint: org.git.backup.endpoint,
        bucket: org.git.backup.bucket,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      };
    }
    const fly = await this.deps.orgFly.resolveOrgFlyContext(orgId);
    if (fly.source !== 'org') {
      throw new OrgGitBackupError(`org ${orgId} has no Fly org of its own — nowhere of theirs to put a bucket`);
    }
    const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(fly.apiToken);
    const organizationId = await client.resolveOrganizationId(fly.orgSlug);
    const addOnName = `${orgGitAppName(orgId)}-bk`;
    const created = await client.createTigrisBucket({ organizationId, name: addOnName });
    try {
      // Secret before pointer, and the mint-once credentials first of all: a
      // crash after creation but before this write leaves a bucket nobody
      // can sign for — the catch below deletes it so the next run starts
      // clean instead of tripping over it.
      await this.deps.orgSecrets.setOrgSecret(
        orgId,
        ORG_GIT_BACKUP_CREDS_SECRET,
        JSON.stringify({ accessKeyId: created.accessKeyId, secretAccessKey: created.secretAccessKey }),
        `S3 keys for this workplace's own git-backup bucket (${created.bucket}) — minted once at creation`,
      );
      await this.deps.orgStorage.updateOrg(orgId, {
        git: {
          ...(org.git ?? { namespaceId: orgId }),
          backup: {
            addOnName,
            bucket: created.bucket,
            endpoint: created.endpoint,
            credsSecretName: ORG_GIT_BACKUP_CREDS_SECRET,
          },
        },
      });
    } catch (error) {
      await client.deleteAddOn(addOnName).catch(() => { /* best-effort unwind */ });
      throw error;
    }
    this.log(`created backup bucket ${created.bucket} for org ${orgId}`);
    return {
      endpoint: created.endpoint,
      bucket: created.bucket,
      accessKeyId: created.accessKeyId,
      secretAccessKey: created.secretAccessKey,
    };
  }

  /** One org: wake its host, hand it the bucket, record what happened. */
  async runOrgBackup(orgId: string): Promise<OrgBackupSummary> {
    try {
      const target = await this.ensureBackupTarget(orgId);
      const host = await this.deps.orgGitHost.clientFor(orgId);
      const run = await host.runBackup(target);
      const ok = run.failed.length === 0;
      const detail = `${run.repos} repos · ${run.uploaded} uploaded (${run.uploadedBytes} B) · ${run.unchanged} unchanged`
        + (run.pruned ? ` · ${run.pruned} pruned` : '')
        + (ok ? '' : ` · FAILED: ${run.failed.map((f) => `${f.repo} (${f.error})`).join('; ')}`);
      return { orgId, ok, detail };
    } catch (error) {
      return { orgId, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Every org that HAS a git host of its own. The central host is not here —
   * its timers and Storage Box discipline predate this and keep running
   * unchanged on the box itself.
   */
  async sweep(): Promise<OrgBackupSummary[]> {
    const summaries: OrgBackupSummary[] = [];
    for (const org of await this.deps.orgStorage.listOrgs()) {
      if (!org.git?.host) continue;
      const summary = await this.runOrgBackup(org.orgId);
      this.log(`org-git-backup ${org.orgId}: ${summary.ok ? 'ok' : 'FAIL'} — ${summary.detail}`);
      await this.recordLastRun(org.orgId, summary);
      summaries.push(summary);
    }
    return summaries;
  }

  /**
   * Stamp the run's outcome on the org's own backup pointer — the per-org
   * "last backup" fact the Workspace's git block reads. Best-effort and
   * re-read (the run itself may have just created the pointer); a failed run
   * before any bucket exists has nowhere to land and that is fine — the
   * screen honestly says no backup has happened yet.
   */
  private async recordLastRun(orgId: string, summary: OrgBackupSummary): Promise<void> {
    try {
      const org = await this.deps.orgStorage.getOrg(orgId);
      if (!org?.git?.backup) return;
      await this.deps.orgStorage.updateOrg(orgId, {
        git: {
          ...org.git,
          backup: {
            ...org.git.backup,
            last: { at: new Date().toISOString(), ok: summary.ok, detail: summary.detail },
          },
        },
      });
    } catch (error) {
      this.log(`org-git-backup ${orgId}: could not record the run on the org (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

/**
 * What a sweep's summaries mean to the backup monitor.
 *
 * An EMPTY sweep is a successful one, not a silence. Reporting nothing when no
 * org hosts its own git looks harmless until the last such org is retired:
 * the heartbeat then freezes at whatever that host last left behind, and since
 * no future run can ever clear it, the monitor repeats "BACKUP STALE" for ever
 * about an org that no longer exists. Recording the empty sweep says the true
 * thing — the clock ran, and there was nothing to copy.
 */
export function describeOrgGitSweep(summaries: OrgBackupSummary[]): { status: 'ok' | 'fail'; detail: string } {
  if (summaries.length === 0) {
    return { status: 'ok', detail: 'no org hosts its own git — nothing to back up' };
  }
  return {
    status: summaries.every((summary) => summary.ok) ? 'ok' : 'fail',
    detail: summaries.map((summary) => `${summary.orgId.slice(0, 8)}: ${summary.detail}`).join(' | '),
  };
}
