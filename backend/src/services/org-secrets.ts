import type { SecretStorage } from './secret-storage.js';

/**
 * Org-scoped secrets (byo-fly-design): credentials the PLATFORM holds on an
 * workplace's behalf — the client's Fly org token first, its WireGuard key
 * later. These are not the org-shared workplace secrets members read; they are
 * operator credentials, and no agent turn may ever see one.
 *
 * Storage shape: rows ride the same {@link SecretStorage} (and so the same
 * encryption at rest) under the synthetic owner `org:<orgId>`, keyed
 * `org-env:NAME`. The per-turn secret export reads `user-env…` keys under a
 * USER's id, and no user id has the `org:` shape — so "never in an agent's
 * environment" holds by construction, not by a filter someone can forget.
 */
const ORG_SECRET_OWNER_PREFIX = 'org:';
const ORG_SECRET_KEY_PREFIX = 'org-env:';

/** Same shell-safe class as user secret names; these too are NAMES, not data. */
const ORG_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fly org tokens and WireGuard keys are small; anything bigger is a mistake. */
export const MAX_ORG_SECRET_VALUE_BYTES = 16 * 1024;

export class OrgSecretError extends Error {}

export class OrgSecretsService {
  constructor(private readonly storage: SecretStorage) {}

  private owner(orgId: string): string {
    const trimmed = orgId.trim();
    if (!trimmed) {
      throw new OrgSecretError('orgId is required');
    }
    return `${ORG_SECRET_OWNER_PREFIX}${trimmed}`;
  }

  private storageKey(name: string): string {
    const trimmed = name.trim();
    if (!ORG_SECRET_NAME_PATTERN.test(trimmed)) {
      throw new OrgSecretError(
        `"${name}" is not a valid secret name (letters, digits and underscores, not starting with a digit)`,
      );
    }
    return `${ORG_SECRET_KEY_PREFIX}${trimmed}`;
  }

  /** Create or rotate. Upsert on purpose: a re-paste is a rotation, not an error. */
  async setOrgSecret(orgId: string, name: string, value: string, description: string): Promise<void> {
    if (!value) {
      throw new OrgSecretError(`org secret "${name}" needs a value`);
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_ORG_SECRET_VALUE_BYTES) {
      throw new OrgSecretError(`org secret "${name}" exceeds ${MAX_ORG_SECRET_VALUE_BYTES} bytes`);
    }
    const owner = this.owner(orgId);
    const key = this.storageKey(name);
    const existing = await this.storage.getSecretByKey(owner, key);
    if (existing) {
      await this.storage.updateSecret(owner, existing.secretId, { value, description });
      return;
    }
    await this.storage.createSecret(owner, { key, value, description });
  }

  /** Plaintext value, or null when the org holds no secret of that name. */
  async getOrgSecret(orgId: string, name: string): Promise<string | null> {
    const secret = await this.storage.getSecretByKey(this.owner(orgId), this.storageKey(name));
    return secret?.value ?? null;
  }

  async deleteOrgSecret(orgId: string, name: string): Promise<boolean> {
    const owner = this.owner(orgId);
    const secret = await this.storage.getSecretByKey(owner, this.storageKey(name));
    if (!secret) {
      return false;
    }
    await this.storage.deleteSecret(owner, secret.secretId);
    return true;
  }
}
