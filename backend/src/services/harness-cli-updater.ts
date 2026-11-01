import { extractCliVersion } from './server-bootstrap.js';
import {
  HARNESS_CLI_BINARIES,
  HARNESS_CLI_NPM_PACKAGES,
  isValidCliVersion,
  type HarnessCliName,
  type PinnedCliVersions,
} from './harness-cli-versions.js';
import type { ExecSyncResult } from './sandbox-types.js';

/** `claude --version` is quick; `npm install -g` downloads a large package. */
const VERSION_CHECK_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface HarnessCliUpdaterDeps {
  /** Root exec on the machine — installs need the global npm prefix. */
  execSync: (
    sandboxId: string,
    command: string,
    options: { timeoutMs?: number; sshUser?: string },
  ) => Promise<ExecSyncResult>;
  getPinnedVersions: () => Promise<PinnedCliVersions>;
  /** Stamp the observed installed version on the agent record. */
  persistObservedVersion: (args: {
    userId: string;
    agentId: string;
    version: string;
    checkedAt: string;
  }) => Promise<void>;
  now?: () => number;
}

export interface HarnessCliUpdateResult {
  outcome:
    | 'no-pin'
    | 'version-unreadable'
    | 'current'
    | 'updated'
    | 'install-failed'
    /** Another caller is already installing on this machine; this one stood down. */
    | 'already-updating';
  installedVersion?: string;
}

/**
 * Brings a Fly machine's harness CLI up to the pinned fleet version right
 * before the idle reaper stops it — the one window where a ~1-minute
 * `npm install -g` is free: the machine is already idle, nobody is waiting,
 * and the rootfs (which persists across stop/start) keeps the result for
 * every later wake. Updating on wake instead would tax exactly the moment a
 * user is waiting for a reply.
 *
 * Only the agent's own CLI is updated (one agent = one machine = one CLI in
 * use); the sibling CLI baked into the image is dead weight not worth npm
 * time on every cycle.
 *
 * NEVER throws and never blocks the stop: a failed update logs, and the
 * machine retries on its next idle cycle. Keeping a machine awake (and
 * billed) over a registry hiccup would be worse than a stale CLI.
 */
