import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DetachedTurnTerminationError,
  TURN_OUTPUT_DIR,
  TURN_OUTPUT_PREFIX,
  TURN_INPUT_KEEPER_MAX_SECONDS,
  TurnOutputReader,
  buildTurnOutputPath,
  closeTurnInput,
  killDetachedTurn,
  killDetachedTurnUntilGone,
  inspectDetachedTurn,
  terminateDetachedTurnBeforeRestart,
  redactHarnessSecrets,
  redirectCommandToTurnOutput,
  probeDetachedTurn,
  probeDetachedTurnUntilKnown,
  startDetachedTurn,
  writeTurnInput,
} from '../../agent/harness-turn-output.js';
import {
  FakeWorkspaceRuntimeClient,
  makeExecSyncResult,
} from '../mocks/fake-workspace-runtime-client.js';

/**
 * Backs the fake execSync with a mutable raw file content string, answering
 * `tail -n +N` byte-for-byte like the real tail (including a missing trailing
 * newline on a partially written last line).
 */
function setupReader(initialContent = '') {
  const client = new FakeWorkspaceRuntimeClient();
  const state = {
    content: initialContent,
    failNextRead: false,
  };
  client.execSyncHandler = (command) => {
    const match = /^tail -n \+(\d+)/.exec(command);
    if (!match) return makeExecSyncResult();
    if (state.failNextRead) {
      state.failNextRead = false;
      throw new Error('ssh hiccup');
    }
    const from = Number(match[1]) - 1;
    const stdout = state.content.split('\n').slice(from).join('\n');
    return makeExecSyncResult({ stdout });
  };
  const reader = new TurnOutputReader(client, 'sb-1', buildTurnOutputPath(), 'agent');
  return { client, state, reader };
}

describe('redirectCommandToTurnOutput', () => {
  it('wraps the command in a brace group redirected into the turn file', () => {
    const path = `${TURN_OUTPUT_DIR}/abc.jsonl`;
    expect(redirectCommandToTurnOutput("codex mcp add x >/dev/null 2>&1; codex exec 'go'", path)).toBe(
      `umask 077; { codex mcp add x >/dev/null 2>&1; codex exec 'go'; } > '${path}' < /dev/null; __harness_exit=$?; exit "$__harness_exit"`,
    );
  });
});

describe('buildTurnOutputPath', () => {
  it('mints unique jsonl paths under the turn-output dir', () => {
    const first = buildTurnOutputPath();
    expect(first).toMatch(new RegExp(`^${TURN_OUTPUT_DIR}/${TURN_OUTPUT_PREFIX}[0-9a-f-]+\\.jsonl$`));
    expect(buildTurnOutputPath()).not.toBe(first);
  });
});

describe('redactHarnessSecrets', () => {
  it('removes every occurrence of known runtime secrets', () => {
    expect(redactHarnessSecrets('token-a then token-b then token-a', ['token-a', undefined, 'token-b']))
      .toBe('[REDACTED] then [REDACTED] then [REDACTED]');
  });
});

