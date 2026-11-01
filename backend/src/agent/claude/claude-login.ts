/**
 * Claude Code subscription auth helpers.
 *
 * The primary credential is the long-lived OAuth token that `claude
 * setup-token` prints (the CLI does NOT write `~/.claude/.credentials.json`
 * in this flow — verified on Claude Code v2.1.205, where `claude -p` says
 * "Not logged in" right after a successful setup-token). The onboarding setup
 * agent drives the sign-in through execute_terminal_session, copies the
 * `sk-ant-oat…` token off the screen, and hands it to the backend via the
 * `set_claude_oauth_token` tool; it lives in per-user secret storage and the
 * harness injects it per turn as `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * The `~/.claude/.credentials.json` file checks remain as a fallback for
 * users who signed in interactively (`claude` + `/login`), which does write
 * that file; those credentials are backed up to secret storage so sandbox
 * rebuilds don't force a re-login.
 */

import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type { SecretStorage } from '../../services/secret-storage.js';
import { quoteShellArg } from '../../utils/shell-quote.js';

export const CLAUDE_CREDENTIALS_SECRET_KEY = 'claude-credentials-json';
export const CLAUDE_CREDENTIALS_FILE_PATH = '~/.claude/.credentials.json';
export const CLAUDE_OAUTH_TOKEN_SECRET_KEY = 'claude-oauth-token';
export const CLAUDE_OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

// Long-lived OAuth tokens from `claude setup-token` look like sk-ant-oat01-…;
// accept any sk-ant- prefix so a CLI format tweak doesn't strand users.
const CLAUDE_OAUTH_TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

export type ClaudeAuthStatus = 'logged_in' | 'logged_out';

export function isValidClaudeOauthTokenShape(token: string): boolean {
  return CLAUDE_OAUTH_TOKEN_PATTERN.test(token.trim());
}

export async function getStoredClaudeOauthToken(
  secretStorage: SecretStorage,
  userId: string,
): Promise<string | null> {
  const secret = await secretStorage.getSecretByKey(userId, CLAUDE_OAUTH_TOKEN_SECRET_KEY);
  const token = secret?.value?.trim();
  return token ? token : null;
}

export async function storeClaudeOauthToken(args: {
  secretStorage: SecretStorage;
  userId: string;
  token: string;
}): Promise<void> {
  const { secretStorage, userId } = args;
  const token = args.token.trim();
  const existing = await secretStorage.getSecretByKey(userId, CLAUDE_OAUTH_TOKEN_SECRET_KEY);
  if (existing) {
    await secretStorage.updateSecret(userId, existing.secretId, { value: token });
  } else {
    await secretStorage.createSecret(userId, { key: CLAUDE_OAUTH_TOKEN_SECRET_KEY, value: token });
  }
}

/**
 * Live check that a token actually authenticates on the given sandbox: one
 * minimal `claude -p` call billed to the user's plan. Used once at connect
 * time so `harness_status` never confirms a token that doesn't work.
 */
export async function probeClaudeOauthToken(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  token: string;
  sshUser?: string;
}): Promise<{ ok: boolean; detail?: string }> {
  const { sandboxClient, sandboxId, token, sshUser } = args;
  const quoted = quoteShellArg(token);
  const result = await sandboxClient.execSync(
    sandboxId,
    `${CLAUDE_OAUTH_TOKEN_ENV}=${quoted} claude -p 'Reply with exactly: OK' --output-format text 2>&1`,
    undefined,
    { timeoutMs: 120_000, sshUser },
  );
  const output = result.stdout.trim();
  if (result.exitCode === 0 && !/not logged in|invalid|unauthorized|authentication/i.test(output)) {
    return { ok: true };
  }
  return { ok: false, detail: output.slice(-300) };
}

export async function getClaudeAuthStatus(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  sshUser?: string,
): Promise<ClaudeAuthStatus> {
  const result = await sandboxClient.execSync(
    sandboxId,
    `test -s ${CLAUDE_CREDENTIALS_FILE_PATH} && echo CLAUDE_LOGGED_IN`,
    undefined,
    { timeoutMs: 30_000, sshUser },
  );
  return result.stdout.includes('CLAUDE_LOGGED_IN') ? 'logged_in' : 'logged_out';
}

export async function backupClaudeCredentialsToSecretStorage(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  secretStorage: SecretStorage;
  userId: string;
  sshUser?: string;
}): Promise<boolean> {
  const { sandboxClient, sandboxId, secretStorage, userId, sshUser } = args;
  const read = await sandboxClient.execSync(sandboxId, `cat ${CLAUDE_CREDENTIALS_FILE_PATH}`, undefined, {
    timeoutMs: 30_000,
    sshUser,
  });
  if (read.exitCode !== 0) return false;
  const content = read.stdout.trim();
  try {
    JSON.parse(content);
  } catch {
    return false;
  }
  const existing = await secretStorage.getSecretByKey(userId, CLAUDE_CREDENTIALS_SECRET_KEY);
  if (existing) {
    await secretStorage.updateSecret(userId, existing.secretId, { value: content });
  } else {
    await secretStorage.createSecret(userId, { key: CLAUDE_CREDENTIALS_SECRET_KEY, value: content });
  }
  return true;
}

export async function restoreClaudeCredentialsFromSecretStorage(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  secretStorage: SecretStorage;
  userId: string;
  sshUser?: string;
}): Promise<boolean> {
  const { sandboxClient, sandboxId, secretStorage, userId, sshUser } = args;
  const secret = await secretStorage.getSecretByKey(userId, CLAUDE_CREDENTIALS_SECRET_KEY);
  if (!secret?.value) return false;
  const encoded = Buffer.from(secret.value, 'utf8').toString('base64');
  const command = [
    'mkdir -p ~/.claude',
    `printf '%s' '${encoded}' | base64 -d > ${CLAUDE_CREDENTIALS_FILE_PATH}`,
    `chmod 600 ${CLAUDE_CREDENTIALS_FILE_PATH}`,
  ].join(' && ');
  const result = await sandboxClient.execSync(sandboxId, command, undefined, { timeoutMs: 30_000, sshUser });
  return result.exitCode === 0;
}

/**
 * Auth check, cheapest signal first: a stored OAuth token in secret storage
 * means logged in (the harness injects it per turn — no SSH round-trip
 * needed). Otherwise fall back to the credentials file on the VM, lazily
 * restoring it from backup after a sandbox rebuild; Claude refreshes restored
 * file credentials on first use.
 */
export async function ensureClaudeAuth(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  secretStorage?: SecretStorage;
  userId: string;
  sshUser?: string;
}): Promise<ClaudeAuthStatus> {
  const { sandboxClient, sandboxId, secretStorage, userId, sshUser } = args;
  if (secretStorage && await getStoredClaudeOauthToken(secretStorage, userId)) {
    return 'logged_in';
  }
  const status = await getClaudeAuthStatus(sandboxClient, sandboxId, sshUser);
  if (status === 'logged_in' || !secretStorage) {
    return status;
  }
  const restored = await restoreClaudeCredentialsFromSecretStorage({
    sandboxClient,
    sandboxId,
    secretStorage,
    userId,
    sshUser,
  }).catch((error) => {
    console.warn(`[claude-login] Failed to restore credentials for user ${userId}:`, error);
    return false;
  });
  if (!restored) {
    return 'logged_out';
  }
  return getClaudeAuthStatus(sandboxClient, sandboxId, sshUser);
}
