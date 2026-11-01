import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level encryption for secret VALUES at rest (docs/user-secrets.md).
 *
 * Why this exists: the secrets table holds every user's API keys and the
 * platform's own credentials in one SQLite file, and a nightly snapshot of
 * that file leaves the box for off-box storage (infra/db-backup). Encrypting
 * just the value field makes the DB file and every backup of it useless
 * without `SECRETS_MASTER_KEY`, which lives only in backend.env — so a leaked
 * copy of either artifact alone is no longer a credential leak. It is NOT a
 * defense against a compromised backend host, which holds both.
 *
 * This is not hypothetical: the snapshots taken before encryption landed were
 * plaintext, and one of them had already been copied off-box. They were all
 * destroyed on 2026-08-12 — but only because someone went looking.
 *
 * An encrypted value is stored as `enc:v1:<base64(nonce || ciphertext || tag)>`
 * — AES-256-GCM, a fresh random 96-bit nonce per encryption. A value without
 * the `enc:` tag is legacy plaintext and is returned as-is, so rows from
 * before encryption keep working with no migration step required to deploy
 * (scripts/encrypt-secrets.mjs converts them afterwards). The `v1` in the tag
 * is what makes a future key or scheme rotation expressible.
 */

const ENCRYPTED_TAG = 'enc:';
const V1_PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export class SecretCipherError extends Error {}

export class SecretCipher {
  private readonly key: Buffer;

  /** @param masterKey base64 of exactly 32 bytes (`openssl rand -base64 32`). */
  constructor(masterKey: string) {
    const key = Buffer.from(masterKey.trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new SecretCipherError(
        `SECRETS_MASTER_KEY must be base64 of exactly ${KEY_BYTES} bytes (openssl rand -base64 32); got ${key.length} bytes.`,
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return V1_PREFIX + Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
  }

  /** Plaintext of a stored value; legacy untagged values pass through as-is. */
  decrypt(stored: string): string {
    if (!isEncryptedSecretValue(stored)) return stored;
    if (!stored.startsWith(V1_PREFIX)) {
      throw new SecretCipherError(
        `Unknown secret encryption version: ${stored.slice(0, stored.indexOf(':', ENCRYPTED_TAG.length) + 1)}… — written by a newer build?`,
      );
    }
    const blob = Buffer.from(stored.slice(V1_PREFIX.length), 'base64');
    if (blob.length < NONCE_BYTES + GCM_TAG_BYTES) {
      throw new SecretCipherError('Encrypted secret value is truncated.');
    }
    const nonce = blob.subarray(0, NONCE_BYTES);
    const ciphertext = blob.subarray(NONCE_BYTES, blob.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(blob.subarray(blob.length - GCM_TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretCipherError(
        'Secret value failed authentication — wrong SECRETS_MASTER_KEY, or a corrupted row.',
      );
    }
  }
}

export function isEncryptedSecretValue(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_TAG);
}

/** The configured cipher, or null when SECRETS_MASTER_KEY is unset (plaintext mode). */
export function secretCipherFromEnv(env: NodeJS.ProcessEnv = process.env): SecretCipher | null {
  const masterKey = env.SECRETS_MASTER_KEY?.trim();
  return masterKey ? new SecretCipher(masterKey) : null;
}
