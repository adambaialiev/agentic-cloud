/**
 * File-based transport for a harness turn's JSONL event stream.
 *
 * The CLI's stdout is redirected to a per-turn file on the sandbox VM and
 * polled back with line-offset `tail -n +N` reads over execSync. This keeps
 * the PTY out of the parse path — no ANSI escapes, no wrapping at terminal
 * width, and stdout is a regular file so the CLI never colorizes it — while
 * the PTY keeps owning the process lifecycle (status, exit code, abort) and
 * now carries only stderr, which is exactly what error tails want.
 *
 * Line offsets (not byte offsets) make reads safe and idempotent: a line
 * boundary is always a valid UTF-8 boundary, a partially written last line
 * is simply re-fetched once complete, and a failed read leaves the offset
 * unchanged so the next poll retries without losing events.
 */

import { randomUUID } from 'node:crypto';
import type { WorkspaceRuntimeClient } from '../services/sandbox-client.js';
import type { HarnessTurnAttachInfo } from '../types/agent.js';
import { quoteShellArg } from '../utils/shell-quote.js';

/**
 * Live detached turns, keyed by run key (`sessionId::agent:<agentId>`). The
 * shutdown handler snapshots these into pending_turn_resumes so the next boot
 * re-attaches instead of re-running. Updated in place by the poll loop.
 */
const activeDetachedTurns = new Map<string, HarnessTurnAttachInfo>();

export function registerActiveDetachedTurn(runKey: string, info: HarnessTurnAttachInfo): void {
  activeDetachedTurns.set(runKey, info);
}

export function updateActiveDetachedTurn(runKey: string, patch: Partial<HarnessTurnAttachInfo>): void {
  const current = activeDetachedTurns.get(runKey);
  if (current) activeDetachedTurns.set(runKey, { ...current, ...patch });
}

export function clearActiveDetachedTurn(runKey: string): void {
  activeDetachedTurns.delete(runKey);
}

export function getActiveDetachedTurn(runKey: string): HarnessTurnAttachInfo | undefined {
  return activeDetachedTurns.get(runKey);
}

/**
 * Set at SIGTERM, before agent loops are aborted: the abort then means "the
 * BACKEND is going away", not "the user cancelled" — harnesses must leave the
 * remote CLI running (the checkpoint carries the attach info) instead of
 * killing the process group.
 */
let shutdownInProgress = false;
export function markHarnessShutdown(): void {
  shutdownInProgress = true;
}
export function isHarnessShutdownInProgress(): boolean {
  return shutdownInProgress;
}

export const TURN_OUTPUT_DIR = '/tmp';
export const TURN_OUTPUT_PREFIX = 'infinite-agents-harness-turn-';

const READ_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 15_000;

/** A replacement turn must not launch after one of these safety failures. */
export class DetachedTurnRestartSafetyError extends Error {
  override readonly name: string = 'DetachedTurnRestartSafetyError';
}

/** Restarting after this error could overlap the still-running old CLI. */
export class DetachedTurnTerminationError extends DetachedTurnRestartSafetyError {
  override readonly name = 'DetachedTurnTerminationError';
}

/** Restarting after this error could lose the native conversation pointer. */
export class DetachedTurnContinuityError extends DetachedTurnRestartSafetyError {
  override readonly name = 'DetachedTurnContinuityError';
}

/**
 * The turn's machine stopped answering (note #1068). A termination error on
 * purpose: nobody can prove the CLI there is gone, so the run keeps its
 * registry entry and the next message first stops the old turn, but the run
 * itself ends now, loudly, and the agent is idle again.
 */
export class DetachedTurnUnreachableError extends DetachedTurnTerminationError {}

/**
 * How long the backend keeps trying a machine that does not answer before a
 * turn, a stop or a recovery gives up (note #1068). Before, the retry loops
 * below had no end but a backend shutdown, so an agent whose machine admitted
 * another address showed "working" for hours and could not even be stopped.
 */
let unreachableGiveUpMs = 2 * 60_000;
export function setUnreachableGiveUpMsForTests(ms: number): void {
  unreachableGiveUpMs = ms;
}
/** The moment a retry loop starting now gives up on an unanswering machine. */
export function unreachableDeadline(): number {
  return Date.now() + unreachableGiveUpMs;
}
export function unreachableGiveUpMinutes(): string {
  const minutes = unreachableGiveUpMs / 60_000;
  return minutes >= 1 ? `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}` : `${Math.round(unreachableGiveUpMs / 1000)} s`;
}

