import type {
  ExecSyncResult,
  TerminalSessionResult,
} from './sandbox-types.js';
import type {
  SshExecConnectionConfig,
  SshTerminalSessionStartOptions,
} from './ssh-client.js';
import { quoteShellArg } from '../utils/shell-quote.js';

export const DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
export const SERVER_BOOTSTRAP_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_SERVER_SSH_READY_TIMEOUT_MS = 2 * 60_000;
export const SERVER_SSH_READY_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_SERVER_SSH_READY_ATTEMPT_TIMEOUT_MS = 10_000;
export const DEFAULT_SERVER_SSH_USER = 'root';
export const SERVER_BOOTSTRAP_SUMMARY = 'Installed baseline development tooling (`rg`, `git`, `gh`, `curl`, `jq`, `unzip`, `tmux`, Node.js, npm, build tools), prepared the `agent` SSH user, Codex CLI, Claude Code and OpenCode without running apt-get upgrade.';
const CODEX_VERSION_MARKER = 'SUMAI_PREP_CODEX_VERSION=';
const CLAUDE_VERSION_MARKER = 'SUMAI_PREP_CLAUDE_VERSION=';

type BootstrapConnectionConfig = Omit<SshExecConnectionConfig, 'host' | 'readyTimeoutMs'>;

interface BootstrapServer {
  id: number;
  name: string;
  networks?: {
    v4?: Array<{ type?: string; ip_address?: string }>;
    v6?: Array<{ type?: string; ip_address?: string }>;
  };
}

