import type { SecretStorage } from './secret-storage.js';
import type {
  SecretDocument,
  CreateSecretInput,
  UpdateSecretInput,
} from '../types/secret.js';
import type { SecretCipher } from './secret-cipher.js';

/**
 * Wraps any {@link SecretStorage} so values are encrypted on the way in and
 * decrypted on the way out. Consumers (user-secrets, the harness login flows,
 * managed bots) keep reading `secret.value` as plaintext and never know; the
 * inner storage and the DB file underneath it only ever see ciphertext.
 *
 * Legacy plaintext rows decrypt as themselves (see SecretCipher), so this can
 * be deployed before scripts/encrypt-secrets.mjs has converted the table.
 */
export class EncryptedSecretStorage implements SecretStorage {
  constructor(
    private readonly inner: SecretStorage,
    private readonly cipher: SecretCipher,
  ) {}

  private reveal(secret: SecretDocument): SecretDocument {
    return { ...secret, value: this.cipher.decrypt(secret.value) };
  }

  async getUserSecrets(userId: string): Promise<SecretDocument[]> {
    return (await this.inner.getUserSecrets(userId)).map((secret) => this.reveal(secret));
  }

  async getSecret(userId: string, secretId: string): Promise<SecretDocument | null> {
    const secret = await this.inner.getSecret(userId, secretId);
    return secret ? this.reveal(secret) : null;
  }

  async getSecretByKey(userId: string, key: string): Promise<SecretDocument | null> {
    const secret = await this.inner.getSecretByKey(userId, key);
    return secret ? this.reveal(secret) : null;
  }

  async createSecret(userId: string, input: CreateSecretInput): Promise<SecretDocument> {
    const created = await this.inner.createSecret(userId, {
      ...input,
      value: this.cipher.encrypt(input.value),
    });
    return { ...created, value: input.value };
  }

  async updateSecret(userId: string, secretId: string, input: UpdateSecretInput): Promise<void> {
    await this.inner.updateSecret(
      userId,
      secretId,
      input.value !== undefined ? { ...input, value: this.cipher.encrypt(input.value) } : input,
    );
  }

  async deleteSecret(userId: string, secretId: string): Promise<void> {
    await this.inner.deleteSecret(userId, secretId);
  }
}