/** The machine did not answer at all, as opposed to a command that failed on it. */
export function isMachineUnreachable(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'MachineUnreachableError' || name === 'MachineWakeError';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildTurnOutputPath(): string {
  return `${TURN_OUTPUT_DIR}/${TURN_OUTPUT_PREFIX}${randomUUID()}.jsonl`;
}

/**
 * Legacy streamed-input support. Fresh harness turns no longer use this FIFO:
 * injecting a later message could interrupt the tool wait already in flight.
 * Kept temporarily so a turn launched before a rolling deploy can re-attach
 * and close its existing pipe instead of being stranded.
 *
 * Derived from the output path so every sidecar for a turn shares one name.
 */
export function buildTurnInputPath(outputPath: string): string {
  return `${outputPath}.in`;
}

/** The keeper's pid file: the process holding the FIFO's write end open. */
function turnInputKeeperPath(inputPath: string): string {
  return `${inputPath}.keeper`;
}

/**
 * How long the keeper lives if nobody closes it.
 *
 * A FIFO reader sees EOF only when the LAST writer closes, so something must
 * hold the write end open for the whole turn — otherwise the CLI reads EOF the
 * instant the first message is written and stops accepting input. That keeper
 * is also the failure mode to bound: if the backend dies without closing it,
 * the CLI would sit on an open stdin forever. Two hours is far longer than any
 * real turn and far shorter than "forever".
 */
export const TURN_INPUT_KEEPER_MAX_SECONDS = 7200;

/** How long an inject call waits before giving up (the CLI may have exited). */
const TURN_INPUT_WRITE_TIMEOUT_SECONDS = 5;

/**
 * A message, as base64, ready to be interpolated bare into a shell command.
 *
 * The payload is JSON, so it is FULL of double quotes — and the first version
 * of this shipped it as a single-quoted argument inside a double-quoted
 * `sh -c "..."`, where those quotes closed the wrapper and the shell ate them.
 * The CLI received `{type:user,...}`, which is not JSON. It got through review
 * and a unit test because the test asserted on fragments of the command string
 * instead of running it (dev, 2026-08-12).
 *
 * base64 is alphanumeric plus `+/=`: nothing a shell reinterprets, at any
 * nesting depth. The trailing newline is encoded WITH the payload so the
 * decoder never has to add one.
 */
function encodeTurnInputPayload(line: string): string {
  return Buffer.from(`${line}\n`, 'utf8').toString('base64');
}

/**
 * Redirect a turn command's stdout into the turn file. The brace group scopes
 * the redirect over compound commands (e.g. Codex's `codex mcp add …; codex
 * exec …`). Each file lives directly in the world-writable sticky `/tmp`
 * directory: using a shared subdirectory lets a stale root-owned directory
 * block the non-root harness user. `umask 077` keeps the per-turn file private.
 *
 * The harness commands run inside an interactive SSH shell, so
 * explicitly close stdin for their headless modes and exit that shell with
 * the CLI status. Without EOF, a CLI may wait on the PTY before emitting its
 * first event; without the explicit exit, the supervisor stays `running`
 * after the CLI has already completed.
 */
export function redirectCommandToTurnOutput(command: string, outputPath: string): string {
  return [
    `umask 077; { ${command}; } > '${outputPath}' < /dev/null`,
    '__harness_exit=$?',
    'exit "$__harness_exit"',
  ].join('; ');
}

/** Sidecar paths derived from the turn file: stderr transcript, exit code, pid. */
export function turnSidecarPaths(outputPath: string): {
  stderrPath: string;
  exitPath: string;
  pidPath: string;
  scriptPath: string;
  launchLockPath: string;
  cancelPath: string;
} {
  return {
    stderrPath: `${outputPath}.stderr`,
    exitPath: `${outputPath}.exit`,
    pidPath: `${outputPath}.pid`,
    scriptPath: `${outputPath}.sh`,
    launchLockPath: `${outputPath}.launch`,
    cancelPath: `${outputPath}.cancel`,
  };
}

export interface DetachedTurnHandle {
  outputPath: string;
  pid: number;
  /** The launch finished before its acknowledgement was recovered. */
  alreadyFinished?: boolean;
}

export type DetachedTurnProbeResult =
  | { state: 'running'; pid?: number }
  | { state: 'finished'; pid?: number }
  | { state: 'gone' }
  | { state: 'unknown' };

/**
 * `export NAME='value'` lines for the launch script.
 *
 * The heredoc that carries this script is quoted, so the shell performs no
 * expansion while writing it — a value containing `$(...)` or backticks lands
 * verbatim and is then protected by single quotes when the script runs. Names
 * are validated upstream (`validateUserSecretName`) and re-checked here: a name
 * is interpolated bare, so an unchecked one would be shell injection.
 */
export function buildTurnEnvExports(env: Record<string, string> | undefined): string[] {
  if (!env) {
    return [];
  }
  return Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${quoteShellArg(value)}`);
}

/**
 * Launch a turn command DETACHED from the SSH session (setsid + nohup), so it
 * keeps running when the backend restarts (deploys used to kill in-flight
 * turns with the connection — observed live 2026-07-18, an 11-minute intro
 * interrupted twice). The command body ships as a script file (heredoc with a
 * random quoted delimiter, so the CLI command's own quoting never fights the
 * launcher). stdout → the turn JSONL, stderr → sidecar, exit code → sidecar
 * on completion, pid (= process-group id, thanks to setsid) → sidecar for
 * post-restart attach/abort.
 *
 * `options.env` exports the user's saved secrets for the turn. They go in the
 * script body rather than the command line so they never appear in `ps` output
 * on the machine; the script is written under `umask 077` and removed when the
 * turn ends. Callers MUST also pass the values to {@link redactHarnessSecrets}
 * for anything derived from the turn.
 */
export async function startDetachedTurn(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  command: string,
  outputPath: string,
  options: {
    cwd?: string;
    sshUser?: string;
    env?: Record<string, string>;
    /** User steering/Stop may fence an acknowledgement-uncertain launch. */
    signal?: AbortSignal;
    /** Legacy only: feed the turn over a FIFO. Fresh harness callers omit it. */
    input?: { path: string; firstMessage: string };
  } = {},
): Promise<DetachedTurnHandle> {
  const {
    stderrPath, exitPath, pidPath, scriptPath, launchLockPath, cancelPath,
  } = turnSidecarPaths(outputPath);
  const delimiter = `HARNESS_TURN_${randomUUID().replace(/-/g, '')}`;
  // A legacy input-pipe turn reads stdin from a FIFO for its whole life. The
  // keeper holds the write end
  // open (see TURN_INPUT_KEEPER_MAX_SECONDS) and lives in the SAME process
  // group as the turn, so the existing abort path takes it down with the CLI.
  //
  // The keeper also DELIVERS THE FIRST MESSAGE. Writing it from the backend
  // instead would race the CLI's startup: opening a FIFO for writing blocks
  // until a reader arrives, and on a machine waking from sleep the CLI is
  // seconds away from opening stdin. Handing it to the writer that is already
  // rendezvousing with the reader removes the timing question entirely.
  //
  // `exec sleep` matters: without it `$!` is the subshell and killing it would
  // leave `sleep` holding the write end open, so the CLI would never see EOF.
  const inputSetup = options.input
    ? [
      `mkfifo '${options.input.path}'`,
      `{ printf %s ${encodeTurnInputPayload(options.input.firstMessage)} | base64 -d;`
      + ` exec sleep ${TURN_INPUT_KEEPER_MAX_SECONDS}; } > '${options.input.path}' &`,
      `echo $! > '${turnInputKeeperPath(options.input.path)}'`,
    ]
    : [];
  const stdinRedirect = options.input ? `< '${options.input.path}'` : '< /dev/null';
  const launch = [
    'umask 077',
    // execSync may transparently retry after a lost SSH connection. The
    // advisory lock is the remote exactly-once claim: only its winner issues
    // nohup. FD 9 is inherited by the child, which releases it only after
    // atomically writing its own PID; if the launcher dies before nohup, the
    // kernel releases the lock and recovery can authoritatively say "gone".
    `exec 9> '${launchLockPath}'`,
    // A retry waits for the current winner. If that winner dies before nohup,
    // the kernel releases FD 9 and this invocation safely takes over.
    'if flock -w 10 9; then',
    // Manual Stop / steering can fence a launch whose original SSH RPC was
    // still unresolved at shutdown. The tombstone is checked while holding
    // the same transaction lock, so a late launcher can never cross nohup.
    `if [ -f '${cancelPath}' ]; then flock -u 9; exec 9>&-; exit 76; fi`,
    `__harness_existing="$(cat '${pidPath}' 2>/dev/null)"`,
    'case "$__harness_existing" in ""|*[!0-9]*) __harness_existing_valid=0 ;; *) __harness_existing_valid=1 ;; esac',
    `__harness_existing_cmdline="$(tr '\\0' '\\n' < "/proc/$__harness_existing/cmdline" 2>/dev/null || true)"`,
    `if [ "$__harness_existing_valid" -eq 1 ] && { [ -f '${exitPath}' ] || { kill -0 -- -"$__harness_existing" 2>/dev/null && { [ -z "$__harness_existing_cmdline" ] || printf '%s\\n' "$__harness_existing_cmdline" | grep -Fx -- '${scriptPath}' >/dev/null; }; }; }; then`,
    // A transparent retry acquired the lock after the first launcher had
    // already published its PID. Return that exact launch; never nohup twice.
    'flock -u 9; exec 9>&-; echo "$__harness_existing"',
    'else',
    `if ! cat > '${scriptPath}' <<'${delimiter}'`,
    // The detached process writes its own identity before doing any work.
    // This is the authoritative recovery fence if the parent SSH response is
    // lost after nohup starts but before the echoed PID reaches the backend.
    `echo "$$" > '${pidPath}' || { flock -u 9; exec 9>&-; exit 74; }`,
    'flock -u 9; exec 9>&-',
    ...buildTurnEnvExports(options.env),
    ...inputSetup,
    `{ ${command}; } > '${outputPath}' ${stdinRedirect} 2> '${stderrPath}'`,
    `echo $? > '${exitPath}'`,
    delimiter,
    'then flock -u 9; exec 9>&-; exit 74; fi',
    // stdin MUST be closed too: the detached child inherits the SSH exec
    // channel's stdin, and a held fd keeps the channel (and the launch
    // command) open until it times out with exit 124 — observed live on the
    // first deployed launch.
    `nohup setsid bash '${scriptPath}' >/dev/null 2>&1 < /dev/null &`,
    // `$!` can be the short-lived setsid wrapper when setsid must fork. Only
    // the final bash process's `$$` above is authoritative; wait for that
    // self-published sidecar rather than racing it with the wrapper PID.
    '__harness_wait=0',
    `while [ ! -s '${pidPath}' ] && [ ! -f '${exitPath}' ] && [ "$__harness_wait" -lt 100 ]; do sleep 0.1; __harness_wait=$((__harness_wait + 1)); done`,
    `__harness_pid="$(cat '${pidPath}' 2>/dev/null)"`,
    // Close only the launcher's copy. An unusually slow setsid child still
    // owns the inherited open-file description and must keep the flock until
    // it publishes its PID (or dies); an explicit unlock here would release
    // the child's fence too and permit a duplicate nohup after exit 75.
    'exec 9>&-',
    'case "$__harness_pid" in ""|*[!0-9]*) exit 75 ;; *) echo "$__harness_pid" ;; esac',
    'fi',
    'else',
    '__harness_wait=0',
    `while [ ! -s '${pidPath}' ] && [ ! -f '${exitPath}' ] && [ "$__harness_wait" -lt 100 ]; do sleep 0.1; __harness_wait=$((__harness_wait + 1)); done`,
    `__harness_pid="$(cat '${pidPath}' 2>/dev/null)"`,
    'case "$__harness_pid" in ""|*[!0-9]*) exit 75 ;; *) echo "$__harness_pid" ;; esac',
    'fi',
  ].join('\n');
  let launchFailure: unknown;
  let launchAcknowledgementUncertain = false;
  try {
    const result = await sandboxClient.execSync(sandboxId, launch, options.cwd, {
      timeoutMs: READ_TIMEOUT_MS,
      sshUser: options.sshUser,
    });
    const pid = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10);
    if (result.exitCode === 0 && Number.isFinite(pid) && pid > 0) {
      return { outputPath, pid };
    }
    // execSync represents a response timeout as a resolved result. The remote
    // shell may still have crossed nohup, so this is just as uncertain as a
    // thrown connection error and may never release the provisional marker.
    launchAcknowledgementUncertain = result.timedOut || result.exitCode === 75;
    launchFailure = new Error(
      `Failed to launch detached turn: exit=${result.exitCode} stdout=${result.stdout.slice(-200)} stderr=${result.stderr.slice(-200)}`,
    );
  } catch (error) {
    launchFailure = error;
    launchAcknowledgementUncertain = true;
  }

  const finishCancelledLaunch = async (): Promise<DetachedTurnHandle | undefined> => {
    if (!options.signal?.aborted || isHarnessShutdownInProgress()) return undefined;
    // Do not reissue an old command merely to learn its PID after the user has
    // stopped or steered. Fence the same remote transaction first. If its
    // wrapper already won, return that one handle so the provider's ordinary
    // abort path kills/final-drains it; if cancellation won, pid=0 plus
    // alreadyFinished flows through the same no-signal cleanup boundary.
    await cancelDetachedLaunchUntilMarked(
      sandboxClient,
      sandboxId,
      outputPath,
      options.sshUser,
    );
    const cancelled = await inspectDetachedTurnUntilKnown(
      sandboxClient,
      sandboxId,
      outputPath,
      options.sshUser,
    );
    if (cancelled.state === 'running' && cancelled.pid) {
      return { outputPath, pid: cancelled.pid };
    }
    if (cancelled.state === 'finished') {
      return {
        outputPath,
        pid: cancelled.pid ?? 0,
        alreadyFinished: true,
      };
    }
    if (cancelled.state === 'gone') {
      return { outputPath, pid: 0, alreadyFinished: true };
    }
    return undefined;
  };

  // A timeout or lost SSH response does NOT prove the remote shell failed:
  // nohup may already have started the CLI and written its PID sidecar. A
  // blind retry here would create two CLIs for the same turn. Reconcile the
  // unique output/script sidecars until the outcome is authoritative. Three
  // consecutive, successful "gone" probes prove there is no matching launch;
  // transport uncertainty keeps this call (and the runner slot) quarantined.
  let authoritativeMisses = 0;
  while (true) {
    const cancelled = await finishCancelledLaunch();
    if (cancelled) return cancelled;
    const inspected = await inspectDetachedTurn(
      sandboxClient,
      sandboxId,
      outputPath,
      options.sshUser,
    );
    if (inspected.state === 'running' && inspected.pid && inspected.pid > 0) {
      return { outputPath, pid: inspected.pid };
    }
    if (inspected.state === 'finished') {
      return {
        outputPath,
        pid: inspected.pid && inspected.pid > 0 ? inspected.pid : 0,
        alreadyFinished: true,
      };
    }
    if (isHarnessShutdownInProgress()) {
      throw new DetachedTurnTerminationError(
        `Detached turn launch outcome for ${outputPath} is still uncertain during backend shutdown.`,
        { cause: launchFailure },
      );
    }
    if (inspected.state === 'gone') {
      authoritativeMisses += 1;
      if (authoritativeMisses >= 3) {
        if (!launchAcknowledgementUncertain) {
          // Even an explicit remote non-zero is not, by itself, proof that a
          // lower transport retry has no older wrapper still in flight. Fence
          // the UUID transaction before releasing the provisional marker;
          // if that wrapper won first, recover its one authoritative handle.
          await cancelDetachedLaunchUntilMarked(
            sandboxClient,
            sandboxId,
            outputPath,
            options.sshUser,
          );
          const afterFence = await inspectDetachedTurnUntilKnown(
            sandboxClient,
            sandboxId,
            outputPath,
            options.sshUser,
          );
          if (afterFence.state === 'running' && afterFence.pid) {
            return { outputPath, pid: afterFence.pid };
          }
          if (afterFence.state === 'finished') {
            return {
              outputPath,
              pid: afterFence.pid ?? 0,
              alreadyFinished: true,
            };
          }
          throw launchFailure instanceof Error
            ? launchFailure
            : new Error(`Failed to launch detached turn for ${outputPath}.`);
        }
        // The remote transaction is idempotent under flock + its published
        // PID. Re-issuing the EXACT command restores liveness when the first
        // RPC never reached the machine; if that first RPC merely starts late,
        // both invocations race on the lock and only one may cross nohup.
        const cancelledBeforeRetry = await finishCancelledLaunch();
        if (cancelledBeforeRetry) return cancelledBeforeRetry;
        try {
          const retried = await sandboxClient.execSync(sandboxId, launch, options.cwd, {
            timeoutMs: READ_TIMEOUT_MS,
            sshUser: options.sshUser,
          });
          const retriedPid = Number.parseInt(retried.stdout.trim().split('\n').at(-1) ?? '', 10);
          if (retried.exitCode === 0 && Number.isFinite(retriedPid) && retriedPid > 0) {
            return { outputPath, pid: retriedPid };
          }
          launchAcknowledgementUncertain ||= retried.timedOut || retried.exitCode === 75;
          launchFailure = new Error(
            `Failed to reconcile detached launch: exit=${retried.exitCode} stdout=${retried.stdout.slice(-200)} stderr=${retried.stderr.slice(-200)}`,
          );
        } catch (error) {
          launchAcknowledgementUncertain = true;
          launchFailure = error;
        }
        authoritativeMisses = 0;
      }
    } else {
      authoritativeMisses = 0;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(Math.max(authoritativeMisses, 1), 5) * 250);
    });
  }
}

/**
 * Legacy helper for a streamed-input turn. Fresh harness code must leave
 * queued messages in BackgroundRunner for the next turn instead.
 *
 * Wrapped in `timeout`: opening a FIFO for writing blocks until a reader is
 * there, so if the CLI has already exited this would hang the backend's SSH
 * call instead of failing. Returns false when the write did not land — the
 * caller keeps the message and lets the normal next-turn path carry it, which
 * is why a failure here costs nothing.
 */
export async function writeTurnInput(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  inputPath: string,
  line: string,
  sshUser?: string,
): Promise<boolean> {
  try {
    const result = await sandboxClient.execSync(
      sandboxId,
      `printf %s ${encodeTurnInputPayload(line)}`
      + ` | timeout ${TURN_INPUT_WRITE_TIMEOUT_SECONDS} sh -c "base64 -d >> '${inputPath}'"`,
      undefined,
      { timeoutMs: CLEANUP_TIMEOUT_MS, sshUser },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Close the turn's stdin: kill the keeper, so the CLI sees EOF and exits.
 *
 * This is what ends a legacy streamed-input turn after a rolling-deploy
 * re-attach — without it the CLI waits for more input and never completes. Best-effort and
 * idempotent: a keeper that is already gone, or a turn that never had an input
 * pipe, is not an error.
 */
export async function closeTurnInput(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  inputPath: string,
  sshUser?: string,
): Promise<void> {
  const keeperPath = turnInputKeeperPath(inputPath);
  try {
    await sandboxClient.execSync(
      sandboxId,
      `kill "$(cat '${keeperPath}' 2>/dev/null)" 2>/dev/null; rm -f '${keeperPath}'; true`,
      undefined,
      { timeoutMs: CLEANUP_TIMEOUT_MS, sshUser },
    );
  } catch {
    // The keeper is gone (turn already ended, machine rebooted) — nothing to do.
  }
}

/** SIGTERM the detached turn's whole process group (user-initiated interrupt). */
export async function killDetachedTurn(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  pid: number,
  sshUser?: string,
  outputPath?: string,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new DetachedTurnTerminationError(
      `Refusing to signal an unresolved detached turn pid (${String(pid)}).`,
    );
  }
  // Sending TERM is not the same as stopping. Steering starts a replacement
  // CLI in the same native conversation, so letting this helper return while
  // the old process still exists can run two turns concurrently against the
  // same workspace and session. Wait for the whole detached process group;
  // after a five-second grace period, KILL it and prove it is gone before the
  // harness is allowed to resolve.
  // Every turn is launched by setsid, so its PID is also its process-group
  // id. Group-only probes/signals avoid a nasty reuse race where the leader
  // exits, its numeric PID is recycled, and a bare-PID fallback later kills
  // the unrelated replacement while an old child still keeps the group live.
  const alive = `kill -0 -- -${pid} 2>/dev/null`;
  const identityGuard = outputPath
    ? (() => {
      const { scriptPath } = turnSidecarPaths(outputPath);
      // Validate identity and signal in ONE remote shell. A durable numeric
      // PID/PGID may have been reused since checkpointing. If the leader still
      // exists it must have the exact script argv. If the leader is gone but
      // the group remains, PGID reuse is impossible while those children are
      // alive, so that survivor group is still ours and may be terminated.
      return `if ! { ${alive}; }; then exit 0; fi; if [ -e '/proc/${pid}' ]; then __harness_state="$(awk '{print $3}' '/proc/${pid}/stat' 2>/dev/null)"; if [ "$__harness_state" = Z ] || [ ! -r '/proc/${pid}/cmdline' ]; then exit 86; fi; __harness_cmdline="$(tr '\\0' '\\n' < '/proc/${pid}/cmdline' 2>/dev/null || true)"; if [ -z "$__harness_cmdline" ]; then if [ -e '/proc/${pid}' ]; then exit 86; fi; elif ! printf '%s\\n' "$__harness_cmdline" | grep -Fx -- '${scriptPath}' >/dev/null; then if [ -e '/proc/${pid}' ]; then exit 0; fi; fi; fi`;
    })()
    : undefined;
  const command = [
    ...(identityGuard ? [identityGuard] : []),
    `kill -TERM -- -${pid} 2>/dev/null || true`,
    '__harness_wait=0',
    `while { ${alive}; } && [ "$__harness_wait" -lt 50 ]; do sleep 0.1; __harness_wait=$((__harness_wait + 1)); done`,
    `if { ${alive}; }; then kill -KILL -- -${pid} 2>/dev/null || true; fi`,
    '__harness_wait=0',
    `while { ${alive}; } && [ "$__harness_wait" -lt 50 ]; do sleep 0.1; __harness_wait=$((__harness_wait + 1)); done`,
    `if { ${alive}; }; then exit 1; fi`,
  ].join('; ');
  let result;
  try {
    result = await sandboxClient.execSync(
      sandboxId,
      command,
      undefined,
      { timeoutMs: CLEANUP_TIMEOUT_MS, sshUser },
    );
  } catch (error) {
    throw new DetachedTurnTerminationError(
      `Could not verify that detached turn process group ${pid} exited.`,
      { cause: error },
    );
  }
  if (result.exitCode !== 0) {
    throw new DetachedTurnTerminationError(
      `Detached turn process group ${pid} did not exit after TERM/KILL.`,
    );
  }
}

/**
 * Keep the caller's run slot quarantined until process-group death is proven.
 * Transient SSH failures are expected during machine wake/restart; returning
 * on one would allow the replacement CLI to overlap the old one. A backend
 * shutdown is the sole escape: its checkpoint carries the PID into the next
 * process, which resumes this same proof before replay.
 */
export async function killDetachedTurnUntilGone(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  pid: number,
  sshUser?: string,
  onRetry?: (failures: number, error: DetachedTurnTerminationError) => void,
  outputPath?: string,
): Promise<void> {
  // Retire the single-use launch key BEFORE making its current process dead.
  // Otherwise a transparently retried SSH wrapper could acquire the lock in
  // the kill-to-cleanup gap, see no live PID, and start the old command again.
  if (outputPath) {
    await cancelDetachedLaunchUntilMarked(
      sandboxClient,
      sandboxId,
      outputPath,
      sshUser,
    );
  }
  let failures = 0;
  const giveUpAt = Date.now() + unreachableGiveUpMs;
  while (true) {
    try {
      await killDetachedTurn(sandboxClient, sandboxId, pid, sshUser, outputPath);
      return;
    } catch (error) {
      if (!(error instanceof DetachedTurnTerminationError)) throw error;
      failures += 1;
      if (isHarnessShutdownInProgress()) throw error;
      if (Date.now() >= giveUpAt) {
        throw new DetachedTurnUnreachableError(
          `Could not stop the turn's process ${pid} for ${unreachableGiveUpMinutes()}: ${reasonOf(error.cause ?? error)}`,
          { cause: error },
        );
      }
      onRetry?.(failures, error);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(failures, 5) * 1_000);
      });
    }
  }
}