interface BootstrapSshClient {
  execCommand(
    connection: SshExecConnectionConfig,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<ExecSyncResult>;
  startSession(
    connection: SshExecConnectionConfig,
    options?: SshTerminalSessionStartOptions,
  ): Promise<TerminalSessionResult>;
  readSession(sessionId: string): Promise<TerminalSessionResult>;
  closeSession(sessionId: string): Promise<TerminalSessionResult>;
}

export interface PrepareBootstrapServerEnvironmentArgs {
  server: Pick<BootstrapServer, 'id' | 'name' | 'networks'>;
  sshClient: BootstrapSshClient;
  connection: BootstrapConnectionConfig;
  bootstrapTimeoutMs?: number;
  bootstrapPollIntervalMs?: number;
  sshReadyTimeoutMs?: number;
  sshReadyPollIntervalMs?: number;
  sshReadyAttemptTimeoutMs?: number;
}

export function getBootstrapServerPublicAddress(server: Pick<BootstrapServer, 'networks'>): string | undefined {
  const publicV4 = server.networks?.v4?.find((network) => network.type === 'public')?.ip_address?.trim();
  if (publicV4) {
    return publicV4;
  }

  const publicV6 = server.networks?.v6?.find((network) => network.type === 'public')?.ip_address?.trim();
  return publicV6 || undefined;
}

export function buildServerBootstrapCommand(): string {
  return [
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'export NEEDRESTART_MODE=a',
    'export APT_LISTCHANGES_FRONTEND=none',
    'wait_for_apt_locks() {',
    '  local deadline=$((SECONDS + 180))',
    '  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || \\',
    '        fuser /var/lib/dpkg/lock >/dev/null 2>&1 || \\',
    '        fuser /var/cache/apt/archives/lock >/dev/null 2>&1 || \\',
    '        fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do',
    '    if [ "$SECONDS" -ge "$deadline" ]; then',
    '      echo "Timed out waiting for apt/dpkg locks to clear." >&2',
    '      ps -ef | grep -E "apt|dpkg|unattended" | grep -v grep >&2 || true',
    '      return 1',
    '    fi',
    '    sleep 5',
    '  done',
    '}',
    'apt_get_with_retry() {',
    '  local attempt=1',
    '  local max_attempts=5',
    '  while true; do',
    '    wait_for_apt_locks',
    '    if apt-get "$@"; then',
    '      return 0',
    '    fi',
    '    local status=$?',
    '    if [ "$attempt" -ge "$max_attempts" ]; then',
    '      return "$status"',
    '    fi',
    '    echo "apt-get $* failed with exit code $status; retrying..." >&2',
    '    attempt=$((attempt + 1))',
    '    sleep 5',
    '  done',
    '}',
    'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait || true; fi',
    'mkdir -p /etc/needrestart/conf.d',
    "cat >/etc/needrestart/conf.d/infinite-agents.conf <<'EOF'",
    "$nrconf{restart} = 'a';",
    'EOF',
    '# Do not run apt-get upgrade here. On fresh Ubuntu 24.04 cloud server servers,',
    '# blanket upgrades can pull kernel updates and leave SSH unreachable after reboot.',
    '# Refresh package lists only, then install the specific packages needed.',
    'apt_get_with_retry update',
    'apt_get_with_retry install -y ca-certificates curl unzip jq ripgrep git gh tmux nodejs npm build-essential python3 make g++',
    '# Create the agent user with an explicit login shell so `bash -lc` and tmux sessions start cleanly.',
    'if ! id -u agent >/dev/null 2>&1; then useradd -m -s /bin/bash agent; fi',
    '# Repair pre-existing agent users that were created without an explicit shell (useradd defaults to /bin/sh).',
    'usermod -s /bin/bash agent',
    'mkdir -p /home/agent/.ssh',
    'cp /root/.ssh/authorized_keys /home/agent/.ssh/authorized_keys',
    'chown -R agent:agent /home/agent/.ssh',
    'chmod 700 /home/agent/.ssh',
    'chmod 600 /home/agent/.ssh/authorized_keys',
    '# Pre-create the default agent tmux runtime dir owned by agent; runtime commands fall back if this dir becomes unusable later.',
    'install -d -m 700 -o agent -g agent "/tmp/tmux-$(id -u agent)"',
    'command -v rg',
    'command -v git',
    'command -v gh',
    'command -v curl',
    'command -v jq',
    'command -v unzip',
    'command -v tmux',
    'command -v node',
    'command -v npm',
    'npm install -g @openai/codex',
    'command -v codex',
    'SUMAI_CODEX_VERSION="$(codex --version 2>/dev/null || true)"',
    'printf "%s%s\\n" "SUMAI_PREP_CODEX_VERSION=" "$SUMAI_CODEX_VERSION"',
    'npm install -g @anthropic-ai/claude-code',
    'command -v claude',
    'SUMAI_CLAUDE_VERSION="$(claude --version 2>/dev/null || true)"',
    'printf "%s%s\\n" "SUMAI_PREP_CLAUDE_VERSION=" "$SUMAI_CLAUDE_VERSION"',
    // OpenCode (note #780) without a gate: a server that cannot take it still
    // serves its Claude and Codex agents, and the pre-sleep updater installs
    // the pin for an OpenCode agent's machine.
    "npm install -g opencode-ai || echo 'opencode install failed; the pre-sleep update retries it' >&2",
    'exit',
  ].join('\n');
}

export function extractCliVersion(output: string | undefined): string | undefined {
  if (!output) {
    return undefined;
  }

  return /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(output)?.[0];
}

function extractMarkedVersion(output: string, marker: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(marker));
  if (!line) {
    return undefined;
  }

  return extractCliVersion(line.slice(line.indexOf(marker) + marker.length).trim());
}

function extractPreparationResult(output: string): {
  codexPrepared: boolean;
  codexVersion?: string;
  claudePrepared: boolean;
  claudeVersion?: string;
} {
  const codexVersion = extractMarkedVersion(output, CODEX_VERSION_MARKER);
  const claudeVersion = extractMarkedVersion(output, CLAUDE_VERSION_MARKER);
  return {
    codexPrepared: Boolean(codexVersion),
    codexVersion,
    claudePrepared: Boolean(claudeVersion),
    claudeVersion,
  };
}

function summarizeScreenOutput(result: Pick<TerminalSessionResult, 'screen'>): string | undefined {
  const lines = result.screen.output
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  return lines.slice(-12).join('\n');
}

function isRetryableSshStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return [
    'econnrefused',
    'timed out',
    'timeout',
    'econnreset',
    'ehostunreach',
    'enetunreach',
    'connection refused',
    'connection reset',
    'connection timed out',
    'unable to authenticate',
    'all configured authentication methods failed',
  ].every((fragment) => !message.includes(fragment))
    ? false
    : ![
        'all configured authentication methods failed',
        'unable to authenticate',
        'permission denied',
      ].some((fragment) => message.includes(fragment));
}

