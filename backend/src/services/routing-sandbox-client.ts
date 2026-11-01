import { isFlySandboxId } from './fly-sandbox-id.js';
import type { FlySandboxClient, ResolvedFlySshConnection } from './fly-sandbox-client.js';
import type {
  CreatedDevelopmentServer,
  WorkspaceProvisioningClient,
} from './sandbox-client.js';
import type { CloudReservationQuote } from './cloud-provider.js';
import type { SshUploadFile } from './ssh-client.js';
import type {
  ExecSyncOptions,
  ExecSyncResult,
  SandboxInfo,
  TerminalSessionInputEvent,
  TerminalSessionResult,
  TerminalSessionSnapshotOptions,
  TerminalSessionStartOptions,
} from './sandbox-types.js';

/**
 * A {@link WorkspaceProvisioningClient} that dispatches per call to the right
 * provider by looking at the sandbox id:
 *
 * - `fly-sandbox-<app>.<machine>` → the {@link FlySandboxClient} (wake-on-connect,
 *   private 6PN IPv6 on :2222). This is what makes a harness message to a stopped
 *   Fly machine transparently wake it — every exec path resolves the machine
 *   first, and the Fly client starts it before handing out a connection target.
 * - anything else (`hcloud-sandbox-<id>`, legacy ids) → the default client —
 *   since the Hetzner provider retirement, a stub that keeps session-keyed
 *   terminal methods working and fails loudly on stale sandbox ids.
 *
 * Fly machines are provisioned by the setup-agent administrator tools against the
 * Fly client directly (app-per-agent: a fresh app per machine), not through
 * `createDevelopmentSandbox`, so provisioning stays on the default client.
 *
 * Session-keyed terminal methods (`input`/`read`/`close` take a sessionId, not a
 * sandbox id) are delegated to the default client, which **must share its
 * `SshClient` instance with the Fly client** (wired in `index.ts`) so a session
 * started on either provider resolves from the one shared session map.
 */
export class RoutingSandboxClient implements WorkspaceProvisioningClient {
  constructor(
    private readonly defaultClient: WorkspaceProvisioningClient,
    private readonly flyClient?: FlySandboxClient,
  ) {}

  private routeForSandbox(sandboxId: string): WorkspaceProvisioningClient {
    if (this.flyClient && isFlySandboxId(sandboxId)) {
      return this.flyClient as unknown as WorkspaceProvisioningClient;
    }
    return this.defaultClient;
  }

  /** The Fly client, when configured (used by the setup-agent tools + reaper). */
  getFlyClient(): FlySandboxClient | undefined {
    return this.flyClient;
  }

  async resolveFlySshConnection(sandboxId: string, sshUser?: string): Promise<ResolvedFlySshConnection> {
    if (!this.flyClient || !isFlySandboxId(sandboxId)) {
      throw new Error(`resolveFlySshConnection is only available for Fly sandbox ids (got ${sandboxId}).`);
    }
    return this.flyClient.resolveSshConnection(sandboxId, sshUser);
  }

  // ── Provisioning (default provider) ──

  createDevelopmentSandbox(args: {
    userId: string;
    name: string;
    tags?: string[];
    prepareEnvironment?: boolean;
  }): Promise<CreatedDevelopmentServer> {
    return this.defaultClient.createDevelopmentSandbox(args);
  }

  getDefaultSandboxSize(): string {
    return this.defaultClient.getDefaultSandboxSize();
  }

  getDefaultReservationQuote(): Promise<CloudReservationQuote | null> {
    return this.defaultClient.getDefaultReservationQuote?.() ?? Promise.resolve(null);
  }

  // ── Runtime (routed by sandbox id) ──

  getSandbox(sandboxId: string): Promise<SandboxInfo> {
    return this.routeForSandbox(sandboxId).getSandbox(sandboxId);
  }

  execSync(
    sandboxId: string,
    command: string,
    cwd?: string,
    options?: ExecSyncOptions,
  ): Promise<ExecSyncResult> {
    return this.routeForSandbox(sandboxId).execSync(sandboxId, command, cwd, options);
  }

  uploadToSandbox(
    sandboxId: string,
    files: SshUploadFile[],
    options?: { sshUser?: string },
  ): Promise<void> {
    const client = this.routeForSandbox(sandboxId);
    if (!client.uploadToSandbox) return Promise.reject(new Error(`This machine's provider cannot receive files for ${sandboxId}.`));
    return client.uploadToSandbox(sandboxId, files, options);
  }

  execTerminalStart(
    sandboxId: string,
    command: string,
    cwd?: string,
    options?: TerminalSessionStartOptions,
  ): Promise<TerminalSessionResult> {
    return this.routeForSandbox(sandboxId).execTerminalStart(sandboxId, command, cwd, options);
  }

  execTerminalInput(
    sessionId: string,
    events: TerminalSessionInputEvent[],
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.defaultClient.execTerminalInput(sessionId, events, options);
  }

  execTerminalRead(sessionId: string, options?: TerminalSessionSnapshotOptions): Promise<TerminalSessionResult> {
    return this.defaultClient.execTerminalRead(sessionId, options);
  }

  execTerminalClose(sessionId: string, options?: TerminalSessionSnapshotOptions): Promise<TerminalSessionResult> {
    return this.defaultClient.execTerminalClose(sessionId, options);
  }

  /**
   * The two OPTIONAL runtime methods (note #268), forwarded like every other
   * routed call — and the reason they are worth their own note: an optional
   * method a wrapper forgets is not a type error, it is a capability that
   * silently reads as ABSENT everywhere. Forgotten here, they cost the whole
   * Fly fleet its machine screen: `canResize` went false for every agent and
   * the Workspace said a size "cannot be changed from here", while the disk
   * figure simply never appeared. Anything added to the interface as `?:`
   * has to be added HERE too, because production reaches every machine
   * through this router.
   */
  resizeSandbox(
    sandboxId: string,
    size: { cpuKind: string; cpus: number; memoryMb: number },
  ): Promise<{ changed: boolean; awake: boolean }> {
    const client = this.routeForSandbox(sandboxId);
    if (!client.resizeSandbox) {
      return Promise.reject(new Error(`This machine's provider cannot resize ${sandboxId}.`));
    }
    return client.resizeSandbox(sandboxId, size);
  }

  getSandboxStorageGb(sandboxId: string): Promise<number | undefined> {
    const client = this.routeForSandbox(sandboxId);
    return client.getSandboxStorageGb?.(sandboxId) ?? Promise.resolve(undefined);
  }

  /**
   * A router HAS the method for every id and can act on only some of them,
   * so the honest answer is the routed provider's: a stale non-Fly id still
   * gets a screen that says what the machine is and offers no control it
   * cannot honour.
   */
  canResizeSandbox(sandboxId: string): boolean {
    const client = this.routeForSandbox(sandboxId);
    return Boolean(client.resizeSandbox) && (client.canResizeSandbox?.(sandboxId) ?? true);
  }

  enablePersistence(sandboxId: string): Promise<{ persistent: boolean }> {
    return this.routeForSandbox(sandboxId).enablePersistence(sandboxId);
  }

  disablePersistence(sandboxId: string): Promise<{ persistent: boolean }> {
    return this.routeForSandbox(sandboxId).disablePersistence(sandboxId);
  }

  destroySandbox(sandboxId: string): Promise<void> {
    return this.routeForSandbox(sandboxId).destroySandbox(sandboxId);
  }
}
