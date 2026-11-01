import { Timestamp } from '../types/timestamp.js';
import {
  SecretDocument,
  CreateSecretInput,
  UpdateSecretInput,
} from '../types/secret.js';

export interface SecretStorage {
  getUserSecrets(userId: string): Promise<SecretDocument[]>;
  getSecret(userId: string, secretId: string): Promise<SecretDocument | null>;
  getSecretByKey(userId: string, key: string): Promise<SecretDocument | null>;
  createSecret(userId: string, input: CreateSecretInput): Promise<SecretDocument>;
  updateSecret(userId: string, secretId: string, input: UpdateSecretInput): Promise<void>;
  deleteSecret(userId: string, secretId: string): Promise<void>;
}


export class InMemorySecretStorage implements SecretStorage {
  private secrets: Map<string, SecretDocument> = new Map();

  private key(userId: string, secretId: string): string {
    return `${userId}/${secretId}`;
  }

  async getUserSecrets(userId: string): Promise<SecretDocument[]> {
    const secrets: SecretDocument[] = [];
    for (const secret of this.secrets.values()) {
      if (secret.userId === userId) secrets.push(secret);
    }
    return secrets.sort((a, b) => b.updatedAt.seconds - a.updatedAt.seconds);
  }

  async getSecret(userId: string, secretId: string): Promise<SecretDocument | null> {
    return this.secrets.get(this.key(userId, secretId)) ?? null;
  }

  async getSecretByKey(userId: string, key: string): Promise<SecretDocument | null> {
    for (const secret of this.secrets.values()) {
      if (secret.userId === userId && secret.key === key) return secret;
    }
    return null;
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
    this.secrets.set(this.key(userId, secretId), secret);
    return secret;
  }

  async updateSecret(userId: string, secretId: string, input: UpdateSecretInput): Promise<void> {
    const secret = this.secrets.get(this.key(userId, secretId));
    if (!secret) return;
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
  }

  async deleteSecret(userId: string, secretId: string): Promise<void> {
    this.secrets.delete(this.key(userId, secretId));
  }
}
