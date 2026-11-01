import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** The authenticator contract. Exported so the enrollment response describes
 * the same parameters the generator and verifier actually use. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
const TOTP_WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;
const RECOVERY_SCRYPT_BYTES = 32;

function normalizeBase32(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const char of normalizeBase32(value)) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    while (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function normalizeTotpCode(code: string): string {
  return code.replace(/\D/g, '');
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function computeHotp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0;
  return (binary % (10 ** TOTP_DIGITS)).toString().padStart(TOTP_DIGITS, '0');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GeneratedTotpSecret {
  secret: string;
  otpauthUrl: string;
}

export interface TotpVerificationResult {
  ok: boolean;
  matchedStep?: number;
}

export function generateTotpSecret(label: string, issuer = 'Agentic Cloud Computer'): GeneratedTotpSecret {
  const secret = encodeBase32(randomBytes(20));
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  return {
    secret,
    otpauthUrl: `otpauth://totp/${encodedLabel}?secret=${secret}`
      + `&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`,
  };
}

/** Exported only for deterministic standards-vector and route tests. */
export function generateTotpCode(secret: string, nowMs: number = Date.now()): string {
  return computeHotp(secret, Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS));
}

export function verifyTotpCode(
  secret: string,
  code: string,
  options: { nowMs?: number; lastAcceptedStep?: number | null } = {},
): TotpVerificationResult {
  const normalized = normalizeTotpCode(code);
  if (normalized.length !== TOTP_DIGITS) return { ok: false };
  const current = Math.floor((options.nowMs ?? Date.now()) / 1000 / TOTP_PERIOD_SECONDS);
  const lastAccepted = options.lastAcceptedStep ?? null;
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    if (step < 0 || (lastAccepted !== null && step <= lastAccepted)) continue;
    if (safeEqual(computeHotp(secret, step), normalized)) return { ok: true, matchedStep: step };
  }
  return { ok: false };
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    // 16 base32 characters = 80 random bits. The grouping is for humans only.
    const raw = encodeBase32(randomBytes(RECOVERY_CODE_BYTES)).slice(0, 16);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

/**
 * Slow, salted recovery-code verifier. Recovery codes are high entropy, but a
 * database snapshot should still not turn them into fast offline guesses.
 */
export function hashRecoveryCode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizeRecoveryCode(code), salt, RECOVERY_SCRYPT_BYTES);
  return `scrypt:v1:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyRecoveryCode(code: string, encoded: string): boolean {
  const [scheme, version, saltText, hashText] = encoded.split(':');
  if (scheme !== 'scrypt' || version !== 'v1' || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, 'base64url');
    const actual = scryptSync(
      normalizeRecoveryCode(code),
      Buffer.from(saltText, 'base64url'),
      expected.length,
    );
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Stable digest for opaque bearer values; the values themselves never land in SQLite. */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