/**
 * Permanently fence a provisional launch keyed by outputPath.
 *
 * A pid=0 checkpoint means the backend disconnected while the non-idempotent
 * launch RPC was still unresolved. "No PID yet" cannot prove that remote RPC
 * will not arrive late. This tombstone is written under the launcher's own
 * flock; a racing launcher either publishes its PID first (and is then killed)
 * or observes the tombstone and exits before nohup. The file intentionally
 * survives successful cleanup until /tmp is rebooted.
 */
export async function cancelDetachedLaunchUntilMarked(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  outputPath: string,
  sshUser?: string,
): Promise<void> {
  const { launchLockPath, cancelPath } = turnSidecarPaths(outputPath);
  let failures = 0;
  const giveUpAt = Date.now() + unreachableGiveUpMs;
  while (true) {
    try {
      const result = await sandboxClient.execSync(
        sandboxId,
        `exec 9> '${launchLockPath}'; flock -w 15 9 || exit 1; touch '${cancelPath}' || exit 1; flock -u 9; exec 9>&-`,
        undefined,
        { timeoutMs: CLEANUP_TIMEOUT_MS + 5_000, sshUser },
      );
      if (result.exitCode === 0 && !result.timedOut) return;
      throw new Error(`cancel fence exit=${result.exitCode}`);
    } catch (error) {
      failures += 1;
      if (isHarnessShutdownInProgress()) {
        throw new DetachedTurnTerminationError(
          `Could not fence unresolved detached launch ${outputPath}.`,
          { cause: error },
        );
      }
      if (Date.now() >= giveUpAt) {
        throw new DetachedTurnUnreachableError(
          `Could not fence the turn's launch for ${unreachableGiveUpMinutes()}: ${reasonOf(error)}`,
          { cause: error },
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(failures, 5) * 1_000);
      });
    }
  }
}

