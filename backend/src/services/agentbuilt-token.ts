import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-agent tokens for the `agentbuilt` CLI (docs/deployments-phase1.md).
 *
 * An agent machine holds exactly one credential for production hosting: this
 * token, minted by the identity writer and stored on the machine's durable
 * volume. It maps to `{userId, agentId}` and grants only the /api/agent-cli
 * surface — never Fly, Cloudflare, or Paddle. Only its SHA-256 lands on the
 * agent record, so a database read never yields a usable credential; rotation
 * is "mint a new one", which every identity rewrite does.
 *
 * Shape: `agb1.<base64url([userId, agentId])>.<base64url secret>` — dots as
 * separators because they can never appear in base64url output. The ids ride
 * inside the token so verification is a single profile read (hash the
 * presented token, compare against that agent's stored hash) instead of a
 * scan over all users.
 */

const TOKEN_PREFIX = 'agb1';

export interface MintedAgentbuiltToken {
  token: string;
  /** SHA-256 hex of the full token — the only part that may be persisted. */
  tokenHash: string;
}

export function mintAgentbuiltToken(userId: string, agentId: string): MintedAgentbuiltToken {
  const ids = Buffer.from(JSON.stringify([userId, agentId]), 'utf8').toString('base64url');
  const secret = randomBytes(24).toString('base64url');
  const token = `${TOKEN_PREFIX}.${ids}.${secret}`;
  return { token, tokenHash: hashAgentbuiltToken(token) };
}

export function hashAgentbuiltToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The ids a well-formed token claims. The claim is only trusted after {@link agentbuiltTokenMatches}. */
export function parseAgentbuiltToken(token: string): { userId: string; agentId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [userId, agentId] = decoded;
    if (typeof userId !== 'string' || typeof agentId !== 'string' || !userId || !agentId) return null;
    return { userId, agentId };
  } catch {
    return null;
  }
}

export function agentbuiltTokenMatches(token: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const presented = Buffer.from(hashAgentbuiltToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
