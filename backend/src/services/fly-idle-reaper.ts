import { isOrgMsgAppName } from './org-msg-host.js';
import { FlyApiError, type FlyClient, type FlyMachine } from './fly-client.js';
import type { UserStorage } from './user-storage.js';
import type { AgentRuntimeSample } from './machine-runtime-meter.js';
import { agentMachineShapeOf, type AgentMachineObservation } from './agent-machine-observer.js';
import type { ExecSyncResult } from './sandbox-types.js';
import { buildFlySandboxId, parseFlyServerRecordId, parseFlySandboxId } from './fly-sandbox-id.js';
import { isDeploymentAppName } from './deployment-service.js';
import { listAgents, type AgentCli } from '../types/user.js';

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
/**
 * A short floor after construction during which nothing is stopped. The real
 * post-boot safety gate is `recoveryReady` (turn recovery re-registers every
 * checkpointed detached turn before the first sweep is allowed to stop
 * anything); this floor only covers the seconds in which the Fly listing and
 * the activity store are being read for the first time.
 */
const DEFAULT_BOOT_GRACE_MS = 60_000;
/**
 * How long a machine must have existed before "no agent record points at it"
 * is read as orphaned rather than mid-provision. Sandbox creation writes the
 * machine first and the agent's `serverId` second, so a brand-new machine is
 * legitimately unowned for that window — stopping one there breaks onboarding.
 */
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60_000;
/** Consecutive sweeps a machine must look unowned before it is stopped. */
const DEFAULT_ORPHAN_CONFIRM_SWEEPS = 3;
/** A whole unrecorded app must burn compute this long before an operator alert. */
const DEFAULT_UNRECORDED_APP_ALERT_AFTER_MS = 60 * 60_000;
/** Repeat a still-actionable alert daily, not on every five-minute sweep. */
const DEFAULT_UNRECORDED_APP_ALERT_REPEAT_MS = 24 * 60 * 60_000;
/**
 * How often the sweep also checks every machine it may read for its SSH pin
 * (`BACKEND_PEER_IP`), the one env fact the image's firewall hangs on. Hourly
 * is plenty for a fact that only changes when a machine is built, and it keeps
 * the read-only site listings off the minute-by-minute path.
 */
const FIREWALL_PIN_AUDIT_INTERVAL_MS = 60 * 60_000;
/**
 * How long an app a rebuild retired (`AgentRecord.retiredMachineApps`, note
 * #792) stays before the sweep deletes it — the window in which the agent's
 * old home can still be recovered from its volume by hand.
 */
export const RETIRED_APP_RETENTION_MS = 14 * 24 * 60 * 60_000;

/**
 * The Fly calls a sweep makes. `deleteApp` is optional: it is used for one
 * thing only, removing an app our own record says a rebuild retired.
 */
type ReaperFlyClient = Pick<FlyClient, 'listApps' | 'listMachines' | 'stopMachine'>
  & Partial<Pick<FlyClient, 'deleteApp'>>;

/** Durable per-app throttle state: backend deploys must not reset the daily limit. */
export interface FlyIdleReaperAlert {
  appKey: string;
  lastAlertAt: string;
}

export interface FlyIdleReaperAlertStore {
  get(appKey: string): FlyIdleReaperAlert | undefined;
  put(alert: FlyIdleReaperAlert): void;
}

/** Used in tests and in the no-SQLite development path. */
export class InMemoryFlyIdleReaperAlertStore implements FlyIdleReaperAlertStore {
  private readonly alerts = new Map<string, FlyIdleReaperAlert>();

  get(appKey: string): FlyIdleReaperAlert | undefined {
    return this.alerts.get(appKey);
  }

  put(alert: FlyIdleReaperAlert): void {
    this.alerts.set(alert.appKey, alert);
  }
}

/**
 * `agentbuilt job` owns a dedicated tmux server and an exact session-name
 * shape. Keeping both constraints here is deliberate: ordinary tmux sessions
 * (including durable OAuth terminals) already have their own live-session
 * gate, and must not turn into an accidental forever-awake signal.
 *
 * The command emits exactly one protocol line. A missing named tmux server is
 * the normal "no jobs" state; every other tmux failure exits non-zero so the
 * parser below fails closed. Static text only — no user-controlled shell input
 * is interpolated into this probe.
 */
export const MANAGED_JOB_TMUX_PROBE_COMMAND = String.raw`
unset TMUX TMUX_PANE TMUX_TMPDIR
probe_stderr_file="$(/usr/bin/mktemp -t agentbuilt-managed-job-probe.XXXXXX)" || exit 70
[ -n "$probe_stderr_file" ] || exit 70
trap '/usr/bin/rm -f -- "$probe_stderr_file"' EXIT
probe_output="$(/usr/bin/tmux -f /dev/null -L agentbuilt-jobs-v1 list-sessions -F '#{session_name}' 2>"$probe_stderr_file")"
probe_status=$?
probe_stderr="$(/usr/bin/cat -- "$probe_stderr_file")" || exit 70
if [ "$probe_status" -eq 0 ] && [ -z "$probe_stderr" ]; then
  if printf '%s\n' "$probe_output" | /usr/bin/grep -Eq '^agentbuilt-job-v1-j_[a-f0-9]{24}$'; then
    printf '%s\n' 'agentbuilt-managed-jobs-v1:active'
  else
    printf '%s\n' 'agentbuilt-managed-jobs-v1:inactive'
  fi
elif [ "$probe_status" -eq 1 ]; then
  case "$probe_stderr" in
    "error connecting to "*"/agentbuilt-jobs-v1 (No such file or directory)"|"no server running on "*"/agentbuilt-jobs-v1")
      if [ -z "$probe_output" ]; then
        printf '%s\n' 'agentbuilt-managed-jobs-v1:inactive'
      else
        exit 70
      fi
      ;;
    *)
      printf '%s\n' "$probe_stderr" >&2
      exit 70
      ;;
  esac
else
  printf '%s\n' "$probe_stderr" >&2
  exit 70
fi
`.trim();

const MANAGED_JOB_PROBE_ACTIVE = 'agentbuilt-managed-jobs-v1:active';
const MANAGED_JOB_PROBE_INACTIVE = 'agentbuilt-managed-jobs-v1:inactive';

/** What we know about the user who owns a given Fly machine. */
interface FlyMachineOwner {
  userId: string;
  /** The agent this machine belongs to (app-per-agent). */
  agentId: string;
  cli: AgentCli;
  /** Epoch ms of the most recent interaction with THIS agent, if known. */
  lastActivityAt?: number;
  /** True while a turn is running for THIS agent (or the owner's setup loop). */
  turnRunning: boolean;
}