/**
 * Recover an abandoned detached turn before any later harness launch.
 *
 * The registry entry is installed first and deliberately retained on every
 * failure, so another user message can retry instead of launching beside an
 * unverified process. Once death is proven, the provider callback receives a
 * partial-line-safe final drain to persist the native conversation id; only
 * then are the registry entry and sidecars removed.
 */
export async function terminateDetachedTurnBeforeRestart(
  sandboxClient: WorkspaceRuntimeClient,
  runKey: string,
  info: HarnessTurnAttachInfo,
  captureContinuity: (lines: string[]) => Promise<void>,
  sshUser?: string,
): Promise<void> {
  registerActiveDetachedTurn(runKey, info);
  await cancelDetachedLaunchUntilMarked(
    sandboxClient,
    info.sandboxId,
    info.outputPath,
    sshUser,
  );
  // A durable checkpoint can outlive the original process. Honor its exit
  // sidecar and verify the unique launch-script identity before signaling the
  // numeric PID; otherwise PID reuse could make cleanup kill unrelated work.
  const inspected = await inspectDetachedTurnUntilKnown(
    sandboxClient,
    info.sandboxId,
    info.outputPath,
    sshUser,
  );
  if (inspected.state === 'unknown') {
    throw new DetachedTurnTerminationError(
      `Could not determine whether detached ${info.cli} turn ${info.pid} is still running.`,
    );
  }
  if (inspected.state === 'running') {
    // A checkpoint written while the launch RPC was still awaiting its SSH
    // acknowledgement deliberately carries pid=0 plus the unique output path.
    // The sidecar/identity probe is authoritative; never interpolate pid=0
    // into a process-group kill ("-0" has unrelated shell semantics).
    const resolvedPid = inspected.pid ?? (info.pid > 0 ? info.pid : undefined);
    if (!resolvedPid) {
      throw new DetachedTurnTerminationError(
        `Detached ${info.cli} turn is running, but its process id could not be recovered.`,
      );
    }
    updateActiveDetachedTurn(runKey, { pid: resolvedPid });
    await killDetachedTurnUntilGone(
      sandboxClient,
      info.sandboxId,
      resolvedPid,
      sshUser,
      undefined,
      info.outputPath,
    );
  }

  let continuityFailures = 0;
  let reader: TurnOutputReader;
  const giveUpAt = unreachableDeadline();
  while (true) {
    // Recreate from the checkpointed offset on every attempt. readNewLines
    // advances before the storage callback runs; if that callback failed, a
    // reused reader would silently skip the very id we are retrying.
    reader = new TurnOutputReader(
      sandboxClient,
      info.sandboxId,
      info.outputPath,
      sshUser,
      info.consumedLines,
    );
    try {
      await captureContinuity(await reader.readNewLines({ final: true }));
      break;
    } catch (error) {
      continuityFailures += 1;
      if (isHarnessShutdownInProgress()) {
        throw new DetachedTurnContinuityError(
          `Detached ${info.cli} turn exited, but its conversation continuity could not be preserved.`,
          { cause: error },
        );
      }
      if (Date.now() >= giveUpAt) {
        throw new DetachedTurnContinuityError(
          `The ${info.cli} conversation could not be read back from its machine for ${unreachableGiveUpMinutes()}: ${reasonOf(error)}`,
          { cause: error },
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(continuityFailures, 5) * 1_000);
      });
    }
  }

  // A provisional launch may still have an arbitrarily delayed SSH wrapper.
  // Its lock file and cancellation tombstone are therefore durable protocol
  // state, not ordinary turn sidecars: never create a gap where cleanup has
  // removed the tombstone and the delayed wrapper can cross `nohup` before a
  // replacement fence is written.
  await reader!.cleanup();
  clearActiveDetachedTurn(runKey);
}

