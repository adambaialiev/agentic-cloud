import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SshClient,
  collectTerminalDeviceResponseBytes,
  renderTerminalOutputForSnapshot,
} from '../../services/ssh-client.js';

describe('SshClient terminal device responses', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers cursor position report requests with the configured terminal size', () => {
    const result = collectTerminalDeviceResponseBytes(
      '\x1b7\x1b[999;999f\x1b[6n',
      '',
      30,
      120,
    );

    expect(result.responseBytes).toBe('\x1b[30;120R');
  });

  it('answers cursor position requests split across output chunks', () => {
    const first = collectTerminalDeviceResponseBytes('\x1b[6', '', 24, 80);
    const second = collectTerminalDeviceResponseBytes('n', first.nextTail, 24, 80);

    expect(first.responseBytes).toBe('');
    expect(second.responseBytes).toBe('\x1b[24;80R');
  });

  it('does not answer the same buffered cursor position request twice', () => {
    const first = collectTerminalDeviceResponseBytes('\x1b[6n', '', 24, 80);
    const second = collectTerminalDeviceResponseBytes('prompt', first.nextTail, 24, 80);

    expect(first.responseBytes).toBe('\x1b[24;80R');
    expect(second.responseBytes).toBe('');
  });

  it('renders ANSI cursor addressing and SGR output into a clean screen snapshot', () => {
    const screen = renderTerminalOutputForSnapshot(
      [
        'root@host:~$ vim notes.txt',
        '\x1b[?1049h',
        '\x1b[2J',
        '\x1b[1;1HHello',
        '\x1b[2;5H\x1b[1m-- INSERT --\x1b[m',
        '\x1b[3;7H',
      ].join(''),
      { rows: 4, cols: 20 },
    );

    expect(screen.altBuffer).toBe(true);
    expect(screen.cursor).toEqual({ row: 3, col: 7 });
    expect(screen.output).toEqual([
      'Hello',
      '    -- INSERT --',
      '',
      '',
    ]);
  });

  it('clears the alternate buffer so pre-TUI shell noise does not leak into the rendered screen', () => {
    const screen = renderTerminalOutputForSnapshot(
      'MOTD\nroot@host:~$\x1b[?1049h\x1b[1;1H\x1b[47mW\x1b[m\x1b[2;1H-- VISUAL LINE --',
      { rows: 3, cols: 24 },
    );

    expect(screen.output.join('\n')).not.toContain('MOTD');
    expect(screen.output).toEqual([
      'W',
      '-- VISUAL LINE --',
      '',
    ]);
  });

  it('adds a small delay between direct SSH input events', async () => {
    vi.useFakeTimers();

    const client = new SshClient();
    const write = vi.fn();
    const rows = 24;
    const cols = 80;
    const now = Date.now();
    (client as any).sessions.set('ssh_input_delay', {
      sessionId: 'ssh_input_delay',
      conn: {},
      channel: { write },
      host: '203.0.113.10',
      port: 22,
      username: 'root',
      cols,
      rows,
      revision: 1,
      status: 'running',
      exitCode: null,
      rawOutput: '',
      renderer: {
        cols,
        rows,
        altBuffer: false,
        cursorRow: 0,
        cursorCol: 0,
        savedCursorRow: 0,
        savedCursorCol: 0,
        scrollTop: 0,
        scrollBottom: rows - 1,
        buffer: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' ')),
        pendingInput: '',
      },
      lastActivityAt: now,
      lastOutputAt: now,
      outputRevision: 0,
      lastDeliveredRawLength: 0,
      terminalResponseTail: '',
    });

    const input = client.sendInput(
      'ssh_input_delay',
      [
        { type: 'text', text: 'first' },
        { type: 'key', key: 'enter' },
        { type: 'text', text: 'second' },
      ],
      { quietForMs: 0 },
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenNthCalledWith(1, 'first');

    await vi.advanceTimersByTimeAsync(49);
    expect(write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, '\r');

    await vi.advanceTimersByTimeAsync(50);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenNthCalledWith(3, 'second');

    await expect(input).resolves.toMatchObject({
      sessionId: 'ssh_input_delay',
      revision: 2,
    });
  });

  it('starts durable tmux sessions and parses captured pane snapshots', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'root@host:/app# npm test',
            'passing',
            marker,
            'dead=0;dead_status=;width=140;height=40;cursor_x=5;cursor_y=3;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      {
        cwd: '/app',
        command: 'npm test',
        cols: 140,
        rows: 40,
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_abc123',
    );

    expect(execCommand).toHaveBeenCalledTimes(3);
    expect(execCommand.mock.calls[0][1]).toContain('tmux list-sessions');
    expect(execCommand.mock.calls[1][1]).toContain('tmux new-session -d');
    expect(execCommand.mock.calls[1][1]).toContain('ssh_tmux_d505_abc123');
    expect(execCommand.mock.calls[1][1]).toContain('-x 140 -y 40');
    expect(execCommand.mock.calls[1][1]).toMatch(/-e COLUMNS=.*240/);
    expect(execCommand.mock.calls[1][1]).toContain('/app');
    expect(execCommand.mock.calls[1][1]).toContain('tmux load-buffer');
    expect(result).toMatchObject({
      sessionId: 'ssh_tmux_d505_abc123',
      revision: 1,
      status: 'running',
      exitCode: null,
      screen: {
        cols: 140,
        rows: 40,
        cursor: { row: 4, col: 6 },
        output: [
          'root@host:/app# npm test',
          'passing',
        ],
      },
    });
  });

  it('falls back to a user-owned tmux socket directory when the default one is unusable', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    await client.cleanupDeadTmuxSessions(
      {
        host: '203.0.113.10',
        username: 'agent',
        privateKey: 'key',
      },
      { force: true },
    );

    const command = execCommand.mock.calls[0][1];
    const setupIndex = command.indexOf('__ia_tmux_default_dir="${__ia_tmux_base%/}/tmux-${__ia_tmux_uid}"');
    const tmuxIndex = command.indexOf('tmux list-sessions');
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeLessThan(tmuxIndex);
    expect(command).toContain('[ -O "$__ia_tmux_default_dir" ]');
    expect(command).toContain('[ -w "$__ia_tmux_default_dir" ]');
    expect(command).toContain('__ia_tmux_fallback_base="$__ia_tmux_home/.cache/infinite-agents/tmux"');
    expect(command).toContain('export TMUX_TMPDIR="$__ia_tmux_fallback_base"');
  });

  it('uses a durable tmux command timeout for input and snapshot reads', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'codex prompt',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.sendTmuxInput(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_abc123',
      [{ type: 'key', key: 'enter' }],
    );

    const command = execCommand.mock.calls[0][1];
    expect(command).toContain('tmux send-keys -t');
    expect(command).toContain('ssh_tmux_d505_abc123');
    expect(command).toContain('Enter');
    expect(command).not.toContain('tmux paste-buffer');
    expect(execCommand.mock.calls[0][2]).toEqual({ timeoutMs: 60_000 });
    expect(execCommand.mock.calls[1][2]).toEqual({ timeoutMs: 60_000 });
  });

  it('does not let short repaint timeouts shorten tmux control command deadlines', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'codex prompt',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_abc123',
      { quietForMs: 300, timeoutMs: 5_000 },
    );

    expect(execCommand.mock.calls[0][2]).toEqual({ timeoutMs: 60_000 });
  });

  it('makes durable tmux starts idempotent when the same session already exists', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'existing codex session',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      {
        command: 'codex',
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_existing',
    );

    const startCommand = execCommand.mock.calls[1][1];
    expect(startCommand).toContain('if tmux has-session -t');
    expect(startCommand).toContain('__ia_existing_session=1');
    expect(startCommand).not.toContain('tmux session already exists');
    expect(startCommand).toContain('-x 240 -y 30 -e COLUMNS=');
    expect(startCommand).toMatch(/-e COLUMNS=.*240/);
    expect(startCommand).toContain('if [ "${__ia_existing_session:-0}" != "1" ]; then');
    expect(result.screen.output).toContain('existing codex session');
  });

  it('kills a newly-created tmux session when start fails after creation', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('tmux new-session')) {
        return {
          stdout: '__IA_TMUX_EXISTING_SESSION=0\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      if (command.includes('tmux kill-session')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: 'tmux capture failed',
        exitCode: 1,
        timedOut: false,
      };
    });

    await expect(client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      {
        command: 'codex',
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_sagent123_abc123',
    )).rejects.toThrow('tmux capture failed');

    expect(execCommand.mock.calls.some(([, command]) => command.includes('tmux kill-session'))).toBe(true);
  });

  it('kills a created tmux session when the initial read fails without the final start marker', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('tmux new-session')) {
        return {
          stdout: '__IA_TMUX_CREATED_SESSION=1\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      if (command.includes('tmux kill-session')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      if (command.includes('capture-pane')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 1,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await expect(client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'agent',
        privateKey: 'key',
      },
      {
        command: 'codex',
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_uYWdlbnQ_readfail',
    )).rejects.toThrow('tmux session ssh_tmux_d505_uYWdlbnQ_readfail started but initial read failed');

    expect(execCommand.mock.calls.some(([, command]) => (
      command.includes('tmux kill-session') && command.includes('ssh_tmux_d505_uYWdlbnQ_readfail')
    ))).toBe(true);
  });

  it('treats a tmux start script injection failure as success once the session exists', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('tmux list-sessions')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      if (command.includes('tmux new-session')) {
        return {
          stdout: '__IA_TMUX_EXISTING_SESSION=0\n',
          stderr: 'tmux paste-buffer failed',
          exitCode: 1,
          timedOut: false,
        };
      }
      if (command.includes('tmux kill-session')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await expect(client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'agent',
        privateKey: 'key',
      },
      {
        command: 'codex',
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_uYWdlbnQ_abc123',
    )).resolves.toMatchObject({
      sessionId: 'ssh_tmux_d505_uYWdlbnQ_abc123',
      status: 'running',
    });

    const startCommand = execCommand.mock.calls.find(([, command]) => command.includes('tmux new-session'))?.[1] ?? '';
    expect(startCommand).toContain('__IA_TMUX_CREATED_SESSION=1');
    expect(startCommand.indexOf('tmux paste-buffer')).toBeLessThan(startCommand.lastIndexOf('__IA_TMUX_EXISTING_SESSION='));
    expect(startCommand).toContain('tmux session exited before command could be sent');
  });

  it('wraps tmux new-session so a silent failure reports the remote user and cwd instead of a bare exit code', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('tmux new-session')) {
        return {
          stdout: '__IA_TMUX_EXISTING_SESSION=0\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'agent',
        privateKey: 'key',
      },
      {
        cwd: '/home/agent',
        command: 'claude',
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_uYWdlbnQ_def456',
    );

    const startCommand = execCommand.mock.calls.find(([, command]) => command.includes('tmux new-session'))?.[1] ?? '';
    // new-session output is captured so even a silent failure (empty stderr) yields a labeled message.
    expect(startCommand).toContain('__ia_new_session_err="$(tmux new-session -d');
    expect(startCommand).toContain('tmux new-session failed (exit ${__ia_new_session_status})');
    expect(startCommand).toContain('id -un');
    // The intended cwd is captured into a variable and echoed back in the diagnostic.
    expect(startCommand).toContain('__ia_target_cwd=');
    expect(startCommand).toContain('with cwd ${__ia_target_cwd}');
    expect(startCommand).toContain('/home/agent');
    expect(startCommand).toContain('${__ia_new_session_err:-no output from tmux');
  });

  it('best-effort kills a tmux session when start command times out before reporting creation', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('tmux list-sessions')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      if (command.includes('tmux new-session')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 124,
          timedOut: true,
        };
      }
      if (command.includes('tmux kill-session')) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await expect(client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      {
        command: 'codex',
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_sagent123_timeout',
    )).rejects.toThrow('tmux command timed out');

    expect(execCommand.mock.calls.some(([, command]) => (
      command.includes('tmux kill-session') && command.includes('ssh_tmux_d505_sagent123_timeout')
    ))).toBe(true);
  });

  it('cleans up dead ssh_tmux sessions before starting new durable sessions', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'running',
            marker,
            'dead=0;dead_status=;width=120;height=30;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: command.includes('tmux new-session') ? '__IA_TMUX_EXISTING_SESSION=0\n' : '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      {
        command: 'codex',
        initialReadDelayMs: 0,
      },
      'ssh_tmux_d505_sagent123_abc123',
    );

    const cleanupCommand = execCommand.mock.calls[0][1];
    expect(cleanupCommand).toContain('tmux list-sessions');
    expect(cleanupCommand).toContain('#{pane_dead}');
    expect(cleanupCommand).toContain('#{session_created}');
    expect(cleanupCommand).toContain('#{session_activity}');
    expect(cleanupCommand).toContain('#{@ia_auto_cleanup}');
    expect(cleanupCommand).toContain('#{@ia_owner_tag}');
    expect(cleanupCommand).toContain('ssh_tmux_*');
    expect(cleanupCommand).toContain('if [ "$dead" = "1" ]; then');
    expect(cleanupCommand).toContain('elif [ 1800 -gt 0 ] && [ "$auto_cleanup" = "1" ]; then');
    expect(cleanupCommand).toContain('reference="$activity"');
    expect(cleanupCommand).toContain('tmux kill-session -t "$name"');
  });

  it('cleans up auto-cleanup tmux sessions for a completed owner tag', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    await client.cleanupDeadTmuxSessions(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      {
        force: true,
        ownerTag: 'sessionabc123',
      },
    );

    const cleanupCommand = execCommand.mock.calls[0][1];
    expect(cleanupCommand).toContain('[ -n \'"\'"\'sessionabc123\'"\'"\' ]');
    expect(cleanupCommand).toContain('[ "$auto_cleanup" = "1" ]');
    expect(cleanupCommand).toContain('[ "$owner_tag" = \'"\'"\'sessionabc123\'"\'"\' ]');
    expect(cleanupCommand).toContain('tmux kill-session -t "$name"');
  });

  it('marks newly-created tmux sessions for future stale cleanup when requested', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'running',
            marker,
            'dead=0;dead_status=;width=120;height=30;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: command.includes('tmux new-session') ? '__IA_TMUX_EXISTING_SESSION=0\n' : '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.startTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      {
        command: 'codex',
        initialReadDelayMs: 0,
        autoCleanup: true,
        ownerTag: 'sessionabc123',
      },
      'ssh_tmux_d505_sagent123_marked',
    );

    const startCommand = execCommand.mock.calls[1][1];
    expect(startCommand).toContain('@ia_auto_cleanup');
    expect(startCommand).toContain("'1'");
    expect(startCommand).toContain('@ia_owner_tag');
    expect(startCommand).toContain('sessionabc123');
  });

  it('encodes shift+enter terminal input for multiline coding-agent prompts', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'codex prompt',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.sendTmuxInput(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_abc123',
      [
        { type: 'text', text: 'first line' },
        { type: 'key', key: 'shift+enter' },
        { type: 'text', text: 'second line' },
        { type: 'key', key: 'enter' },
      ],
    );

    const command = execCommand.mock.calls[0][1];
    const firstText = command.indexOf('first line');
    const shiftEnter = command.indexOf('\x1b[13;2u', firstText);
    const secondText = command.indexOf('second line', shiftEnter);
    const sleep = command.indexOf('sleep 0.05', firstText);
    const enter = command.indexOf('Enter', sleep);
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(command).toContain('tmux send-keys -l -t');
    expect(command).toContain('tmux send-keys -t');
    expect(shiftEnter).toBeGreaterThan(firstText);
    expect(secondText).toBeGreaterThan(shiftEnter);
    expect(sleep).toBeGreaterThan(firstText);
    expect(enter).toBeGreaterThan(sleep);
    expect(command).not.toContain('tmux paste-buffer');
  });

  it('preserves tmux input order when mixing literal text with control keys', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'codex prompt',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.sendTmuxInput(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_abc123',
      [
        { type: 'text', text: 'working prompt' },
        { type: 'ctrl', key: 'c' },
        { type: 'text', text: 'replacement prompt' },
        { type: 'key', key: 'enter' },
      ],
    );

    const command = execCommand.mock.calls[0][1];
    const firstText = command.indexOf('working prompt');
    const ctrlC = command.indexOf('C-c', firstText);
    const secondText = command.indexOf('replacement prompt');
    const enter = command.indexOf('Enter', secondText);
    const firstSleep = command.indexOf('sleep 0.05', firstText);
    const secondSleep = command.indexOf('sleep 0.05', ctrlC);
    const thirdSleep = command.indexOf('sleep 0.05', secondText);
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(command).toContain('tmux send-keys -l -t');
    expect(firstSleep).toBeGreaterThan(firstText);
    expect(ctrlC).toBeGreaterThan(firstText);
    expect(secondSleep).toBeGreaterThan(ctrlC);
    expect(secondText).toBeGreaterThan(ctrlC);
    expect(thirdSleep).toBeGreaterThan(secondText);
    expect(enter).toBeGreaterThan(secondText);
    expect(command).not.toContain('tmux paste-buffer');
  });

  it('terminates tmux send-keys options before literal text that starts with a dash', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'codex prompt',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.sendTmuxInput(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_abc123',
      [
        { type: 'text', text: '- bullet item' },
      ],
    );

    const command = execCommand.mock.calls[0][1];
    const literalText = command.indexOf('- bullet item');
    const literalSendKeys = command.lastIndexOf('tmux send-keys -l -t', literalText);
    const optionTerminator = command.lastIndexOf(' -- ', literalText);
    expect(literalText).toBeGreaterThanOrEqual(0);
    expect(literalSendKeys).toBeGreaterThanOrEqual(0);
    expect(optionTerminator).toBeGreaterThan(literalSendKeys);
    expect(optionTerminator).toBeLessThan(literalText);
    expect(command).not.toContain('tmux paste-buffer');
  });

  it('cleans up exited tmux sessions after capturing their final snapshot', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'final codex output',
            marker,
            'dead=1;dead_status=0;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_done',
    );
    const closed = await client.closeTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_done',
    );

    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(execCommand.mock.calls.some(([, command]) => command.includes('tmux kill-session'))).toBe(true);
    expect(closed.status).toBe('closed');
    expect(closed.screen.output).toContain('final codex output');
  });

  it('normalizes forced tmux closes without capturing full scrollback logs', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane') && command.includes('display-message')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'root@app:/repo#',
            marker,
            'dead=0;dead_status=;width=120;height=30;cursor_x=11;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const closed = await client.closeTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_close_prompt',
      { readMode: 'delta' },
    );

    expect(closed).toMatchObject({
      status: 'closed',
      processState: 'exited',
      forced: true,
    });
    const snapshotCaptureCall = execCommand.mock.calls.find(([, command]) => (
      command.includes('capture-pane') && command.includes('display-message')
    ));
    const scrollbackCaptureCall = execCommand.mock.calls.find(([, command]) => (
      command.includes('capture-pane') && !command.includes('display-message')
    ));
    const killSessionCall = execCommand.mock.calls.find(([, command]) => command.includes('kill-session'));
    expect(snapshotCaptureCall?.[1]).toContain('-S -2000');
    expect(scrollbackCaptureCall).toBeUndefined();
    expect(killSessionCall?.[2]).toEqual({ timeoutMs: 1_500 });
  });

  it('sends Ctrl+C before closing a running Codex tmux session', async () => {
    const client = new SshClient();
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane') && command.includes('display-message')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'Codex',
            '• Working',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=1;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      if (command.includes('capture-pane')) {
        return {
          stdout: 'Codex scrollback',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const closed = await client.closeTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_codex_close',
      { quietForMs: 0 },
    );

    const commands = execCommand.mock.calls.map(([, command]) => command);
    const ctrlCCommandIndex = commands.findIndex((command) => (
      command.includes('tmux send-keys') && command.includes('C-c')
    ));
    const killSessionIndex = commands.findIndex((command) => command.includes('tmux kill-session'));
    expect(ctrlCCommandIndex).toBeGreaterThanOrEqual(0);
    expect(killSessionIndex).toBeGreaterThan(ctrlCCommandIndex);
    expect(closed.status).toBe('closed');
  });

  it('returns the cached tmux snapshot with a warning when a later read times out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T00:00:00.000Z'));

    const client = new SshClient();
    let captureCount = 0;
    vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        captureCount += 1;
        if (captureCount === 2) {
          return {
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: true,
          };
        }

        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'root@app:/repo# npm test',
            'still running',
            marker,
            'dead=0;dead_status=;width=120;height=30;cursor_x=0;cursor_y=1;alt=0;activity=1778716800',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_cached_timeout',
    );

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_cached_timeout',
      { readMode: 'delta' },
    );

    expect(captureCount).toBe(2);
    expect(result).toMatchObject({
      sessionId: 'ssh_tmux_d505_cached_timeout',
      revision: 1,
      status: 'running',
      timedOut: true,
      warning: expect.stringContaining('tmux read timed out'),
      lastActivityMs: 2_000,
      screen: {
        output: ['root@app:/repo# npm test', 'still running'],
        changedRows: [],
      },
    });
    expect(result.stableForMs).toBe(2_000);
  });

  it('waits up to timeoutMs for tmux pane output to change before returning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T00:00:00.000Z'));

    const client = new SshClient();
    const capturedOutputs = [
      'installing dependencies',
      'installing dependencies',
      'installing dependencies',
      'installing dependencies',
      'install complete',
    ];
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        const output = capturedOutputs[Math.min(execCommand.mock.calls.length - 1, capturedOutputs.length - 1)];
        return {
          stdout: [
            output,
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=1778716800',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_wait',
    );

    const resultPromise = client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_wait',
      { waitForChange: true, timeoutMs: 100 },
    );

    await Promise.resolve();
    expect(execCommand).toHaveBeenCalledTimes(2);
    await expect(Promise.race([
      resultPromise.then(() => 'resolved'),
      Promise.resolve('pending'),
    ])).resolves.toBe('pending');

    await vi.advanceTimersByTimeAsync(25);
    expect(execCommand).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(25);
    expect(execCommand).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: 'ssh_tmux_d505_wait',
      revision: 2,
      stableForMs: 0,
      screen: {
        output: ['install complete'],
      },
    });
    expect(execCommand).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(75);
    const stableResultPromise = client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_wait',
      { waitForChange: true, timeoutMs: 75 },
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(75);
    const stableResult = await stableResultPromise;

    expect(stableResult.revision).toBe(2);
    expect(stableResult.stableForMs).toBeGreaterThanOrEqual(150);
  });

  it('computes tmux delta from retained scrollback so scrolled-out lines are returned', async () => {
    const client = new SshClient();
    const initialRows = [
      'progress line 1',
      'progress line 2',
    ];
    const finalRows = Array.from({ length: 120 }, (_, index) => `final report line ${index + 1}`);
    const captures = [
      initialRows,
      [...initialRows, ...finalRows],
    ];
    let captureIndex = 0;
    const execCommand = vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        const output = captures[Math.min(captureIndex, captures.length - 1)];
        captureIndex += 1;
        return {
          stdout: [
            ...output,
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=0;cursor_y=49;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_delta_scrollback',
      { readMode: 'delta', rows: 50 },
    );

    const result = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_delta_scrollback',
      { readMode: 'delta' },
    );

    expect(execCommand.mock.calls[0][1]).toContain('tmux capture-pane');
    expect(execCommand.mock.calls[0][1]).toContain('-S -2000');
    expect(result.screen.rows).toBe(50);
    expect(result.screen.output).toHaveLength(50);
    expect(result.screen.output).not.toContain('final report line 1');
    expect(result.screen.changedRows?.map((row) => row.text)).toEqual(finalRows);
    expect(result.screen.changedRows?.[0]).toEqual({ row: 3, text: 'final report line 1' });
  });

  it('does not capture a separate scrollback log for exited sessions', async () => {
    const client = new SshClient();
    vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane') && command.includes('display-message')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'final output before exit',
            marker,
            'dead=1;dead_status=0;width=160;height=50;cursor_x=0;cursor_y=0;alt=0;activity=123',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      if (command.includes('capture-pane')) {
        throw new Error('unexpected full scrollback capture');
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_capture_error',
    );
    const closed = await client.closeTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_capture_error',
    );

    expect(result.status).toBe('exited');
    expect(closed.status).toBe('closed');
  });

  it('returns stableForMs on structured tmux results', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T00:00:00.000Z'));

    const client = new SshClient();
    vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'root@app:/repo#',
            marker,
            'dead=0;dead_status=;width=120;height=30;cursor_x=11;cursor_y=0;alt=0;activity=1778716800',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_stable',
    );

    await vi.advanceTimersByTimeAsync(3_100);
    const result = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_d505_stable',
    );

    expect(result).toMatchObject({
      sessionId: 'ssh_tmux_d505_stable',
      revision: 1,
      stableForMs: 3100,
    });
    expect(result.stableForMs).toBe(3100);
  });

  it('treats Codex and Claude composer prompts as waiting input states', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T00:00:00.000Z'));

    const client = new SshClient();
    vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        return {
          stdout: [
            'Ask Codex',
            '>',
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=1;cursor_y=1;alt=0;activity=1778716799;current_command=codex',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_codex_prompt',
    );

    expect(result.processState).toBe('waiting_for_input');
    expect(result.currentCommand).toBe('codex');
  });

  it('keeps processState running for visible TUI work and background terminal indicators', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T00:00:00.000Z'));

    const client = new SshClient();
    const outputs = [
      ['• Working (1m 02s)', '>'],
      ['Claude', '✽ Thinking…', '2 background terminals running'],
    ];
    vi.spyOn(client, 'execCommand').mockImplementation(async (_connection, command: string) => {
      if (command.includes('capture-pane')) {
        const marker = /__IA_TMUX_META_[a-f0-9]+__/i.exec(command)?.[0] ?? '__IA_TMUX_META_TEST__';
        const output = outputs.shift() ?? ['>'];
        return {
          stdout: [
            ...output,
            marker,
            'dead=0;dead_status=;width=160;height=50;cursor_x=1;cursor_y=1;alt=0;activity=1778716796',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    });

    const codexResult = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_codex_working',
    );
    const claudeResult = await client.readTmuxSession(
      {
        host: '203.0.113.10',
        username: 'root',
        privateKey: 'key',
      },
      'ssh_tmux_claude_thinking',
    );

    expect(codexResult.processState).toBe('running');
    expect(claudeResult.processState).toBe('running');
  });
});