export interface FlyIdleReaperDeps {
  flyClient: ReaperFlyClient;
  orgSlug: string;
  userStorage: Pick<UserStorage, 'getAllUsers'>;
  /**
   * Whether a turn is running that THIS machine must stay awake for: this
   * agent's own turn slot, or the account-level setup loop (which provisions
   * a machine before any agent slot exists to name it).
   *
   * Per-agent on purpose. The account-wide predicate this replaced answered
   * "is any of the owner's agents working", so on a fleet of twenty agents a
   * single long turn pinned all twenty machines awake and no idle timeout
   * could fire at any value. That is the same defect the account-level
   * activity stamp had (see `getAgentLastActiveAt` below); both signals are
   * now scoped to the one agent whose machine is being decided.
   */
  isTurnRunningForAgent: (userId: string, agentId: string) => boolean;
  /**
   * The eighth gate (note #779): an approved schedule inside its daily
   * window keeps the agent's machine awake, so a tick every few minutes is
   * not a cold start every few minutes. The schedule row says so to the
   * owner, because it is the cost of the thing.
   */
  scheduleHoldsAwake?: (userId: string, agentId: string) => boolean;
  /**
   * Epoch ms of the last inbound interaction with one specific agent, or
   * undefined if it hasn't been touched since the process booted
   * (AgentService.getTelegramAgentLastActiveAt). Per-agent on purpose:
   * the account-level activity stamp this replaced kept EVERY machine of a
   * user hot for `idleMs` after any single message — the more agents someone
   * ran, the more idle compute each message bought.
   */
  getAgentLastActiveAt: (userId: string, agentId: string) => number | undefined;
  /**
   * Runtime metering (recordAgentRuntimeSamples): called once per sweep with
   * every machine observed running, crediting each with the time since the
   * previous sweep (capped at the sweep interval, so a delayed sweep
   * under-counts rather than inventing runtime). The reaper hosts this because
   * it is the one place that already enumerates the whole fleet with owners
   * attached — a second scanner would double the Fly and storage traffic to
   * learn the same facts.
   */
  recordRuntimeSamples?: (samples: AgentRuntimeSample[]) => Promise<unknown>;
  /**
   * Machine shapes (recordAgentMachineShapes, note #356): called once per
   * sweep with what each machine is MADE OF, so the fleet list can name it
   * without a control-plane read per agent on `api/state`.
   *
   * Hosted here for the same reason metering is, and it costs even less: the
   * listing this sweep already fetched carries every machine's guest, so this
   * adds no Fly traffic at all, and the writer behind it skips a shape the
   * record already holds — which is every machine, every sweep, until
   * somebody actually resizes one.
   *
   * Strictly downstream of the stop decisions: it reads nothing they read and
   * they read nothing it writes.
   */
  recordMachineShapes?: (observations: AgentMachineObservation[]) => Promise<unknown>;
  /**
   * The final probe found NO durable job on a machine about to be stopped
   * (note #564). The fleet list's per-agent job count is otherwise refreshed
   * only where a turn or an open screen looks, so a `--quiet` job that ended
   * between turns would leave its count standing on a sleeping machine. Best
   * effort, and strictly downstream of the stop decision.
   */
  recordNoManagedJobs?: (owner: { userId: string; agentId: string }) => Promise<unknown>;
  /** Hosts (private IPs) with a live terminal session — never stop these. */
  getActiveSessionHosts: () => Set<string>;
  /**
   * Run the reaper-owned managed-job probe on the remote machine as its
   * development user. The result is validated at runtime rather than trusted:
   * SSH errors, timeouts and malformed adapters must all keep the VM awake.
   */
  execManagedJobProbe: (args: {
    sandboxId: string;
    command: string;
  }) => Promise<ExecSyncResult>;
  /** App slugs to never touch (e.g. the machine-image registry app). */
  skipAppNames?: Iterable<string>;
  /**
   * The platform's own control-plane apps (note #1070, `platform-apps.ts`):
   * the backend, its code host, CI, the image registry. In the reaper's own
   * org these are never probed, stopped, deleted or reported, whatever any
   * record says; the journal names them once per change instead. A client
   * org's app of the same name is that client's and is treated as usual.
   */
  platformAppNames?: Iterable<string>;
  /**
   * App slugs the deployment records claim (DeploymentStorage.listAll →
   * appName). Deployment-shaped apps are never walked either way; this feeds
   * only the unrecorded-app report, so an `iapp-…` name nothing claims is
   * surfaced to an operator instead of hiding behind its prefix.
   */
  listDeploymentAppNames?: () => Promise<string[]>;
  /**
   * Fly contexts of connected CLIENT orgs (byo-fly-design part 3), swept
   * exactly like the default org: same allowlist, same gates, same report.
   * Without this, a client org's machines would never sleep — invisible to
   * the one loop that stops idle compute.
   */
  listAdditionalOrgContexts?: () => Promise<Array<{
    orgSlug: string;
    /**
     * Opaque identity of the stored org connection. It must change when the
     * org row, slug, or credential changes, so a previously missing Fly org
     * is retried immediately after an operator repairs the connection.
     */
    connectionRevision: string;
    flyClient: ReaperFlyClient;
  }>>;
  /**
   * Deliver a plain-text operator alert. The production adapter sends it to
   * the ops Telegram chat; keeping transport outside this class makes the
   * safety/rate-limit behavior testable without Telegram.
   */
  notifyUnrecordedApps?: (text: string) => Promise<unknown>;
  /**
   * Durable throttle state, so a backend deploy cannot resend an unrecorded
   * app alert or retry a client-org connection already proven missing.
   */
  unrecordedAppAlertStore?: FlyIdleReaperAlertStore;
  /** How long a machine in an unrecorded app must be continuously started. */
  unrecordedAppAlertAfterMs?: number;
  /** Minimum delay between alerts for the same org/app. */
  unrecordedAppAlertRepeatMs?: number;
  /** Overrides RETIRED_APP_RETENTION_MS (tests). */
  retiredAppRetentionMs?: number;
  /**
   * Pre-sleep CLI update (HarnessCliUpdater): runs after the stop decision and
   * before the stop itself — the machine is idle and the rootfs persists
   * across stop/start, so the install is invisible to the user and sticks for
   * every later wake. Must never throw (guarded here anyway); the sweep's
   * sequential loop is the concurrency bound, so one fleet-wide version bump
   * never fires npm installs in parallel through the WireGuard peer.
   */
  updateClisBeforeStop?: (args: {
    sandboxId: string;
    userId: string;
    agentId: string;
    cli: AgentCli;
  }) => Promise<unknown>;
  /**
   * Whether a CLI install is running on this machine right now — asked
   * immediately before the stop, like the managed-job probe beside it.
   *
   * The sweep awaits its OWN update, which is not the same as no install
   * being in flight: a Mini App "Update" tap starts one through a different
   * path. On 2026-09-11 this machine was stopped one second after such an
   * install failed, with npm work still settling, and what the halt left
   * behind was a half-written package the agent could not run at all.
   */
  cliInstallInFlight?: (sandboxId: string) => boolean;
  /**
   * Image roll for machines that are ALREADY asleep (MachineImageUpdater):
   * a machine otherwise keeps its creation-time image for life, so an image fix
   * reaches new signups and nobody else. The reaper hosts it for the same
   * reason it hosts metering — it is the one loop that already enumerates the
   * whole fleet with owners attached — and because it already answers the only
   * question that matters here: whether anybody is using the machine.
   * Must never throw (guarded here anyway).
   */
  rollImageWhileStopped?: (args: {
    sandboxId: string;
    userId: string;
    agentId: string;
    /**
     * What this sweep's listing already reported, so a machine that is already
     * on the fleet image costs no extra Fly call to confirm — which is the
     * common case once the fleet has caught up.
     */
    listedImage?: string;
    listedRootfsPersist?: string;
    /** The listing's `AUTHORIZED_KEYS`, for the same reason (note #1074). */
    listedAuthorizedKeys?: string;
    /** Set when this machine was stopped a moment ago and is still settling. */
    waitForStopped?: boolean;
  }) => Promise<unknown>;
  idleMs?: number;
  intervalMs?: number;
  /**
   * Settles once boot-time turn recovery (`resumePendingTurns`) has
   * quarantined every detached turn the previous process checkpointed and
   * claimed its run slot (the re-attach to the machine itself settles later,
   * in the background — note #762; a claimed slot already reads as a running
   * turn). Until it resolves the in-memory turn registry is EMPTY and a
   * machine running a live turn is indistinguishable from an abandoned one,
   * so the reaper stops nothing. If it rejects, recovery failed closed with a
   * possibly-live CLI unowned somewhere in the fleet, and the reaper stays
   * closed too: it stops nothing for the life of this process. Omitted (tests,
   * no recovery step): treated as already settled.
   */
  recoveryReady?: Promise<unknown>;
  /**
   * Floor after construction during which nothing is stopped (default 60s).
   * NOT the safety gate — that is `recoveryReady`. Before the activity stamp
   * was durable this defaulted to `idleMs` and blinded the reaper for the
   * whole window after every deploy; with deploys landing more often than
   * that, the windows chained and the reaper was off all working day.
   */
  bootGraceMs?: number;
  /**
   * How old a machine must be before an absent owner counts as orphaned
   * (default 1h). Guards the provisioning window, where the machine exists and
   * the agent record does not yet.
   */
  orphanGraceMs?: number;
  /**
   * How many consecutive sweeps must agree a machine is unowned before it is
   * stopped (default 3). A single sweep can read a user mid-write; three across
   * the interval cannot all land in the same crack.
   */
  orphanConfirmSweeps?: number;
  now?: () => number;
}

