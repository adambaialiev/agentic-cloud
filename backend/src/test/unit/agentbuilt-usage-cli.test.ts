import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `agentbuilt usage` (note #719), RUN through the real CLI file against a
 * stub backend, so what a Workspace Agent or room agent reads is what is
 * pinned here — the agent split, the plan lines, the two-provider rule —
 * and a renderer that throws fails here rather than on every machine.
 */

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));

/** The Monday of the week the test runs in, so "this week" is exact. */
function thisMonday(): string {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return at.toISOString().slice(0, 10);
}
function weeksBefore(start: string, weeks: number): string {
  const at = new Date(`${start}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 7 * weeks);
  return at.toISOString().slice(0, 10);
}

const counts = (output: number, input: number, cacheRead: number, cacheWrite = 0, reasoning = 0) => ({ output, input, cacheRead, cacheWrite, reasoning });

const ANSWER = {
  since: weeksBefore(thisMonday(), 3),
  weeks: [
    {
      start: thisMonday(),
      providers: [
        {
          provider: 'claude', ...counts(84_120, 14_300, 1_903_400, 41_200),
          models: [
            {
              model: 'claude-opus-5-5', ...counts(72_949, 12_300, 1_603_400, 38_000),
              agents: [
                { agentId: 'a1', name: 'Alex', room: 'Platform', ...counts(48_200, 8_100, 1_100_000, 30_000) },
                { agentId: 'a2', name: 'Oscar', room: 'Platform', ...counts(20_749, 3_200, 400_400, 6_000) },
                { agentId: 'a9', name: 'Theo', deleted: true, ...counts(4_000, 1_000, 103_000, 2_000) },
              ],
            },
            {
              model: 'claude-sonnet-5-5', ...counts(11_171, 2_000, 300_000, 3_200),
              agents: [{ agentId: 'a3', name: 'Nora', elsewhere: true, ...counts(11_171, 2_000, 300_000, 3_200) }],
            },
          ],
        },
        {
          provider: 'codex', ...counts(5_020, 2_100, 9_000, 0, 1_200),
          models: [{ model: 'gpt-6-sol', ...counts(5_020, 2_100, 9_000, 0, 1_200), agents: [{ agentId: 'a4', name: 'Gus', room: 'Mail', ...counts(5_020, 2_100, 9_000, 0, 1_200) }] }],
        },
      ],
    },
    {
      start: weeksBefore(thisMonday(), 1),
      providers: [{ provider: 'claude', ...counts(9_000, 1_000, 50_000, 500), models: [{ model: 'claude-opus-5-5', ...counts(9_000, 1_000, 50_000, 500), agents: [{ agentId: 'a1', name: 'Alex', room: 'Platform', ...counts(9_000, 1_000, 50_000, 500) }] }] }],
    },
  ],
  plans: [
    {
      provider: 'claude', label: 'my Max account', planText: 'Max 20x', status: 'active', inThisWorkplace: true, primary: true,
      usageRefreshedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      windows: [
        { label: '5 hours', usedPercent: 12, percentText: '12', resetAt: '2026-10-11T14:00:00.000Z', resetsText: 'Oct 11, 14:00 UTC' },
        { label: '7 days · other models', usedPercent: 61.4, percentText: '61.4', resetAt: '2026-10-14T09:00:00.000Z', resetsText: 'Oct 14, 09:00 UTC' },
        { label: '7 days · Fable', usedPercent: 80, percentText: '80', resetAt: '2026-10-14T09:00:00.000Z', resetsText: 'Oct 14, 09:00 UTC' },
        { label: 'Extra usage', usedPercent: 15, percentText: '15', spend: true, detailText: '$12.00 of $80.00' },
      ],
    },
    { provider: 'codex', label: 'work ChatGPT', planText: 'Plus', status: 'active', inThisWorkplace: true, primary: true, windows: [], usageNotice: 'Usage appears after this subscription completes its first message.' },
    { provider: 'claude', label: 'old Pro', planText: 'Pro', status: 'payment_required', inThisWorkplace: false, primary: false, windows: [], usageNotice: 'No reading yet.' },
  ],
};

let server: Server;
let apiUrl: string;
let requested: string[];
let answer: unknown;

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_CLI, ...args], {
      env: { ...process.env, HOME: '/nonexistent-agentbuilt-usage-cli-test', AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

beforeEach(async () => {
  requested = [];
  answer = ANSWER;
  server = createServer((req, res) => {
    requested.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if ((req.url ?? '').startsWith('/api/agent-cli/usage')) {
      res.end(JSON.stringify(answer));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `unexpected ${req.url}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('agentbuilt usage', () => {
  it('prints the weeks split by provider, model and agent, then every subscription with its limits and resets', async () => {
    const { status, stdout, stderr } = await runCli(['usage']);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(requested).toEqual(['/api/agent-cli/usage']);
    expect(stdout).toContain(`Tokens your user's agents spent since Monday ${ANSWER.since}`);
    expect(stdout).toContain('Each provider counts tokens differently, and they are never added together.');
    expect(stdout).toContain(`Week of ${thisMonday()} (this week, so far)`);
    expect(stdout).toContain('  Claude Code                   output 84,120   input 14,300   cache read 1,903,400   cache write 41,200');
    expect(stdout).toContain('    claude-opus-5-5             output 72,949   input 12,300   cache read 1,603,400   cache write 38,000');
    // No room beside an agent since rooms went (note #843).
    expect(stdout).toContain('      Alex                      output 48,200   input 8,100   cache read 1,100,000   cache write 30,000');
    expect(stdout).toContain('      Theo (deleted)            output 4,000');
    expect(stdout).toContain('      Nora (another workplace)  output 11,171');
    expect(stdout).toContain('  Codex                         output 5,020   input 2,100   cache read 9,000   reasoning 1,200');
    expect(stdout).toContain(`Week of ${weeksBefore(thisMonday(), 1)}\n`);
    expect(stdout).toContain("Your user's subscriptions");
    expect(stdout).toContain('  Claude Code · my Max account · Max 20x · primary in this workplace');
    expect(stdout).toContain('    5 hours                12% used    resets Oct 11, 14:00 UTC');
    expect(stdout).toContain('    7 days · Fable         80% used    resets Oct 14, 09:00 UTC');
    expect(stdout).toContain('    Extra usage            15% used    $12.00 of $80.00 — a spend cap, not a limit that stops a turn');
    expect(stdout).toContain('    Checked (3m ago)');
    expect(stdout).toContain('  Codex · work ChatGPT · Plus · primary in this workplace\n    Usage appears after this subscription completes its first message.');
    expect(stdout).toContain('  Claude Code · old Pro · Pro · in another workplace of theirs · payment required\n    No reading yet.');
    // Nothing that looks like a key, by construction: the stub sent none and the renderer invents nothing.
    expect(stdout).not.toMatch(/sk-ant|eyJ|Bearer/);
  });

  it('asks for the weeks it was given, and prints the answer whole with --json', async () => {
    const { status, stdout } = await runCli(['usage', '--weeks', '8', '--json']);
    expect(status).toBe(0);
    expect(requested).toEqual(['/api/agent-cli/usage?weeks=8']);
    expect(JSON.parse(stdout)).toEqual(ANSWER);
  });

  it('refuses a weeks count outside 1 to 8 before asking the backend', async () => {
    const { status, stderr } = await runCli(['usage', '--weeks', '9']);
    expect(status).toBe(1);
    expect(stderr).toContain('--weeks takes a whole number from 1 to 8');
    expect(requested).toEqual([]);
  });

  it('says plainly when nothing is recorded and no subscription is signed in', async () => {
    answer = { since: ANSWER.since, weeks: [], plans: [] };
    const { status, stdout } = await runCli(['usage', '--weeks', '1']);
    expect(status).toBe(0);
    expect(stdout).toContain('Nothing recorded in the last 1 week.');
    expect(stdout).toContain('None signed in.');
  });
});
