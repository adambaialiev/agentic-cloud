import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The key an approved CI run publishes its repository's linked site with
 * (`agentbuilt repo publish`).
 *
 * Why it is not an agent's own `agb1.` token: that token is re-minted on
 * every identity write — several times a day across the fleet — so a copy
 * saved as a CI secret died within hours, and it carried the agent's whole
 * power (mail, proposals, notes) into a machine running repository code. An
 * agent that wanted its merges to go live had to publish them by hand.
 *
 * This one is minted by `/git/ci-secrets` for ONE job: a protected-branch run
 * of a repository whose owner allowed the link. The scope rides inside it —
 * the repository, the site, the commit — and it is dead within the hour.
 * `/deploy` checks the link again on use, so taking the link off stops a key
 * that is already out. Stateless for the same reasons as the clone token
 * (`ci-clone-token.ts`): a signature check rather than a storage read, with a
 * subkey of the CI status secret so this MAC use stays separate from every
 * other one.
 *
 * Shape: `cdt1.<base64url(JSON [repoId, siteId, sha, expiresAtMs])>.<base64url hmac>`.
 * The prefix is how `/deploy` tells it from an agent token before anything
 * else is read, and why a refusal here never touches an agent record.
 */

const PREFIX = 'cdt1';

/** Long enough for a full suite plus the publish after it; the host fails
 *  any check still pending after 30 minutes. */
export const CI_DEPLOY_TOKEN_TTL_MS = 60 * 60_000;

export interface CiDeployTokenScope {
  repoId: string;
  siteId: string;
  sha: string;
}

function signingKey(ciStatusSecret: string): Buffer {
  return createHmac('sha256', ciStatusSecret).update('ci-deploy-token-v1', 'utf8').digest();
}

function signature(ciStatusSecret: string, prefixAndPayload: string): string {
  return createHmac('sha256', signingKey(ciStatusSecret))
    .update(prefixAndPayload, 'utf8')
    .digest('base64url');
}

export function looksLikeCiDeployToken(token: string): boolean {
  return token.startsWith(`${PREFIX}.`);
}

export function mintCiDeployToken(
  ciStatusSecret: string,
  scope: CiDeployTokenScope,
  ttlMs: number = CI_DEPLOY_TOKEN_TTL_MS,
): { token: string; expiresAt: string } {
  const expiresAtMs = Date.now() + Math.min(Math.max(ttlMs, 60_000), CI_DEPLOY_TOKEN_TTL_MS);
  const payload = Buffer.from(
    JSON.stringify([scope.repoId, scope.siteId, scope.sha, expiresAtMs]),
    'utf8',
  ).toString('base64url');
  const body = `${PREFIX}.${payload}`;
  return {
    token: `${body}.${signature(ciStatusSecret, body)}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** The scope a valid key grants, or null for anything malformed, forged or expired. */
export function verifyCiDeployToken(ciStatusSecret: string, token: string): CiDeployTokenScope | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const presented = Buffer.from(parts[2]!, 'utf8');
  const expected = Buffer.from(signature(ciStatusSecret, `${PREFIX}.${parts[1]!}`), 'utf8');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 4) return null;
    const [repoId, siteId, sha, expiresAtMs] = decoded;
    if (typeof repoId !== 'string' || !repoId || typeof siteId !== 'string' || !siteId) return null;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return null;
    if (typeof expiresAtMs !== 'number' || Date.now() >= expiresAtMs) return null;
    return { repoId, siteId, sha };
  } catch {
    return null;
  }
}