export class HarnessCliUpdater {
  /**
   * The machines with an install in flight — the ONE writer's lock.
   *
   * Every caller comes through here, so this is the only place that can see
   * all of them. Both entry points used to guard against themselves alone:
   * the reaper's sweep against other sweeps, the Mini App's button against
   * other button presses. Neither could see the other, and on 2026-09-11 they
   * ran at the same time on one machine — the sweep installing since 07:43:47,
   * the button arriving at 07:44:20, finding a CLI that could not answer
   * `--version` because the first install was mid-flight, concluding it was
   * broken, and starting a second `npm install -g` into the same global
   * prefix. What survived was a half-written package: `ENOTEMPTY` on every
   * retry afterwards, and that agent could not run at all until a human
   * cleared it by hand.
   *
   * Keyed by machine, not by agent: the global npm prefix is the machine's.
   * Each entry is the install itself, settled when it is over, so a turn
   * about to start can wait for it (`installInFlight`).
   */
  private readonly installsInFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: HarnessCliUpdaterDeps) {}

  /** Whether an install is running on this machine right now. */
  isInstalling(sandboxId: string): boolean {
    return this.installsInFlight.has(sandboxId);
  }

  /**
   * The install running on this machine right now, settled when it is over
   * (whatever its outcome — the updater reports that), or undefined when
   * none is.
   *
   * A turn asks before it starts the CLI. The pre-sleep update begins the
   * moment a machine falls idle, and a message can land a second later: on
   * 2026-10-15 Iris's machine began installing claude 2.1.300 at 11:29:23,
   * Adam's approval started her turn at 11:29:25, and npm had the old
   * package gone and the new binary not yet written — `claude: command not
   * found`, exit 127, the turn lost. The install was done at 11:29:32.
   * Waiting those seconds costs the turn nothing it would not have lost.
   */
  installInFlight(sandboxId: string): Promise<void> | undefined {
    return this.installsInFlight.get(sandboxId);
  }

  async updateBeforeSleep(args: {
    sandboxId: string;
    userId: string;
    agentId: string;
    cli: HarnessCliName;
  }): Promise<HarnessCliUpdateResult> {
    const { sandboxId, userId, agentId, cli } = args;
    if (this.installsInFlight.has(sandboxId)) {
      // Not an error and not worth retrying here: the install already running
      // is installing the same pin this call would. Say so and get out of its
      // way — the alternative is the collision described above.
      console.log(`[HarnessCliUpdater] ${sandboxId}: an install is already in flight; leaving it to finish`);
      return { outcome: 'already-updating' };
    }
    // Held from the version read on, not only around npm: a turn arriving
    // while the CLI is being asked its version would otherwise start in the
    // moment before the install begins replacing it.
    let finished: () => void = () => {};
    this.installsInFlight.set(sandboxId, new Promise<void>((resolve) => { finished = resolve; }));
    try {
      const pinned = (await this.deps.getPinnedVersions())[cli];
      if (!pinned) {
        return { outcome: 'no-pin' };
      }

      // Exact pin, validated shape — never a dist-tag, so the registry can't
      // move the target between the compare and the install.
      if (!isValidCliVersion(pinned)) {
        console.warn(`[HarnessCliUpdater] invalid pinned ${cli} version "${pinned}"; skipping`);
        return { outcome: 'no-pin' };
      }

      const installed = await this.readInstalledVersion(sandboxId, cli);
      if (!installed) {
        // A CLI that cannot answer `--version` is usually a BROKEN one, not an
        // unknown one — and skipping left it broken forever, because every
        // later sweep asked the same dead binary the same question.
        //
        // Seen live 2026-08-08: an install was cut off by the stop below and
        // left a 112 MiB fragment of a 277 MiB binary. Every `claude` after
        // that died with SIGBUS, including the user's turns, for six hours.
        // Reinstalling the pin is the repair, and it is safe to attempt blind:
        // the machine is idle, nobody is waiting, and if the read failed for
        // some other reason the install simply lands the version we wanted.
        console.warn(`[HarnessCliUpdater] ${cli} on ${sandboxId} did not report a version; reinstalling the pin to repair it`);
        // `await` matters: returning the promise unawaited would escape the
        // try/catch below, and this method's whole contract is never throwing.
        return await this.installPin({ sandboxId, userId, agentId, cli, pinned, repairing: true });
      }
      if (installed === pinned) {
        await this.persist(userId, agentId, installed);
        return { outcome: 'current', installedVersion: installed };
      }
      console.log(`[HarnessCliUpdater] ${sandboxId}: ${cli} ${installed} → ${pinned}`);
      return await this.installPin({ sandboxId, userId, agentId, cli, pinned, previous: installed });
    } catch (error) {
      console.warn(`[HarnessCliUpdater] update failed on ${sandboxId}:`, error);
      return { outcome: 'install-failed' };
    } finally {
      // Released only here, so the install's own version read-back is inside
      // the lock too: a caller arriving mid-verification must still stand down.
      this.installsInFlight.delete(sandboxId);
      finished();
    }
  }

  /**
   * Install the pinned version and verify it by asking the binary.
   *
   * **The `sync` is load-bearing.** The reaper stops this machine within a
   * second of this returning, and `npm install -g` of a ~277 MB binary is still
   * in the page cache at that point: the verification below reads it back
   * happily from cache, then the halt truncates it on the rootfs. That is how
   * one machine ended up with a 112 MiB fragment on 2026-08-08 — SIGBUS on
   * every invocation afterwards, while the install had logged success. Flushing
   * costs a second on an idle machine and closes the whole class.
   */
  private async installPin(args: {
    sandboxId: string;
    userId: string;
    agentId: string;
    cli: HarnessCliName;
    pinned: string;
    previous?: string;
    /** This install is repairing a CLI that already fails `--version`. */
    repairing?: boolean;
  }): Promise<HarnessCliUpdateResult> {
    const { sandboxId, userId, agentId, cli, pinned, previous, repairing } = args;
    const pkg = HARNESS_CLI_NPM_PACKAGES[cli];
    let install = await this.deps.execSync(
      sandboxId,
      `npm install -g ${pkg}@${pinned} && sync`,
      { timeoutMs: INSTALL_TIMEOUT_MS, sshUser: 'root' },
    );

    // A reinstall over a CLI that is ALREADY dead can fail in a way no
    // number of retries will fix. npm installs by unpacking beside the
    // package and renaming it into place; when a previous install was cut
    // off mid-write, the directory it must rename aside is neither complete
    // nor empty, and npm stops with ENOTEMPTY. The repair path then runs
    // every idle cycle forever, failing identically each time, while the
    // agent cannot run at all. Seen live 2026-09-11: three attempts over 34
    // minutes, and it would have continued indefinitely.
    //
    // So clear the wreckage and install fresh — the same thing a human does
    // by hand. Deliberately narrow: only the one package directory and the
    // dot-prefixed temp siblings npm itself leaves behind, only when the CLI
    // is already failing `--version`, and only after an install has actually
    // failed. A working install is never a candidate for this.
    if (install.exitCode !== 0 && repairing && isUnrenameableTree(install.stderr)) {
      console.warn(
        `[HarnessCliUpdater] ${sandboxId}: ${cli} install cannot replace a half-written package; clearing it and installing fresh`,
      );
      const cleared = await this.deps.execSync(
        sandboxId,
        `rm -rf ${globalPackagePath(pkg)} ${globalPackageTempGlob(pkg)}`,
        { timeoutMs: VERSION_CHECK_TIMEOUT_MS, sshUser: 'root' },
      );
      if (cleared.exitCode === 0) {
        install = await this.deps.execSync(
          sandboxId,
          `npm install -g ${pkg}@${pinned} && sync`,
          { timeoutMs: INSTALL_TIMEOUT_MS, sshUser: 'root' },
        );
      } else {
        console.warn(
          `[HarnessCliUpdater] ${sandboxId}: could not clear the broken ${cli} tree: ${tail(cleared.stderr)}`,
        );
      }
    }

    if (install.exitCode !== 0) {
      console.warn(
        `[HarnessCliUpdater] npm install failed on ${sandboxId} (exit ${install.exitCode}): ${tail(install.stderr)}`,
      );
      return { outcome: 'install-failed', ...(previous ? { installedVersion: previous } : {}) };
    }

    // Trust the binary, not npm's exit code — same lesson as everywhere
    // else: verify via what actually responds.
    const observed = await this.readInstalledVersion(sandboxId, cli);
    if (observed) {
      await this.persist(userId, agentId, observed);
    }
    if (observed !== pinned) {
      console.warn(
        `[HarnessCliUpdater] ${sandboxId}: ${cli} reports ${observed ?? 'nothing'} after installing ${pinned}`,
      );
      return {
        outcome: 'install-failed',
        ...(observed ?? previous ? { installedVersion: observed ?? previous } : {}),
      };
    }
    console.log(`[HarnessCliUpdater] ${sandboxId}: ${cli} now ${observed}`);
    return { outcome: 'updated', installedVersion: observed };
  }

  private async readInstalledVersion(sandboxId: string, cli: HarnessCliName): Promise<string | undefined> {
    const binary = HARNESS_CLI_BINARIES[cli];
    try {
      const result = await this.deps.execSync(
        sandboxId,
        `${binary} --version`,
        { timeoutMs: VERSION_CHECK_TIMEOUT_MS, sshUser: 'root' },
      );
      if (result.exitCode !== 0) {
        return undefined;
      }
      return extractCliVersion(result.stdout);
    } catch {
      return undefined;
    }
  }

  private async persist(userId: string, agentId: string, version: string): Promise<void> {
    const checkedAt = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    try {
      await this.deps.persistObservedVersion({ userId, agentId, version, checkedAt });
    } catch (error) {
      console.warn(`[HarnessCliUpdater] could not persist version for agent ${agentId}:`, error);
    }
  }
}

