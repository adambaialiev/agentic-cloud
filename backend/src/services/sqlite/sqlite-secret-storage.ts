import { Timestamp } from '../../types/timestamp.js';
import type { SqliteDb } from './sqlite-db.js';
import { deserializeDoc, serializeDoc } from './sqlite-db.js';
import type { SecretStorage } from '../secret-storage.js';
import {
  SecretDocument,
  CreateSecretInput,
  UpdateSecretInput,
} from '../../types/secret.js';

export class SqliteSecretStorage implements SecretStorage {
  constructor(private readonly db: SqliteDb) {}

  private save(secret: SecretDocument): void {
    this.db.prepare(
      'INSERT INTO secrets (user_id, secret_id, doc) VALUES (?, ?, ?)'
      + ' ON CONFLICT(user_id, secret_id) DO UPDATE SET doc = excluded.doc',
    ).run(secret.userId, secret.secretId, serializeDoc(secret));
  }

  async getUserSecrets(userId: string): Promise<SecretDocument[]> {
    const rows = this.db.prepare('SELECT doc FROM secrets WHERE user_id = ?').all(userId) as Array<{ doc: string }>;
    return rows
      .map((row) => deserializeDoc<SecretDocument>(row.doc))
      .sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis());
  }

  async getSecret(userId: string, secretId: string): Promise<SecretDocument | null> {
    const row = this.db.prepare('SELECT doc FROM secrets WHERE user_id = ? AND secret_id = ?')
      .get(userId, secretId) as { doc: string } | undefined;
    return row ? deserializeDoc<SecretDocument>(row.doc) : null;
  }

  async getSecretByKey(userId: string, key: string): Promise<SecretDocument | null> {
    const secrets = await this.getUserSecrets(userId);
    return secrets.find((secret) => secret.key === key) ?? null;
  }

  async createSecret(userId: string, input: CreateSecretInput): Promise<SecretDocument> {
    const secretId = `secret_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Timestamp.now();
    const secret: SecretDocument = {
      secretId,
      userId,
      key: input.key,
      value: input.value,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.save(secret);
    return secret;
  }

  async updateSecret(userId: string, secretId: string, input: UpdateSecretInput): Promise<void> {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT doc FROM secrets WHERE user_id = ? AND secret_id = ?')
        .get(userId, secretId) as { doc: string } | undefined;
      if (!row) return;
      const secret = deserializeDoc<SecretDocument>(row.doc);
      if (input.key !== undefined) secret.key = input.key;
      if (input.value !== undefined) secret.value = input.value;
      if (input.description !== undefined) {
        if (input.description) secret.description = input.description;
        else delete secret.description;
      }
      if (input.audience !== undefined) secret.audience = input.audience;
      // updatedAt answers "when did the key material last change" — a
      // description-only edit annotates the row without rotating anything.
      if (input.key !== undefined || input.value !== undefined) {
        secret.updatedAt = Timestamp.now();
      }
      this.save(secret);
    });
    tx();
  }

  async deleteSecret(userId: string, secretId: string): Promise<void> {
    this.db.prepare('DELETE FROM secrets WHERE user_id = ? AND secret_id = ?').run(userId, secretId);
  }
}
