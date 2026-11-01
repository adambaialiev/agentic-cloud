export interface SandboxInfo {
  id: string;
  containerId?: string;
  status: 'creating' | 'running' | 'stopped' | 'expired' | 'error';
  publicUrl?: string;
  expiresAt?: string;
  execCount?: number;
  /**
   * Where the machine runs and what it is made of. Optional because only a
   * cloud backend knows them — but when one does, they arrive in the SAME
   * reply as `status` and used to be dropped by this mapping, so anything
   * already asking whether a machine is awake can show them for free.
   *
   * `cpuKind` is the shared-vs-dedicated fact (note #268): the one that
   * explains a machine that is mysteriously slow, and the one nothing outside
   * Fly's own dashboard could see before.
   */
  region?: string;
  memoryMb?: number;
  cpuKind?: string;
  cpus?: number;
}

export interface ExecSyncResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecBackgroundResult {
  taskId: string;
  outputFile: string;
  status: 'running';
}

export interface ExecInteractiveResult {
  sessionId: string;
  output: string;
  status: 'running' | 'exited' | 'closed';
  exitCode: number | null;
  forced?: boolean;
  timedOut?: boolean;
  signal?: string;
}

export interface TerminalSessionCursor {
  row: number;
  col: number;
}

export interface TerminalSessionChangedRow {
  row: number;
  text: string;
}

export interface TerminalSessionScreen {
  cols: number;
  rows: number;
  altBuffer: boolean;
  cursor: TerminalSessionCursor;
  output: string[];
  changedRows?: TerminalSessionChangedRow[];
}

export interface TerminalSessionResult {
  sessionId: string;
  revision: number;
  status: 'running' | 'exited' | 'closed';
  currentCommand?: string;
  processState?: 'running' | 'waiting_for_input' | 'exited';
  stableForMs?: number;
  exitCode: number | null;
  screen: TerminalSessionScreen;
  lastActivityMs?: number;
  forced?: boolean;
  timedOut?: boolean;
  warning?: string;
  signal?: string;
}

export interface TerminalSessionInputEventText {
  type: 'text';
  text: string;
  multiline?: boolean;
}

export interface TerminalSessionInputEventKey {
  type: 'key';
  key: string;
}

export interface TerminalSessionInputEventCtrl {
  type: 'ctrl';
  key: string;
}

export interface TerminalSessionInputEventRaw {
  type: 'raw';
  data: string;
}

export type TerminalSessionInputEvent =
  | TerminalSessionInputEventText
  | TerminalSessionInputEventKey
  | TerminalSessionInputEventCtrl
  | TerminalSessionInputEventRaw;

export type TerminalSessionOutputMode = 'screen' | 'raw';

export type TerminalSessionReadMode = 'full' | 'delta';

export interface TerminalSessionSnapshotOptions {
  outputMode?: TerminalSessionOutputMode;
  readMode?: TerminalSessionReadMode;
  quietForMs?: number;
  timeoutMs?: number;
  waitForChange?: boolean;
}

export interface TerminalSessionStartOptions extends TerminalSessionSnapshotOptions {
  cols?: number;
  rows?: number;
  /** SSH login user for this session; defaults to the client's configured user. */
  sshUser?: string;
}

export interface ExecSyncOptions {
  timeoutMs?: number;
  /** SSH login user for this command; defaults to the client's configured user. */
  sshUser?: string;
  /**
   * Fly normally wakes a stopped machine before SSH. Set false for a
   * read-only observation that must fail rather than change machine state.
   */
  wake?: boolean;
}
