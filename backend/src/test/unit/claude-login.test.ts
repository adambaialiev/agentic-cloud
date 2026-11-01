import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CREDENTIALS_SECRET_KEY,
  CLAUDE_OAUTH_TOKEN_SECRET_KEY,
  backupClaudeCredentialsToSecretStorage,
  ensureClaudeAuth,
  getClaudeAuthStatus,
  getStoredClaudeOauthToken,
  isValidClaudeOauthTokenShape,
  probeClaudeOauthToken,
  restoreClaudeCredentialsFromSecretStorage,
  storeClaudeOauthToken,
} from '../../agent/claude/claude-login.js';
import type { SecretStorage } from '../../services/secret-storage.js';
import type { SecretDocument } from '../../types/secret.js';
import {
  FakeWorkspaceRuntimeClient,
  makeExecSyncResult,
} from '../mocks/fake-workspace-runtime-client.js';

class FakeSecretStorage implements SecretStorage {
  private secrets: SecretDocument[] = [];
  async getUserSecrets(): Promise<SecretDocument[]> { return [...this.secrets]; }
  async getSecret(_u: string, id: string): Promise<SecretDocument | null> {
    return this.secrets.find((s) => s.secretId === id) ?? null;
  }
  async getSecretByKey(userId: string, key: string): Promise<SecretDocument | null> {
    return this.secrets.find((s) => s.userId === userId && s.key === key) ?? null;
  }
  async createSecret(userId: string, input: { key: string; value: string }): Promise<SecretDocument> {
    const secret = { secretId: `s${this.secrets.length + 1}`, userId, key: input.key, value: input.value } as SecretDocument;
    this.secrets.push(secret);
    return secret;
  }
  async updateSecret(_u: string, id: string, input: { value?: string }): Promise<void> {
    const s = this.secrets.find((x) => x.secretId === id);
    if (s && input.value !== undefined) s.value = input.value;
  }
  async deleteSecret(_u: string, id: string): Promise<void> {
    this.secrets = this.secrets.filter((s) => s.secretId !== id);
  }
}

describe('getClaudeAuthStatus', () => {
  it('maps the credentials-file probe to a status', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: 'CLAUDE_LOGGED_IN\n' });
    await expect(getClaudeAuthStatus(client, 'sb-1')).resolves.toBe('logged_in');

    client.execSyncHandler = () => makeExecSyncResult({ stdout: '', exitCode: 1 });
    await expect(getClaudeAuthStatus(client, 'sb-1')).resolves.toBe('logged_out');
  });
});

describe('credentials backup/restore', () => {
  it('backs up valid credentials and restores them via base64', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const secretStorage = new FakeSecretStorage();
    const creds = '{"claudeAiOauth":{"accessToken":"a"}}';
    client.execSyncHandler = () => makeExecSyncResult({ stdout: creds });

    await expect(backupClaudeCredentialsToSecretStorage({
      sandboxClient: client, sandboxId: 'sb-1', secretStorage, userId: 'user-1',
    })).resolves.toBe(true);
    expect((await secretStorage.getSecretByKey('user-1', CLAUDE_CREDENTIALS_SECRET_KEY))?.value).toBe(creds);

    const restoreClient = new FakeWorkspaceRuntimeClient();
    await expect(restoreClaudeCredentialsFromSecretStorage({
      sandboxClient: restoreClient, sandboxId: 'sb-1', secretStorage, userId: 'user-1',
    })).resolves.toBe(true);
    const restoreCmd = restoreClient.execSyncCalls.at(-1)?.command ?? '';
    expect(restoreCmd).toContain('base64 -d > ~/.claude/.credentials.json');
    expect(restoreCmd).toContain(Buffer.from(creds, 'utf8').toString('base64'));
  });
});

describe('OAuth token helpers', () => {
  const TOKEN = 'sk-ant-oat01-fixture-not-a-real-token-0000000000000000000000000000';

  it('validates the setup-token shape', () => {
    expect(isValidClaudeOauthTokenShape(TOKEN)).toBe(true);
    expect(isValidClaudeOauthTokenShape(` ${TOKEN} `)).toBe(true);
    expect(isValidClaudeOauthTokenShape('sk-ant-x')).toBe(false);
    expect(isValidClaudeOauthTokenShape('hFI2fTV4pJ0SUfut0ih4X61eBrbICFkVLcxoaDelKZc')).toBe(false);
    expect(isValidClaudeOauthTokenShape('')).toBe(false);
  });

  it('stores, overwrites, and reads back the token', async () => {
    const secretStorage = new FakeSecretStorage();
    await storeClaudeOauthToken({ secretStorage, userId: 'user-1', token: `${TOKEN} ` });
    expect(await getStoredClaudeOauthToken(secretStorage, 'user-1')).toBe(TOKEN);

    await storeClaudeOauthToken({ secretStorage, userId: 'user-1', token: `${TOKEN}-v2` });
    expect(await getStoredClaudeOauthToken(secretStorage, 'user-1')).toBe(`${TOKEN}-v2`);
    expect((await secretStorage.getUserSecrets()).filter((s) => s.key === CLAUDE_OAUTH_TOKEN_SECRET_KEY)).toHaveLength(1);
  });

  it('probes with the env-injected CLI as the given user and maps auth failures', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: 'OK\n' });
    await expect(probeClaudeOauthToken({ sandboxClient: client, sandboxId: 'sb-1', token: TOKEN, sshUser: 'agent' }))
      .resolves.toEqual({ ok: true });
    expect(client.execSyncCalls[0]?.command).toContain(`CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}' claude -p`);
    expect(client.execSyncCalls[0]?.sshUser).toBe('agent');

    client.execSyncHandler = () => makeExecSyncResult({ stdout: 'Not logged in · Please run /login\n' });
    const failed = await probeClaudeOauthToken({ sandboxClient: client, sandboxId: 'sb-1', token: TOKEN });
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('Not logged in');
  });
});

describe('ensureClaudeAuth', () => {
  it('reports logged in from the stored OAuth token without touching the sandbox', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const secretStorage = new FakeSecretStorage();
    await secretStorage.createSecret('user-1', { key: CLAUDE_OAUTH_TOKEN_SECRET_KEY, value: 'sk-ant-oat01-stored' });

    await expect(ensureClaudeAuth({ sandboxClient: client, sandboxId: 'sb-1', secretStorage, userId: 'user-1' }))
      .resolves.toBe('logged_in');
    expect(client.execSyncCalls).toEqual([]);
  });

  it('restores from secret storage when the sandbox is logged out', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const secretStorage = new FakeSecretStorage();
    await secretStorage.createSecret('user-1', { key: CLAUDE_CREDENTIALS_SECRET_KEY, value: '{"claudeAiOauth":{}}' });

    let restored = false;
    client.execSyncHandler = (command) => {
      if (command.includes('test -s')) return makeExecSyncResult({ stdout: restored ? 'CLAUDE_LOGGED_IN' : '' });
      restored = true;
      return makeExecSyncResult();
    };
    await expect(ensureClaudeAuth({ sandboxClient: client, sandboxId: 'sb-1', secretStorage, userId: 'user-1' }))
      .resolves.toBe('logged_in');
  });
});
