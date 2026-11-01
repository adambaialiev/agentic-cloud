import { describe, expect, it } from 'vitest';
import { OrgSecretsService, OrgSecretError, MAX_ORG_SECRET_VALUE_BYTES } from '../../services/org-secrets.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { EncryptedSecretStorage } from '../../services/encrypted-secret-storage.js';
import { SecretCipher } from '../../services/secret-cipher.js';
import { UserSecretsService } from '../../services/user-secrets.js';

const ORG = 'org-1111';

describe('OrgSecretsService', () => {
  it('round-trips a secret, rotates on re-set, and deletes', async () => {
    const service = new OrgSecretsService(new InMemorySecretStorage());
    expect(await service.getOrgSecret(ORG, 'FLY_ORG_TOKEN')).toBeNull();

    await service.setOrgSecret(ORG, 'FLY_ORG_TOKEN', 'fo1_first', 'Fly token');
    expect(await service.getOrgSecret(ORG, 'FLY_ORG_TOKEN')).toBe('fo1_first');

    // A re-paste is a rotation, not an error.
    await service.setOrgSecret(ORG, 'FLY_ORG_TOKEN', 'fo1_second', 'Fly token');
    expect(await service.getOrgSecret(ORG, 'FLY_ORG_TOKEN')).toBe('fo1_second');

    expect(await service.deleteOrgSecret(ORG, 'FLY_ORG_TOKEN')).toBe(true);
    expect(await service.getOrgSecret(ORG, 'FLY_ORG_TOKEN')).toBeNull();
    expect(await service.deleteOrgSecret(ORG, 'FLY_ORG_TOKEN')).toBe(false);
  });

  it('scopes by org: two orgs, same name, different values', async () => {
    const service = new OrgSecretsService(new InMemorySecretStorage());
    await service.setOrgSecret('org-a', 'FLY_ORG_TOKEN', 'token-a', 'a');
    await service.setOrgSecret('org-b', 'FLY_ORG_TOKEN', 'token-b', 'b');
    expect(await service.getOrgSecret('org-a', 'FLY_ORG_TOKEN')).toBe('token-a');
    expect(await service.getOrgSecret('org-b', 'FLY_ORG_TOKEN')).toBe('token-b');
  });

  it('refuses bad names, empty values, and oversized values', async () => {
    const service = new OrgSecretsService(new InMemorySecretStorage());
    await expect(service.setOrgSecret(ORG, 'bad name', 'v', 'd')).rejects.toThrow(OrgSecretError);
    await expect(service.setOrgSecret(ORG, '1LEADING', 'v', 'd')).rejects.toThrow(OrgSecretError);
    await expect(service.setOrgSecret(ORG, 'NAME', '', 'd')).rejects.toThrow(OrgSecretError);
    await expect(
      service.setOrgSecret(ORG, 'NAME', 'x'.repeat(MAX_ORG_SECRET_VALUE_BYTES + 1), 'd'),
    ).rejects.toThrow(OrgSecretError);
    await expect(service.setOrgSecret('', 'NAME', 'v', 'd')).rejects.toThrow(OrgSecretError);
  });

  it('stores rows under the org owner with the org-env key prefix', async () => {
    const storage = new InMemorySecretStorage();
    await new OrgSecretsService(storage).setOrgSecret(ORG, 'FLY_ORG_TOKEN', 'fo1_x', 'Fly token');
    const rows = await storage.getUserSecrets(`org:${ORG}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe('org-env:FLY_ORG_TOKEN');
    expect(rows[0]!.description).toBe('Fly token');
  });

  it('never leaks into any turn export — exclusion by construction', async () => {
    // Org rows and user rows share one storage; the per-turn export reads
    // `user-env…` keys under a USER's id. Neither a normal user nor even a
    // hostile id shaped like the org owner can surface an org secret.
    const storage = new InMemorySecretStorage();
    await new OrgSecretsService(storage).setOrgSecret(ORG, 'FLY_ORG_TOKEN', 'fo1_x', 'Fly token');
    const userSecrets = new UserSecretsService(storage);
    expect(await userSecrets.getSecretEnv('u1')).toEqual({});
    expect(await userSecrets.getSecretEnv(`org:${ORG}`)).toEqual({});
  });

  it('rides the same encryption at rest as everything else', async () => {
    const inner = new InMemorySecretStorage();
    const cipher = new SecretCipher(Buffer.alloc(32, 7).toString('base64'));
    const service = new OrgSecretsService(new EncryptedSecretStorage(inner, cipher));

    await service.setOrgSecret(ORG, 'FLY_ORG_TOKEN', 'fo1_plain', 'Fly token');
    // The service answers plaintext; the row underneath holds only ciphertext.
    expect(await service.getOrgSecret(ORG, 'FLY_ORG_TOKEN')).toBe('fo1_plain');
    const rows = await inner.getUserSecrets(`org:${ORG}`);
    expect(rows[0]!.value.startsWith('enc:v1:')).toBe(true);
    expect(rows[0]!.value).not.toContain('fo1_plain');
  });
});
