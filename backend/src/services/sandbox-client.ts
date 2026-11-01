import type {
  ExecSyncOptions,
  ExecSyncResult,
  SandboxInfo,
  TerminalSessionInputEvent,
  TerminalSessionResult,
  TerminalSessionSnapshotOptions,
  TerminalSessionStartOptions,
} from './sandbox-types.js';
import type { CloudServer } from './cloud-provider.js';
import type { CloudReservationQuote } from './cloud-provider.js';
import type { SshUploadFile } from './ssh-client.js';

export interface CreatedDevelopmentServer {
  sandboxId: string;
  server: CloudServer;
  environmentPrepared: boolean;
  codexPrepared: boolean;
  codexVersion?: string;
  claudePrepared: boolean;
  claudeVersion?: string;
  preparationStatus: 'pending' | 'succeeded' | 'failed';
  preparationSummary?: string;
  preparationError?: string;
  reservationQuote?: CloudReservationQuote;
}

export interface WorkspaceRuntimeClient {
  getSandbox(sandboxId: string): Promise<SandboxInfo>;
  execSync(
    sandboxId: string,
    command: string,
    cwd?: string,
    options?: ExecSyncOptions,
  ): Promise<ExecSyncResult>;
  /** Write bounded runtime inputs without putting them in one shell argument. */
  uploadToSandbox?(
    sandboxId: string,
    files: SshUploadFile[],
    options?: { sshUser?: string },
  ): Promise<void>;
  execTerminalStart(
    sandboxId: string,
    command: string,
    cwd?: string,
    options?: TerminalSessionStartOptions,
  ): Promise<TerminalSessionResult>;
  execTerminalInput(
    sessionId: string,
    events: TerminalSessionInputEvent[],
    options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult>;
  execTerminalRead(sessionId: string, options?: TerminalSessionSnapshotOptions): Promise<TerminalSessionResult>;
  execTerminalClose(sessionId: string, options?: TerminalSessionSnapshotOptions): Promise<TerminalSessionResult>;
  /**
   * Move the machine onto another shape (note #268), and how big its durable
   * volume is. OPTIONAL: only a cloud backend can resize anything, and a
   * backend without them makes the Workspace's machine screen say so rather
   * than offering a control that cannot act.
   */
  resizeSandbox?(
    sandboxId: string,
    size: { cpuKind: string; cpus: number; memoryMb: number },
  ): Promise<{ changed: boolean; awake: boolean }>;
  getSandboxStorageGb?(sandboxId: string): Promise<number | undefined>;
  /**
   * Whether {@link resizeSandbox} can act on THIS id. Absent means the
   * method's own presence is the whole answer, which is true of every client
   * that serves one provider — and false of a client that ROUTES between
   * several, where the capability belongs to the provider the id names and
   * not to the router in front of them.
   */
  canResizeSandbox?(sandboxId: string): boolean;
  enablePersistence(sandboxId: string): Promise<{ persistent: boolean }>;
  disablePersistence(sandboxId: string): Promise<{ persistent: boolean }>;
  destroySandbox(sandboxId: string): Promise<void>;
}

export interface WorkspaceProvisioningClient extends WorkspaceRuntimeClient {
  createDevelopmentSandbox(args: {
    userId: string;
    name: string;
    tags?: string[];
    prepareEnvironment?: boolean;
  }): Promise<CreatedDevelopmentServer>;
  getDefaultSandboxSize(): string;
  getDefaultReservationQuote?(): Promise<CloudReservationQuote | null>;
}
