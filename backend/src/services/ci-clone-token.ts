import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Read-only, single-repo, short-TTL clone tokens for CI jobs
 * (docs/ci-two-lane-runner.md → "Credentials, precisely").
 *
 * The CI dispatcher mints one per job and hands it to an ephemeral machine
 * that runs code nobody has reviewed. Worthless if exfiltrated is the design
 * goal, so the scope rides INSIDE the token: one repo, read access, dead by
 * the time anyone could reuse it. `/git/verify` recognizes the shape and
 * answers the git host with a `scope` object the host enforces.
 *
 * Stateless on purpose: HMAC-signed with a key derived from the CI status
 * secret, so verification is a signature check, not a storage read, and a
 * backend restart invalidates nothing. Deriving a subkey (rather than using
 * the secret directly) keeps this MAC use separate from the secret's bearer
 * use on the ingest routes.
 *
 * Shape: `cit1.<base64url(JSON [owner, repo, expiresAtMs])>.<base64url hmac>`
 * — same dot-separated convention as agentbuilt tokens, distinct prefix so
 * `/git/verify` can route on the first characters.
 */

const PREFIX = 'cit1';

export const CI_CLONE_TOKEN_DEFAULT_TTL_MS = 30 * 60_000;
export const CI_CLONE_TOKEN_MAX_TTL_MS = 60 * 60_000;

function signingKey(ciStatusSecret: string): Buffer {
  return createHmac('sha256', ciStatusSecret).update('ci-clone-token-v1', 'utf8').digest();
}

function signature(ciStatusSecret: string, prefixAndPayload: string): string {
  return createHmac('sha256', signingKey(ciStatusSecret))
    .update(prefixAndPayload, 'utf8')
    .digest('base64url');
}

export function looksLikeCiCloneToken(token: string): boolean {
  return token.startsWith(`${PREFIX}.`);
}

export function mintCiCloneToken(
  ciStatusSecret: string,
  owner: string,
  repo: string,
  ttlMs: number = CI_CLONE_TOKEN_DEFAULT_TTL_MS,
): { token: string; expiresAt: string } {
  const ttl = Math.min(Math.max(ttlMs, 60_000), CI_CLONE_TOKEN_MAX_TTL_MS);
  const expiresAtMs = Date.now() + ttl;
  const payload = Buffer.from(JSON.stringify([owner, repo, expiresAtMs]), 'utf8').toString('base64url');
  const body = `${PREFIX}.${payload}`;
  return {
    token: `${body}.${signature(ciStatusSecret, body)}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** The scope a valid token grants, or null for anything malformed, forged or expired. */
export function verifyCiCloneToken(
  ciStatusSecret: string,
  token: string,
): { owner: string; repo: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const presented = Buffer.from(parts[2]!, 'utf8');
  const expected = Buffer.from(signature(ciStatusSecret, `${PREFIX}.${parts[1]!}`), 'utf8');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 3) return null;
    const [owner, repo, expiresAtMs] = decoded;
    if (typeof owner !== 'string' || !owner || typeof repo !== 'string' || !repo) return null;
    if (typeof expiresAtMs !== 'number' || Date.now() >= expiresAtMs) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}
