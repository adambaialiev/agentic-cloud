import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The owner's own git credential — the "laptop key" (slice 6 of
 * docs/agent-git-project-repos.md, made a prerequisite by
 * docs/platform-on-own-git.md: a person must be able to clone the platform
 * repo with nothing but a laptop).
 *
 * One per user, minted ONLY in the Mini App — the value appears once on the
 * owner's screen and nowhere else: never in chat, never in an agent's
 * transcript. Only its SHA-256 lands on the profile (`gitAccess.tokenHash`),
 * so a database read never yields a usable credential, and minting again is
 * the rotation. The git host learns nothing new: the token rides the same
 * `/git/verify` round trip as every agent token, answered from the profile.
 *
 * Shape mirrors agentbuilt-token.ts: `hum1.<base64url(userId)>.<secret>` —
 * the userId rides inside so verification is a single profile read, and the
 * prefix routes it before agent-token parsing pays anything.
 */

const TOKEN_PREFIX = 'hum1';

export interface MintedHumanGitToken {
  token: string;
  /** SHA-256 hex of the full token — the only part that may be persisted. */
  tokenHash: string;
}

export function mintHumanGitToken(userId: string): MintedHumanGitToken {
  const id = Buffer.from(userId, 'utf8').toString('base64url');
  const secret = randomBytes(24).toString('base64url');
  const token = `${TOKEN_PREFIX}.${id}.${secret}`;
  return { token, tokenHash: hashHumanGitToken(token) };
}

export function hashHumanGitToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function looksLikeHumanGitToken(token: string): boolean {
  return token.startsWith(`${TOKEN_PREFIX}.`);
}

/** The userId a well-formed token claims. Trusted only after {@link humanGitTokenMatches}. */
export function parseHumanGitToken(token: string): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[2]) return null;
  const userId = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  if (!userId) return null;
  return { userId };
}

export function humanGitTokenMatches(token: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const presented = Buffer.from(hashHumanGitToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
