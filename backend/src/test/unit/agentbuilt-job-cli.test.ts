import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SOURCE_CLI = new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url);
const JOB_ID = /j_[a-f0-9]{24}/;
const REAL_TMUX = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const CAN_SUDO = existsSync('/usr/bin/sudo')
  && spawnSync('/usr/bin/sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;

interface Fixture {
  root: string;
  home: string;
  socket: string;
  cli: string;
  tmuxArgvLog: string;
  env: NodeJS.ProcessEnv;
}

let fixture: Fixture;

function runCli(args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  return spawnSync(process.execPath, [fixture.cli, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 12_000,
    env: { ...fixture.env, ...options.env },
  });
}

function runCliAsync(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture.cli, ...args], {
      env: { ...fixture.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 12_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function runTmux(args: string[]) {
  return spawnSync('tmux', ['-L', fixture.socket, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    env: fixture.env,
  });
}

function startJob(
  command: string[],
  options: { cwd?: string; timeout?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const args = ['job', 'start'];
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.timeout) args.push('--timeout', options.timeout);
  args.push('--', ...command);
  const result = runCli(args, { env: options.env });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const id = result.stdout.match(JOB_ID)?.[0];
  expect(id).toMatch(/^j_[a-f0-9]{24}$/);
  return id!;
}

function jobDir(id: string): string {
  return join(fixture.home, '.agentbuilt', 'jobs', id);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * Poll until a condition holds. The budget is a CEILING, not an expectation:
 * this returns the moment the check passes, so a generous one costs nothing
 * on a healthy run and only spends time on a run that was going to fail.
 *
 * Sized for the shared-CPU CI VM these tests actually run on, not a
 * workstation — the same reasoning behind the 30s testTimeout in
 * vitest.config.ts, and kept well under it so a real hang still fails here,
 * with a message naming the condition, rather than as a bare test timeout.
 * Two call sites used to pass 3s and 5s — tighter than this default, waiting
 * on a process to be reaped — and the 3s one broke a merge on 2026-09-11
 * when the host was busy. Nothing in this file waits on a workstation budget
 * now.
 */
async function waitUntil(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'agentbuilt-job-cli-'));
  const home = join(root, 'home');
  const cli = join(root, 'agentbuilt.mjs');
  const socket = `agentbuilt-jobs-test-${basename(root).slice(-12).toLowerCase()}`;
  const shimDir = join(root, 'bin');
  const tmuxShim = join(shimDir, 'tmux');
  const tmuxArgvLog = join(root, 'tmux-argv.jsonl');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(shimDir, { mode: 0o700 });
  // The production literal has no runtime override: that guarantee is what
  // lets the idle reaper find every real job. Give this copied distribution a
  // unique literal instead, so tests never touch a developer's real server.
  const source = readFileSync(SOURCE_CLI, 'utf8');
  expect(source).toContain("const JOB_TMUX_BINARY = '/usr/bin/tmux';");
  expect(source).toContain("const JOB_TMUX_SOCKET = 'agentbuilt-jobs-v1';");
  const isolated = source
    .replace(
      "const JOB_TMUX_BINARY = '/usr/bin/tmux';",
      `const JOB_TMUX_BINARY = ${JSON.stringify(tmuxShim)};`,
    )
    .replace(
      "const JOB_TMUX_SOCKET = 'agentbuilt-jobs-v1';",
      `const JOB_TMUX_SOCKET = '${socket}';`,
    );
  expect(isolated).not.toBe(source);
  writeFileSync(cli, isolated, { mode: 0o700 });
  chmodSync(cli, 0o700);
  writeFileSync(tmuxShim, [
    '#!/usr/bin/env node',
    'const { appendFileSync } = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(tmuxArgvLog)}, JSON.stringify(args) + "\\n");`,
    `const result = spawnSync(${JSON.stringify(REAL_TMUX)}, args, { stdio: "inherit", env: process.env });`,
    'if (result.error) { console.error(result.error.message); process.exit(127); }',
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(tmuxShim, 0o700);
  fixture = {
    root,
    home,
    socket,
    cli,
    tmuxArgvLog,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    },
  };
});

/**
 * Mark the fixture home as having read the repositories rulebook. The first
 * `repo` command of a day otherwise prints one stderr reminder naming
 * `agentbuilt help repos` (identity v154), and the `repo checks --wait` tests
 * assert a silent stderr. Done per test, not in the fixture: other tests
 * replace ~/.agentbuilt itself (symlink, staging) and must find it absent.
 * The reminder is tested in agentbuilt-help-topics.test.ts.
 */
function markReposRulebookRead(home: string): void {
  mkdirSync(join(home, '.agentbuilt', 'help-read'), { recursive: true });
  writeFileSync(join(home, '.agentbuilt', 'help-read', 'repos'), new Date().toISOString());
}

afterEach(async () => {
  // This copied CLI has a unique socket literal, so it can never be a real
  // agent's production job namespace.
  runTmux(['kill-server']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(fixture.root, { recursive: true, force: true });
});

describe('standalone agentbuilt job CLI', () => {
  it('preserves exact argv, cwd, environment, closed stdin, and private records without an implicit shell', () => {
    const touched = join(fixture.root, 'shell-was-run');
    const awkward = [
      'a b',
      '',
      `$(touch ${touched})`,
      'x;y',
      '*',
      'line\nbreak',
      '--looks-like-a-flag',
    ];
    const script = [
      'let input="";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data",chunk=>input+=chunk);',
      'process.stdin.on("end",()=>console.log(JSON.stringify({',
      'argv:process.argv.slice(1),cwd:process.cwd(),env:process.env.JOB_TEST_VALUE,input',
      '})));',
    ].join('');
    const id = startJob([process.execPath, '-e', script, ...awkward], {
      cwd: fixture.root,
      timeout: '5s',
      env: { JOB_TEST_VALUE: 'fresh value with spaces\nand a newline' },
    });

    const waited = runCli(['job', 'wait', id, '--timeout', '5s']);
    expect(waited.status, waited.stderr).toBe(0);
    const logs = runCli(['job', 'logs', id]);
    expect(logs.status).toBe(0);
    expect(JSON.parse(logs.stdout.trim())).toEqual({
      argv: awkward,
      cwd: fixture.root,
      env: 'fresh value with spaces\nand a newline',
      input: '',
    });
    expect(existsSync(touched)).toBe(false);

    const dir = jobDir(id);
    const metadata = readJson(join(dir, 'metadata.json'));
    expect(metadata.command).toEqual([process.execPath, '-e', script, ...awkward]);
    expect(statSync(join(fixture.home, '.agentbuilt', 'jobs')).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of ['metadata.json', 'output.log', 'result.json']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
  });

  it('lists active jobs as bounded JSON with a command redacted at launch time', async () => {
    const secret = 'launch-only-secret-value';
    const pat = 'literal-github-pat-value';
    const database = 'postgres://user:password@example.invalid/db';
    const id = startJob([
      process.execPath,
      '-e',
      'setInterval(()=>{},1000)',
      `credential:${secret}`,
      `GH_PAT=${pat}`,
      `DATABASE_URL=${database}`,
    ], {
      timeout: '20s',
      env: { DEPLOY_TOKEN: secret },
    });

    const listed = runCli(['job', 'list', '--json', '--active'], {
      // Model the infrastructure read: it does not inherit turn secrets.
      env: { DEPLOY_TOKEN: undefined },
    });
    expect(listed.status, listed.stderr).toBe(0);
    const rows = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
    expect(rows).toEqual([expect.objectContaining({
      id,
      status: 'running',
      startedAt: expect.any(String),
    })]);
    expect(String(rows[0]!.label)).toContain('credential:[REDACTED]');
    expect(String(rows[0]!.label)).toContain('GH_PAT=[REDACTED]');
    expect(String(rows[0]!.label)).toContain('DATABASE_URL=[REDACTED]');
    for (const value of [secret, pat, database]) {
      expect(String(rows[0]!.label)).not.toContain(value);
    }

    expect(runCli(['job', 'stop', id]).status).toBe(0);
    const finished = runCli(['job', 'list', '--json', '--active']);
    expect(JSON.parse(finished.stdout)).toEqual([]);

    // --recent (note #564) keeps the outcome the active list just dropped,
    // with when it ended and the same launch-time redaction.
    const recent = runCli(['job', 'list', '--json', '--recent']);
    expect(recent.status, recent.stderr).toBe(0);
    const settled = JSON.parse(recent.stdout) as Array<Record<string, unknown>>;
    expect(settled).toEqual([expect.objectContaining({ id, status: 'stopped', finishedAt: expect.any(String) })]);
    expect(Number.isFinite(Date.parse(String(settled[0]!.finishedAt)))).toBe(true);
    expect(String(settled[0]!.label)).not.toContain(secret);
    // One bounded read or the other, and JSON only.
    expect(runCli(['job', 'list', '--json', '--active', '--recent']).status).not.toBe(0);
    expect(runCli(['job', 'list', '--recent']).status).not.toBe(0);
  });

  it('outlives its launcher and a killed wait client, then reconnects from a fresh process', async () => {
    const id = startJob([
      process.execPath,
      '-e',
      'setTimeout(()=>console.log("finished after clients died"),1200)',
    ], { timeout: '10s' });

    // startJob's standalone CLI process is already gone; the tmux-owned
    // supervisor is still discoverable by a completely new invocation.
    expect(runCli(['job', 'status', id]).stdout).toContain('State: running');
    const waiter = spawn(process.execPath, [fixture.cli, 'job', 'wait', id], {
      env: fixture.env,
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    waiter.kill('SIGKILL');
    await new Promise<void>((resolve) => waiter.once('close', () => resolve()));
    expect(runCli(['job', 'status', id]).stdout).toContain('State: running');

    const reconnected = runCli(['job', 'wait', id, '--timeout', '5s']);
    expect(reconnected.status, reconnected.stderr).toBe(0);
    expect(runCli(['job', 'logs', id]).stdout).toContain('finished after clients died');
  });

  it('keeps running when the actual start launcher process group is killed', async () => {
    const launcher = spawn(
      process.execPath,
      [
        fixture.cli,
        'job', 'start', '--timeout', '10s', '--',
        process.execPath, '-e', 'setTimeout(()=>console.log("survived launcher SIGKILL"),1200)',
      ],
      { env: fixture.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    launcher.stdout!.setEncoding('utf8');
    launcher.stderr!.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      launcher.once('close', (code, signal) => resolve({ code, signal }));
    });
    const id = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`launcher did not print a job ID: ${stdout}\n${stderr}`)), 5_000);
      launcher.stdout!.on('data', (chunk) => {
        stdout += chunk;
        const match = stdout.match(JOB_ID);
        if (!match) return;
        clearTimeout(timer);
        resolve(match[0]);
      });
    });

    // Freeze the real CLI while it is still alive, then kill its whole harness
    // process group. The tmux-owned supervisor must already be independent.
    expect(launcher.pid).toBeTypeOf('number');
    process.kill(launcher.pid!, 'SIGSTOP');
    process.kill(-launcher.pid!, 'SIGKILL');
    const launcherExit = await closed;
    expect(launcherExit).toEqual({ code: null, signal: 'SIGKILL' });

    const reconnected = runCli(['job', 'wait', id, '--timeout', '5s']);
    expect(reconnected.status, `${reconnected.stdout}\n${reconnected.stderr}`).toBe(0);
    expect(runCli(['job', 'logs', id]).stdout).toContain('survived launcher SIGKILL');
  });

  // The first read is the caller's own, before any job exists: it learns the
  // host's settle horizon and the last run's length, prints them, and only
  // THEN promotes the wait. With no number on `--wait`, the job's budget is
  // that horizon plus a minute of slack — never the old fixed ten minutes
  // that gave up on an eleven-minute suite (note #549).
  it('makes repo checks --wait one durable job, bounded by the host\'s horizon, and preserves its successful shell gate', async () => {
    const sha = 'a'.repeat(40);
    const requested: string[] = [];
    const server = createServer((req, res) => {
      requested.push(req.url ?? '');
      expect(req.headers.authorization).toBe('Bearer test-token');
      res.setHeader('content-type', 'application/json');
      const first = requested.length === 1;
      res.end(JSON.stringify(first
        ? {
          ci: true,
          settled: false,
          commitKnown: true,
          settlesWithinSeconds: 90,
          lastRunSeconds: 648,
          runs: [{
            context: 'tests',
            state: 'pending',
            startedAt: new Date(Date.now() - 130_000).toISOString(),
            description: 'Running',
          }],
        }
        : {
          ci: true,
          settled: true,
          commitKnown: true,
          lastRunSeconds: 648,
          runs: [{
            context: 'tests',
            state: 'success',
            startedAt: '2026-08-27T11:49:12.000Z',
            completedAt: '2026-08-27T12:00:00.000Z',
            description: 'All checks passed',
          }],
        }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      markReposRulebookRead(fixture.home);
      const result = await runCliAsync([
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait',
      ], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe('');
      const id = result.stdout.match(JOB_ID)?.[0];
      expect(id).toMatch(JOB_ID);
      // The line before the quiet: what is running, for how long, what it
      // usually takes, and the outside bound (90 s horizon + 60 s slack).
      expect(result.stdout).toContain('tests: running for 2m 10s; the last run took 10m 48s. Waiting for the verdict (up to 2m 30s).');
      expect(result.stdout).toContain(`Started job ${id}`);
      expect(result.stdout).toContain('✓ tests  success (2026-08-27T12:00:00.000Z)  All checks passed  in 10m 48s');
      expect(result.stdout).toContain(`Job ${id}: succeeded`);
      // One read by the caller, one by the worker, which found it settled.
      expect(requested).toEqual([
        `/api/agent-cli/repos/infinite-agents/checks?sha=${sha}`,
        `/api/agent-cli/repos/infinite-agents/checks?sha=${sha}`,
      ]);

      // The worker marker stops the promoted CLI from recursively promoting
      // itself: one logical wait leaves exactly one durable record.
      const listed = runCli(['job', 'list']);
      expect(listed.stdout.match(/\bj_[a-f0-9]{24}\b/g)).toEqual([id]);
      const metadata = readJson(join(jobDir(id!), 'metadata.json'));
      expect(metadata.command).toEqual([
        process.execPath,
        fixture.cli,
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait', '150',
      ]);
      // The job outlives its own budget by a minute, so a poll that runs to
      // the horizon still writes its result rather than being killed first.
      expect(metadata.timeoutMs).toBe(150_000 + 60_000);
      expect(runCli(['job', 'logs', id!]).stdout).toContain('All checks passed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // A sha that has already settled is answered from the first read: no job,
  // no receipt, no quiet follow-up turn for a verdict the caller already has.
  it('answers an already-settled sha without starting a job', async () => {
    const sha = 'd'.repeat(40);
    const requested: string[] = [];
    const server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ci: true,
        settled: true,
        commitKnown: true,
        runs: [{ context: 'tests', state: 'success', completedAt: '2026-08-27T12:00:00.000Z', description: 'All checks passed' }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await runCliAsync([
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait',
      ], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('✓ tests  success');
      expect(result.stdout).not.toMatch(JOB_ID);
      expect(requested).toHaveLength(1);
      expect(runCli(['job', 'list']).stdout).not.toMatch(JOB_ID);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // A number on the flag is the caller's own limit and is never stretched to
  // the host's horizon: "I only have this long" means exactly that.
  it('honours an explicit --wait bound over the host\'s horizon', async () => {
    const sha = 'e'.repeat(40);
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      res.setHeader('content-type', 'application/json');
      // Pending on the caller's read AND the worker's first, so the worker
      // has something to announce into its own log.
      res.end(JSON.stringify(calls <= 2
        ? { ci: true, settled: false, commitKnown: true, settlesWithinSeconds: 1700, runs: [{ context: 'tests', state: 'pending', startedAt: new Date().toISOString(), description: 'Running' }] }
        : { ci: true, settled: true, commitKnown: true, runs: [{ context: 'tests', state: 'success', description: 'ok' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await runCliAsync([
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait', '7',
      ], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('tests: running; no earlier run to say how long it takes. Waiting for the verdict (up to 7s).');
      const id = result.stdout.match(JOB_ID)?.[0];
      expect(readJson(join(jobDir(id!), 'metadata.json')).command.slice(-2)).toEqual(['--wait', '7']);
      // The worker says the same line into the job's own log, for a wait
      // recovered later with `job logs`.
      expect(runCli(['job', 'logs', id!]).stdout).toContain('tests: running; no earlier run to say how long it takes. Waiting for the verdict (up to 7s).');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('propagates a promoted check failure and its log through the original wait', async () => {
    const sha = 'b'.repeat(40);
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      res.setHeader('content-type', 'application/json');
      // Pending on the caller's first read, so the wait is promoted; red on
      // the worker's.
      res.end(JSON.stringify(calls === 1
        ? {
          ci: true, settled: false, commitKnown: true, settlesWithinSeconds: 30,
          runs: [{ context: 'tests', state: 'pending', startedAt: new Date().toISOString(), description: 'Running' }],
        }
        : {
          ci: true,
          settled: true,
          commitKnown: true,
          runs: [{
            context: 'tests',
            state: 'failure',
            completedAt: '2026-08-27T12:00:00.000Z',
            description: 'Tests failed',
            logTail: 'expected 2, received 3',
          }],
        }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await runCliAsync([
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait', '1',
      ], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stdout).toContain('✗ tests  failure');
      expect(result.stdout).toContain('expected 2, received 3');
      expect(result.stdout).toMatch(/Job j_[a-f0-9]{24}: failed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The incident of 2026-09-18: the caller's first read went out during a
  // backend release and never came back. The wait used to be durable only on
  // the far side of that read — so not at all. Now silence past the bound is
  // the cue to start the job at once and leave the reading to it.
  it('makes the wait durable when the backend does not answer its first read', async () => {
    const sha = 'f'.repeat(40);
    let calls = 0;
    const held: import('node:http').ServerResponse[] = [];
    const server = createServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        // A backend mid-restart: the socket is open and nothing ever comes.
        held.push(res);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(calls === 2
        ? {
          ci: true, settled: false, commitKnown: true, settlesWithinSeconds: 40, lastRunSeconds: 300,
          runs: [{ context: 'tests', state: 'pending', startedAt: new Date().toISOString(), description: 'Running' }],
        }
        : {
          ci: true, settled: true, commitKnown: true,
          runs: [{ context: 'tests', state: 'success', completedAt: '2026-09-18T13:22:45.000Z', description: 'Green after the release' }],
        }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      markReposRulebookRead(fixture.home);
      const result = await runCliAsync([
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait',
      ], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token', AGENTBUILT_API_TIMEOUT_MS: '1000' },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe('');
      // Said out loud, before anything else: why the job exists this early.
      expect(result.stdout).toContain('The backend did not answer within 1s — making this wait durable now');
      const id = result.stdout.match(JOB_ID)?.[0];
      expect(id).toMatch(JOB_ID);
      expect(result.stdout).toContain(`Started job ${id}`);
      expect(result.stdout).toContain('✓ tests  success');
      expect(result.stdout).toContain(`Job ${id}: succeeded`);
      // The worker was handed a BARE --wait: the caller never learned the
      // horizon, so the worker reads it itself (40 s + 60 s slack) instead of
      // inheriting a fallback it would then call the caller's own limit.
      const metadata = readJson(join(jobDir(id!), 'metadata.json'));
      expect(metadata.command.slice(-1)).toEqual(['--wait']);
      expect(metadata.timeoutMs).toBe((30 * 60 + 60) * 1000 + 60_000);
      expect(runCli(['job', 'logs', id!]).stdout).toContain('tests: running; the last run took 5m. Waiting for the verdict (up to 1m 40s).');
      // Exactly one job for one logical wait, however it was reached.
      expect(runCli(['job', 'list']).stdout.match(/\bj_[a-f0-9]{24}\b/g)).toEqual([id]);
    } finally {
      for (const res of held) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // A number on the flag survives the unanswered read too: it is still the
  // caller's own limit, handed on rather than replaced with the horizon.
  it('keeps an explicit --wait bound through an unanswered first read', async () => {
    const sha = '9'.repeat(40);
    let calls = 0;
    const held: import('node:http').ServerResponse[] = [];
    const server = createServer((_req, res) => {
      calls += 1;
      if (calls === 1) { held.push(res); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ci: true, settled: true, commitKnown: true, runs: [{ context: 'tests', state: 'success', description: 'ok' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await runCliAsync([
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait', '9',
      ], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token', AGENTBUILT_API_TIMEOUT_MS: '1000' },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const id = result.stdout.match(JOB_ID)?.[0];
      expect(id).toMatch(JOB_ID);
      const metadata = readJson(join(jobDir(id!), 'metadata.json'));
      expect(metadata.command.slice(-2)).toEqual(['--wait', '9']);
      expect(metadata.timeoutMs).toBe(9_000 + 60_000);
    } finally {
      for (const res of held) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The worker is the patient half: a backend restarting mid-build is a blip
  // it rides out, not a red verdict it hands back to the gate.
  it('rides out a backend that drops mid-wait instead of failing the job', async () => {
    const sha = '8'.repeat(40);
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      if (calls === 2) {
        // The worker's first read: connection torn down with no answer.
        res.destroy();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(calls === 1
        ? {
          ci: true, settled: false, commitKnown: true, settlesWithinSeconds: 30,
          runs: [{ context: 'tests', state: 'pending', startedAt: new Date().toISOString(), description: 'Running' }],
        }
        : { ci: true, settled: true, commitKnown: true, runs: [{ context: 'tests', state: 'success', description: 'Back after the blip' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await runCliAsync([
        'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait',
      ], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
        timeout: 20_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Back after the blip');
      expect(result.stdout).toMatch(/Job j_[a-f0-9]{24}: succeeded/);
      // Caller's read, the dropped one, the one that answered.
      expect(calls).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Note #1166: a passed run's output (a deploy's "Live at", a probe's line)
  // was readable in the Workspace alone. It is still not printed unasked,
  // but the reader is told it exists, and --logs prints every run's.
  it('prints a passed run\'s output with --logs, and says it is there without', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ci: true, settled: true, commitKnown: true,
        runs: [
          { context: 'ci/checks', state: 'success', completedAt: '2026-11-12T09:00:00.000Z', description: 'Passed', logTail: 'SECRET ARRIVED len=32' },
          { context: 'deploy/docs', state: 'success', completedAt: '2026-11-12T09:00:01.000Z', description: 'Published docs', logTail: 'Live at https://docs.example' },
        ],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' };
    try {
      const plain = await runCliAsync(['repo', 'checks', 'infinite-agents', '--sha', 'c'.repeat(40)], { env });
      expect(plain.status, `${plain.stdout}\n${plain.stderr}`).toBe(0);
      expect(plain.stdout).not.toContain('SECRET ARRIVED');
      expect(plain.stdout).toContain('add --logs to read it');

      const logs = await runCliAsync(['repo', 'checks', 'infinite-agents', '--sha', 'c'.repeat(40), '--logs'], { env });
      expect(logs.status, `${logs.stdout}\n${logs.stderr}`).toBe(0);
      expect(logs.stdout).toContain('--- ci/checks log tail ---\nSECRET ARRIVED len=32');
      expect(logs.stdout).toContain('--- deploy/docs log tail ---\nLive at https://docs.example');
      expect(logs.stdout).not.toContain('add --logs');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Note #1166: a publish run's deploy.sh holds a one-hour publish key, not
  // an agent's token; the "read the rules first" line only cluttered its log.
  it('prints no help reminder when it runs with a publish key', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ci: true, settled: true, commitKnown: true, runs: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const agent = await runCliAsync(['repo', 'checks', 'infinite-agents', '--sha', 'd'.repeat(40)], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'agb1.x.y' },
      });
      const publish = await runCliAsync(['repo', 'checks', 'infinite-agents', '--sha', 'd'.repeat(40)], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'cdt1.x.y' },
      });
      expect(publish.stderr).not.toContain('read the rules for this area');
      // The reminder itself still reaches an agent that has not read them.
      expect(agent.stderr).toContain('read the rules for this area');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Every other verb: silence is now one line and an exit code, where it used
  // to be a command that sat until the turn ended.
  it('says so and exits when the backend does not answer an ordinary call', async () => {
    const held: import('node:http').ServerResponse[] = [];
    const server = createServer((_req, res) => { held.push(res); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await runCliAsync(['repo', 'checks', 'infinite-agents', '--sha', '7'.repeat(40)], {
        env: { AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token', AGENTBUILT_API_TIMEOUT_MS: '1000' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('could not reach the platform backend (no answer within 1s)');
    } finally {
      for (const res of held) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps a promoted checks wait and its output after the following shell is killed', async () => {
    const sha = 'c'.repeat(40);
    let releaseResponse: (() => void) | undefined;
    let markRequestArrived: (() => void) | undefined;
    const requestArrived = new Promise<void>((resolve) => { markRequestArrived = resolve; });
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        // The caller's own first read: still pending, so the wait is promoted.
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ci: true, settled: false, commitKnown: true, settlesWithinSeconds: 30,
          runs: [{ context: 'tests', state: 'pending', startedAt: new Date().toISOString(), description: 'Running' }],
        }));
        return;
      }
      releaseResponse = () => {
        if (res.headersSent) return;
        releaseResponse = undefined;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ci: true,
          settled: true,
          commitKnown: true,
          runs: [{ context: 'tests', state: 'success', description: 'Survived teardown' }],
        }));
      };
      markRequestArrived?.();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const launcher = spawn(process.execPath, [
      fixture.cli,
      'repo', 'checks', 'infinite-agents', '--sha', sha, '--wait', '1',
    ], {
      env: { ...fixture.env, AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let launcherClosed = false;
    launcher.stdout.setEncoding('utf8');
    launcher.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      launcher.once('close', (code, signal) => {
        launcherClosed = true;
        resolve({ code, signal });
      });
    });
    try {
      const id = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`checks wait did not print a job ID: ${stdout}\n${stderr}`)), 5_000);
        launcher.stdout.on('data', (chunk) => {
          stdout += chunk;
          const match = stdout.match(JOB_ID);
          if (!match) return;
          clearTimeout(timer);
          resolve(match[0]);
        });
      });
      await requestArrived;

      // This is the incident boundary: the Codex-owned following shell dies.
      // Its tmux-owned job must remain alive, discoverable, and able to finish.
      process.kill(-launcher.pid!, 'SIGKILL');
      expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
      releaseResponse?.();

      const reconnected = await runCliAsync(['job', 'wait', id, '--timeout', '5s'], { timeout: 8_000 });
      expect(reconnected.status, `${reconnected.stdout}\n${reconnected.stderr}`).toBe(0);
      expect(runCli(['job', 'logs', id]).stdout).toContain('Survived teardown');
      expect(readJson(join(jobDir(id), 'result.json'))).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
      });
    } finally {
      if (!launcherClosed && launcher.pid) {
        try { process.kill(-launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
        await closed;
      }
      releaseResponse?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refreshes session environment values and removes stale names without putting values in tmux argv', async () => {
    const first = startJob([
      process.execPath,
      '-e',
      'console.log("first-ready");setInterval(()=>{},1000)',
    ], {
      timeout: '10s',
      env: { JOB_ENV_FRESHNESS_PROBE: 'first-secret-value', JOB_ENV_STALE_PROBE: 'stale-secret-value' },
    });
    await waitUntil(() => runCli(['job', 'logs', first]).stdout.includes('first-ready'));

    const second = startJob([
      process.execPath,
      '-e',
      'console.log(JSON.stringify({fresh:process.env.JOB_ENV_FRESHNESS_PROBE,stale:process.env.JOB_ENV_STALE_PROBE??null}))',
    ], {
      env: { JOB_ENV_FRESHNESS_PROBE: 'second-secret-value' },
    });
    expect(runCli(['job', 'wait', second, '--timeout', '5s']).status).toBe(0);
    expect(JSON.parse(runCli(['job', 'logs', second]).stdout.trim())).toEqual({
      fresh: 'second-secret-value',
      stale: null,
    });

    // The shim records the REAL tmux client's argv, including short-lived
    // new-session/configuration calls. Values must travel only in its env.
    const tmuxInvocations = readFileSync(fixture.tmuxArgvLog, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(tmuxInvocations.some((args) => args.includes('new-session'))).toBe(true);
    expect(JSON.stringify(tmuxInvocations)).not.toContain('first-secret-value');
    expect(JSON.stringify(tmuxInvocations)).not.toContain('second-secret-value');
    expect(JSON.stringify(tmuxInvocations)).not.toContain('stale-secret-value');

    // Pane start commands are controlled runner argv too.
    const panes = runTmux(['list-panes', '-a', '-F', '#{pane_start_command}']);
    expect(panes.status).toBe(0);
    expect(panes.stdout).not.toContain('first-secret-value');
    expect(panes.stdout).not.toContain('second-secret-value');
    expect(panes.stdout).not.toContain('stale-secret-value');
    expect(runCli(['job', 'stop', first]).status).toBe(0);
  });

  it('ignores hostile user tmux settings for the managed server', async () => {
    const configMarker = join(fixture.root, 'user-tmux-config-ran');
    writeFileSync(join(fixture.home, '.tmux.conf'), [
      'set -g base-index 1',
      'setw -g pane-base-index 1',
      'set -g remain-on-exit on',
      'set -g destroy-unattached on',
      `run-shell 'touch ${configMarker}'`,
      '',
    ].join('\n'));
    const id = startJob([
      process.execPath,
      '-e',
      'console.log("hostile-config-ready");setInterval(()=>{},1000)',
    ], { timeout: '20s' });
    await waitUntil(() => runCli(['job', 'logs', id]).stdout.includes('hostile-config-ready'));
    expect(existsSync(configMarker)).toBe(false);

    const stopped = runCli(['job', 'stop', id], { timeout: 10_000 });
    expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    const metadata = readJson(join(jobDir(id), 'metadata.json'));
    await waitUntil(() => runTmux(['has-session', '-t', `=${metadata.sessionName}`]).status !== 0);
    const tmuxInvocations = readFileSync(fixture.tmuxArgvLog, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as string[]);
    const managedLaunch = tmuxInvocations.find((args) => args.includes('new-session'));
    expect(managedLaunch?.slice(0, 4)).toEqual(['-f', '/dev/null', '-L', fixture.socket]);
  });

  it('records and propagates a nonzero program exit', () => {
    const id = startJob([
      process.execPath,
      '-e',
      'console.log("stdout");console.error("stderr");process.exit(7)',
    ]);
    const waited = runCli(['job', 'wait', id, '--timeout', '5s']);
    expect(waited.status).toBe(7);
    expect(waited.stdout).toContain('failed');
    const result = readJson(join(jobDir(id), 'result.json'));
    expect(result).toMatchObject({ status: 'failed', exitCode: 7, signal: null });
    const output = runCli(['job', 'logs', id]).stdout;
    expect(output).toContain('stdout');
    expect(output).toContain('stderr');
  });

  it('enforces both the runtime deadline and the combined output cap', () => {
    const id = startJob([
      process.execPath,
      '-e',
      'process.stdout.write("x".repeat(4000));setInterval(()=>{},1000)',
    ], {
      timeout: '250ms',
      env: { AGENTBUILT_JOB_TEST_MAX_OUTPUT_BYTES: '512' },
    });
    const waited = runCli(['job', 'wait', id, '--timeout', '5s']);
    expect(waited.status).toBe(124);
    const result = readJson(join(jobDir(id), 'result.json'));
    expect(result).toMatchObject({ status: 'timed_out', outputBytes: 512, outputTruncated: true });
    const output = readFileSync(join(jobDir(id), 'output.log'), 'utf8');
    expect(Buffer.byteLength(output)).toBe(512);
    expect(output).toContain('[agentbuilt: output truncated at 512 bytes]');
  });

  it('stops the whole detached process group, including a TERM-resistant grandchild', async () => {
    const childPidFile = join(fixture.root, 'grandchild.pid');
    const script = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      'const child=spawn(process.execPath,["-e",',
      '"process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});',
      'fs.writeFileSync(process.argv[1],String(child.pid));',
      'process.on("SIGTERM",()=>process.exit(0));',
      'setInterval(()=>{},1000);',
    ].join('');
    const id = startJob([process.execPath, '-e', script, childPidFile], { timeout: '20s' });
    await waitUntil(() => existsSync(childPidFile));
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    expect(processExists(childPid)).toBe(true);

    const stopped = runCli(['job', 'stop', id], { timeout: 10_000 });
    expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    expect(stopped.stdout).toContain('stopped');
    await waitUntil(() => !processExists(childPid));
    expect(readJson(join(jobDir(id), 'result.json'))).toMatchObject({ status: 'stopped' });
  });

  it('uses the privileged group signal path for same-PGID sudo descendants', async () => {
    if (!CAN_SUDO) return;
    const rootPidFile = join(fixture.root, 'root-child.pid');
    let rootPid: number | undefined;
    try {
      const id = startJob([
        '/usr/bin/sudo', '-n', process.execPath, '-e',
        'require("node:fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
        rootPidFile,
      ], { timeout: '20s' });
      await waitUntil(() => existsSync(rootPidFile));
      rootPid = Number(readFileSync(rootPidFile, 'utf8'));
      expect(processExists(rootPid)).toBe(true);

      const stopped = runCli(['job', 'stop', id], { timeout: 12_000 });
      expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await waitUntil(() => !processExists(rootPid!));
      expect(readJson(join(jobDir(id), 'result.json'))).toMatchObject({ status: 'stopped' });
    } finally {
      if (rootPid && processExists(rootPid)) {
        spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/kill', '-s', 'KILL', '--', String(rootPid)], {
          stdio: 'ignore',
        });
      }
    }
  });

  it('treats a FIFO stop marker as corruption without blocking the supervisor', async () => {
    const childPidFile = join(fixture.root, 'fifo-command.pid');
    const id = startJob([
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',
      childPidFile,
    ], { timeout: '20s' });
    await waitUntil(() => existsSync(childPidFile));
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    const marker = join(jobDir(id), 'stop-request.json');
    const madeFifo = spawnSync('/usr/bin/mkfifo', [marker], { encoding: 'utf8' });
    expect(madeFifo.status, madeFifo.stderr).toBe(0);

    const waited = runCli(['job', 'wait', id, '--timeout', '8s'], { timeout: 10_000 });
    expect(waited.status, `${waited.stdout}\n${waited.stderr}`).toBe(125);
    expect(waited.stdout).toContain('unsafe type');
    await waitUntil(() => !processExists(childPid));
    expect(readJson(join(jobDir(id), 'result.json'))).toMatchObject({ status: 'interrupted' });
    unlinkSync(marker);
  });

  it('does not replay a record whose supervisor vanished across a reboot-like interruption', async () => {
    const childPidFile = join(fixture.root, 'command.pid');
    const id = startJob([
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',
      childPidFile,
    ], { timeout: '20s' });
    await waitUntil(() => existsSync(childPidFile));
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    const metadata = readJson(join(jobDir(id), 'metadata.json'));
    const pane = runTmux([
      'display-message', '-p', '-t', `=${metadata.sessionName}:`, '#{pane_pid}',
    ]);
    expect(pane.status, pane.stderr).toBe(0);
    const supervisorPid = Number(pane.stdout.trim());

    // SIGKILL models the VM disappearing: neither process gets a chance to
    // write result.json, and the later CLI must infer interruption, not replay.
    process.kill(supervisorPid, 'SIGKILL');
    process.kill(-childPid, 'SIGKILL');
    await waitUntil(() => !processExists(childPid));
    await waitUntil(() => runTmux(['has-session', '-t', `=${metadata.sessionName}`]).status !== 0);
    expect(existsSync(join(jobDir(id), 'result.json'))).toBe(false);

    const status = runCli(['job', 'status', id]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('State: interrupted');
    const waited = runCli(['job', 'wait', id, '--timeout', '1s']);
    expect(waited.status).toBe(125);
    expect(waited.stdout).toContain('interrupted');
    expect(existsSync(join(jobDir(id), 'result.json'))).toBe(false);
  });

  it('serializes concurrent starts and never exceeds four active jobs', async () => {
    const launches = Array.from({ length: 5 }, () => spawn(
      process.execPath,
      [fixture.cli, 'job', 'start', '--timeout', '20s', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'],
      { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    const outcomes = await Promise.all(launches.map((child) => new Promise<{
      code: number | null; stdout: string; stderr: string;
    }>((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr!.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    })));
    const started = outcomes.filter((outcome) => outcome.code === 0);
    const refused = outcomes.filter((outcome) => outcome.code !== 0);
    expect(started).toHaveLength(4);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.stderr).toContain('limit 4');
    const ids = started.map((outcome) => outcome.stdout.match(JOB_ID)![0]);
    expect(runCli(['job', 'list']).stdout.match(/\brunning\b/g)).toHaveLength(4);
    for (const id of ids) {
      const stopped = runCli(['job', 'stop', id]);
      expect(stopped.status, stopped.stderr).toBe(0);
    }
  });

  it('rejects corrupt records and unsafe file modes instead of executing or trusting them', () => {
    const id = startJob([process.execPath, '-e', 'console.log("safe")']);
    expect(runCli(['job', 'wait', id, '--timeout', '5s']).status).toBe(0);
    const metadata = join(jobDir(id), 'metadata.json');
    chmodSync(metadata, 0o644);
    const unsafe = runCli(['job', 'status', id]);
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain('mode 0600');
    chmodSync(metadata, 0o600);
    writeFileSync(metadata, '{not json\n', { mode: 0o600 });
    const corrupt = runCli(['job', 'status', id]);
    expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toContain('invalid JSON');
  });

  it('ignores an unpublished staging directory left by a killed launcher', () => {
    const agentbuilt = join(fixture.home, '.agentbuilt');
    const jobs = join(agentbuilt, 'jobs');
    mkdirSync(agentbuilt, { mode: 0o700 });
    mkdirSync(jobs, { mode: 0o700 });
    const staging = join(jobs, '.j_0123456789abcdef01234567.123.deadbeef.tmp');
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, 'metadata.json'), '{"partial":true}\n', { mode: 0o600 });

    const listed = runCli(['job', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('No managed jobs yet');
  });

  it('rejects a symlinked managed store without following it', () => {
    const agentbuilt = join(fixture.home, '.agentbuilt');
    const outside = join(fixture.root, 'outside');
    mkdirSync(agentbuilt, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(agentbuilt, 'jobs'));
    const result = runCli(['job', 'list']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be a real directory');
    expect(lstatSync(join(agentbuilt, 'jobs')).isSymbolicLink()).toBe(true);
  });
});

/**
 * The wake a finished job sends (note #532). The machine is the only side that
 * can see a terminal result, a reboot, and the environment holding the user's
 * saved credentials — so this is where the receipt is built, bounded and
 * redacted, and where "never drop it" has to be true.
 *
 * Every CLI call here goes through `runCliAsync`. The stub backend lives in
 * THIS process, and `spawnSync` blocks its event loop: a synchronous call that
 * waits on an answer this process cannot send while it is blocked is a
 * deadlock, not a slow test.
 */
describe('a finished job delivers its receipt', () => {
  interface Backend {
    url: string;
    requests: Array<{ path: string; auth: string | undefined; body: { jobs: Array<Record<string, unknown>> } }>;
    close: () => Promise<void>;
  }

  async function startBackend(reply: () => { status: number; body: unknown } = () => ({
    status: 202,
    body: { ok: true },
  })): Promise<Backend> {
    const requests: Backend['requests'] = [];
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        requests.push({
          path: req.url ?? '',
          auth: req.headers.authorization,
          body: JSON.parse(raw || '{}'),
        });
        const answer = reply();
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
      });
    });
    // fetch keeps its connection alive, so a close() that waits for idle
    // sockets would hold the suite open after the assertions are done.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests,
      close: () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    };
  }

  function connected(backend: Backend, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      AGENTBUILT_API_URL: backend.url,
      AGENTBUILT_TOKEN: 'test-token',
      // The real debounce is 3s and exists to collapse a fan-out; these tests
      // exercise the collapse directly instead of waiting it out.
      AGENTBUILT_JOB_TEST_WAKE_DEBOUNCE_MS: '50',
      ...over,
    };
  }

  async function job(args: string[], env: NodeJS.ProcessEnv) {
    return runCliAsync(['job', ...args], { env });
  }

  /** A finished record written by hand — a job that ended before this process existed. */
  function writeFinishedJob(id: string, over: {
    wake?: boolean;
    unfinished?: boolean;
    status?: string;
    output?: string;
  } = {}): string {
    const dir = jobDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const output = over.output ?? 'done\n';
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({
      schemaVersion: 1,
      id,
      sessionName: `agentbuilt-job-v1-${id}`,
      command: [process.execPath, '-e', 'console.log("done")'],
      cwd: fixture.root,
      createdAt: '2026-09-16T15:00:00.000Z',
      timeoutMs: 60_000,
      outputLimitBytes: 16 * 1024 * 1024,
      wake: over.wake ?? true,
      cliVersion: '1.23.0',
    }), { mode: 0o600 });
    writeFileSync(join(dir, 'output.log'), output, { mode: 0o600 });
    if (!over.unfinished) {
      writeFileSync(join(dir, 'result.json'), JSON.stringify({
        schemaVersion: 1,
        id,
        status: over.status ?? 'succeeded',
        startedAt: '2026-09-16T15:00:00.000Z',
        finishedAt: '2026-09-16T15:06:12.000Z',
        exitCode: 0,
        signal: null,
        outputBytes: output.length,
        outputTruncated: false,
      }), { mode: 0o600 });
    }
    for (const file of ['metadata.json', 'output.log', 'result.json']) {
      if (existsSync(join(dir, file))) chmodSync(join(dir, file), 0o600);
    }
    return dir;
  }

  const jobId = (n: number) => `j_${String(n).repeat(24)}`;

  it('says at start which jobs wake you, and records the choice where a later process can read it', async () => {
    const loud = startJob([process.execPath, '-e', 'process.exit(0)'], { timeout: '5s' });
    const quiet = await runCliAsync(['job', 'start', '--quiet', '--timeout', '5s', '--', process.execPath, '-e', 'process.exit(0)']);
    expect(quiet.status, quiet.stderr).toBe(0);
    const quietId = quiet.stdout.match(JOB_ID)![0];

    expect(runCli(['job', 'status', loud]).stdout).toMatch(/Wake: (on finish|pending)/);
    expect(quiet.stdout).toContain('on finish: quiet (--quiet); nothing starts a turn');
    expect(readJson(join(jobDir(loud), 'metadata.json')).wake).toBe(true);
    expect(readJson(join(jobDir(quietId), 'metadata.json')).wake).toBe(false);
    expect(runCli(['job', 'status', quietId]).stdout).toContain('Wake: no (started with --quiet)');
  });

  it('says on the list which jobs announce themselves and which must be gone and read', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      writeFinishedJob(jobId(1));
      writeFinishedJob(jobId(2), { wake: false });
      const running = await runCliAsync([
        'job', 'start', '--timeout', '30s', '--', process.execPath, '-e', 'setTimeout(()=>{}, 20000)',
      ], { env });
      const runningId = running.stdout.match(JOB_ID)![0];

      const listed = await job(['list'], env);
      const row = (id: string) => listed.stdout.split('\n').find((line) => line.includes(id)) ?? '';
      expect(row(runningId)).toContain('wake');
      expect(row(jobId(2))).toContain('quiet');
      // The flush that `job list` itself performs settles the first one, so its
      // mark is either owed (scanned before delivery) or told (after it).
      expect(row(jobId(1))).toMatch(/owed|told/);

      await waitUntil(() => existsSync(join(jobDir(jobId(1)), 'wake.json')));
      const settled = (await job(['list'], env)).stdout.split('\n');
      expect(settled.find((line) => line.includes(jobId(1)))).toContain('told');
      await job(['stop', runningId], env);
    } finally {
      await backend.close();
    }
  });

  it('sends the receipt when the work ends, and retires it only on the answer', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      const started = await runCliAsync([
        'job', 'start', '--cwd', fixture.root, '--timeout', '10s', '--',
        process.execPath, '-e', 'console.log("scenario 1 ok"); console.error("scenario 2 ok")',
      ], { env });
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain('on finish: starts a turn for you with the result');
      const id = started.stdout.match(JOB_ID)![0];

      expect((await job(['wait', id, '--timeout', '10s'], env)).status).toBe(0);
      await waitUntil(() => backend.requests.length > 0);

      const [sent] = backend.requests;
      // The EXACT path, not a suffix of it. `toContain` passed happily while
      // the request was missing its `api/` prefix and every wake 404'd on the
      // real backend — merged, deployed, and doing nothing (2026-09-17).
      expect(sent!.path).toBe('/api/agent-cli/jobs/finished');
      expect(sent!.auth).toBe('Bearer test-token');
      expect(sent!.body.jobs).toHaveLength(1);
      expect(sent!.body.jobs[0]).toMatchObject({
        id,
        status: 'succeeded',
        exitCode: 0,
        cwd: fixture.root,
        outputTruncated: false,
      });
      expect(String(sent!.body.jobs[0]!.tail)).toContain('scenario 1 ok');
      expect(String(sent!.body.jobs[0]!.tail)).toContain('scenario 2 ok');
      expect(Number(sent!.body.jobs[0]!.durationMs)).toBeGreaterThanOrEqual(0);

      await waitUntil(() => existsSync(join(jobDir(id), 'wake.json')));
      expect(readJson(join(jobDir(id), 'wake.json'))).toMatchObject({ id, schemaVersion: 1 });
      expect((await job(['status', id], env)).stdout).toContain('Wake: delivered');

      // Settled means settled: no later command offers it again.
      const before = backend.requests.length;
      await job(['list'], env);
      expect(backend.requests).toHaveLength(before);
    } finally {
      await backend.close();
    }
  });

  it('never lets a credential out: the command and the output are redacted on this machine', async () => {
    const backend = await startBackend();
    const secret = 'sk-live-31415926535897932384';
    const env = connected(backend, { DEPLOY_TOKEN: secret });
    try {
      const started = await runCliAsync([
        'job', 'start', '--timeout', '10s', '--',
        process.execPath,
        '-e',
        'console.log("used " + process.env.DEPLOY_TOKEN); console.log("Authorization: Bearer " + process.env.DEPLOY_TOKEN)',
        '--',
        `--api-key=${secret}`,
      ], { env });
      expect(started.status, started.stderr).toBe(0);
      const id = started.stdout.match(JOB_ID)![0];

      await job(['wait', id, '--timeout', '10s'], env);
      await waitUntil(() => backend.requests.length > 0);

      const receipt = backend.requests[0]!.body.jobs[0]!;
      expect(JSON.stringify(receipt)).not.toContain(secret);
      expect(String(receipt.command)).toContain('[REDACTED]');
      expect(String(receipt.tail)).toContain('used [REDACTED]');
      expect(String(receipt.tail)).toContain('Bearer [REDACTED]');
    } finally {
      await backend.close();
    }
  });

  it('bounds a long tail by lines rather than sending the whole log', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      const started = await runCliAsync([
        'job', 'start', '--timeout', '10s', '--',
        process.execPath, '-e', 'for (let i = 0; i < 500; i += 1) console.log("line " + i);',
      ], { env });
      const id = started.stdout.match(JOB_ID)![0];

      await job(['wait', id, '--timeout', '10s'], env);
      await waitUntil(() => backend.requests.length > 0);

      const tail = String(backend.requests[0]!.body.jobs[0]!.tail);
      expect(tail).toContain('line 499');
      expect(tail).not.toContain('line 1\n');
      expect(tail.split('\n').length).toBeLessThanOrEqual(40);
      expect(tail.length).toBeLessThanOrEqual(2_000);
    } finally {
      await backend.close();
    }
  });

  it('wakes nobody for a job the agent stopped, or one started --quiet', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      const long = await runCliAsync([
        'job', 'start', '--timeout', '60s', '--',
        process.execPath, '-e', 'setTimeout(()=>{}, 30000)',
      ], { env });
      const stopped = long.stdout.match(JOB_ID)![0];
      expect((await job(['stop', stopped], env)).status).toBe(0);

      const quiet = await runCliAsync([
        'job', 'start', '--quiet', '--timeout', '5s', '--', process.execPath, '-e', 'process.exit(0)',
      ], { env });
      const quietId = quiet.stdout.match(JOB_ID)![0];
      await job(['wait', quietId, '--timeout', '10s'], env);

      // Give any delivery that WOULD happen time to happen, then prove none did.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await job(['list'], env);
      expect(backend.requests).toEqual([]);
      expect((await job(['status', stopped], env)).stdout).toContain('Wake: no (you stopped this job)');
    } finally {
      await backend.close();
    }
  });

  it('collapses a whole fan-out into one wake', async () => {
    const backend = await startBackend();
    try {
      for (const n of [1, 2, 3]) writeFinishedJob(jobId(n), { output: `job ${n} output\n` });

      await job(['list'], connected(backend));
      await waitUntil(() => backend.requests.length > 0);

      expect(backend.requests).toHaveLength(1);
      const ids = backend.requests[0]!.body.jobs.map((one) => one.id);
      expect([...ids].sort()).toEqual([jobId(1), jobId(2), jobId(3)].sort());
    } finally {
      await backend.close();
    }
  });

  it('keeps a receipt owed when the backend cannot take it, and pays it on the next command', async () => {
    let answer: { status: number; body: unknown } = { status: 503, body: { error: 'restarting' } };
    const backend = await startBackend(() => answer);
    const env = connected(backend);
    try {
      writeFinishedJob(jobId(4));

      await job(['list'], env);
      await waitUntil(() => backend.requests.length > 0);
      expect(existsSync(join(jobDir(jobId(4)), 'wake.json'))).toBe(false);
      expect((await job(['status', jobId(4)], env)).stdout).toContain('Wake: pending');

      answer = { status: 202, body: { ok: true } };
      await job(['list'], env);
      await waitUntil(() => existsSync(join(jobDir(jobId(4)), 'wake.json')));
      expect(readJson(join(jobDir(jobId(4)), 'wake.json')).deliveredAt).toBeTruthy();
    } finally {
      await backend.close();
    }
  });

  it('stops asking when the backend refuses in terms retrying cannot change', async () => {
    const backend = await startBackend(() => ({ status: 409, body: { error: 'not woken by its own jobs' } }));
    const env = connected(backend);
    try {
      writeFinishedJob(jobId(5));

      await job(['list'], env);
      await waitUntil(() => existsSync(join(jobDir(jobId(5)), 'wake.json')));
      expect(readJson(join(jobDir(jobId(5)), 'wake.json'))).toMatchObject({
        refusedAt: expect.any(String),
        error: 'not woken by its own jobs',
      });

      const before = backend.requests.length;
      await job(['list'], env);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(backend.requests).toHaveLength(before);
      expect((await job(['status', jobId(5)], env)).stdout).toContain('Wake: refused');
    } finally {
      await backend.close();
    }
  });

  it('keeps a receipt owed through a rotated token, which is the refusal that passes', async () => {
    const backend = await startBackend(() => ({
      status: 401,
      body: { error: 'Token is not valid (it may have been rotated — try again next turn)' },
    }));
    const env = connected(backend);
    try {
      writeFinishedJob(jobId(9));

      await job(['list'], env);
      await waitUntil(() => backend.requests.length > 0);

      // The machine gets a fresh token on its next identity write, so retiring
      // this receipt would throw away an outcome nobody else can announce.
      expect(existsSync(join(jobDir(jobId(9)), 'wake.json'))).toBe(false);
      expect((await job(['status', jobId(9)], env)).stdout).toContain('Wake: pending');
    } finally {
      await backend.close();
    }
  });

  it('reconcile settles what a reboot killed and delivers it — the one event no worker survives to send', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      // A record with no result and no supervisor: exactly what a VM restart
      // leaves behind, and what used to sit there telling nobody anything.
      writeFinishedJob(jobId(6), { unfinished: true, output: 'migrating row 40000\n' });

      const reconciled = await job(['reconcile'], env);
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain('interrupted');

      expect(readJson(join(jobDir(jobId(6)), 'result.json')).status).toBe('interrupted');
      await waitUntil(() => backend.requests.length > 0);
      expect(backend.requests[0]!.body.jobs[0]).toMatchObject({ id: jobId(6), status: 'interrupted' });
      expect(String(backend.requests[0]!.body.jobs[0]!.tail)).toContain('migrating row 40000');

      // Still never replayed: settling it is a receipt, not a rerun.
      expect((await job(['status', jobId(6)], env)).stdout).toContain('State: interrupted');
    } finally {
      await backend.close();
    }
  });

  it('sends no output tail from a boot pass, and says where the output is instead', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      writeFinishedJob(jobId(9), { unfinished: true, output: 'token=hunter2-not-a-shape-we-match\n' });

      const reconciled = await job(['reconcile', '--boot'], env);
      expect(reconciled.status, reconciled.stderr).toBe(0);
      await waitUntil(() => backend.requests.length > 0);

      // ~/.boot.d runs under the entrypoint's environment, which holds none of
      // the user's saved keys — so the exact-value half of the redaction
      // cannot fire and a raw credential in the tail would leave the machine
      // with only the syntax passes applied (Ada's review of note #532).
      const sent = backend.requests[0]!.body.jobs[0]!;
      expect(sent).toMatchObject({ id: jobId(9), status: 'interrupted', tailWithheld: true });
      expect(sent.tail).toBeUndefined();
      expect(JSON.stringify(sent)).not.toContain('hunter2');
    } finally {
      await backend.close();
    }
  });

  it('still sends the tail when reconcile is run by hand, inside a turn', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      writeFinishedJob(jobId(3), { output: 'the build finished\n' });

      await job(['reconcile'], env);
      await waitUntil(() => backend.requests.length > 0);

      const sent = backend.requests[0]!.body.jobs[0]!;
      expect(String(sent.tail)).toContain('the build finished');
      expect(sent.tailWithheld).toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it('leaves a job that is still starting alone, rather than settling it out from under its worker', async () => {
    const backend = await startBackend();
    const env = connected(backend);
    try {
      // The record directory is published before `tmux new-session` returns, so
      // a hand-run reconcile in that window used to write an interrupted
      // result the worker would then find and exit on (Ada's review).
      writeFinishedJob(jobId(2), { unfinished: true });
      const metadata = readJson(join(jobDir(jobId(2)), 'metadata.json'));
      metadata.createdAt = new Date().toISOString();
      writeFileSync(join(jobDir(jobId(2)), 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
      chmodSync(join(jobDir(jobId(2)), 'metadata.json'), 0o600);

      await job(['reconcile'], env);
      expect(existsSync(join(jobDir(jobId(2)), 'result.json'))).toBe(false);

      // A boot pass has no launcher to race: everything it finds predates the reboot.
      await job(['reconcile', '--boot'], env);
      expect(readJson(join(jobDir(jobId(2)), 'result.json')).status).toBe('interrupted');
    } finally {
      await backend.close();
    }
  });

  it('settles only the receipts the backend says it took', async () => {
    const backend = await startBackend(() => ({
      status: 202,
      body: { ok: true, accepted: [jobId(6)] },
    }));
    const env = connected(backend);
    try {
      writeFinishedJob(jobId(6));
      writeFinishedJob(jobId(7));

      await job(['list'], env);
      await waitUntil(() => existsSync(join(jobDir(jobId(6)), 'wake.json')));

      // Settling one the backend never named would retire a receipt nobody has.
      expect(existsSync(join(jobDir(jobId(7)), 'wake.json'))).toBe(false);
      expect((await job(['status', jobId(7)], env)).stdout).toContain('Wake: pending');
    } finally {
      await backend.close();
    }
  });

  it('leaves records from before this shipped alone, so an upgrade is not a flood of receipts', async () => {
    const backend = await startBackend();
    try {
      const dir = writeFinishedJob(jobId(7));
      const metadata = readJson(join(dir, 'metadata.json'));
      delete metadata.wake;
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
      chmodSync(join(dir, 'metadata.json'), 0o600);

      await job(['list'], connected(backend));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(backend.requests).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  it('says nothing and sends nothing on a machine that has no credential yet', async () => {
    writeFinishedJob(jobId(8));
    const listed = await runCliAsync(['job', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stderr).toBe('');
    expect(existsSync(join(jobDir(jobId(8)), 'wake.json'))).toBe(false);
  });
});