describe('SshClient preserved sign-in hosts (idle-reaper visibility)', () => {
  // Durable tmux sessions hold no SSH connection between commands, so a
  // preserved OAuth sign-in is invisible to the plain session registry. The
  // idle reaper stopping such a machine kills the waiting `claude setup-token`
  // and forces the user through a second OAuth link (observed live 2026-07-26).
  const HOST = 'fdaa:99:600e::42';
  const connection = { host: HOST, username: 'agent', privateKey: 'key' };

  function mockedClient() {
    const client = new SshClient();
    vi.spyOn(client, 'execCommand').mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0, timedOut: false,
    });
    return client;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a preserved tmux session as an active host, and releases it when preservation is lifted', async () => {
    const client = mockedClient();

    await client.setTmuxSessionAutoCleanup(connection, 'ssh_tmux_signin_1', false);
    expect(client.getActiveSessionHosts().has(HOST)).toBe(true);

    await client.setTmuxSessionAutoCleanup(connection, 'ssh_tmux_signin_1', true);
    expect(client.getActiveSessionHosts().has(HOST)).toBe(false);
  });

  it('keeps the host active even when the remote metadata write fails (in-memory first)', async () => {
    const client = new SshClient();
    vi.spyOn(client, 'execCommand').mockRejectedValue(new Error('ssh unreachable'));

    await client.setTmuxSessionAutoCleanup(connection, 'ssh_tmux_signin_2', false);

    expect(client.getActiveSessionHosts().has(HOST)).toBe(true);
  });

  it('releases the host when the preserved session is cleaned up', async () => {
    const client = mockedClient();
    await client.setTmuxSessionAutoCleanup(connection, 'ssh_tmux_signin_3', false);

    await client.cleanupTmuxSessions(connection, ['ssh_tmux_signin_3']);

    expect(client.getActiveSessionHosts().has(HOST)).toBe(false);
  });

  it('expires an abandoned sign-in so it cannot hold the machine hot forever', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
    const client = mockedClient();
    await client.setTmuxSessionAutoCleanup(connection, 'ssh_tmux_signin_4', false);

    vi.setSystemTime(new Date('2026-07-26T12:44:00.000Z'));
    expect(client.getActiveSessionHosts().has(HOST)).toBe(true);

    vi.setSystemTime(new Date('2026-07-26T12:46:00.000Z'));
    expect(client.getActiveSessionHosts().has(HOST)).toBe(false);
  });
});