describe('TurnOutputReader', () => {
  it('returns complete lines and defers a partially written last line', async () => {
    const { state, reader } = setupReader('{"a":1}\n{"b":');

    expect(await reader.readNewLines()).toEqual(['{"a":1}']);

    // The partial line completes and another partial begins.
    state.content = '{"a":1}\n{"b":2}\n{"c":3';
    expect(await reader.readNewLines()).toEqual(['{"b":2}']);

    // Nothing new: the partial line stays deferred.
    expect(await reader.readNewLines()).toEqual([]);

    // On the final drain the file cannot grow, so the trailing line counts.
    expect(await reader.readNewLines({ final: true })).toEqual(['{"c":3']);
  });

  it('polls with advancing line offsets against its own path', async () => {
    const { client, state, reader } = setupReader('one\ntwo\n');
    await reader.readNewLines();
    state.content = 'one\ntwo\nthree\n';
    await reader.readNewLines();

    const tails = client.execSyncCalls.map((call) => call.command);
    expect(tails[0]).toBe(`tail -n +1 '${reader.outputPath}' 2>/dev/null || true`);
    expect(tails[1]).toBe(`tail -n +3 '${reader.outputPath}' 2>/dev/null || true`);
    // Reads run as the same user that wrote the file.
    expect(client.execSyncCalls.every((call) => call.sshUser === 'agent')).toBe(true);
  });

  it('absorbs a transient read failure without losing lines', async () => {
    const { state, reader } = setupReader('{"a":1}\n');
    state.failNextRead = true;

    expect(await reader.readNewLines()).toEqual([]);
    // The offset is unchanged, so the retry re-reads the same lines.
    expect(await reader.readNewLines()).toEqual(['{"a":1}']);
  });

  it('propagates a failure on the final drain', async () => {
    const { state, reader } = setupReader('{"a":1}\n');
    state.failNextRead = true;
    await expect(reader.readNewLines({ final: true })).rejects.toThrow('ssh hiccup');
  });

  it('does not advance the final-drain offset when SSH resolves with a timeout', async () => {
    const { client, reader } = setupReader('{"thread":"late"}\n');
    const answer = client.execSyncHandler;
    let timedOut = true;
    client.execSyncHandler = (command) => {
      if (timedOut) {
        timedOut = false;
        return makeExecSyncResult({
          stdout: '{"thread":"truncated',
          exitCode: 124,
          timedOut: true,
        });
      }
      return answer(command);
    };

    await expect(reader.readNewLines({ final: true })).rejects.toThrow('timed out');
    expect(reader.linesConsumed).toBe(0);
    expect(await reader.readNewLines({ final: true })).toEqual(['{"thread":"late"}']);
  });

  it('treats a resolved status timeout as transient without consuming partial output', async () => {
    const { client, reader } = setupReader('{"event":"complete"}\n');
    const answer = client.execSyncHandler;
    let timedOut = true;
    client.execSyncHandler = (command) => {
      if (timedOut) {
        timedOut = false;
        return makeExecSyncResult({
          stdout: '{"event":"partial',
          stderr: '__RUNNING__\n',
          exitCode: 124,
          timedOut: true,
        });
      }
      return answer(command);
    };

    expect(await reader.readNewLinesWithStatus()).toEqual({ lines: [], running: true, exitCode: null });
    expect(reader.linesConsumed).toBe(0);
    expect(await reader.readNewLinesWithStatus()).toEqual({
      lines: ['{"event":"complete"}'],
      running: true,
      exitCode: null,
    });
  });

  it('retires the launch key atomically while removing turn data, swallowing failures', async () => {
    const { client, reader } = setupReader();
    await reader.cleanup();
    expect(client.execSyncCalls.at(-2)?.command).toBe(
      `exec 9> '${reader.outputPath}.launch'; flock -w 15 9 || exit 1; touch '${reader.outputPath}.cancel' || exit 1; flock -u 9; exec 9>&-`,
    );
    expect(client.execSyncCalls.at(-1)?.command).toBe(
      `rm -f '${reader.outputPath}' '${reader.outputPath}.stderr' '${reader.outputPath}.exit' '${reader.outputPath}.pid' '${reader.outputPath}.sh' '${reader.outputPath}.in' '${reader.outputPath}.in.keeper'`,
    );

    client.execSyncHandler = (command) => {
      if (command.startsWith('rm -f ')) throw new Error('gone');
      return makeExecSyncResult();
    };
    await expect(reader.cleanup()).resolves.toBeUndefined();
  });
});


