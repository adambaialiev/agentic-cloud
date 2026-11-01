/**
 * The non-Fly side of {@link RoutingSandboxClient} after the Hetzner sandbox
 * provider was retired (user machines are exclusively Fly since the cutover;
 * see docs/backend-cutover-runbook.md).
 *
 * Session-keyed terminal methods still work — they resolve from the shared
 * {@link SshClient} session registry and carry no provider coupling (the Fly
 * client shares the same registry). Everything addressed by a sandbox id
 * throws: any non-Fly id reaching runtime today is stale data, and failing
 * loudly beats silently attempting an hcloud API call with a revoked token.
 */

import type {
  CreatedDevelopmentServer,
  WorkspaceProvisioningClient,
} from './sandbox-client.js';
import type { SshClient } from './ssh-client.js';
import type {
  ExecSyncResult,
  SandboxInfo,
  TerminalSessionInputEvent,
  TerminalSessionResult,
  TerminalSessionSnapshotOptions,
  TerminalSessionStartOptions,
} from './sandbox-types.js';

export class RetiredSandboxProviderError extends Error {
  constructor(operation: string, sandboxId?: string) {
    super(
      `The Hetzner sandbox provider was retired — only Fly machines are supported`
      + ` (${operation}${sandboxId ? ` on ${sandboxId}` : ''}).`,
    );
    this.name = 'RetiredSandboxProviderError';
  }
}

export class RetiredSandboxClient implements WorkspaceProvisioningClient {
  constructor(private readonly sshClient: SshClient) {}

  async getSandbox(sandboxId: string): Promise<SandboxInfo> {
    throw new RetiredSandboxProviderError('getSandbox', sandboxId);
  }

  async execSync(sandboxId: string): Promise<ExecSyncResult> {
    throw new RetiredSandboxProviderError('execSync', sandboxId);
  }

  async execTerminalStart(sandboxId: string): Promise<TerminalSessionResult> {
    throw new RetiredSandboxProviderError('execTerminalStart', sandboxId);
  }

  async execTerminalInput(
    sessionId: string,
    events: TerminalSessionInputEvent[],
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.sshClient.sendInput(sessionId, events, options);
  }

  async execTerminalRead(
    sessionId: string,
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.sshClient.readSession(sessionId, options);
  }

  async execTerminalClose(
    sessionId: string,
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.sshClient.closeSession(sessionId, options);
  }

  async enablePersistence(sandboxId: string): Promise<{ persistent: boolean }> {
    throw new RetiredSandboxProviderError('enablePersistence', sandboxId);
  }

  async disablePersistence(sandboxId: string): Promise<{ persistent: boolean }> {
    throw new RetiredSandboxProviderError('disablePersistence', sandboxId);
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    throw new RetiredSandboxProviderError('destroySandbox', sandboxId);
  }

  async createDevelopmentSandbox(args: { userId: string; name: string }): Promise<CreatedDevelopmentServer> {
    throw new RetiredSandboxProviderError(`createDevelopmentSandbox for ${args.userId}`);
  }

  getDefaultSandboxSize(): string {
    throw new RetiredSandboxProviderError('getDefaultSandboxSize');
  }
}