/**
 * execCommand runs a command and collects its output; it has no way to SEND
 * anything, so the remote command's stdin is a pipe nobody will ever fill.
 * A real ssh2 server stands in for the machine here because the bug this pins
 * is a channel-lifecycle fact, not a code shape: `codex exec` reads stdin to
 * EOF before doing any work when stdin is not a terminal, so without the
 * half-close the recap summarizer blocked until its 180s timeout on every
 * Codex turn — and by the recap contract ("failure = silence") the row simply
 * never changed. Nothing logged it.
 */
describe('SshClient.execCommand stdin', () => {
  it('half-closes the channel so a command that reads stdin finishes instead of timing out', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const ssh2 = (await import('ssh2')).default;
    const hostKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;

    let sawStdinEof = false;
    const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {
        client.on('session', (accept) => {
          accept().on('exec', (acceptExec) => {
            const channel = acceptExec();
            // Stands in for a CLI that consumes stdin before it answers. The
            // read has to actually flow: a paused stream never reaches 'end'.
            channel.resume();
            channel.on('end', () => {
              sawStdinEof = true;
              channel.write('ran\n');
              channel.exit(0);
              channel.end();
            });
          });
        });
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', function (this: { address(): { port: number } }) {
        resolve(this.address().port);
      });
    });

    try {
      const result = await new SshClient().execCommand(
        { host: '127.0.0.1', port, username: 'probe', privateKey: hostKey },
        'reads-stdin',
        { timeoutMs: 8000 },
      );
      expect(sawStdinEof).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('ran\n');
    } finally {
      server.close();
    }
  }, 20_000);
});