async function waitForSshReady(args: {
  host: string;
  sshClient: BootstrapSshClient;
  connection: BootstrapConnectionConfig;
  sshReadyTimeoutMs: number;
  sshReadyPollIntervalMs: number;
  sshReadyAttemptTimeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + args.sshReadyTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await args.sshClient.execCommand(
        {
          ...args.connection,
          host: args.host,
          readyTimeoutMs: args.sshReadyAttemptTimeoutMs,
        },
        `bash -lc ${quoteShellArg('true')}`,
        { timeoutMs: args.sshReadyAttemptTimeoutMs },
      );

      if (!result.timedOut && result.exitCode === 0) {
        return;
      }

      lastError = new Error(
        result.timedOut
          ? `SSH readiness probe timed out after ${Math.round(args.sshReadyAttemptTimeoutMs / 1000)} seconds.`
          : `SSH readiness probe exited with code ${result.exitCode}.`,
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableSshStartupError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    await new Promise((resolve) => setTimeout(resolve, args.sshReadyPollIntervalMs));
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown SSH startup error');
  throw new Error(
    `SSH did not become ready on ${args.host}:${args.connection.port ?? 22} within ${Math.round(args.sshReadyTimeoutMs / 1000)} seconds. Last error: ${detail}`,
  );
}

export async function prepareBootstrapServerEnvironment(
  args: PrepareBootstrapServerEnvironmentArgs,
): Promise<{
  ok: true;
  summary: string;
  codexPrepared: boolean;
  codexVersion?: string;
  claudePrepared: boolean;
  claudeVersion?: string;
} | {
  ok: false;
  error: string;
  summary?: string;
  codexPrepared?: boolean;
  codexVersion?: string;
  claudePrepared?: boolean;
  claudeVersion?: string;
}> {
  const host = getBootstrapServerPublicAddress(args.server);
  if (!host) {
    return {
      ok: false,
      error: `Server ${args.server.name} (${args.server.id}) does not have a public address yet.`,
    };
  }

  const bootstrapTimeoutMs = args.bootstrapTimeoutMs ?? DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS;
  const bootstrapPollIntervalMs = args.bootstrapPollIntervalMs ?? SERVER_BOOTSTRAP_POLL_INTERVAL_MS;
  const sshReadyTimeoutMs = args.sshReadyTimeoutMs ?? DEFAULT_SERVER_SSH_READY_TIMEOUT_MS;
  const sshReadyPollIntervalMs = args.sshReadyPollIntervalMs ?? SERVER_SSH_READY_POLL_INTERVAL_MS;
  const sshReadyAttemptTimeoutMs = args.sshReadyAttemptTimeoutMs ?? DEFAULT_SERVER_SSH_READY_ATTEMPT_TIMEOUT_MS;

  let sessionId: string | undefined;
  try {
    await waitForSshReady({
      host,
      sshClient: args.sshClient,
      connection: args.connection,
      sshReadyTimeoutMs,
      sshReadyPollIntervalMs,
      sshReadyAttemptTimeoutMs,
    });

    let snapshot = await args.sshClient.startSession(
      {
        ...args.connection,
        host,
      },
      {
        command: buildServerBootstrapCommand(),
        initialReadDelayMs: 300,
      },
    );
    sessionId = snapshot.sessionId;
    const deadline = Date.now() + bootstrapTimeoutMs;

    while (snapshot.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, bootstrapPollIntervalMs));
      snapshot = await args.sshClient.readSession(snapshot.sessionId);
    }

    if (snapshot.status === 'running') {
      const outputTail = summarizeScreenOutput(snapshot);
      return {
        ok: false,
        error: `Timed out after ${Math.round(bootstrapTimeoutMs / 1000)} seconds while preparing the sandbox server.`,
        summary: outputTail,
        ...extractPreparationResult(snapshot.screen.output.join('\n')),
      };
    }

    if ((snapshot.exitCode ?? 0) !== 0) {
      const outputTail = summarizeScreenOutput(snapshot);
      return {
        ok: false,
        error: `Bootstrap exited with code ${snapshot.exitCode ?? 'unknown'}.`,
        summary: outputTail,
        ...extractPreparationResult(snapshot.screen.output.join('\n')),
      };
    }

    return {
      ok: true,
      summary: SERVER_BOOTSTRAP_SUMMARY,
      ...extractPreparationResult(snapshot.screen.output.join('\n')),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (sessionId) {
      try {
        await args.sshClient.closeSession(sessionId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}