describe('detached turn lifecycle', () => {
  // These two run the GENERATED COMMANDS through a real shell against a real
  // FIFO, because asserting on fragments of a command string is what let a
  // quoting bug ship: the JSON payload's own double quotes closed the
  // `sh -c "..."` wrapper it sat inside, the shell ate them, and the CLI was
  // handed `{type:user,...}` — not JSON. The string still "contained" every
  // fragment the old test looked for (dev, 2026-08-12).
  describe('against a real shell and a real FIFO', () => {
    // Every shell hazard in one payload: the double quotes that broke it, an
    // apostrophe, `$HOME`, and a backtick command substitution.
    const message = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"it\'s $HOME `date` \\"quoted\\""}]}}';

    /** Run a generated writer command against a real FIFO; return what a reader saw. */
    function throughFifo(writer: (fifo: string) => string): string {
      const dir = mkdtempSync(join(tmpdir(), 'turn-input-'));
      try {
        const fifo = join(dir, 'in');
        const out = join(dir, 'out');
        execFileSync('bash', ['-c', [
          // The reader waits for the pipe to exist, because the launch script
          // creates it itself — a `cat` that started first would fail and leave
          // the writer blocked on an open with no reader.
          `( while [ ! -p '${fifo}' ]; do sleep 0.05; done; timeout 5 cat '${fifo}' > '${out}' ) &`,
          'sleep 0.1',
          writer(fifo),
          'wait',
        ].join('\n')], { stdio: 'ignore', timeout: 20_000 });
        return readFileSync(out, 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('the launch script delivers the first message byte-for-byte', async () => {
      const client = new FakeWorkspaceRuntimeClient();
      client.execSyncHandler = () => makeExecSyncResult({ stdout: '31337\n' });
      let script = '';

      const got = throughFifo((fifo) => {
        void startDetachedTurn(client, 'sb-1', 'true', '/tmp/turn.jsonl', {
          input: { path: fifo, firstMessage: message },
        });
        // Run the launcher's own input setup verbatim, with the keeper's
        // two-hour hold shortened.
        script = client.execSyncCalls.at(-1)!.command
          .split('\n')
          .filter((line) => line.startsWith('mkfifo') || line.startsWith('{ printf'))
          .join('\n')
          .replace(/exec sleep \d+/, 'exec sleep 1');
        return script;
      });

      expect(script).toContain('mkfifo');
      expect(got).toBe(`${message}\n`);
      expect(JSON.parse(got)).toMatchObject({ type: 'user' });
    });

    it('writeTurnInput delivers a mid-turn message byte-for-byte', () => {
      const client = new FakeWorkspaceRuntimeClient();
      let generated = '';
      client.execSyncHandler = (command) => { generated = command; return makeExecSyncResult(); };

      const got = throughFifo((fifo) => {
        void writeTurnInput(client, 'sb-1', fifo, message, 'agent');
        return `mkfifo '${fifo}'\n${generated}`;
      });

      expect(got).toBe(`${message}\n`);
      expect(JSON.parse(got)).toMatchObject({ type: 'user' });
    });
  });

  it('with an input pipe: makes the FIFO, holds it open, and reads stdin from it', async () => {
    // A FIFO reader sees EOF when the LAST writer closes, so without a keeper
    // the CLI would read EOF the moment the first message was written and stop
    // accepting input — which is the whole feature.
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '31337\n' });

    await startDetachedTurn(client, 'sb-1', 'claude -p', '/tmp/turn.jsonl', {
      sshUser: 'agent',
      input: { path: '/tmp/turn.jsonl.in', firstMessage: '{"hello":"world"}' },
    });

    const command = client.execSyncCalls[0]!.command;
    expect(command).toContain("mkfifo '/tmp/turn.jsonl.in'");
    // The keeper writes the first message and then holds the pipe open. `exec`
    // is load-bearing: without it the recorded pid is the subshell, and killing
    // it would leave `sleep` holding the write end so the CLI never sees EOF.
    expect(command).toContain(`exec sleep ${TURN_INPUT_KEEPER_MAX_SECONDS}; } > '/tmp/turn.jsonl.in' &`);
    expect(command).toContain('| base64 -d;');
    expect(command).toContain("echo $! > '/tmp/turn.jsonl.in.keeper'");
    // stdin comes from the pipe, NOT /dev/null.
    expect(command).toContain("{ claude -p; } > '/tmp/turn.jsonl' < '/tmp/turn.jsonl.in'");
    expect(command).not.toContain("> '/tmp/turn.jsonl' < /dev/null");
  });

  it('without an input pipe: stdin stays closed, exactly as before', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '31337\n' });

    await startDetachedTurn(client, 'sb-1', "claude -p 'go'", '/tmp/turn.jsonl', { sshUser: 'agent' });

    const command = client.execSyncCalls[0]!.command;
    expect(command).toContain("< /dev/null");
    expect(command).not.toContain('mkfifo');
  });

  it('writeTurnInput appends under a timeout, carries no shell metacharacters, and reports failure', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult();

    const ok = await writeTurnInput(client, 'sb-1', '/tmp/turn.jsonl.in', '{"text":"it\'s here"}', 'agent');

    expect(ok).toBe(true);
    const command = client.execSyncCalls[0]!.command;
    // Timeout-wrapped: opening a FIFO for writing blocks until a reader is
    // there, so a CLI that already exited must fail rather than hang.
    expect(command).toContain('timeout 5 sh -c');
    expect(command).toContain(`>> '/tmp/turn.jsonl.in'`);
    // The payload rides as base64 — alphanumerics plus `+/=` — so none of the
    // JSON's own quotes can close a wrapper around it, at any nesting depth.
    // (What broke this in dev was a raw payload inside `sh -c "..."`.)
    const payload = /printf %s (\S+)/.exec(command)![1]!;
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('{"text":"it\'s here"}\n');

    client.execSyncHandler = () => makeExecSyncResult({ exitCode: 1 });
    expect(await writeTurnInput(client, 'sb-1', '/tmp/turn.jsonl.in', '{}', 'agent')).toBe(false);
    client.execSyncHandler = () => { throw new Error('ssh gone'); };
    expect(await writeTurnInput(client, 'sb-1', '/tmp/turn.jsonl.in', '{}', 'agent')).toBe(false);
  });

  it('closeTurnInput kills the keeper — the only thing that ends a streamed turn', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult();

    await closeTurnInput(client, 'sb-1', '/tmp/turn.jsonl.in', 'agent');

    const command = client.execSyncCalls[0]!.command;
    expect(command).toContain(`kill "$(cat '/tmp/turn.jsonl.in.keeper' 2>/dev/null)"`);
    // Best-effort: a keeper that is already gone must not throw.
    client.execSyncHandler = () => { throw new Error('ssh gone'); };
    await expect(closeTurnInput(client, 'sb-1', '/tmp/turn.jsonl.in', 'agent')).resolves.toBeUndefined();
  });

  it('kills and waits for the whole detached process group before resolving', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult();

    await killDetachedTurn(client, 'sb-1', 31337, 'agent');

    const call = client.execSyncCalls[0]!;
    expect(call.command).toMatch(/^kill -TERM -- -31337/);
    // The command does not equate a successful signal send with exit: it
    // probes the process group through a grace period, escalates only if it is
    // still alive, then probes again and fails if death cannot be proven.
    expect(call.command.match(/kill -0 -- -31337/g)).toHaveLength(4);
    expect(call.command).toContain('kill -KILL -- -31337');
    expect(call.command).toContain('then exit 1; fi');
    expect(call.sshUser).toBe('agent');
  });

  it('fails closed when detached process exit cannot be verified', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ exitCode: 1 });

    await expect(killDetachedTurn(client, 'sb-1', 31337, 'agent'))
      .rejects.toBeInstanceOf(DetachedTurnTerminationError);

    client.execSyncHandler = () => { throw new Error('ssh timeout'); };
    await expect(killDetachedTurn(client, 'sb-1', 31337, 'agent'))
      .rejects.toMatchObject({
        name: 'DetachedTurnTerminationError',
        message: expect.stringContaining('Could not verify'),
      });
  });

  it('never interpolates an unresolved pid into a process-group signal', async () => {
    const client = new FakeWorkspaceRuntimeClient();

    await expect(killDetachedTurn(client, 'sb-1', 0, 'agent'))
      .rejects.toBeInstanceOf(DetachedTurnTerminationError);

    expect(client.execSyncCalls).toHaveLength(0);
  });

  it('retries a transient termination-verification failure before resolving', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeWorkspaceRuntimeClient();
      let attempts = 0;
      client.execSyncHandler = () => makeExecSyncResult({ exitCode: ++attempts === 1 ? 1 : 0 });
      const onRetry = vi.fn();

      const completion = killDetachedTurnUntilGone(client, 'sb-1', 31337, 'agent', onRetry);
      await vi.advanceTimersByTimeAsync(1_000);
      await completion;

      expect(attempts).toBe(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences the launch key before intentionally killing its process group', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult();

    await killDetachedTurnUntilGone(
      client,
      'sb-1',
      31337,
      'agent',
      undefined,
      '/tmp/turn.jsonl',
    );

    expect(client.execSyncCalls[0]?.command).toContain("touch '/tmp/turn.jsonl.cancel'");
    expect(client.execSyncCalls[1]?.command).toContain('kill -TERM -- -31337');
  });

  it('terminates a surviving process group after its leader has exited', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = (command) => {
      const result = spawnSync('bash', ['-c', [
        'group_alive=1',
        'kill() {',
        '  if [ "$1" = "-0" ]; then [ "$group_alive" = 1 ]; return; fi',
        '  group_alive=0',
        '  return 0',
        '}',
        command,
      ].join('\n')], { encoding: 'utf8', timeout: 5_000 });
      return makeExecSyncResult({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status ?? 1,
      });
    };

    // There is deliberately no /proc/987654 leader. The mocked negative-PGID
    // probe remains alive, which means children still own that original group
    // and the group must be signalled rather than quarantined forever.
    await expect(killDetachedTurn(
      client,
      'local',
      987654,
      'agent',
      '/tmp/leaderless-turn.jsonl',
    )).resolves.toBeUndefined();
    expect(client.execSyncCalls[0]?.command).toContain('kill -TERM -- -987654');
  });

  it('retries continuity persistence from the same offset before cleanup', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeWorkspaceRuntimeClient();
      client.execSyncHandler = (command) => {
        if (command.startsWith('if [ -f ')) return makeExecSyncResult({ stdout: 'running\n' });
        if (command.startsWith('tail -n +3 ')) {
          return makeExecSyncResult({ stdout: '{"type":"thread.started"}\n' });
        }
        return makeExecSyncResult();
      };
      const capture = vi.fn()
        .mockRejectedValueOnce(new Error('storage unavailable'))
        .mockResolvedValueOnce(undefined);

      const completion = terminateDetachedTurnBeforeRestart(client, 'run-1', {
        cli: 'codex', sandboxId: 'sb-1', outputPath: '/tmp/old.jsonl', pid: 31337,
        consumedLines: 2, deliveredMessageCount: 0,
      }, capture, 'agent');
      await vi.advanceTimersByTimeAsync(1_000);
      await completion;

      expect(capture).toHaveBeenCalledTimes(2);
      expect(capture).toHaveBeenNthCalledWith(1, ['{"type":"thread.started"}']);
      expect(capture).toHaveBeenNthCalledWith(2, ['{"type":"thread.started"}']);
      expect(client.execSyncCalls.at(-1)?.command).toContain("rm -f '/tmp/old.jsonl'");
    } finally {
      vi.useRealTimers();
    }
  });

  it('final-drains an already-finished durable turn without signaling a reused PID', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = (command) => {
      if (command.startsWith('if [ -f ')) return makeExecSyncResult({ stdout: 'finished\n' });
      if (command.startsWith('tail -n +1 ')) {
        return makeExecSyncResult({ stdout: '{"type":"thread.started"}\n' });
      }
      return makeExecSyncResult();
    };
    const capture = vi.fn().mockResolvedValue(undefined);

    await terminateDetachedTurnBeforeRestart(client, 'run-1', {
      cli: 'codex', sandboxId: 'sb-1', outputPath: '/tmp/finished.jsonl', pid: 31337,
      consumedLines: 0, deliveredMessageCount: 0,
    }, capture, 'agent');

    expect(client.execSyncCalls.some((call) => call.command.startsWith('kill -TERM'))).toBe(false);
    expect(capture).toHaveBeenCalledWith(['{"type":"thread.started"}']);
  });

  it('hydrates a provisional pid from the verified sidecar before terminating', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = (command) => {
      if (command.startsWith('if [ -f ')) {
        return makeExecSyncResult({ stdout: 'running:4242\n' });
      }
      return makeExecSyncResult();
    };

    await terminateDetachedTurnBeforeRestart(client, 'run-provisional', {
      cli: 'codex', sandboxId: 'sb-1', outputPath: '/tmp/provisional.jsonl', pid: 0,
      consumedLines: 0, deliveredMessageCount: 0,
    }, async () => {}, 'agent');

    const kill = client.execSyncCalls.find((call) => call.command.includes('kill -TERM -- -4242'));
    expect(kill?.command).toContain('kill -TERM -- -4242');
    expect(kill?.command).not.toContain('kill -TERM -- -0');
  });

  it('launches detached: setsid + sidecars, returns the pid', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '31337\n' });
    const handle = await startDetachedTurn(client, 'sb-1', "claude -p 'go'", '/tmp/turn.jsonl', {
      cwd: '/home/agent',
      sshUser: 'agent',
    });
    expect(handle.pid).toBe(31337);
    const call = client.execSyncCalls[0];
    expect(call.command).toContain('nohup setsid bash');
    expect(call.command).toContain("{ claude -p 'go'; } > '/tmp/turn.jsonl' < /dev/null 2> '/tmp/turn.jsonl.stderr'");
    expect(call.command).toContain("echo $? > '/tmp/turn.jsonl.exit'");
    expect(call.command).toContain("> '/tmp/turn.jsonl.pid'");
    expect(call.command).toContain("if ! cat > '/tmp/turn.jsonl.sh'");
    expect(call.command).toContain("echo \"$$\" > '/tmp/turn.jsonl.pid' ||");
    expect(call.command).toContain("exec 9> '/tmp/turn.jsonl.launch'");
    expect(call.command).toContain('if flock -w 10 9; then');
    expect(call.sshUser).toBe('agent');
    expect(call.cwd).toBe('/home/agent');
  });

  it('recovers the launched pid when the SSH acknowledgement is lost', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = (command) => {
      if (command.includes('nohup setsid')) throw new Error('response lost after launch');
      if (command.startsWith('if [ -f ')) {
        return makeExecSyncResult({ stdout: 'running:31337\n' });
      }
      return makeExecSyncResult();
    };

    await expect(startDetachedTurn(client, 'sb-1', 'claude', '/tmp/lost-ack.jsonl'))
      .resolves.toMatchObject({ pid: 31337 });
    expect(client.detachedLaunchCalls).toHaveLength(1);
  });

  it('keeps a resolved SSH timeout quarantined until its late sidecar appears', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeWorkspaceRuntimeClient();
      let probes = 0;
      client.execSyncHandler = (command) => {
        if (command.includes('nohup setsid')) {
          return makeExecSyncResult({ exitCode: 124, timedOut: true });
        }
        probes += 1;
        return makeExecSyncResult({ stdout: probes <= 3 ? 'gone\n' : 'running:9191\n' });
      };

      const completion = startDetachedTurn(client, 'sb-1', 'claude', '/tmp/timed-out-launch.jsonl');
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(completion).resolves.toMatchObject({ pid: 9191 });

      expect(client.detachedLaunchCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an uncertain launch on Stop without reissuing the old command', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    const controller = new AbortController();
    client.execSyncHandler = (command) => {
      if (command.includes('nohup setsid')) {
        controller.abort();
        return makeExecSyncResult({ exitCode: 124, timedOut: true });
      }
      if (command.startsWith('if [ -f ')) {
        return makeExecSyncResult({ stdout: 'gone\n' });
      }
      return makeExecSyncResult();
    };

    await expect(startDetachedTurn(
      client,
      'sb-1',
      'claude',
      '/tmp/cancelled-launch.jsonl',
      { signal: controller.signal },
    )).resolves.toEqual({
      outputPath: '/tmp/cancelled-launch.jsonl',
      pid: 0,
      alreadyFinished: true,
    });

    expect(client.detachedLaunchCalls).toHaveLength(1);
    expect(client.execSyncCalls.some((call) => (
      call.command.includes("touch '/tmp/cancelled-launch.jsonl.cancel'")
    ))).toBe(true);
  });

  it('the remote launch claim makes a transparent exec retry idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-launch-claim-'));
    try {
      const outputPath = join(dir, 'turn.jsonl');
      const countPath = join(dir, 'launch-count');
      const client = new FakeWorkspaceRuntimeClient();
      client.execSyncHandler = (command) => {
        if (!command.includes('nohup setsid')) return makeExecSyncResult();
        // Model Fly's connect retry: attempt one completed remotely but its
        // response was lost, so the exact non-idempotent command is invoked
        // once more. The second invocation must only return attempt one's PID.
        execFileSync('bash', ['-c', command], { encoding: 'utf8', timeout: 5_000 });
        const stdout = execFileSync('bash', ['-c', command], { encoding: 'utf8', timeout: 5_000 });
        return makeExecSyncResult({ stdout });
      };

      const handle = await startDetachedTurn(
        client,
        'local',
        `printf x >> '${countPath}'; sleep 0.2`,
        outputPath,
      );
      expect(handle.pid).toBeGreaterThan(0);
      execFileSync('bash', ['-c', `for _ in $(seq 1 50); do [ -f '${outputPath}.exit' ] && exit 0; sleep 0.05; done; exit 1`], {
        timeout: 5_000,
      });
      expect(readFileSync(countPath, 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the child launch fence when the parent times out before PID publication', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-slow-pid-'));
    try {
      const outputPath = join(dir, 'turn.jsonl');
      const countPath = join(dir, 'launch-count');
      const fakeBin = join(dir, 'bin');
      execFileSync('mkdir', ['-p', fakeBin]);
      const fakeSetsid = join(fakeBin, 'setsid');
      writeFileSync(fakeSetsid, '#!/bin/bash\nsleep 0.4\nexec /usr/bin/setsid "$@"\n');
      chmodSync(fakeSetsid, 0o755);

      const client = new FakeWorkspaceRuntimeClient();
      client.execSyncHandler = () => makeExecSyncResult({ stdout: '31337\n' });
      await startDetachedTurn(
        client,
        'local',
        `printf x >> '${countPath}'; sleep 0.2`,
        outputPath,
      );
      const launch = client.execSyncCalls[0]!.command
        // Make the regression fast: the parent gives up after 100ms, while
        // the inherited child does not publish its PID for 400ms.
        .replaceAll('[ "$__harness_wait" -lt 100 ]', '[ "$__harness_wait" -lt 1 ]');
      const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` };

      const first = spawnSync('bash', ['-c', launch], { encoding: 'utf8', env, timeout: 5_000 });
      expect(first.status).toBe(75);
      const second = spawnSync('bash', ['-c', launch], { encoding: 'utf8', env, timeout: 5_000 });
      expect(second.status).toBe(0);
      expect(Number.parseInt(second.stdout.trim(), 10)).toBeGreaterThan(0);
      execFileSync('bash', ['-c', `for _ in $(seq 1 50); do [ -f '${outputPath}.exit' ] && exit 0; sleep 0.05; done; exit 1`], {
        timeout: 5_000,
      });
      expect(readFileSync(countPath, 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not mistake the probe shell itself for a nonexistent turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-probe-'));
    try {
      const client = new FakeWorkspaceRuntimeClient();
      client.execSyncHandler = (command) => makeExecSyncResult({
        // Point the stale sidecar at the executing probe shell. Substring
        // matching would see the path inside this shell's `-c` argument and
        // mistake the probe itself for the detached CLI; exact argv matching
        // must classify it gone.
        stdout: execFileSync('bash', ['-c', `echo $$ > '${join(dir, 'missing.jsonl.pid')}'; ${command}`], {
          encoding: 'utf8', timeout: 5_000,
        }),
      });

      await expect(inspectDetachedTurn(client, 'local', join(dir, 'missing.jsonl')))
        .resolves.toEqual({ state: 'gone' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a leaderless but live process group as running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-leaderless-group-'));
    try {
      const outputPath = join(dir, 'turn.jsonl');
      writeFileSync(`${outputPath}.pid`, '987654\n');
      const client = new FakeWorkspaceRuntimeClient();
      client.execSyncHandler = (command) => {
        const result = spawnSync('bash', ['-c', [
          'kill() { [ "$1" = "-0" ]; }',
          command,
        ].join('\n')], { encoding: 'utf8', timeout: 5_000 });
        return makeExecSyncResult({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status ?? 1,
        });
      };

      await expect(inspectDetachedTurn(client, 'local', outputPath))
        .resolves.toEqual({ state: 'running', pid: 987654 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports the turn environment inside the script, ahead of the command', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '31337\n' });

    await startDetachedTurn(client, 'sb-1', "claude -p 'go'", '/tmp/turn.jsonl', {
      cwd: '/home/agent',
      sshUser: 'agent',
      env: { GH_TOKEN: 'ghp_abc', OPENAI_API_KEY: 'sk-xyz' },
    });

    const { command } = client.execSyncCalls[0];
    expect(command).toContain("export GH_TOKEN='ghp_abc'");
    expect(command).toContain("export OPENAI_API_KEY='sk-xyz'");
    // Before the command, or the CLI would not inherit them.
    expect(command.indexOf("export GH_TOKEN='ghp_abc'")).toBeLessThan(command.indexOf('{ claude -p'));
    // Inside the script body, not on the launch line — otherwise the values
    // would be visible in `ps` to anything else on the machine.
    expect(command).not.toContain("nohup setsid bash '/tmp/turn.jsonl.sh' GH_TOKEN");
  });

  it('writes the script under umask 077 with a quoted heredoc, so a value cannot expand', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '1\n' });

    await startDetachedTurn(client, 'sb-1', 'claude', '/tmp/turn.jsonl', {
      env: { EVIL: '$(rm -rf /)' },
    });

    const { command } = client.execSyncCalls[0];
    expect(command.startsWith('umask 077')).toBe(true);
    // The delimiter is single-quoted, which is what stops the shell expanding
    // the heredoc body as it writes it.
    expect(command).toMatch(/cat > '\/tmp\/turn\.jsonl\.sh' <<'HARNESS_TURN_[0-9a-f]+'/);
    expect(command).toContain("export EVIL='$(rm -rf /)'");
  });

  it('launches unchanged when no environment is supplied', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    client.execSyncHandler = () => makeExecSyncResult({ stdout: '7\n' });

    await startDetachedTurn(client, 'sb-1', 'claude', '/tmp/turn.jsonl', {});

    expect(client.execSyncCalls[0].command).not.toContain('export ');
  });

  it('probe distinguishes authoritative states from transport uncertainty', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    for (const [reply, expected] of [['finished', 'finished'], ['running', 'running'], ['gone', 'gone'], ['garbage', 'unknown']] as const) {
      client.execSyncHandler = () => makeExecSyncResult({ stdout: `${reply}\n` });
      expect(await probeDetachedTurn(client, 'sb-1', '/tmp/turn.jsonl')).toBe(expected);
    }
    client.execSyncHandler = () => { throw new Error('machine waking'); };
    expect(await probeDetachedTurn(client, 'sb-1', '/tmp/turn.jsonl')).toBe('unknown');
  });

  it('retries an uncertain attach probe instead of authorizing a relaunch', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeWorkspaceRuntimeClient();
      let probes = 0;
      client.execSyncHandler = () => {
        probes += 1;
        if (probes === 1) throw new Error('machine waking');
        return makeExecSyncResult({ stdout: 'running\n' });
      };
      const onRetry = vi.fn();

      const completion = probeDetachedTurnUntilKnown(
        client, 'sb-1', '/tmp/turn.jsonl', 'agent', undefined, onRetry,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(completion).resolves.toBe('running');
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('combined poll reads lines on stdout and liveness on stderr, resuming from an offset', async () => {
    const client = new FakeWorkspaceRuntimeClient();
    // Attach at line 2: only the tail from line 3 comes back, already finished.
    client.execSyncHandler = (command) => {
      expect(command).toContain("tail -n +3 '/tmp/turn.jsonl'");
      return makeExecSyncResult({ stdout: '{"a":3}\n{"a":4}\n', stderr: '0\n' });
    };
    const reader = new TurnOutputReader(client, 'sb-1', '/tmp/turn.jsonl', 'agent', 2);
    const poll = await reader.readNewLinesWithStatus();
    expect(poll.running).toBe(false);
    expect(poll.exitCode).toBe(0);
    expect(poll.lines).toEqual(['{"a":3}', '{"a":4}']);
    expect(reader.linesConsumed).toBe(4);
  });
});
