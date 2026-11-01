import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PASSWORD_HASH_BYTES = 64;
export const WORKSPACE_PASSWORD_MIN_LENGTH = 10;
export const WORKSPACE_PASSWORD_MAX_LENGTH = 256;

export function normalizeWorkspacePassword(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.length < WORKSPACE_PASSWORD_MIN_LENGTH || input.length > WORKSPACE_PASSWORD_MAX_LENGTH) return null;
  return input;
}

export function hashWorkspacePassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, PASSWORD_HASH_BYTES);
  return `scrypt:v1:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyWorkspacePassword(password: string, encoded: string): boolean {
  const [scheme, version, saltText, hashText] = encoded.split(':');
  if (scheme !== 'scrypt' || version !== 'v1' || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

