import { describe, expect, it } from 'vitest';
import {
  CODEX_AUTH_SECRET_KEY,
  backupCodexAuthToSecretStorage,
  ensureCodexAuth,
  getCodexAuthStatus,
  restoreCodexAuthFromSecretStorage,
} from '../../agent/codex/codex-login.js';
import type { SecretStorage } from '../../services/secret-storage.js';
import type { SecretDocument } from '../../types/secret.js';
import {
  FakeWorkspaceRuntimeClient,
  makeExecSyncResult,
} from '../mocks/fake-workspace-runtime-client.js';

class FakeSecretStorage implements SecretStorage {
  private secrets: SecretDocument[] = [];

  async getUserSecrets(): Promise<SecretDocument[]> {
    return [...this.secrets];
  }

  async getSecret(_userId: string, secretId: string): Promise<SecretDocument | null> {
    return this.secrets.find((secret) => secret.secretId === secretId) ?? null;
  }

  async getSecretByKey(userId: string, key: string): Promise<SecretDocument | null> {
    return this.secrets.find((secret) => secret.userId === userId && secret.key === key) ?? null;
  }

  async createSecret(userId: string, input: { key: string; value: string }): Promise<SecretDocument> {
    const secret = {
      secretId: `secret-${this.secrets.length + 1}`,
      userId,
      key: input.key,
      value: input.value,
    } as SecretDocument;
    this.secrets.push(secret);
    return secret;
  }

  async updateSecret(
    _userId: string,
    secretId: string,
    input: { key?: string; value?: string },
  ): Promise<void> {
    const secret = this.secrets.find((candidate) => candidate.secretId === secretId);
    if (secret && input.value !== undefined) {
      secret.value = input.value;
    }
  }

  async deleteSecret(_userId: string, secretId: string): Promise<void> {
    this.secrets = this.secrets.filter((secret) => secret.secretId !== secretId);
  }
}

describe('getCodexAuthStatus', () => {
  it('maps exit codes to login status', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: 'Logged in using ChatGPT' });
    await expect(getCodexAuthStatus(client, 'sb-1')).resolves.toBe('logged_in');

    client.execSyncHandler = () => makeExecSyncResult({ stdout: 'Not logged in', exitCode: 1 });
    await expect(getCodexAuthStatus(client, 'sb-1')).resolves.toBe('logged_out');
    expect(client.execSyncCalls.every((call) => call.command === 'codex login status')).toBe(true);
  });
});

describe('auth.json backup and restore', () => {
  it('backs up valid auth.json to secret storage and updates on re-backup', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const secretStorage = new FakeSecretStorage();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '{"tokens":{"access":"a"}}' });

    await expect(backupCodexAuthToSecretStorage({
      sandboxClient: client,
      sandboxId: 'sb-1',
      secretStorage,
      userId: 'user-1',
    })).resolves.toBe(true);
    const stored = await secretStorage.getSecretByKey('user-1', CODEX_AUTH_SECRET_KEY);
    expect(stored?.value).toBe('{"tokens":{"access":"a"}}');

    client.execSyncHandler = () => makeExecSyncResult({ stdout: '{"tokens":{"access":"b"}}' });
    await backupCodexAuthToSecretStorage({
      sandboxClient: client,
      sandboxId: 'sb-1',
      secretStorage,
      userId: 'user-1',
    });
    const updated = await secretStorage.getSecretByKey('user-1', CODEX_AUTH_SECRET_KEY);
    expect(updated?.value).toBe('{"tokens":{"access":"b"}}');
    expect((await secretStorage.getUserSecrets()).length).toBe(1);
  });

  it('refuses to back up unreadable or non-JSON auth files', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const secretStorage = new FakeSecretStorage();

    client.execSyncHandler = () => makeExecSyncResult({ exitCode: 1, stderr: 'No such file' });
    await expect(backupCodexAuthToSecretStorage({
      sandboxClient: client,
      sandboxId: 'sb-1',
      secretStorage,
      userId: 'user-1',
    })).resolves.toBe(false);

    client.execSyncHandler = () => makeExecSyncResult({ stdout: 'not json' });
    await expect(backupCodexAuthToSecretStorage({
      sandboxClient: client,
      sandboxId: 'sb-1',
      secretStorage,
      userId: 'user-1',
    })).resolves.toBe(false);
  });

  it('restores the backed-up auth.json via base64 to avoid quoting issues', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const secretStorage = new FakeSecretStorage();
    const authJson = '{"tokens":{"access":"with \'quotes\'"}}';
    await secretStorage.createSecret('user-1', { key: CODEX_AUTH_SECRET_KEY, value: authJson });

    await expect(restoreCodexAuthFromSecretStorage({
      sandboxClient: client,
      sandboxId: 'sb-1',
      secretStorage,
      userId: 'user-1',
    })).resolves.toBe(true);

    const restoreCall = client.execSyncCalls.at(-1);
    expect(restoreCall?.command).toContain('mkdir -p ~/.codex');
    expect(restoreCall?.command).toContain('base64 -d > ~/.codex/auth.json');
    expect(restoreCall?.command).toContain(Buffer.from(authJson, 'utf8').toString('base64'));
    expect(restoreCall?.command).toContain('chmod 600');
  });
});

describe('ensureCodexAuth', () => {
  it('restores from secret storage when the sandbox is logged out', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const secretStorage = new FakeSecretStorage();
    await secretStorage.createSecret('user-1', { key: CODEX_AUTH_SECRET_KEY, value: '{"t":1}' });

    let restored = false;
    client.execSyncHandler = (command) => {
      if (command === 'codex login status') {
        return makeExecSyncResult({ exitCode: restored ? 0 : 1 });
      }
      restored = true;
      return makeExecSyncResult();
    };

    await expect(ensureCodexAuth({
      sandboxClient: client,
      sandboxId: 'sb-1',
      secretStorage,
      userId: 'user-1',
    })).resolves.toBe('logged_in');
  });

  it('reports logged_out when no backup exists', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ exitCode: 1 });

    await expect(ensureCodexAuth({
      sandboxClient: client,
      sandboxId: 'sb-1',
      secretStorage: new FakeSecretStorage(),
      userId: 'user-1',
    })).resolves.toBe('logged_out');
  });
});
