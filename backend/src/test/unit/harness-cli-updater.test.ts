import { describe, expect, it, vi } from 'vitest';
import { HarnessCliUpdater } from '../../services/harness-cli-updater.js';
import type { ExecSyncResult } from '../../services/sandbox-types.js';

const SANDBOX_ID = 'fly-sandbox-ia-app1.aa11bb22';
const TARGET = { sandboxId: SANDBOX_ID, userId: 'u1', agentId: 'a1', cli: 'claude' as const };

function ok(stdout: string): ExecSyncResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false };
}

function fail(stderr = 'boom', exitCode = 1): ExecSyncResult {
  return { stdout: '', stderr, exitCode, timedOut: false };
}

function makeUpdater(args: {
  pinned?: { claude?: string; codex?: string };
  exec: (command: string) => ExecSyncResult | Promise<ExecSyncResult>;
}) {
  const execSync = vi.fn(async (_sandboxId: string, command: string) => args.exec(command));
  const persistObservedVersion = vi.fn().mockResolvedValue(undefined);
  const updater = new HarnessCliUpdater({
    execSync,
    getPinnedVersions: async () => args.pinned ?? {},
    persistObservedVersion,
  });
  return { updater, execSync, persistObservedVersion };
}

describe('HarnessCliUpdater.updateBeforeSleep', () => {
  it('does nothing when no version is pinned for the CLI', async () => {
    const { updater, execSync } = makeUpdater({ pinned: { codex: '0.48.0' }, exec: () => ok('') });
    const result = await updater.updateBeforeSleep(TARGET);

    expect(result.outcome).toBe('no-pin');
    expect(execSync).not.toHaveBeenCalled();
  });

  it('persists and skips the install when already on the pin', async () => {
    const { updater, execSync, persistObservedVersion } = makeUpdater({
      pinned: { claude: '2.1.219' },
      exec: () => ok('2.1.219 (Claude Code)'),
    });
    const result = await updater.updateBeforeSleep(TARGET);

    expect(result).toEqual({ outcome: 'current', installedVersion: '2.1.219' });
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync.mock.calls[0][1]).toBe('claude --version');
    expect(persistObservedVersion).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', agentId: 'a1', version: '2.1.219',
    }));
  });

  it('installs the exact pin as root and verifies via the binary, not npm', async () => {
    let installed = '2.1.219';
    const { updater, execSync, persistObservedVersion } = makeUpdater({
      pinned: { claude: '2.1.223' },
      exec: (command) => {
        if (command === 'claude --version') return ok(`${installed} (Claude Code)`);
        expect(command).toBe('npm install -g @anthropic-ai/claude-code@2.1.223 && sync');
        installed = '2.1.223';
        return ok('added 1 package');
      },
    });
    const result = await updater.updateBeforeSleep(TARGET);

    expect(result).toEqual({ outcome: 'updated', installedVersion: '2.1.223' });
    // version check → install → re-check, all as root.
    expect(execSync.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ sshUser: 'root' }),
      expect.objectContaining({ sshUser: 'root' }),
      expect.objectContaining({ sshUser: 'root' }),
    ]);
    expect(persistObservedVersion).toHaveBeenCalledWith(expect.objectContaining({ version: '2.1.223' }));
  });

  it('uses the codex package for codex agents', async () => {
    const { updater, execSync } = makeUpdater({
      pinned: { codex: '0.48.0' },
      exec: (command) => (command === 'codex --version' ? ok('codex-cli 0.47.0') : ok('done')),
    });
    await updater.updateBeforeSleep({ ...TARGET, cli: 'codex' });

    expect(execSync.mock.calls[1][1]).toBe('npm install -g @openai/codex@0.48.0 && sync');
  });

  it('reports install-failed without throwing when npm fails', async () => {
    const { updater, persistObservedVersion } = makeUpdater({
      pinned: { claude: '2.1.223' },
      exec: (command) => (command === 'claude --version' ? ok('2.1.219 (Claude Code)') : fail('ETIMEDOUT')),
    });
    const result = await updater.updateBeforeSleep(TARGET);

    expect(result).toEqual({ outcome: 'install-failed', installedVersion: '2.1.219' });
    expect(persistObservedVersion).not.toHaveBeenCalled();
  });

  it('reports install-failed when the binary still reports the old version after install', async () => {
    const { updater, persistObservedVersion } = makeUpdater({
      pinned: { claude: '2.1.223' },
      // npm claims success but the binary never moves.
      exec: (command) => (command === 'claude --version' ? ok('2.1.219 (Claude Code)') : ok('added 1 package')),
    });
    const result = await updater.updateBeforeSleep(TARGET);

    expect(result).toEqual({ outcome: 'install-failed', installedVersion: '2.1.219' });
    // The observed (old) version is still persisted — it IS what's running.
    expect(persistObservedVersion).toHaveBeenCalledWith(expect.objectContaining({ version: '2.1.219' }));
  });

  it('REPAIRS a CLI that cannot answer --version, instead of skipping it forever', async () => {
    // The signature of a broken binary, not an unknown one. On 2026-08-08 a
    // truncated install left `claude` dying with SIGBUS; the old code read the
    // failure as "unknown version" and skipped, so every later sweep asked the
    // same dead binary the same question and the machine stayed broken for
    // hours — including for the user's own turns.
    let healthy = false;
    const { updater, execSync, persistObservedVersion } = makeUpdater({
      pinned: { claude: '2.1.223' },
      exec: (command) => {
        if (command === 'claude --version') {
          return healthy ? ok('2.1.223 (Claude Code)') : fail('Bus error', 135);
        }
        healthy = true;
        return ok('added 1 package');
      },
    });
    const result = await updater.updateBeforeSleep(TARGET);

    expect(result).toEqual({ outcome: 'updated', installedVersion: '2.1.223' });
    expect(execSync.mock.calls.map((call) => call[1])).toEqual([
      'claude --version',
      'npm install -g @anthropic-ai/claude-code@2.1.223 && sync',
      'claude --version',
    ]);
    expect(persistObservedVersion).toHaveBeenCalledWith(expect.objectContaining({ version: '2.1.223' }));
  });

  it('flushes to disk in the same command as the install', async () => {
    // The reaper stops the machine within a second of this returning, and the
    // verification below reads the fresh binary back from the page cache — so
    // an unflushed write passes every check we make and is truncated by the
    // halt anyway. `sync` is the only thing standing between a 277 MB install
    // and a 112 MiB fragment.
    const { updater, execSync } = makeUpdater({
      pinned: { claude: '2.1.223' },
      exec: (command) => (command === 'claude --version' ? ok('2.1.219') : ok('added 1 package')),
    });
    await updater.updateBeforeSleep(TARGET);

    const install = execSync.mock.calls.map((call) => String(call[1])).find((c) => c.startsWith('npm install'));
    expect(install).toMatch(/&& sync$/);
  });

  it('never throws when exec itself rejects', async () => {
    const updater = new HarnessCliUpdater({
      execSync: vi.fn().mockRejectedValue(new Error('tunnel down')),
      getPinnedVersions: async () => ({ claude: '2.1.223' }),
      persistObservedVersion: vi.fn(),
    });
    // A machine we cannot reach at all reports the failed repair, not a
    // mystery: either way the next sweep retries, and nothing throws.
    await expect(updater.updateBeforeSleep(TARGET)).resolves.toEqual({ outcome: 'install-failed' });
  });
  it('stands down when another caller is already installing on the same machine', async () => {
    // The 2026-09-11 collision: the pre-sleep sweep is installing, and the
    // Mini App's Update button arrives mid-install. The button's own version
    // check cannot get an answer out of a CLI being replaced, so without this
    // lock it concludes "broken" and starts a SECOND npm install into the same
    // global prefix — which is what left a half-written package behind.
    let startInstall: () => void = () => {};
    let finishInstall: () => void = () => {};
    const installStarted = new Promise<void>((resolve) => { startInstall = resolve; });
    const installHeld = new Promise<void>((resolve) => { finishInstall = resolve; });

    const { updater, execSync } = makeUpdater({
      pinned: { claude: '2.1.223' },
      exec: async (command) => {
        if (command === 'claude --version') return ok('2.1.219 (Claude Code)');
        startInstall();
        await installHeld;
        return ok('added 1 package');
      },
    });

    const sweep = updater.updateBeforeSleep(TARGET);
    await installStarted;

    const button = await updater.updateBeforeSleep(TARGET);
    expect(button).toEqual({ outcome: 'already-updating' });
    // The decisive assertion: exactly ONE install command reached the machine.
    const installs = () => execSync.mock.calls
      .map((call) => String(call[1]))
      .filter((command) => command.startsWith('npm install'));
    expect(installs()).toHaveLength(1);

    finishInstall();
    await sweep;

    expect(installs()).toHaveLength(1);
    // The lock is released, so a later caller is free again.
    expect(updater.isInstalling(SANDBOX_ID)).toBe(false);
  });

  it('hands out the install in flight on a machine, settled when it is over — whatever its outcome (2026-10-15)', async () => {
    // A turn arriving mid-install waits on this before it starts the CLI.
    let startInstall: () => void = () => {};
    let finishInstall: (result: ExecSyncResult) => void = () => {};
    const installStarted = new Promise<void>((resolve) => { startInstall = resolve; });
    const { updater } = makeUpdater({
      pinned: { claude: '2.1.300' },
      exec: (command) => {
        if (command === 'claude --version') return ok('2.1.293 (Claude Code)');
        startInstall();
        return new Promise<ExecSyncResult>((resolve) => { finishInstall = resolve; });
      },
    });

    expect(updater.installInFlight(SANDBOX_ID)).toBeUndefined();
    const sweep = updater.updateBeforeSleep(TARGET);
    // Held from the version read on, before npm has started.
    expect(updater.installInFlight(SANDBOX_ID)).toBeInstanceOf(Promise);
    await installStarted;
    const install = updater.installInFlight(SANDBOX_ID);
    expect(install).toBeInstanceOf(Promise);
    expect(updater.installInFlight('fly-sandbox-ia-other.cc33')).toBeUndefined();
    let settled = false;
    void install!.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // npm fails: the install is still over, and a waiting turn goes on.
    finishInstall(fail('ETARGET'));
    await expect(sweep).resolves.toEqual({ outcome: 'install-failed', installedVersion: '2.1.293' });
    await install;
    expect(settled).toBe(true);
    expect(updater.installInFlight(SANDBOX_ID)).toBeUndefined();
  });

  it('clears a half-written package when the repair install cannot rename it aside', async () => {
    // Rosa's machine, 2026-09-11: `codex --version` dead, and every reinstall
    // stopped with ENOTEMPTY because npm must move the damaged directory out
    // of the way first. The repair retried every idle cycle for 34 minutes and
    // could never have succeeded — it needed the wreckage cleared.
    const commands: string[] = [];
    let repaired = false;
    const { updater } = makeUpdater({
      pinned: { claude: '2.1.223' },
      exec: (command) => {
        commands.push(command);
        if (command === 'claude --version') {
          return repaired ? ok('2.1.223 (Claude Code)') : fail('cannot execute');
        }
        if (command.startsWith('rm -rf')) {
          repaired = true;
          return ok('');
        }
        return repaired
          ? ok('added 1 package')
          : fail("npm error code ENOTEMPTY\nnpm error syscall rename\nnpm error ENOTEMPTY: directory not empty, rename '/usr/lib/node_modules/@anthropic-ai/claude-code' -> '/usr/lib/node_modules/@anthropic-ai/.claude-code-XCNbUSl9'", 217);
      },
    });

    const result = await updater.updateBeforeSleep(TARGET);

    expect(result).toEqual({ outcome: 'updated', installedVersion: '2.1.223' });
    const clear = commands.find((c) => c.startsWith('rm -rf'));
    // Narrow on purpose: the package directory and npm's own staging siblings,
    // nothing else under the global prefix.
    expect(clear).toBe(
      'rm -rf /usr/lib/node_modules/@anthropic-ai/claude-code'
      + ' /usr/lib/node_modules/@anthropic-ai/.claude-code-*',
    );
    expect(commands.filter((c) => c.startsWith('npm install'))).toHaveLength(2);
  });

  it('does not clear anything when a WORKING CLI is merely being upgraded', async () => {
    // The guard that keeps the rm -rf away from a healthy install: this CLI
    // answers --version, so a failing upgrade is a failing upgrade — reported,
    // retried next sweep, never "repaired" by deleting it.
    const commands: string[] = [];
    const { updater } = makeUpdater({
      pinned: { claude: '2.1.223' },
      exec: (command) => {
        commands.push(command);
        if (command === 'claude --version') return ok('2.1.219 (Claude Code)');
        return fail('npm error code ENOTEMPTY\nnpm error syscall rename', 217);
      },
    });

    const result = await updater.updateBeforeSleep(TARGET);

    expect(result).toEqual({ outcome: 'install-failed', installedVersion: '2.1.219' });
    expect(commands.some((c) => c.startsWith('rm -rf'))).toBe(false);
  });
});
