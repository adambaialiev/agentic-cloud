import type { WorkspaceRuntimeClient } from '../../services/sandbox-client.js';
import type {
  ExecSyncOptions,
  ExecSyncResult,
  SandboxInfo,
  TerminalSessionInputEvent,
  TerminalSessionResult,
  TerminalSessionSnapshotOptions,
  TerminalSessionStartOptions,
} from '../../services/sandbox-types.js';

export function makeExecSyncResult(overrides: Partial<ExecSyncResult> = {}): ExecSyncResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  };
}

export function makeTerminalSnapshot(args: {
  sessionId?: string;
  status?: TerminalSessionResult['status'];
  exitCode?: number | null;
  output?: string[];
} = {}): TerminalSessionResult {
  return {
    sessionId: args.sessionId ?? 'terminal-1',
    revision: 1,
    status: args.status ?? 'running',
    exitCode: args.exitCode ?? null,
    screen: {
      cols: 80,
      rows: 24,
      altBuffer: false,
      cursor: { row: 1, col: 1 },
      output: args.output ?? [],
    },
  };
}

/**
 * Serves the harness turn-output `tail -n +N '<path>'` polls from scripted
 * file contents. Turn file names are random UUIDs the test can't predict, so
 * paths are mapped to the scripted files in first-seen order (one file per
 * turn attempt). Returns null for commands that aren't turn-file tails so
 * callers can fall through to their own execSync handling.
 */
export class FakeTurnOutputFiles {
  private readonly pathOrder: string[] = [];
  /** Launch commands (detached setsid) in start order, for assertions. */
  readonly launchCommands: string[] = [];

  constructor(
    private readonly files: string[][],
    /** Per-file CLI exit code reported once all lines are served (default 0). */
    private readonly exitCodes: number[] = [],
    /** Per-file stderr sidecar contents (error tails; default ''). */
    private readonly stderrs: string[] = [],
    /**
     * Per-file number of polls to report RUNNING before finishing. A scripted
     * turn otherwise ends on its first poll, which never exercises anything
     * that happens WHILE a turn runs (mid-turn message hand-off, live status).
     */
    private readonly keepRunningPolls: number[] = [],
  ) {}

  /** Status polls served per turn file, for keepRunningPolls. */
  private readonly statusPolls = new Map<number, number>();

  answer(command: string): ExecSyncResult | null {
    // Stderr sidecar tail (error diagnostics).
    const stderrTail = /^tail -c \d+ '([^']+)\.stderr'/.exec(command);
    if (stderrTail) {
      const index = this.pathOrder.indexOf(stderrTail[1]);
      return makeExecSyncResult({ stdout: index === -1 ? '' : (this.stderrs[index] ?? '') });
    }
    // Detached launch: register the turn file and hand back a fake pid.
    const launch = /cat > '([^']+)\.sh' <<'HARNESS_TURN_/.exec(command);
    if (launch) {
      const path = launch[1].replace(/\.jsonl$/, '.jsonl');
      if (!this.pathOrder.includes(path)) this.pathOrder.push(path);
      this.launchCommands.push(command);
      return makeExecSyncResult({ stdout: '4242\n' });
    }
    const match = /^tail -n \+(\d+) '([^']+)'/.exec(command);
    if (!match) return null;
    const path = match[2];
    let index = this.pathOrder.indexOf(path);
    if (index === -1) {
      index = this.pathOrder.length;
      this.pathOrder.push(path);
    }
    const lines = this.files[index] ?? [];
    const from = Number(match[1]) - 1;
    const stdout = lines.slice(from).map((line) => `${line}\n`).join('');
    // Combined lines+status poll (detached protocol): status rides stderr —
    // the CLI "finishes" as soon as every scripted line has been served.
    if (command.includes(".exit'")) {
      const polls = (this.statusPolls.get(index) ?? 0) + 1;
      this.statusPolls.set(index, polls);
      const held = polls <= (this.keepRunningPolls[index] ?? 0);
      const finished = !held && from + lines.slice(from).length >= lines.length;
      const exitCode = this.exitCodes[index] ?? 0;
      return makeExecSyncResult({ stdout, stderr: finished ? `${exitCode}\n` : '__RUNNING__\n' });
    }
    return makeExecSyncResult({ stdout });
  }
}

/**
 * Scriptable in-memory WorkspaceRuntimeClient: `execSyncHandler` answers
 * synchronous commands, `terminalStartResult` + `terminalReads` (a FIFO
 * queue) script one PTY session.
 */
export class FakeWorkspaceRuntimeClient implements WorkspaceRuntimeClient {
  execSyncCalls: Array<{ sandboxId: string; command: string; cwd?: string; sshUser?: string }> = [];
  terminalStartCalls: Array<{
    sandboxId: string;
    command: string;
    cwd?: string;
    options?: TerminalSessionStartOptions;
  }> = [];

  terminalInputCalls: Array<[string, TerminalSessionInputEvent[]]> = [];
  closedTerminalSessions: string[] = [];
  execSyncHandler: (command: string) => ExecSyncResult = () => makeExecSyncResult();

  /** Detached-turn launches (setsid), for command/cwd/sshUser assertions. */
  get detachedLaunchCalls(): Array<{ sandboxId: string; command: string; cwd?: string; sshUser?: string }> {
    return this.execSyncCalls.filter((call) => call.command.includes('nohup setsid'));
  }
  terminalStartResult: TerminalSessionResult = makeTerminalSnapshot();
  /** When non-empty, each execTerminalStart shifts from here instead. */
  terminalStartResults: TerminalSessionResult[] = [];
  terminalReads: TerminalSessionResult[] = [];

  async getSandbox(sandboxId: string): Promise<SandboxInfo> {
    return { sandboxId } as SandboxInfo;
  }

  async execSync(
    sandboxId: string,
    command: string,
    cwd?: string,
    options?: ExecSyncOptions,
  ): Promise<ExecSyncResult> {
    this.execSyncCalls.push({ sandboxId, command, cwd, sshUser: options?.sshUser });
    return this.execSyncHandler(command);
  }

  async execTerminalStart(
    sandboxId: string,
    command: string,
    cwd?: string,
    options?: TerminalSessionStartOptions,
  ): Promise<TerminalSessionResult> {
    this.terminalStartCalls.push({ sandboxId, command, cwd, options });
    return this.terminalStartResults.shift() ?? this.terminalStartResult;
  }

  async execTerminalInput(
    sessionId: string,
    events: TerminalSessionInputEvent[],
  ): Promise<TerminalSessionResult> {
    this.terminalInputCalls.push([sessionId, events]);
    return this.nextTerminalRead(sessionId);
  }

  async execTerminalRead(
    sessionId: string,
    _options?: TerminalSessionSnapshotOptions,
  ): Promise<TerminalSessionResult> {
    return this.nextTerminalRead(sessionId);
  }

  async execTerminalClose(sessionId: string): Promise<TerminalSessionResult> {
    this.closedTerminalSessions.push(sessionId);
    return makeTerminalSnapshot({ sessionId, status: 'closed', exitCode: null });
  }

  async enablePersistence(): Promise<{ persistent: boolean }> {
    return { persistent: true };
  }

  async disablePersistence(): Promise<{ persistent: boolean }> {
    return { persistent: false };
  }

  async destroySandbox(): Promise<void> {}

  private nextTerminalRead(sessionId: string): TerminalSessionResult {
    const queued = this.terminalReads.shift();
    return queued ?? makeTerminalSnapshot({ sessionId, status: 'exited', exitCode: 0 });
  }
}
