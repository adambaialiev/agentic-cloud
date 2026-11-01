import type { SecretStorage } from './secret-storage.js';
import type { CreateSecretInput, SecretDocument, UpdateSecretInput } from '../types/secret.js';

/** Maps the namespace a caller stands in to the one whose secrets it reads. */
export type SecretShelfResolver = (namespaceId: string) => Promise<string>;

/**
 * ONE set of secrets per workplace (note #783).
 *
 * Every reader and writer of user secrets — the turn's environment, the
 * agent CLI, the Workspace, a site's `--secret`, a bucket's four keys, CI
 * grants — names the namespace of the ROOM it stands in. Rather than teach
 * each of them where the workplace keeps its keys, this wraps the storage
 * they already hold and maps that owner through the resolver on every call:
 * a room's namespace answers with the workplace's own once its shelf has
 * been merged, and with itself before that (or for a personal account, or
 * an owner that is no room at all, such as the platform's `org:` rows).
 *
 * The same shape `shelfMappedPageComments` gave the knowledge margins.
 */
export class ShelfMappedSecretStorage implements SecretStorage {
  constructor(
    private readonly inner: SecretStorage,
    private readonly shelfFor: SecretShelfResolver,
  ) {}

  private async owner(userId: string): Promise<string> {
    // Platform-held rows (`org:<id>`) are never a room's; skip the lookup.
    if (userId.startsWith('org:')) return userId;
    try {
      return await this.shelfFor(userId);
    } catch {
      return userId;
    }
  }

  async getUserSecrets(userId: string): Promise<SecretDocument[]> {
    return this.inner.getUserSecrets(await this.owner(userId));
  }

  async getSecret(userId: string, secretId: string): Promise<SecretDocument | null> {
    return this.inner.getSecret(await this.owner(userId), secretId);
  }

  async getSecretByKey(userId: string, key: string): Promise<SecretDocument | null> {
    return this.inner.getSecretByKey(await this.owner(userId), key);
  }

  async createSecret(userId: string, input: CreateSecretInput): Promise<SecretDocument> {
    return this.inner.createSecret(await this.owner(userId), input);
  }

  async updateSecret(userId: string, secretId: string, input: UpdateSecretInput): Promise<void> {
    await this.inner.updateSecret(await this.owner(userId), secretId, input);
  }

  async deleteSecret(userId: string, secretId: string): Promise<void> {
    await this.inner.deleteSecret(await this.owner(userId), secretId);
  }
}
