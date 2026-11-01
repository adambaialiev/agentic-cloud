import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `agentbuilt forward` (note #724), RUN through the real CLI file against a
 * stub backend: what the Workspace Agent types becomes the request the route
 * expects — items in order, `--repo` in the body, `--room` as the header.
 */

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));

let server: Server;
let apiUrl: string;
let seen: Array<{ url: string; room?: string; body: unknown }>;

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_CLI, ...args], {
      env: { ...process.env, HOME: '/nonexistent-agentbuilt-forward-cli-test', AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
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
  seen = [];
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', (chunk) => { raw += chunk; }).on('end', () => {
      const room = req.headers['x-agentbuilt-room'];
      seen.push({ url: req.url ?? '', ...(typeof room === 'string' ? { room } : {}), body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, message: 'Forwarded 2 cards into your conversation: PR #1325 in infinite-agents (Platform) — Loading screen; knowledge proposal #353 (Platform) — Models.' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('agentbuilt forward', () => {
  it('sends the pairs in order, with --repo in the body and an old --room ignored (note #843), and prints the answer', async () => {
    const { status, stdout, stderr } = await runCli(['forward', 'pr', '#1325', 'knowledge', '353', '--repo', 'infinite-agents', '--room', 'Platform']);
    expect(stderr).toContain('--room is ignored');
    expect(status).toBe(0);
    expect(seen).toEqual([{
      url: '/api/agent-cli/forward', room: undefined,
      body: { items: [{ kind: 'pr', number: 1325 }, { kind: 'knowledge', number: 353 }], repo: 'infinite-agents' },
    }]);
    expect(stdout).toContain('Forwarded 2 cards into your conversation');
  });

  it('refuses a malformed list before asking the backend', async () => {
    for (const args of [['forward'], ['forward', 'pr'], ['forward', 'issue', '3'], ['forward', 'pr', 'x']]) {
      const { status, stderr } = await runCli(args);
      expect(status).toBe(1);
      expect(stderr).toContain('usage: agentbuilt forward pr <n>');
    }
    const many = await runCli(['forward', ...Array.from({ length: 6 }, (_, n) => ['pr', String(n + 1)]).flat()]);
    expect(many.status).toBe(1);
    expect(many.stderr).toContain('one to five');
    expect(seen).toEqual([]);
  });

  it('is in the help, under the Workspace Agent\'s verbs', async () => {
    const { stdout } = await runCli(['help']);
    const at = stdout.indexOf('agentbuilt forward pr <n>');
    expect(at).toBeGreaterThan(stdout.indexOf('Orchestrating the workplace (Workspace Agent only'));
    expect(stdout).toContain('CARDS in your conversation');
  });
});