function tail(text: string | undefined, maxChars = 400): string {
  const trimmed = text?.trim() ?? '';
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

/**
 * The global npm prefix on an agent machine. Fixed, not discovered: these
 * paths are passed to `rm -rf` as root, so they must come from the image's
 * known layout and never from anything a command on the machine printed back.
 */
const GLOBAL_NODE_MODULES = '/usr/lib/node_modules';

/** `@openai/codex` → `/usr/lib/node_modules/@openai/codex`. */
function globalPackagePath(pkg: string): string {
  return `${GLOBAL_NODE_MODULES}/${pkg}`;
}

/**
 * The dot-prefixed staging directories npm leaves beside a package when an
 * install is interrupted (`@openai/.codex-XCNbUSl9`). They are what makes the
 * next rename fail, so clearing the package without them fixes nothing.
 *
 * Scoped to the package's own directory and its own name — the glob cannot
 * reach a sibling package, and every harness CLI package name is a literal in
 * HARNESS_CLI_NPM_PACKAGES, never user input.
 */
function globalPackageTempGlob(pkg: string): string {
  const lastSlash = pkg.lastIndexOf('/');
  if (lastSlash === -1) {
    return `${GLOBAL_NODE_MODULES}/.${pkg}-*`;
  }
  return `${GLOBAL_NODE_MODULES}/${pkg.slice(0, lastSlash)}/.${pkg.slice(lastSlash + 1)}-*`;
}

/**
 * Whether npm failed because it could not move an existing package directory
 * out of the way — the signature of a previous install cut off mid-write.
 *
 * Matched on npm's own error code and syscall rather than the prose, which is
 * localised and reworded between versions.
 */
function isUnrenameableTree(stderr: string | undefined): boolean {
  const text = stderr ?? '';
  return /ENOTEMPTY|EEXIST/.test(text) && /rename/.test(text);
}
