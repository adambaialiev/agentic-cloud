import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildKillTurnCommand,
  buildKillableTurnCommand,
  buildTurnActivityCommand,
  buildWorkspaceAgentCommand,
  parseWorkspaceAgentRunOutput,
  readWorkspaceAgentActivity,
  watchWorkspaceAgentActivity,
  WORKSPACE_AGENT_THOUGHT_MAX,
} from '../../services/workspace-recap-runtime.js';

describe('the Workspace Agent structured turn', () => {
  it('keeps Claude’s final reply and the last request’s full prompt size', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          model: 'claude-sonnet-5-20260320',
          usage: { input_tokens: 12_000, cache_read_input_tokens: 188_000, cache_creation_input_tokens: 5_000 },
          content: [{ type: 'tool_use', name: 'Bash' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          model: 'claude-sonnet-5-20260320',
          usage: { input_tokens: 14_000, cache_read_input_tokens: 210_000, cache_creation_input_tokens: 6_000 },
          content: [{ type: 'text', text: 'Done.' }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'claude-session-1' }),
    ].join('\n');

    expect(parseWorkspaceAgentRunOutput(stdout, 'claude')).toEqual({
      text: 'Done.',
      context: { tokens: 230_000, model: 'claude-sonnet-5-20260320' },
      claudeSessionId: 'claude-session-1',
    });
  });

  it('keeps Codex’s final reply and thread id for the rollout read', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: '019c-thread' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'one', type: 'agent_message', text: 'Checking.' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'two', type: 'agent_message', text: 'All set.' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 999_999 } }),
    ].join('\n');

    // `turn.completed` is deliberately ignored: across a tool loop it sums
    // several requests. The rollout's last_token_usage is read separately.
    expect(parseWorkspaceAgentRunOutput(stdout, 'codex')).toEqual({
      text: 'All set.',
      codexThreadId: '019c-thread',
    });
  });

  it('never exposes a structured failure stream as the person’s reply', () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(parseWorkspaceAgentRunOutput(stdout, 'claude')).toEqual({});
  });

  it('retains plain-text compatibility during a rolling deploy', () => {
    expect(parseWorkspaceAgentRunOutput('Ready.\n', 'claude')).toEqual({ text: 'Ready.' });
    expect(parseWorkspaceAgentRunOutput('Ready.\n', 'codex')).toEqual({ text: 'Ready.' });
  });

  it('asks both acting CLIs for structured output with the full room-agent machine powers', () => {
    const claude = buildWorkspaceAgentCommand('Do it.', { cli: 'claude', model: 'sonnet', effort: 'high' });
    expect(claude).toContain('--output-format stream-json --verbose');
    expect(claude).toContain('--permission-mode bypassPermissions');
    expect(claude).not.toContain('--allowedTools');
    expect(claude).not.toContain('--permission-mode dontAsk');

    const codex = buildWorkspaceAgentCommand('Do it.', { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' });
    expect(codex).toContain('--json');
    expect(codex).toContain('--sandbox danger-full-access');
    expect(codex).not.toContain('features.multi_agent=false');
    expect(codex).not.toContain('web_search="disabled"');
    expect(codex).not.toContain('project_doc_max_bytes=0');

    const withSecrets = buildWorkspaceAgentCommand(
      'Do it.',
      { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
      undefined, undefined, undefined,
      { API_TOKEN: 'safe value' },
    );
    expect(withSecrets).toContain("export API_TOKEN='");
    const stagedSecrets = buildWorkspaceAgentCommand(
      'Do it.',
      { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
      undefined, undefined, '/home/agent/.workspace-agent-turn.prompt', undefined,
      '/home/agent/.workspace-agent-turn.env',
    );
    expect(stagedSecrets).toContain('/home/agent/.workspace-agent-turn.env');
    expect(stagedSecrets).toContain('rm -f -- "$STREAM" "$ERR"');
    expect(stagedSecrets).not.toContain('export API_TOKEN=');

    const resumedClaude = buildWorkspaceAgentCommand('Continue.', { cli: 'claude', model: 'sonnet', effort: 'high' }, undefined, { claudeSessionId: 'session-1' });
    expect(resumedClaude).toContain('session-1');
    expect(resumedClaude).toContain('--resume');
    const resumedCodex = buildWorkspaceAgentCommand('Continue.', { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' }, undefined, { codexThreadId: 'thread-1' });
    expect(resumedCodex).toContain('thread-1');
    expect(resumedCodex).toContain('--json resume');

    const stagedClaude = buildWorkspaceAgentCommand('', { cli: 'claude', model: 'sonnet', effort: 'high' }, undefined, undefined, '/home/agent/.workspace-agent-turn.prompt');
    expect(stagedClaude).toContain('claude -p --output-format');
    expect(stagedClaude).toContain('.workspace-agent-turn.prompt');
    const stagedCodex = buildWorkspaceAgentCommand('', { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' }, undefined, { codexThreadId: 'thread-1' }, '/home/agent/.workspace-agent-turn.prompt');
    expect(stagedCodex).toContain('--json resume');
    expect(stagedCodex).toContain('thread-1');
    expect(stagedCodex).toContain("- < '");
  });
});

/**
 * Stop and steer (note #423) need the turn on the machine to be ENDABLE: the
 * wrapper puts it in its own process group and records that group where the
 * kill looks. Run for real here, against this machine's own bash: a sleeping
 * turn is killed by the kill command, its wrapper exits with the killed
 * status, the pid file is gone afterwards, and a kill with nothing running
 * says so with exit 1.
 */
describe('the Workspace Agent turn as an endable process', () => {
  it('records the process group, is ended by the kill command, and reports nothing to kill afterwards', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'wa-turn-'));
    // The wrapper names /home/agent; point both at a temp home for the test.
    const rewrite = (command: string) => command.replaceAll('/home/agent/.workspace-agent-turn.pid', `${home}/turn.pid`);
    const turn = spawn('bash', ['-c', rewrite(buildKillableTurnCommand('echo started; sleep 30; echo never'))], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    turn.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    await vi.waitFor(() => expect(stdout).toContain('started'));
    await vi.waitFor(async () => expect((await readFile(`${home}/turn.pid`, 'utf8')).trim()).toMatch(/^\d+$/));
    const killed = spawnSync('bash', ['-c', rewrite(buildKillTurnCommand())]);
    expect(killed.status).toBe(0);
    const exit = await new Promise<number | null>((resolve) => turn.on('exit', (code) => resolve(code)));
    expect(exit).not.toBe(0);
    expect(stdout).not.toContain('never');
    expect(existsSync(`${home}/turn.pid`)).toBe(false);
    // Nothing running: the kill says so, which the service reads as "already ended".
    expect(spawnSync('bash', ['-c', rewrite(buildKillTurnCommand()).replaceAll('sleep 0.5', 'true')]).status).toBe(1);
    await rm(home, { recursive: true, force: true });
  }, 20_000);
  it('passes the wrapped command\'s own exit status through', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'wa-turn-'));
    const rewrite = (command: string) => command.replaceAll('/home/agent/.workspace-agent-turn.pid', `${home}/turn.pid`);
    const ok = spawnSync('bash', ['-c', rewrite(buildKillableTurnCommand("printf 'reply'; exit 0"))]);
    expect(ok.status).toBe(0);
    expect(ok.stdout.toString()).toBe('reply');
    const failed = spawnSync('bash', ['-c', rewrite(buildKillableTurnCommand('exit 7'))]);
    expect(failed.status).toBe(7);
    expect(existsSync(`${home}/turn.pid`)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

/**
 * Note #452: what the agent is thinking, read off the running turn's stream
 * file. The reader runs on the machine (real node, real file here), the
 * interpretation on the backend.
 */
describe('what the Workspace Agent is thinking (note #452)', () => {
  const settings = { cli: 'claude' as const, model: 'sonnet', effort: 'high' };
  it('writes the acting stream to the one watched path and empties it as the turn starts', () => {
    const command = buildWorkspaceAgentCommand('Hi', settings);
    // Inside the killable wrapper's quoting, so the path is the stable part to look for.
    expect(command).toContain('/home/agent/.workspace-agent-turn.stream');
    expect(command).toContain(': >"$STREAM"');
    expect(command).not.toContain('STREAM=$(mktemp)');
    expect(buildWorkspaceAgentCommand('Hi', { ...settings, cli: 'codex' })).toContain('/home/agent/.workspace-agent-turn.stream');
    expect(buildTurnActivityCommand('claude')).toContain("'/home/agent/.workspace-agent-turn.stream'");
  });
  it('reads the newest thought off a real stream file, and nothing off a missing or empty one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-think-'));
    const file = path.join(dir, 'stream');
    const probe = (cli: 'claude' | 'codex') => buildTurnActivityCommand(cli).replaceAll("'/home/agent/.workspace-agent-turn.stream'", `'${file}'`);
    try {
      expect(spawnSync('bash', ['-c', probe('claude')], { encoding: 'utf8' }).stdout).toBe('');
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look at the notes.' }, { type: 'tool_use', name: 'Bash', input: { command: 'agentbuilt note list' } }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(50_000) }] } }),
        'not json',
      ];
      writeFileSync(file, lines.join('\n') + '\n');
      const out = spawnSync('bash', ['-c', probe('claude')], { encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(out.stdout.length).toBeLessThan(400);
      expect(readWorkspaceAgentActivity(out.stdout, 'claude')).toBe('Bash: agentbuilt note list');
      const codex = [
        JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '**Listing the notes**\nI should read them first.' } }),
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'agentbuilt note show 7' } }),
      ];
      writeFileSync(file, codex.join('\n') + '\n');
      expect(readWorkspaceAgentActivity(spawnSync('bash', ['-c', probe('codex')], { encoding: 'utf8' }).stdout, 'codex')).toBe('$ agentbuilt note show 7');
      writeFileSync(file, codex.slice(0, 2).join('\n') + '\n');
      expect(readWorkspaceAgentActivity(spawnSync('bash', ['-c', probe('codex')], { encoding: 'utf8' }).stdout, 'codex')).toBe('**Listing the notes** I should read them first.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('takes the LAST block of Claude’s event as the current thought, and clips a long one', () => {
    const event = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });
    expect(readWorkspaceAgentActivity(event([{ type: 'tool_use', name: 'Bash', input: { command: 'agentbuilt note list' } }, { type: 'text', text: 'Two notes are  stale.\nArchiving.' }]), 'claude')).toBe('Two notes are stale. Archiving.');
    expect(readWorkspaceAgentActivity(event([{ type: 'thinking', thinking: 'The person wants the stale ones gone.' }]), 'claude')).toBe('The person wants the stale ones gone.');
    const long = readWorkspaceAgentActivity(event([{ type: 'text', text: 'word '.repeat(300) }]), 'claude')!;
    expect(long.length).toBe(WORKSPACE_AGENT_THOUGHT_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(readWorkspaceAgentActivity(event([{ type: 'text', text: '   ' }]), 'claude')).toBeUndefined();
    expect(readWorkspaceAgentActivity(JSON.stringify({ type: 'result', result: 'Done.' }), 'claude')).toBeUndefined();
    expect(readWorkspaceAgentActivity('', 'codex')).toBeUndefined();
    expect(readWorkspaceAgentActivity(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Nearly there.' } }), 'codex')).toBe('Nearly there.');
  });
  it('polls one probe at a time, reports only NEW thoughts, and reports nothing after it is stopped', async () => {
    const seen: string[] = [];
    let answer = '';
    let inFlight = 0, overlapped = false;
    const exec = vi.fn(async (command: string) => {
      expect(command).toBe(buildTurnActivityCommand('claude'));
      inFlight += 1; if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { stdout: answer };
    });
    const watch = watchWorkspaceAgentActivity({ exec, cli: 'claude', intervalMs: 5, onActivity: async (activity) => { seen.push(activity); } });
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());
    expect(seen).toEqual([]);
    answer = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading.' }] } });
    await vi.waitFor(() => expect(seen).toEqual(['Reading.']));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toEqual(['Reading.']);
    answer = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'agentbuilt note archive 3' } }] } });
    await vi.waitFor(() => expect(seen).toEqual(['Reading.', 'Bash: agentbuilt note archive 3']));
    watch.stop();
    const calls = exec.mock.calls.length;
    answer = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Too late.' }] } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exec.mock.calls.length).toBeLessThanOrEqual(calls + 1);
    expect(seen).toEqual(['Reading.', 'Bash: agentbuilt note archive 3']);
    expect(overlapped).toBe(false);
  });
  it('calls the stall boundary after the stream fingerprint stops moving', async () => {
    const onStalled = vi.fn(async () => {});
    const watch = watchWorkspaceAgentActivity({
      exec: async () => ({ stdout: '1700000000:0\n' }),
      cli: 'codex',
      onActivity: async () => {},
      onStalled,
      intervalMs: 2,
      stallMs: 12,
    });
    await vi.waitFor(() => expect(onStalled).toHaveBeenCalledTimes(1));
    watch.stop();
  });
});
