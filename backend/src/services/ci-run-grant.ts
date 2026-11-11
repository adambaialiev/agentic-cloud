import { UserSecretsService } from './user-secrets.js';
import { mintCiDeployToken } from './ci-deploy-token.js';
import type { SecretStorage } from './secret-storage.js';
import type { DeploymentStorage } from './deployment-storage.js';
import { repoCiSecretsNamespaceId, type GitRepoDocument } from '../types/git-repo.js';

/**
 * What ONE check run receives (note #1161): the granted shared secrets and,
 * for a linked repository, a one-hour key that publishes its site. The one
 * rule, used by both controllers: `/git/ci-secrets` answers our own
 * dispatcher with it, and an own cloud's OrgCiService calls it in-process.
 * Before this, OrgCiService decided by itself, read the wrong store, and
 * never published.
 *
 * Both only on a branch the host calls protected right now, asked fresh per
 * run (`protectedBranches`): code someone approved through the merge gate.
 * When protection cannot be confirmed this throws
 * {@link CiProtectionUnknownError}, and the caller fails closed.
 */
export interface CiRunGrant {
  secrets: Record<string, string>;
  publish: { site: string; token: string; apiUrl: string; expiresAt: string } | null;
}

export class CiProtectionUnknownError extends Error {}

const NOTHING: CiRunGrant = { secrets: {}, publish: null };

export async function ciRunGrant(args: {
  doc: GitRepoDocument;
  /** The branch as the git host spells it, e.g. `main`. */
  ref: string;
  sha: string;
  secretStorage: SecretStorage;
  deploymentStorage?: Pick<DeploymentStorage, 'get'>;
  ciStatusSecret: string;
  /** The public API address the run's CLI publishes through; none, no key. */
  agentbuiltApiUrl?: string;
  protectedBranches: () => Promise<string[]>;
}): Promise<CiRunGrant> {
  const { doc, ref, sha } = args;
  const granted = doc.ciSecrets ?? [];
  // A publish key needs the commit it publishes (a runner from before this
  // field sends none, and so publishes nothing) and the public address the
  // job's CLI will call.
  const publishes = Boolean(doc.publishTo && args.agentbuiltApiUrl && /^[0-9a-f]{40}$/.test(sha));
  if ((granted.length === 0 && !publishes) || !ref) return NOTHING;
  // Protection is the host's fact, asked fresh per job — a stale copy here
  // would keep paying secrets into a branch someone just unprotected.
  let protectedBranches: string[];
  try {
    protectedBranches = await args.protectedBranches();
  } catch (error) {
    throw new CiProtectionUnknownError(error instanceof Error ? error.message : String(error));
  }
  if (!protectedBranches.includes(ref)) return NOTHING;
  // The grant names the namespace it was asked from. Secrets are the
  // workplace's (note #783; the store maps the namespace) — the same set
  // `ci-secrets` validated the names against, so what was granted and what
  // the job receives are one list.
  const secrets: Record<string, string> = {};
  if (granted.length > 0) {
    const env = await new UserSecretsService(args.secretStorage)
      .getSecretEnv(repoCiSecretsNamespaceId(doc), undefined, { ownerIsAdmin: true });
    for (const key of granted) {
      if (env[key] !== undefined && !/^CI_/i.test(key)) secrets[key] = env[key];
    }
  }
  // Publishing on approval (`repo publish`): a key for this ONE job, this
  // site and this commit, dead within the hour. The runner hands it only to
  // the publish step after ci.sh passes; `/deploy` re-checks the link when
  // it is used. The site's CURRENT name, because a rename keeps the link.
  const site = publishes ? await args.deploymentStorage?.get(doc.publishTo!.siteId).catch(() => null) : null;
  if (!publishes || !site || site.status === 'destroyed') return { secrets, publish: null };
  const minted = mintCiDeployToken(args.ciStatusSecret, { repoId: doc.id, siteId: site.id, sha });
  return {
    secrets,
    publish: { site: site.name, token: minted.token, apiUrl: args.agentbuiltApiUrl!, expiresAt: minted.expiresAt },
  };
}