export interface FlyStopDecision {
  stop: boolean;
  reason:
    | 'idle'
    | 'orphan'
    | 'no-owner'
    | 'boot-grace'
    | 'awaiting-recovery'
    | 'in-flight-turn'
    | 'live-terminal-session'
    | 'recently-active';
}

export interface FlyReaperSweepResult {
  consideredStarted: number;
  stopped: number;
  kept: number;
  /** Subset of `stopped` that no agent record claimed. */
  orphansStopped: number;
  /** Org apps no record claims — reported, never walked, never touched. */
  unrecordedApps: number;
}

interface UnrecordedApp {
  appName: string;
  orgSlug: string;
  flyClient: Pick<FlyClient, 'listMachines'>;
}

interface AlertableUnrecordedApp {
  appName: string;
  orgSlug: string;
  runningMachines: number;
  oldestRunningForMs: number;
}

/**
 * Periodically stops Fly machines that have been idle for ≥ `idleMs`, so free
 * users' machines don't burn compute while unused (the volume — the retention
 * hook — persists; the machine wakes transparently on the next message).
 *
 * Stopping a machine kills tmux, so `lastUsedAt`-style activity alone is not a
 * safe signal. Before stopping, this consults, per machine:
 *   1. an in-flight turn for THIS agent, or the owner's setup loop (background
 *      runner),
 *   2. a live terminal session on the machine's host (a preserved OAuth sign-in),
 *   3. a seat sign-in ceremony outstanding on THIS machine — a device login
 *      holds no session and runs no turn, so it is invisible to every other
 *      gate here and was being stopped mid-code (2026-09-05),
 *   4. remotely discovered `agentbuilt job` tmux sessions (twice, around the
 *      potentially slow CLI updater),
 *   5. recent activity on THIS agent (in-memory, unthrottled).
 * Gates 1 and 5 are both per-AGENT, and both used to be per-account: while any
 * one of an owner's agents was working, every machine they had was held awake,
 * which is how a fleet stops sleeping no matter what the idle timeout says.
 * A machine with none of those is stopped. An UNATTRIBUTED machine — one no
 * agent record points at — is stopped too, but only on corroborated evidence:
 * the owner index must have loaded, the machine must be older than
 * `orphanGraceMs`, and `orphanConfirmSweeps` consecutive sweeps must agree.
 * Orphans exist (provisioning dies between creating the machine and saving its
 * `serverId`, or an agent record is removed while its machine lives on) and
 * used to run forever: unstoppable because nothing claimed them, and unmetered
 * for exactly the same reason, so they were invisible in both directions.
 * Only Fly machines are touched — Hetzner is never here.
 *
 * After a deploy the reaper stops NOTHING until `recoveryReady` settles: that
 * is when boot-time turn recovery has re-registered every detached turn the
 * previous process checkpointed, so gate 1 is answerable again. Gate 4 reads a
 * DURABLE per-agent stamp (the activity store), so it needs no window at all;
 * `bootGraceMs` is only a short floor on top. It used to default to `idleMs`
 * because the stamp was in-memory, and with deploys landing more often than
 * that the windows chained end to end and the reaper was off all working day.
 *
 * Image rolls ride the same gate, because sleep is the only moment an image
 * swap costs the user nothing and without one a machine runs its creation-time
 * image forever. The primary path is EVENT-driven: a machine this sweep puts to
 * sleep is rolled right there, on the transition. The scan of machines found
 * ALREADY stopped is only the backstop, for the ones that were asleep when the
 * fleet image changed and would otherwise wait for their owner's next session;
 * it is free, because the listing this sweep already fetched carries each
 * machine's image, so a converged one is answered without an API call.
 *
 * Discovery is record-driven (byo-fly-design: record-allowlist ownership).
 * The sweep lists every org app but WALKS only the apps a record claims — an
 * agent's `serverId`, its provisioning marker, or a deployment record. An app
 * nothing claims is never touched. When an operator notifier is configured,
 * its machines are listed read-only so a continuously running one can raise a
 * daily alert; in a client's Fly org an unrecognized app may be the client's
 * own, and in ours it is the visible end of a provisioning leak — an
 * operator's question either way, not a machine to stop on a name's evidence. The orphan
 * corroboration above therefore applies only to unattributed machines INSIDE
 * claimed apps (a provision retry's extra machine); whole unclaimed apps are
 * the report's job. `skipAppNames` still excludes the shared machine-image app,
 * and `platformAppNames` the platform's own control plane in its own org.
 */
export class FlyIdleReaper {
  private readonly idleMs: number;
  private readonly intervalMs: number;
  /**
   * Ceiling on the runtime one sweep may credit. Deliberately NOT `intervalMs`:
   * a sweep that overruns its own tick is skipped by the re-entrancy guard, so
   * the next one sees two intervals of real runtime — and capping at the
   * interval would book half of it. The cap answers a different question
   * ("how long will we believe a machine ran unobserved?"), which does not get
   * shorter just because we started looking more often.
   */
  private readonly meteringCapMs: number;
  private readonly bootGraceMs: number;
  /** See `FlyIdleReaperDeps.recoveryReady`; 'failed' never leaves. */
  private recoveryState: 'pending' | 'ready' | 'failed';
  private readonly orphanGraceMs: number;
  private readonly orphanConfirmSweeps: number;
  private readonly unrecordedAppAlertAfterMs: number;
  private readonly unrecordedAppAlertRepeatMs: number;
  private readonly unrecordedAppAlertStore: FlyIdleReaperAlertStore;
  private readonly retiredAppRetentionMs: number;
  private readonly now: () => number;
  private readonly bootedAt: number;
  private readonly skipAppNames: Set<string>;
  private readonly platformAppNames: Set<string>;
  /** The control-plane apps last named in the journal, to log only changes. */
  private loggedPlatformApps = '';
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  /** When the previous sweep ran — the runtime-credit baseline. */
  private prevSweepAt: number;

  /**
   * Sandbox id → consecutive sweeps seen RUNNING with no owning agent record.
   * Reset the moment an owner appears, and pruned to what the sweep actually
   * saw, so a rebuilt or deleted machine never inherits an old tally.
   */
  private readonly unownedSweeps = new Map<string, number>();
  /** When the last firewall-pin audit ran (note #664); 0 = never. */
  private lastPinAuditAt = 0;

  /** Last logged unrecorded-app set; Telegram has its own durable daily throttle. */
  private lastUnrecordedReport = '';

  /**
   * Connected client orgs Fly has definitively answered 404 for. Retrying the
   * same dead record every minute cannot discover anything new and floods the
   * journal; the provider's opaque revision makes a slug/token repair visible
   * without retaining or logging either credential material here.
   */
  private readonly missingOrgConnections = new Set<string>();

