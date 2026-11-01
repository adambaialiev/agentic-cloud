/**
 * ChatGPT/Codex subscription auth helpers, run against the user's sandbox VM.
 *
 * The interactive `codex login` sign-in is driven by the onboarding setup
 * agent itself through execute_terminal_session (it runs the command, relays
 * the verification URL + code, and waits for completion). These helpers only
 * inspect and persist the result: a successful login leaves
 * `~/.codex/auth.json` on the VM (Codex refreshes it on use), and we back that
 * file up to per-user secret storage so sandbox rebuilds don't force a
 * re-login.
 */

import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type { SecretStorage } from '../../services/secret-storage.js';

export const CODEX_AUTH_SECRET_KEY = 'codex-auth-json';
export const CODEX_AUTH_FILE_PATH = '~/.codex/auth.json';

export type CodexAuthStatus = 'logged_in' | 'logged_out';

export async function getCodexAuthStatus(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  sshUser?: string,
): Promise<CodexAuthStatus> {
  const result = await sandboxClient.execSync(sandboxId, 'codex login status', undefined, {
    timeoutMs: 30_000,
    sshUser,
  });
  return result.exitCode === 0 ? 'logged_in' : 'logged_out';
}

export async function backupCodexAuthToSecretStorage(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  secretStorage: SecretStorage;
  userId: string;
  sshUser?: string;
}): Promise<boolean> {
  const { sandboxClient, sandboxId, secretStorage, userId, sshUser } = args;
  const read = await sandboxClient.execSync(sandboxId, `cat ${CODEX_AUTH_FILE_PATH}`, undefined, {
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
  const existing = await secretStorage.getSecretByKey(userId, CODEX_AUTH_SECRET_KEY);
  if (existing) {
    await secretStorage.updateSecret(userId, existing.secretId, { value: content });
  } else {
    await secretStorage.createSecret(userId, { key: CODEX_AUTH_SECRET_KEY, value: content });
  }
  return true;
}

/**
 * Write auth.json content onto the machine (base64-piped so the JSON never
 * hits shell quoting). Used by the secret-storage restore below and by the
 * platform credential pool, which delivers pool auth.json per turn.
 */
export async function writeCodexAuthFile(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  content: string;
  sshUser?: string;
}): Promise<boolean> {
  const { sandboxClient, sandboxId, content, sshUser } = args;
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const command = [
    'mkdir -p ~/.codex',
    `printf '%s' '${encoded}' | base64 -d > ${CODEX_AUTH_FILE_PATH}`,
    `chmod 600 ${CODEX_AUTH_FILE_PATH}`,
  ].join(' && ');
  const result = await sandboxClient.execSync(sandboxId, command, undefined, { timeoutMs: 30_000, sshUser });
  return result.exitCode === 0;
}

/**
 * Read auth.json back off the machine. Returns null when missing or not valid
 * JSON (a partial write, a wiped VM). The platform pool syncs this back after
 * each turn because the CLI refreshes tokens in place.
 */
export async function readCodexAuthFile(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  sshUser?: string;
}): Promise<string | null> {
  const { sandboxClient, sandboxId, sshUser } = args;
  const read = await sandboxClient.execSync(sandboxId, `cat ${CODEX_AUTH_FILE_PATH}`, undefined, {
    timeoutMs: 30_000,
    sshUser,
  });
  if (read.exitCode !== 0) return null;
  const content = read.stdout.trim();
  try {
    JSON.parse(content);
  } catch {
    return null;
  }
  return content;
}

/**
 * Read auth.json back, but only if it was written no earlier than `since` —
 * the recovery read for a ceremony whose pane is gone (the machine was
 * stopped, or tmux died) but whose login may already have landed.
 *
 * The freshness bound is the whole safety of this function, not a nicety.
 * `writeCodexAuthFile` above delivers PLATFORM POOL credentials to this exact
 * path before a pooled turn, so a machine that has ever run one already has
 * an auth.json sitting there, belonging to somebody else entirely. Only a
 * file the ceremony itself caused may be adopted as the member's own seat.
 *
 * `stat` reports whole seconds, so the comparison is deliberately strict: a
 * file stamped the same second the ceremony began is refused. Nothing
 * legitimate is lost — a device flow cannot mint a credential before it has
 * even printed its code — and the alternative rounds the guard open.
 */
export async function readCodexAuthFileWrittenSince(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  sshUser?: string;
  /** Epoch ms; the file must be no older than this. */
  since: number;
}): Promise<string | null> {
  const { sandboxClient, sandboxId, sshUser, since } = args;
  // One round trip: mtime on the first line, the file itself below it.
  const read = await sandboxClient.execSync(
    sandboxId,
    `stat -c %Y ${CODEX_AUTH_FILE_PATH} && cat ${CODEX_AUTH_FILE_PATH}`,
    undefined,
    { timeoutMs: 30_000, sshUser },
  );
  if (read.exitCode !== 0) return null;
  const newline = read.stdout.indexOf('\n');
  if (newline < 0) return null;
  const mtimeSeconds = Number(read.stdout.slice(0, newline).trim());
  if (!Number.isFinite(mtimeSeconds) || mtimeSeconds * 1000 < since) return null;
  const content = read.stdout.slice(newline + 1).trim();
  try {
    JSON.parse(content);
  } catch {
    return null;
  }
  return content;
}

export async function restoreCodexAuthFromSecretStorage(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  secretStorage: SecretStorage;
  userId: string;
  sshUser?: string;
}): Promise<boolean> {
  const { sandboxClient, sandboxId, secretStorage, userId, sshUser } = args;
  const secret = await secretStorage.getSecretByKey(userId, CODEX_AUTH_SECRET_KEY);
  if (!secret?.value) return false;
  return writeCodexAuthFile({ sandboxClient, sandboxId, content: secret.value, sshUser });
}

/**
 * Auth check with lazy restore: when the sandbox has no valid login (fresh
 * VM or post-reset) but a backup exists in secret storage, restore it and
 * re-check. Codex refreshes restored tokens on first use.
 */
export async function ensureCodexAuth(args: {
  sandboxClient: WorkspaceRuntimeClient;
  sandboxId: string;
  secretStorage?: SecretStorage;
  userId: string;
  sshUser?: string;
}): Promise<CodexAuthStatus> {
  const { sandboxClient, sandboxId, secretStorage, userId, sshUser } = args;
  const status = await getCodexAuthStatus(sandboxClient, sandboxId, sshUser);
  if (status === 'logged_in' || !secretStorage) {
    return status;
  }
  const restored = await restoreCodexAuthFromSecretStorage({
    sandboxClient,
    sandboxId,
    secretStorage,
    userId,
    sshUser,
  }).catch((error) => {
    console.warn(`[codex-login] Failed to restore auth.json for user ${userId}:`, error);
    return false;
  });
  if (!restored) {
    return 'logged_out';
  }
  return getCodexAuthStatus(sandboxClient, sandboxId, sshUser);
}