/**
 * Post-restart probe: is the detached turn still alive or already finished?
 * 'gone' (no exit file, pid dead/missing — machine rebooted or reaped) tells
 * the caller to fall back to a full re-run. Transport failures are UNKNOWN,
 * never gone: treating one SSH timeout as proof of absence can launch a
 * second CLI beside the still-running first one.
 */
export async function inspectDetachedTurn(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  outputPath: string,
  sshUser?: string,
): Promise<DetachedTurnProbeResult> {
  const { exitPath, pidPath, scriptPath, launchLockPath } = turnSidecarPaths(outputPath);
  try {
    const result = await sandboxClient.execSync(
      sandboxId,
      [
        `if [ -f '${exitPath}' ]; then __harness_pid="$(cat '${pidPath}' 2>/dev/null)"; echo "finished:${'$'}{__harness_pid:-0}"`,
        `else __harness_pid="$(cat '${pidPath}' 2>/dev/null)"`,
        `if [ -n "$__harness_pid" ] && kill -0 -- -"$__harness_pid" 2>/dev/null; then :`,
        `if [ ! -e "/proc/$__harness_pid" ]; then echo "running:$__harness_pid"`,
        `elif [ "$(awk '{print $3}' "/proc/$__harness_pid/stat" 2>/dev/null)" = Z ] || [ ! -r "/proc/$__harness_pid/cmdline" ]; then echo unknown`,
        `else __harness_cmdline="$(tr '\\0' '\\n' < "/proc/$__harness_pid/cmdline" 2>/dev/null || true)"`,
        `if [ -z "$__harness_cmdline" ]; then if [ ! -e "/proc/$__harness_pid" ]; then echo "running:$__harness_pid"; else echo unknown; fi`,
        `elif printf '%s\\n' "$__harness_cmdline" | grep -Fx -- '${scriptPath}' >/dev/null; then echo "running:$__harness_pid"`,
        `elif [ ! -e "/proc/$__harness_pid" ]; then echo "running:$__harness_pid"`,
        'else echo gone; fi; fi',
        `elif [ -e '${launchLockPath}' ] && ! flock -n '${launchLockPath}' -c true; then echo unknown`,
        'else echo gone',
        'fi; fi',
      ].join('; '),
      undefined,
      { timeoutMs: READ_TIMEOUT_MS, sshUser },
    );
    if (result.exitCode !== 0) return { state: 'unknown' };
    const answer = result.stdout.trim().split('\n').at(-1);
    const running = /^running:(\d+)$/.exec(answer ?? '');
    if (running) {
      const pid = Number.parseInt(running[1]!, 10);
      return pid > 0 ? { state: 'running', pid } : { state: 'unknown' };
    }
    const finished = /^finished(?::(\d+))?$/.exec(answer ?? '');
    if (finished) {
      const pid = Number.parseInt(finished[1] ?? '', 10);
      return Number.isFinite(pid) && pid > 0
        ? { state: 'finished', pid }
        : { state: 'finished' };
    }
    // Plain tokens remain accepted for old/fake probe implementations during
    // rolling deploys and unit tests; only the detailed form can recover pid=0.
    if (answer === 'running') return { state: 'running' };
    if (answer === 'gone') return { state: 'gone' };
    return { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

export async function probeDetachedTurn(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  outputPath: string,
  sshUser?: string,
): Promise<'running' | 'finished' | 'gone' | 'unknown'> {
  return (await inspectDetachedTurn(sandboxClient, sandboxId, outputPath, sshUser)).state;
}

/** Detailed counterpart used when a provisional checkpoint must recover PID. */
export async function inspectDetachedTurnUntilKnown(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  outputPath: string,
  sshUser?: string,
  signal?: AbortSignal,
  onRetry?: (failures: number) => void,
): Promise<DetachedTurnProbeResult> {
  let failures = 0;
  const giveUpAt = Date.now() + unreachableGiveUpMs;
  while (true) {
    const outcome = await inspectDetachedTurn(sandboxClient, sandboxId, outputPath, sshUser);
    if (outcome.state !== 'unknown' || signal?.aborted || isHarnessShutdownInProgress()) return outcome;
    // Unknown is a safe answer for every caller (it never proves the CLI
    // gone); a machine that will not answer must not hold it forever.
    if (Date.now() >= giveUpAt) return outcome;
    failures += 1;
    onRetry?.(failures);
    await sleepUnlessAborted(Math.min(failures, 5) * 1_000, signal);
  }
}

/**
 * Keep a re-attach run quarantined until its remote state is authoritative.
 * An abort ends the wait by returning `unknown`; callers then retain/attach
 * the known process metadata so their normal abort path can either leave it
 * alive for backend restart or terminate it for user steering.
 */
export async function probeDetachedTurnUntilKnown(
  sandboxClient: WorkspaceRuntimeClient,
  sandboxId: string,
  outputPath: string,
  sshUser?: string,
  signal?: AbortSignal,
  onRetry?: (failures: number) => void,
): Promise<'running' | 'finished' | 'gone' | 'unknown'> {
  return (
    await inspectDetachedTurnUntilKnown(
      sandboxClient,
      sandboxId,
      outputPath,
      sshUser,
      signal,
      onRetry,
    )
  ).state;
}

/** Abort-aware pacing for the detached poll loop. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Remove exact runtime secret values before a PTY transcript reaches logs. */
export function redactHarnessSecrets(text: string, secrets: Array<string | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted;
}

export class TurnOutputReader {
  private consumedLines: number;
  /** When the machine first stopped answering, during the current run of failed polls (note #1068). */
  private unreachableSince: number | null = null;

  constructor(
    private readonly sandboxClient: WorkspaceRuntimeClient,
    private readonly sandboxId: string,
    readonly outputPath: string,
    // The turn file is written by the CLI running as this user; read and
    // remove it as the same user so paths and ownership stay consistent.
    private readonly sshUser?: string,
    // Re-attach after a backend restart: start from the checkpointed offset
    // instead of re-reading (and re-delivering) from the top of the file.
    initialConsumedLines = 0,
  ) {
    this.consumedLines = initialConsumedLines;
  }

  /**
   * One round trip for the detached poll: new complete lines from the turn
   * file (stdout) plus the turn's liveness (stderr — kept out of stdout so
   * the trailing-partial-line logic stays byte-exact). `exitCode` is null
   * while the CLI is still running.
   */
  async readNewLinesWithStatus(): Promise<{ lines: string[]; running: boolean; exitCode: number | null }> {
    const { exitPath } = turnSidecarPaths(this.outputPath);
    let stdout = '';
    let stderr = '';
    const attemptStartedAt = Date.now();
    try {
      const result = await this.sandboxClient.execSync(
        this.sandboxId,
        `tail -n +${this.consumedLines + 1} '${this.outputPath}' 2>/dev/null || true; { cat '${exitPath}' 2>/dev/null || echo __RUNNING__; } >&2`,
        undefined,
        { timeoutMs: READ_TIMEOUT_MS, sshUser: this.sshUser },
      );
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(
          `Detached turn status read did not complete (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})`,
        );
      }
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      console.warn(
        `[harness-turn-output] Transient status poll failure for ${this.outputPath}:`,
        isMachineUnreachable(error) ? reasonOf(error) : error,
      );
      // A machine that does not answer at all is not transient forever: past
      // the give-up window the turn ends loudly instead of reading "working"
      // with no step until the 15-minute stall clock (note #1068).
      if (isMachineUnreachable(error)) {
        // From the start of the first attempt that got no answer: each one
        // already spent its connect budget before it failed.
        this.unreachableSince ??= attemptStartedAt;
        if (Date.now() - this.unreachableSince >= unreachableGiveUpMs) {
          throw new DetachedTurnUnreachableError(
            `The agent's machine has not answered for ${unreachableGiveUpMinutes()}, so this turn was given up. ${reasonOf(error)}`,
            { cause: error },
          );
        }
      } else {
        this.unreachableSince = null;
      }
      return { lines: [], running: true, exitCode: null };
    }
    this.unreachableSince = null;
    const statusToken = stderr.trim().split('\n').at(-1) ?? '';
    const running = statusToken === '__RUNNING__' || statusToken === '';
    const exitCode = running ? null : Number.parseInt(statusToken, 10);
    const segments = stdout.split('\n');
    const trailing = segments.pop() ?? '';
    if (!running && trailing.length > 0) {
      segments.push(trailing);
    }
    this.consumedLines += segments.length;
    return { lines: segments, running, exitCode: Number.isFinite(exitCode as number) ? exitCode : running ? null : 1 };
  }

  /** Tail of the detached turn's stderr sidecar (error diagnostics). */
  async readStderrTail(maxChars = 2000): Promise<string> {
    const { stderrPath } = turnSidecarPaths(this.outputPath);
    try {
      const result = await this.sandboxClient.execSync(
        this.sandboxId,
        `tail -c ${maxChars} '${stderrPath}' 2>/dev/null || true`,
        undefined,
        { timeoutMs: READ_TIMEOUT_MS, sshUser: this.sshUser },
      );
      return result.stdout;
    } catch {
      return '';
    }
  }

  /**
   * Complete lines appended to the turn file since the last successful read.
   * A trailing partial line is left for the next poll, unless `final` — the
   * process has exited, so the file can no longer grow and a missing trailing
   * newline just means the CLI's last write had none.
   */
  async readNewLines(options: { final?: boolean } = {}): Promise<string[]> {
    let stdout: string;
    try {
      const result = await this.sandboxClient.execSync(
        this.sandboxId,
        `tail -n +${this.consumedLines + 1} '${this.outputPath}' 2>/dev/null || true`,
        undefined,
        { timeoutMs: READ_TIMEOUT_MS, sshUser: this.sshUser },
      );
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(
          `Detached turn output read did not complete (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})`,
        );
      }
      stdout = result.stdout;
    } catch (error) {
      if (options.final) throw error;
      // Offset unchanged: the next poll re-reads the same lines, so a
      // transient SSH failure delays events instead of dropping them.
      console.warn(`[harness-turn-output] Transient read failure for ${this.outputPath}:`, error);
      return [];
    }
    if (!stdout) return [];
    const segments = stdout.split('\n');
    // A chunk ending in '\n' leaves an empty trailing segment; anything else
    // there is a line still being written.
    const trailing = segments.pop() ?? '';
    if (options.final && trailing.length > 0) {
      segments.push(trailing);
    }
    this.consumedLines += segments.length;
    return segments;
  }

  /** Lines consumed so far — useful for diagnostics/heartbeat logging. */
  get linesConsumed(): number {
    return this.consumedLines;
  }

  /**
   * Best-effort tail of the raw turn file for diagnostics (e.g. on timeout),
   * independent of the read offset. Returns '' if the file is missing/empty or
   * the read fails.
   */
  async readTailForDiagnostics(maxChars = 2000): Promise<string> {
    try {
      const result = await this.sandboxClient.execSync(
        this.sandboxId,
        `tail -c ${maxChars} '${this.outputPath}' 2>/dev/null || true`,
        undefined,
        { timeoutMs: READ_TIMEOUT_MS, sshUser: this.sshUser },
      );
      return result.stdout;
    } catch {
      return '';
    }
  }

  /** Best-effort removal of the turn file once the turn is over. */
  async cleanup(): Promise<void> {
    // Fence first, and require acknowledgement. Data-file removal remains
    // best-effort, but releasing the run marker without a durable tombstone
    // would allow a late transparent SSH retry to relaunch completed work.
    await cancelDetachedLaunchUntilMarked(
      this.sandboxClient,
      this.sandboxId,
      this.outputPath,
      this.sshUser,
    );
    try {
      const {
        stderrPath, exitPath, pidPath, scriptPath,
      } = turnSidecarPaths(this.outputPath);
      await this.sandboxClient.execSync(
        this.sandboxId,
        `rm -f '${this.outputPath}' '${stderrPath}' '${exitPath}' '${pidPath}' '${scriptPath}' '${buildTurnInputPath(this.outputPath)}' '${turnInputKeeperPath(buildTurnInputPath(this.outputPath))}'`,
        undefined,
        { timeoutMs: CLEANUP_TIMEOUT_MS, sshUser: this.sshUser },
      );
    } catch {
      // Leftover files live under /tmp and vanish on reboot.
    }
  }
}

/** How many agent turns are running on this backend right now (note #1008: the Upgrade confirmation says so). */
export function countActiveDetachedTurns(): number {
  return activeDetachedTurns.size;
}