  constructor(private readonly deps: FlyIdleReaperDeps) {
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.meteringCapMs = Math.max(this.intervalMs, DEFAULT_INTERVAL_MS);
    this.bootGraceMs = deps.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
    this.recoveryState = deps.recoveryReady ? 'pending' : 'ready';
    deps.recoveryReady?.then(
      () => {
        this.recoveryState = 'ready';
      },
      (error: unknown) => {
        this.recoveryState = 'failed';
        console.error(
          '[FlyIdleReaper] turn recovery failed; a detached turn may be unowned, so nothing will be stopped until the next restart',
          error,
        );
      },
    );
    this.orphanGraceMs = deps.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    this.orphanConfirmSweeps = deps.orphanConfirmSweeps ?? DEFAULT_ORPHAN_CONFIRM_SWEEPS;
    this.unrecordedAppAlertAfterMs = deps.unrecordedAppAlertAfterMs
      ?? DEFAULT_UNRECORDED_APP_ALERT_AFTER_MS;
    this.unrecordedAppAlertRepeatMs = deps.unrecordedAppAlertRepeatMs
      ?? DEFAULT_UNRECORDED_APP_ALERT_REPEAT_MS;
    this.unrecordedAppAlertStore = deps.unrecordedAppAlertStore
      ?? new InMemoryFlyIdleReaperAlertStore();
    this.retiredAppRetentionMs = deps.retiredAppRetentionMs ?? RETIRED_APP_RETENTION_MS;
    this.now = deps.now ?? (() => Date.now());
    this.bootedAt = this.now();
    this.prevSweepAt = this.bootedAt;
    this.skipAppNames = new Set(deps.skipAppNames ?? []);
    this.platformAppNames = new Set(deps.platformAppNames ?? []);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.warn('[FlyIdleReaper] sweep failed', error);
      });
    }, this.intervalMs);
    // Don't keep the event loop alive just for the reaper.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Pure stop decision — the safety gate, isolated for testing. */
  decideStop(args: {
    owner: FlyMachineOwner | undefined;
    host: string | undefined;
    liveHosts: Set<string>;
    now: number;
    /**
     * Whether the owner index was actually read this sweep. False means a
     * storage failure, where EVERY machine looks unowned — the one reading
     * under which stopping orphans would take down the whole fleet mid-turn.
     * Defaults false: a caller that says nothing gets the old, timid answer.
     */
    ownersLoaded?: boolean;
    /** Consecutive sweeps this machine has been seen running and unowned. */
    unownedSweeps?: number;
    /** Machine creation time (epoch ms); undefined when Fly didn't report it. */
    createdAt?: number;
  }): FlyStopDecision {
    const {
      owner, host, liveHosts, now,
      ownersLoaded = false, unownedSweeps = 0, createdAt,
    } = args;
    // Until turn recovery has re-registered the previous process's detached
    // turns, an empty registry proves nothing; stopping on it would halt a VM
    // with a live CLI on it. Applies to unowned machines too: a provisioning
    // record is part of what recovery may still be re-establishing.
    if (this.recoveryState !== 'ready') {
      return { stop: false, reason: 'awaiting-recovery' };
    }
    if (!owner) {
      // Every arm below is a reason to DOUBT the orphan reading, and each maps
      // to a way a machine can look unowned while being perfectly healthy.
      if (!ownersLoaded) {
        return { stop: false, reason: 'no-owner' };
      }
      if (now - this.bootedAt < this.bootGraceMs) {
        return { stop: false, reason: 'boot-grace' };
      }
      // Unknown age is treated as newborn: a machine we can't date might be
      // provisioning right now, and the next sweep re-asks at no cost.
      if (createdAt === undefined || now - createdAt < this.orphanGraceMs) {
        return { stop: false, reason: 'no-owner' };
      }
      if (unownedSweeps < this.orphanConfirmSweeps) {
        return { stop: false, reason: 'no-owner' };
      }
      return { stop: true, reason: 'orphan' };
    }
    // Fresh process, empty in-memory activity map — an agent last messaged a
    // minute before the deploy is indistinguishable from one idle all week.
    if (now - this.bootedAt < this.bootGraceMs) {
      return { stop: false, reason: 'boot-grace' };
    }
    // NOTE deliberately NO exemption for published sites (`exposedUrl`): a
    // machine is a workbench, not hosting. Keeping machines hot forever
    // because a visitor might come is an unbounded compute commitment for a
    // preview feature — the public URL works while the user is actively
    // working; for always-on hosting their agent deploys to the user's own
    // infrastructure (Cloudflare, Hetzner, …).
    if (owner.turnRunning) {
      return { stop: false, reason: 'in-flight-turn' };
    }
    if (host && liveHosts.has(host)) {
      return { stop: false, reason: 'live-terminal-session' };
    }
    if (owner.lastActivityAt !== undefined && now - owner.lastActivityAt < this.idleMs) {
      return { stop: false, reason: 'recently-active' };
    }
    return { stop: true, reason: 'idle' };
  }

  /** Refresh every in-memory wake gate after an awaited pre-stop operation. */
  private liveGateAppeared(
    owner: FlyMachineOwner | undefined,
    host: string | undefined,
  ): boolean {
    if (owner && this.deps.isTurnRunningForAgent(owner.userId, owner.agentId)) return true;
    if (host && this.deps.getActiveSessionHosts().has(host)) return true;
    if (owner) {
      const latestActivity = this.deps.getAgentLastActiveAt(owner.userId, owner.agentId);
      if (latestActivity !== undefined && this.now() - latestActivity < this.idleMs) return true;
    }
    return false;
  }

  /** One reaper pass. Safe to call directly (tests) or on the interval. */
  async runOnce(): Promise<FlyReaperSweepResult> {
    if (this.running) {
      return { consideredStarted: 0, stopped: 0, kept: 0, orphansStopped: 0, unrecordedApps: 0 };
    }
    this.running = true;
    try {
      const {
        index: owners,
        byApp: provisioningOwners,
        claimedApps,
        retiredApps,
        loaded: ownersLoaded,
        read: ownersRead,
      } = await this.buildOwnerIndex();
      if (!ownersRead) {
        // With the store unreadable the claim set is unknowable, so the only
        // safe sweep is no sweep. Runtime credit self-heals: the interval cap
        // means a skipped pass under-counts rather than doubling the next one.
        console.warn('[FlyIdleReaper] owner index unreadable; skipping this sweep');
        return { consideredStarted: 0, stopped: 0, kept: 0, orphansStopped: 0, unrecordedApps: 0 };
      }
      const deploymentApps = await this.loadDeploymentAppNames();
      const unrecordedApps: UnrecordedApp[] = [];
      // Machines built with no SSH pin (note #664). With neither a pin nor a
      // readable own address the image skips its WHOLE firewall — sshd and
      // every side port open to the private network, which hosted workplaces
      // share with ours. That went unnoticed for a month; this is the watch.
      const unpinned: UnpinnedMachine[] = [];
      const auditPins = this.now() - this.lastPinAuditAt >= FIREWALL_PIN_AUDIT_INTERVAL_MS;
      const liveHosts = this.deps.getActiveSessionHosts();
      const now = this.now();
      // Runtime to credit each machine seen running this pass. Capped (see
      // `meteringCapMs`) so a delayed sweep — backend down, listApps hung —
      // under-counts rather than crediting hours nobody observed. Advanced
      // before the sweep body: a mid-sweep failure then loses one interval
      // instead of doubling it.
      const runtimeCreditMs = Math.min(Math.max(now - this.prevSweepAt, 0), this.meteringCapMs);
      this.prevSweepAt = now;
      const runtimeSamples: AgentRuntimeSample[] = [];
      // What each machine is MADE OF (note #356), collected from the listing
      // this sweep already fetched. Whatever state a machine is in — the
      // shape of a sleeping machine is as true as a running one's, and most
      // of the fleet is asleep whenever anyone looks at the list.
      const machineShapes: AgentMachineObservation[] = [];
      // The default org first, then every connected client org — one flat
      // list, each app remembering which org's client can touch it.
      const sweepContexts: Array<{
        orgSlug: string;
        connectionRevision?: string;
        flyClient: ReaperFlyClient;
      }> = [{ orgSlug: this.deps.orgSlug, flyClient: this.deps.flyClient }];
      if (this.deps.listAdditionalOrgContexts) {
        const additional = await this.deps.listAdditionalOrgContexts().catch((error) => {
          console.warn('[FlyIdleReaper] listAdditionalOrgContexts failed; sweeping the default org only', error);
          return null;
        });
        if (additional) {
          // Release process memory for records that were removed. The durable
          // marker stays tied to the old opaque connection identity; a new org
          // id, slug, or token produces a different revision and retries.
          const currentRevisions = new Set(additional.map((context) => context.connectionRevision));
          for (const revision of this.missingOrgConnections) {
            if (!currentRevisions.has(revision)) this.missingOrgConnections.delete(revision);
          }
          // One Fly org, one sweep. Client orgs may share a Fly account — a
          // second context for the same slug would list the same apps again,
          // decide the same machines twice and credit their runtime twice.
          const sweptOrgSlugs = new Set<string>([this.deps.orgSlug]);
          for (const context of additional) {
            if (sweptOrgSlugs.has(context.orgSlug)) continue;
            sweptOrgSlugs.add(context.orgSlug);
            sweepContexts.push(context);
          }
        }
      }
      const listedApps: Array<{
        app: Awaited<ReturnType<FlyClient['listApps']>>[number];
        orgSlug: string;
        flyClient: ReaperFlyClient;
      }> = [];
      for (const context of sweepContexts) {
        if (context.connectionRevision && this.missingOrgConnections.has(context.connectionRevision)) {
          continue;
        }
        if (context.connectionRevision) {
          const missingKey = `missing-org/${context.connectionRevision}`;
          try {
            if (this.unrecordedAppAlertStore.get(missingKey)) {
              this.missingOrgConnections.add(context.connectionRevision);
              continue;
            }
          } catch (error) {
            // The Fly read remains safe when the local throttle is unreadable.
            // Retry it rather than mistaking a storage failure for proof that
            // the external organization is still missing.
            console.warn(
              `[FlyIdleReaper] missing-org throttle unreadable for ${context.orgSlug}; retrying its listing`,
              error,
            );
          }
        }
        let apps: Awaited<ReturnType<FlyClient['listApps']>>;
        try {
          apps = await context.flyClient.listApps(context.orgSlug);
        } catch (error) {
          if (context.connectionRevision && error instanceof FlyApiError && error.status === 404) {
            this.missingOrgConnections.add(context.connectionRevision);
            const missingKey = `missing-org/${context.connectionRevision}`;
            try {
              this.unrecordedAppAlertStore.put({
                appKey: missingKey,
                lastAlertAt: new Date(now).toISOString(),
              });
            } catch (persistError) {
              console.warn(
                `[FlyIdleReaper] could not persist missing-org throttle for ${context.orgSlug}`,
                persistError,
              );
            }
            console.warn(
              `[FlyIdleReaper] Fly organization ${context.orgSlug} no longer exists; `
              + 'skipping it until its connection record changes',
            );
          } else {
            console.warn(`[FlyIdleReaper] listApps failed for ${context.orgSlug}`, error);
          }
          continue;
        }
        for (const app of apps) {
          listedApps.push({ app, orgSlug: context.orgSlug, flyClient: context.flyClient });
        }
      }

      let consideredStarted = 0;
      let stopped = 0;
      let kept = 0;
      // Why each machine was kept. The counts alone answer "nothing slept, is
      // the reaper broken?" without a code read: `awaiting-recovery` means
      // boot-time turn recovery has not settled (or failed — then it never
      // clears), `boot-grace` is the short post-start floor, `in-flight-turn`
      // means real work, and `managed-job`/`stop-failed` need a human.
      const keptBy = new Map<string, number>();
      const keep = (reason: string): void => {
        kept += 1;
        keptBy.set(reason, (keptBy.get(reason) ?? 0) + 1);
      };
      let orphansStopped = 0;
      /** Every sandbox id this sweep actually laid eyes on, for pruning. */
      const seenSandboxIds = new Set<string>();
      /** Control-plane apps this sweep recognised and left alone. */
      const platformAppsSeen: string[] = [];

      for (const { app, orgSlug, flyClient } of listedApps) {
        const appName = app.name?.trim();
        if (!appName || this.skipAppNames.has(appName)) {
          continue;
        }
        // The platform itself (note #1070): ahead of every branch that could
        // walk, stop, delete or report an app, so no record can ever make the
        // reaper act on the backend, its code host or its CI.
        if (orgSlug === this.deps.orgSlug && this.platformAppNames.has(appName)) {
          platformAppsSeen.push(appName);
          continue;
        }
        // A workplace's messaging machine (note #608) belongs to the ORG, not
        // to an agent record, and sleeps by itself: its server exits after a
        // quiet spell. Never probed (it has no SSH), stopped or reported.
        if (isOrgMsgAppName(appName)) {
          continue;
        }
        // Production deployment machines (iapp-*) are PAYMENT-bound, not
        // activity-bound: customers pay monthly for always-on. Only
        // deployment-service (dunning/operator) may ever stop them. The record
        // check feeds the report alone — a deployment-shaped app is never
        // walked regardless, so a stale name can at worst be surfaced.
        if (isDeploymentAppName(appName)) {
          // A recorded site is read, never walked — and read only for the
          // hourly pin audit (prospect-desk ran unpinned for a week).
          if (auditPins && deploymentApps?.has(appName)) {
            const siteMachines = await flyClient.listMachines(appName).catch((error) => {
              console.warn(`[FlyIdleReaper] read-only listMachines failed for site ${appName}`, error);
              return [] as FlyMachine[];
            });
            for (const machine of siteMachines) collectUnpinned(unpinned, orgSlug, appName, machine);
          }
          if (deploymentApps && !deploymentApps.has(appName)) {
            unrecordedApps.push({ appName, orgSlug, flyClient });
          }
          continue;
        }
        // The allowlist: an app no record claims is never probed or stopped.
        // A notifier may list its machines READ-ONLY after this loop, solely
        // to distinguish a costly running leak from an inert unfamiliar app.
        if (!claimedApps.has(appName)) {
          const retiredAt = retiredApps.get(appName);
          if (retiredAt !== undefined && await this.deleteRetiredApp(appName, orgSlug, flyClient, retiredAt, now)) {
            continue;
          }
          unrecordedApps.push({ appName, orgSlug, flyClient });
          continue;
        }
        const machines = await flyClient.listMachines(appName).catch((error) => {
          console.warn(`[FlyIdleReaper] listMachines failed for ${appName}`, error);
          return [] as FlyMachine[];
        });
        for (const machine of machines) {
          const sandboxId = buildFlySandboxId(appName, machine.id);
          // Fall back to the provisioning marker: between minting an app and
          // saving the machine on the record there is no sandbox id to match,
          // and that window is exactly when a machine looks unowned while being
          // very much someone's.
          const owner = owners.get(sandboxId) ?? provisioningOwners.get(appName);
          const host = machine.private_ip?.trim() || undefined;
          seenSandboxIds.add(sandboxId);
          if (auditPins) collectUnpinned(unpinned, orgSlug, appName, machine);
          // Note the shape before any of the state branches below: a stopped
          // machine leaves this loop two lines from here, and an asleep
          // machine is exactly the one whose row a reader is most likely to
          // be looking at. Recording only, never read by a gate.
          //
          // Off the EXACT owner, never the app-wide provisioning fallback the
          // gates above may use. That fallback says "some machine in this app
          // is probably this agent's" — enough to refuse to stop it, and not
          // enough to write down as its shape: a retried provision leaves two
          // machines in one app, and both would claim the same row, with
          // whichever the listing returned last winning.
          const owned = owners.get(sandboxId);
          const shape = owned ? agentMachineShapeOf(machine.config?.guest) : undefined;
          if (owned && shape) {
            machineShapes.push({ userId: owned.userId, agentId: owned.agentId, ...shape });
          }
          // Orphan evidence accrues only while a machine is RUNNING and
          // unclaimed — that is the state that costs money and the only one we
          // act on. Any owner at all clears the tally outright.
          if (owner) {
            this.unownedSweeps.delete(sandboxId);
          } else if (machine.state === 'started') {
            this.unownedSweeps.set(sandboxId, (this.unownedSweeps.get(sandboxId) ?? 0) + 1);
          }
          // Already asleep: the free moment to move it onto the current fleet
          // image. Nothing else here applies to a stopped machine — it burns no
          // compute, so there is nothing to meter and nothing to stop.
          if (machine.state === 'stopped') {
            await this.rollStoppedMachineImage({ sandboxId, owner, host, now, machine });
            continue;
          }
          if (machine.state !== 'started') {
            continue;
          }
          consideredStarted += 1;
          // Meter every running machine — including ones this pass stops
          // (they ran since the previous pass) and ones kept by a gate.
          if (owner && runtimeCreditMs > 0) {
            runtimeSamples.push({ userId: owner.userId, agentId: owner.agentId, ms: runtimeCreditMs });
          }
          const createdAt = machine.created_at ? Date.parse(machine.created_at) : Number.NaN;
          const decision = this.decideStop({
            owner,
            host,
            liveHosts,
            now,
            ownersLoaded,
            unownedSweeps: this.unownedSweeps.get(sandboxId) ?? 0,
            ...(Number.isFinite(createdAt) ? { createdAt } : {}),
          });
          if (!decision.stop) {
            keep(decision.reason);
            continue;
          }
          if (owner && this.deps.scheduleHoldsAwake?.(owner.userId, owner.agentId)) {
            keep('scheduled-window');
            continue;
          }
          // A durable managed job is intentionally independent of a harness
          // turn and of this backend process. Discover it on the machine, from
          // the exact named tmux namespace, before doing any updater work.
          if (await this.managedJobProbeBlocksStop(sandboxId, 'before CLI update')) {
            keep('managed-job');
            continue;
          }
          // Idle-confirmed: give the machine its CLI update before it sleeps,
          // then re-check the LIVE gates — the install can take a minute, and a
          // message may have arrived meanwhile. Stopping then would kill the
          // fresh turn mid-flight; skipping costs nothing (next sweep retries).
          if (this.deps.updateClisBeforeStop && owner) {
            await this.deps.updateClisBeforeStop({
              sandboxId,
              userId: owner.userId,
              agentId: owner.agentId,
              cli: owner.cli,
            }).catch((error) => {
              console.warn(`[FlyIdleReaper] pre-stop CLI update failed for ${sandboxId}`, error);
            });
            const busyAgain = this.liveGateAppeared(owner, host);
            if (busyAgain) {
              keep('woke-during-cli-update');
              console.log(`[FlyIdleReaper] ${machine.id} woke during CLI update; not stopping`);
              continue;
            }
          }
          // Re-probe immediately before the Fly stop. A job may have started
          // during the npm install (or between the first probe and this point),
          // and no in-memory registry can close that race across a deploy.
          if (await this.managedJobProbeBlocksStop(sandboxId, 'before stop')) {
            keep('managed-job');
            continue;
          }
          if (owner && this.deps.recordNoManagedJobs) {
            await this.deps.recordNoManagedJobs({ userId: owner.userId, agentId: owner.agentId })
              .catch((error) => {
                console.warn(`[FlyIdleReaper] could not clear the job count for ${sandboxId}:`, error);
              });
          }
          // An install started somewhere else — the Mini App's Update button —
          // is still writing to this machine's global npm prefix. Halting it
          // truncates that write, and what is left cannot be repaired by the
          // updater's own retry. The machine is idle either way; leaving it
          // running one more sweep costs a minute of an already-cheap machine.
          if (this.deps.cliInstallInFlight?.(sandboxId)) {
            keep('cli-install-in-flight');
            console.log(`[FlyIdleReaper] ${machine.id} has a CLI install in flight; not stopping`);
            continue;
          }
          // The SSH probe is awaited and can take up to its timeout. Refresh
          // every live gate after it returns so a turn or terminal that starts
          // during that wait cannot be stopped with the machine.
          if (this.liveGateAppeared(owner, host)) {
            keep('woke-during-probe');
            console.log(`[FlyIdleReaper] ${machine.id} woke during final managed-job probe; not stopping`);
            continue;
          }
          if (decision.reason === 'orphan') {
            // Loud on purpose: an orphan is the visible end of a provisioning
            // failure or a stale record, and stopping it treats the symptom
            // only — the machine, its volume and its app are all still billed.
            console.warn(
              `[FlyIdleReaper] ${sandboxId} has been running unclaimed by any agent record `
              + `for ${this.unownedSweeps.get(sandboxId) ?? 0} sweeps; stopping it`,
            );
          }
          try {
            await flyClient.stopMachine(appName, machine.id);
            stopped += 1;
            if (decision.reason === 'orphan') {
              orphansStopped += 1;
            }
            console.log(`[FlyIdleReaper] stopped ${decision.reason} machine ${machine.id} in ${appName}`);
            // Roll it NOW, on the sleep we just caused, rather than leaving a
            // later scan to notice. Same gate (we only get here because
            // decideStop said yes), same write — but the machine converges the
            // moment it falls asleep, and the causality is in one place instead
            // of split across two sweeps.
            if (owner) {
              await this.deps.rollImageWhileStopped?.({
                sandboxId,
                userId: owner.userId,
                agentId: owner.agentId,
                waitForStopped: true,
                ...(machine.config?.image ? { listedImage: machine.config.image } : {}),
                ...(machine.config?.rootfs?.persist
                  ? { listedRootfsPersist: machine.config.rootfs.persist }
                  : {}),
                ...(machine.config?.env?.AUTHORIZED_KEYS
                  ? { listedAuthorizedKeys: machine.config.env.AUTHORIZED_KEYS }
                  : {}),
              }).catch((error) => {
                console.warn(`[FlyIdleReaper] image roll failed for ${sandboxId}`, error);
              });
            }
          } catch (error) {
            keep('stop-failed');
            console.warn(`[FlyIdleReaper] failed to stop ${machine.id} in ${appName}`, error);
          }
        }
      }

      // Forget machines this sweep never saw: an app that was deleted, or one
      // a failed listing hid. Either way the tally is no longer evidence about
      // anything that exists, and a rebuilt machine must start its own count.
      for (const sandboxId of this.unownedSweeps.keys()) {
        if (!seenSandboxIds.has(sandboxId)) {
          this.unownedSweeps.delete(sandboxId);
        }
      }

      if (this.deps.recordRuntimeSamples && runtimeSamples.length > 0) {
        await this.deps.recordRuntimeSamples(runtimeSamples).catch((error) => {
          console.warn('[FlyIdleReaper] runtime metering failed (sweep unaffected)', error);
        });
      }

      if (this.deps.recordMachineShapes && machineShapes.length > 0) {
        await this.deps.recordMachineShapes(machineShapes).catch((error) => {
          console.warn('[FlyIdleReaper] machine-shape recording failed (sweep unaffected)', error);
        });
      }

      const platformLine = [...platformAppsSeen].sort().join(', ');
      if (platformLine !== this.loggedPlatformApps) {
        this.loggedPlatformApps = platformLine;
        if (platformLine) {
          console.log(`[FlyIdleReaper] control-plane apps, never touched: ${platformLine}`);
        }
      }
      await this.reportUnrecordedApps(unrecordedApps, now);
      if (auditPins) {
        this.lastPinAuditAt = now;
        await this.reportUnpinnedMachines(unpinned, now);
      }

      // One line per sweep, always. Every count above was previously computed
      // and thrown away, so a fleet that stopped sleeping looked identical in
      // the journal to one with nothing to do — the reason this loop's real
      // behaviour went unread for weeks. Cheap: one line every intervalMs.
      const because = [...keptBy.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}=${count}`)
        .join(' ');
      console.log(
        `[FlyIdleReaper] sweep: running=${consideredStarted} stopped=${stopped} kept=${kept}`
        + `${because ? ` (${because})` : ''}`,
      );

      return { consideredStarted, stopped, kept, orphansStopped, unrecordedApps: unrecordedApps.length };
    } finally {
      this.running = false;
    }
  }

  /** Deployment-claimed app names, or null when unknowable this sweep. */
  private async loadDeploymentAppNames(): Promise<Set<string> | null> {
    if (!this.deps.listDeploymentAppNames) {
      return null;
    }
    try {
      return new Set(await this.deps.listDeploymentAppNames());
    } catch (error) {
      console.warn('[FlyIdleReaper] listDeploymentAppNames failed; skipping the deployment-app report', error);
      return null;
    }
  }

  /**
   * Keep the no-auto-stop rule, but make costly unknown apps visible where a
   * human actually looks. The machine listing is read-only: it exists solely
   * to prove the app is currently burning compute and to read Fly's latest
   * start event. The per-app alert stamp is persisted BEFORE Telegram is
   * called, so deploys and notifier failures cannot turn this into five-minute
   * spam. A still-running app becomes eligible again after one day.
   */
  /**
   * Say so when a machine runs without its SSH pin (note #664): once a day
   * per machine at most, through the same notifier and throttle store as the
   * unrecorded-app alert, and always in the journal. Nothing is changed on
   * the machine here — a pin takes effect only at boot, so fixing one means
   * a config write, and for a machine that never sleeps, a restart.
   */
  private async reportUnpinnedMachines(machines: UnpinnedMachine[], now: number): Promise<void> {
    if (machines.length === 0) return;
    console.warn(
      `[FlyIdleReaper] ${machines.length} machine(s) without a firewall pin: `
      + machines.map((machine) => `${machine.appName}/${machine.machineId}`).join(', '),
    );
    if (!this.deps.notifyUnrecordedApps) return;
    const due: UnpinnedMachine[] = [];
    for (const machine of machines) {
      const key = `unpinned:${unrecordedAppKey(machine.orgSlug, `${machine.appName}/${machine.machineId}`)}`;
      try {
        const stored = this.unrecordedAppAlertStore.get(key);
        const last = stored ? Date.parse(stored.lastAlertAt) : Number.NaN;
        if (Number.isFinite(last) && now - last < this.unrecordedAppAlertRepeatMs) continue;
        // Persist first, as the unrecorded-app alert does: a throw here must
        // never license an alert on every sweep.
        this.unrecordedAppAlertStore.put({ appKey: key, lastAlertAt: new Date(now).toISOString() });
      } catch (error) {
        console.warn(`[FlyIdleReaper] alert throttle unusable for ${key}; not notifying`, error);
        continue;
      }
      due.push(machine);
    }
    for (let offset = 0; offset < due.length; offset += 20) {
      try {
        await this.deps.notifyUnrecordedApps(formatUnpinnedMachineAlert(due.slice(offset, offset + 20)));
      } catch (error) {
        console.warn('[FlyIdleReaper] could not deliver the unpinned-machine alert', error);
      }
    }
  }

  /**
   * Remove an app a rebuild retired (note #792), once the recovery window has
   * passed. Only reached for an app no record claims AND one that an agent's
   * own record names as retired, so it is never a decision on a name's
   * evidence. Still checked at the moment of deleting: an app with any machine
   * in it is somebody recovering the old home, and is left alone. Returns
   * whether the app is gone.
   */
  private async deleteRetiredApp(
    appName: string,
    orgSlug: string,
    flyClient: ReaperFlyClient,
    retiredAt: number,
    now: number,
  ): Promise<boolean> {
    if (!flyClient.deleteApp || now - retiredAt < this.retiredAppRetentionMs) return false;
    try {
      const machines = await flyClient.listMachines(appName);
      if (machines.length > 0) {
        console.warn(`[FlyIdleReaper] retired app ${orgSlug}/${appName} holds ${machines.length} machine(s) again; left alone`);
        return false;
      }
      await flyClient.deleteApp(appName);
      console.log(`[FlyIdleReaper] deleted retired app ${orgSlug}/${appName} (retired ${new Date(retiredAt).toISOString()}, no machine since)`);
      return true;
    } catch (error) {
      console.warn(`[FlyIdleReaper] could not delete retired app ${orgSlug}/${appName}`, error);
      return false;
    }
  }

  private async reportUnrecordedApps(apps: UnrecordedApp[], now: number): Promise<void> {
    const sorted = [...apps].sort((left, right) => (
      left.orgSlug.localeCompare(right.orgSlug) || left.appName.localeCompare(right.appName)
    ));
    const key = sorted.map((app) => unrecordedAppKey(app.orgSlug, app.appName)).join(',');
    if (key !== this.lastUnrecordedReport) {
      const hadAny = this.lastUnrecordedReport !== '';
      this.lastUnrecordedReport = key;
      if (sorted.length === 0) {
        if (hadAny) {
          console.log('[FlyIdleReaper] every org app is claimed by a record again');
        }
      } else {
        console.warn(
          `[FlyIdleReaper] ${sorted.length} org app(s) claimed by no record; left untouched: `
          + sorted.map((app) => unrecordedAppKey(app.orgSlug, app.appName)).join(', '),
        );
      }
    }

    if (!this.deps.notifyUnrecordedApps || sorted.length === 0) return;

    const due: AlertableUnrecordedApp[] = [];
    for (const app of sorted) {
      const appKey = unrecordedAppKey(app.orgSlug, app.appName);
      let lastAlertAt: number | undefined;
      try {
        const stored = this.unrecordedAppAlertStore.get(appKey);
        const parsed = stored ? Date.parse(stored.lastAlertAt) : Number.NaN;
        lastAlertAt = Number.isFinite(parsed) ? parsed : undefined;
      } catch (error) {
        // Sending without a readable throttle could repeat on every sweep.
        console.warn(`[FlyIdleReaper] alert throttle unreadable for ${appKey}; not notifying`, error);
        continue;
      }
      if (lastAlertAt !== undefined && now - lastAlertAt < this.unrecordedAppAlertRepeatMs) {
        continue;
      }

      let machines: FlyMachine[];
      try {
        machines = await app.flyClient.listMachines(app.appName);
      } catch (error) {
        console.warn(`[FlyIdleReaper] read-only listMachines failed for unrecorded app ${app.appName}`, error);
        continue;
      }

      const running = machines.filter((machine) => machine.state === 'started');
      const oldRunning = running
        .map((machine) => machineStartedAt(machine))
        .filter((startedAt): startedAt is number => (
          startedAt !== undefined && now - startedAt > this.unrecordedAppAlertAfterMs
      ));
      if (oldRunning.length === 0) continue;

      try {
        // Persist first. The production notifier resolves even if Telegram is
        // unreachable, and an exception here must never license alert spam.
        this.unrecordedAppAlertStore.put({ appKey, lastAlertAt: new Date(now).toISOString() });
      } catch (error) {
        console.warn(`[FlyIdleReaper] could not persist alert throttle for ${appKey}; not notifying`, error);
        continue;
      }
      due.push({
        appName: app.appName,
        orgSlug: app.orgSlug,
        runningMachines: running.length,
        oldestRunningForMs: now - Math.min(...oldRunning),
      });
    }

    // Stay well below Telegram's 4,096-character ceiling even if a connected
    // client org legitimately contains many apps we do not own.
    for (let offset = 0; offset < due.length; offset += 20) {
      try {
        await this.deps.notifyUnrecordedApps(formatUnrecordedAppAlert(due.slice(offset, offset + 20)));
      } catch (error) {
        console.warn('[FlyIdleReaper] could not deliver the unrecorded-app alert', error);
      }
    }
  }

  /**
   * True means "do not stop". Only one exact, healthy `inactive` response
   * licenses sleep; active, timeout, transport error, non-zero exit, stderr,
   * or malformed output all fail closed. Each call is remote and stateless,
   * so a newly deployed backend rediscovers jobs it never started.
   */
  private async managedJobProbeBlocksStop(
    sandboxId: string,
    phase: 'before CLI update' | 'before stop',
  ): Promise<boolean> {
    let result: ExecSyncResult;
    try {
      result = await this.deps.execManagedJobProbe({
        sandboxId,
        command: MANAGED_JOB_TMUX_PROBE_COMMAND,
      });
    } catch (error) {
      console.warn(`[FlyIdleReaper] managed-job probe failed for ${sandboxId} ${phase}; keeping awake`, error);
      return true;
    }

    if (!isValidManagedJobProbeExecResult(result)) {
      console.warn(`[FlyIdleReaper] managed-job probe returned a malformed result for ${sandboxId} ${phase}; keeping awake`);
      return true;
    }
    if (result.timedOut || result.exitCode !== 0 || result.stderr.trim() !== '') {
      console.warn(
        `[FlyIdleReaper] managed-job probe was unhealthy for ${sandboxId} ${phase} `
        + `(exit=${result.exitCode}, timedOut=${result.timedOut}); keeping awake`,
      );
      return true;
    }

    const response = result.stdout.trim();
    if (response === MANAGED_JOB_PROBE_ACTIVE) {
      console.log(`[FlyIdleReaper] ${sandboxId} has an active managed job ${phase}; keeping awake`);
      return true;
    }
    if (response === MANAGED_JOB_PROBE_INACTIVE) {
      return false;
    }
    console.warn(`[FlyIdleReaper] managed-job probe response was malformed for ${sandboxId} ${phase}; keeping awake`);
    return true;
  }

  /**
   * Offer an ALREADY-sleeping machine to the image updater — the backstop, not
   * the main path. A machine this sweep stops is rolled on the spot; this
   * catches the ones that were asleep before the fleet image moved, which
   * would otherwise stay behind until their owner next used them and let go.
   *
   * The gate is `decideStop` itself, on purpose: "is it safe to stop this
   * machine" and "is it safe to write its config" are the same question, since
   * both cost the user their running processes if the answer is wrong. Reusing
   * it means there is one place where the fleet decides a machine is unused —
   * a second, subtly different gate is how a machine ends up rolled mid-turn.
   *
   * It is re-asked here against LIVE turn and session state rather than the
   * owner index, which was built before the sweep walked every other app and
   * may be minutes stale. The recency arm is what closes the wake race: a
   * message arriving now marks the agent active well before the machine leaves
   * `stopped`, so "asleep and quiet for the whole idle window" is a much colder
   * signal than `stopped` alone.
   *
   * Never throws: a machine that misses this pass is offered again next sweep.
   */
  private async rollStoppedMachineImage(args: {
    sandboxId: string;
    owner: FlyMachineOwner | undefined;
    host: string | undefined;
    now: number;
    machine: FlyMachine;
  }): Promise<void> {
    const { sandboxId, owner, host, now, machine } = args;
    if (!this.deps.rollImageWhileStopped || !owner) {
      return;
    }
    const decision = this.decideStop({
      owner: { ...owner, turnRunning: this.deps.isTurnRunningForAgent(owner.userId, owner.agentId) },
      host,
      liveHosts: this.deps.getActiveSessionHosts(),
      now,
    });
    if (!decision.stop) {
      return;
    }
    await this.deps.rollImageWhileStopped({
      sandboxId,
      userId: owner.userId,
      agentId: owner.agentId,
      ...(machine.config?.image ? { listedImage: machine.config.image } : {}),
      ...(machine.config?.rootfs?.persist ? { listedRootfsPersist: machine.config.rootfs.persist } : {}),
      ...(machine.config?.env?.AUTHORIZED_KEYS ? { listedAuthorizedKeys: machine.config.env.AUTHORIZED_KEYS } : {}),
    }).catch((error) => {
      console.warn(`[FlyIdleReaper] image roll failed for ${sandboxId}`, error);
    });
  }

  /**
   * Map each user's Fly agent sandbox id → owner activity/turn state.
   *
   * `loaded` is what licenses stopping an unattributed machine, so it is
   * deliberately pessimistic: false when the read threw, and false when it
   * came back with no Fly-backed agent at all. An empty index and a broken
   * index look identical from here, and reading the empty one as truth would
   * declare the entire fleet orphaned.
   */
  private async buildOwnerIndex(): Promise<{
    index: Map<string, FlyMachineOwner>;
    byApp: Map<string, FlyMachineOwner>;
    /** Every app name an agent record claims — serverId or provisioning marker. */
    claimedApps: Set<string>;
    /** Apps a rebuild retired (note #792), with when — the only apps a sweep deletes. */
    retiredApps: Map<string, number>;
    loaded: boolean;
    /** Whether the store was readable at all; false skips the whole sweep. */
    read: boolean;
  }> {
    const index = new Map<string, FlyMachineOwner>();
    // Agents mid-provision: the record names the app before the machine exists,
    // so its machine is attributable by app alone for the minutes it takes to
    // get a serverId — and after a crashed provision, indefinitely.
    const byApp = new Map<string, FlyMachineOwner>();
    const claimedApps = new Set<string>();
    const retiredApps = new Map<string, number>();
    let read = true;
    const users = await this.deps.userStorage.getAllUsers().catch((error) => {
      console.warn('[FlyIdleReaper] getAllUsers failed', error);
      read = false;
      return [];
    });
    for (const user of users) {
      const agents = listAgents(user.telegram, true);
      if (agents.length === 0) {
        continue;
      }
      for (const agent of agents) {
        const lastActivityAt = this.deps.getAgentLastActiveAt(user.userId, agent.id);
        const owner: FlyMachineOwner = {
          userId: user.userId,
          agentId: agent.id,
          cli: agent.cli,
          ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
          turnRunning: this.deps.isTurnRunningForAgent(user.userId, agent.id),
        };
        for (const retired of agent.retiredMachineApps ?? []) {
          const retiredAt = Date.parse(retired.retiredAt);
          if (retired.appName && Number.isFinite(retiredAt)) retiredApps.set(retired.appName, retiredAt);
        }
        const provisioningApp = agent.provisioningAppName?.trim();
        if (provisioningApp) {
          byApp.set(provisioningApp, owner);
          claimedApps.add(provisioningApp);
        }
        const sandboxId = parseFlyServerRecordId(agent.serverId);
        const target = sandboxId ? parseFlySandboxId(sandboxId) : null;
        if (!sandboxId || !target) {
          continue;
        }
        claimedApps.add(target.appName);
        index.set(sandboxId, owner);
      }
    }
    // `byApp` alone does not count as a loaded index: a fleet whose only
    // attributions are provisioning markers is not one to start stopping
    // machines on the strength of.
    return { index, byApp, claimedApps, retiredApps, loaded: read && index.size > 0, read };
  }
}

function isValidManagedJobProbeExecResult(value: unknown): value is ExecSyncResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ExecSyncResult>;
  return typeof candidate.stdout === 'string'
    && typeof candidate.stderr === 'string'
    && Number.isInteger(candidate.exitCode)
    && typeof candidate.timedOut === 'boolean';
}

/** Fly app names are globally unique, but the org stays in the key for auditability. */
function unrecordedAppKey(orgSlug: string, appName: string): string {
  return `${orgSlug}/${appName}`;
}

/** Latest successful start event from Fly's bounded, newest-first event list. */
function machineStartedAt(machine: FlyMachine): number | undefined {
  const starts = (machine.events ?? [])
    .filter((event) => event.type === 'start' && event.status === 'started')
    .map((event) => {
      if (typeof event.timestamp === 'number') return event.timestamp;
      if (typeof event.timestamp === 'string') {
        const numeric = Number(event.timestamp);
        if (Number.isFinite(numeric)) return numeric;
        return Date.parse(event.timestamp);
      }
      return Number.NaN;
    })
    .filter(Number.isFinite);
  return starts.length > 0 ? Math.max(...starts) : undefined;
}

/** A machine the pin audit found running without `BACKEND_PEER_IP`. */
interface UnpinnedMachine {
  orgSlug: string;
  appName: string;
  machineId: string;
  state: string;
}

/**
 * Add `machine` when its env carries no pin. A listing that returned no env
 * at all is not evidence of anything — every machine we build has one — so
 * only a machine with env and without the pin counts.
 */
function collectUnpinned(into: UnpinnedMachine[], orgSlug: string, appName: string, machine: FlyMachine): void {
  const env = machine.config?.env;
  if (!env || Object.keys(env).length === 0 || env.BACKEND_PEER_IP?.trim()) return;
  into.push({ orgSlug, appName, machineId: machine.id, state: machine.state ?? 'unknown' });
}

function formatUnpinnedMachineAlert(machines: UnpinnedMachine[]): string {
  const lines = [
    `🔴 ${machines.length === 1 ? 'A MACHINE IS' : `${machines.length} MACHINES ARE`} RUNNING WITHOUT ITS FIREWALL`,
    'No BACKEND_PEER_IP in its env, so the image skipped its firewall: its SSH and every side port are open to the private network.',
    ...machines.map((machine) => `• ${machine.appName} / ${machine.machineId} (${machine.orgSlug}, ${machine.state})`),
    'Fix: add BACKEND_PEER_IP to its env (asleep: with skip_launch; always-on: it restarts). See docs/byo-fly.md section 8.',
  ];
  return lines.join('\n');
}

function formatUnrecordedAppAlert(apps: AlertableUnrecordedApp[]): string {
  const plural = apps.length === 1 ? 'APP' : 'APPS';
  const lines = [
    `🔴 UNCLAIMED FLY ${plural} RUNNING`,
    'No agent or deployment record claims:',
    ...apps.map((app) => (
      `• ${app.appName} (${app.orgSlug}) — ${app.runningMachines} running machine`
      + `${app.runningMachines === 1 ? '' : 's'}, oldest ${describeDuration(app.oldestRunningForMs)}`
    )),
    'The idle reaper left them untouched. Inspect them in Fly; stop or delete only confirmed leaks.',
  ];
  return lines.join('\n');
}

function describeDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
