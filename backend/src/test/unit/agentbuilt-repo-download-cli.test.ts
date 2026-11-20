import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `agentbuilt repo download <name>` (note #1199), run through the real CLI
 * file against a stub backend: the zip lands on disk as sent, an existing
 * file is not overwritten unless asked, and a refusal is the backend's own
 * sentence.
 */

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));
const ZIP = Buffer.from('PK\u0003\u0004 pretend zip bytes');

let server: Server;
let apiUrl: string;
let dir: string;
let requested: Array<{ url: string; auth: string | undefined }>;

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_CLI, ...args], {
      cwd: dir,
      env: { ...process.env, HOME: '/nonexistent-agentbuilt-repo-download-test', AGENTBUILT_API_URL: apiUrl, AGENTBUILT_TOKEN: 'test-token' },
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
  dir = mkdtempSync(join(tmpdir(), 'repo-download-cli-'));
  requested = [];
  server = createServer((req, res) => {
    requested.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (req.url === '/api/agent-cli/repos/shop/download') {
      res.writeHead(200, { 'content-type': 'application/zip', 'x-download-estimate-bytes': String(ZIP.length) });
      res.end(ZIP);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No such repository here' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('agentbuilt repo download', () => {
  it('saves <name>.zip as sent, and says how to move it', async () => {
    const { status, stdout } = await runCli(['repo', 'download', 'shop']);
    expect(status).toBe(0);
    expect(requested).toEqual([{ url: '/api/agent-cli/repos/shop/download', auth: 'Bearer test-token' }]);
    expect(readFileSync(join(dir, 'shop.zip'))).toEqual(ZIP);
    expect(stdout).toContain('Saved shop.zip');
    expect(stdout).toContain('every branch, tag and commit of shop');
    expect(stdout).toContain('git push --mirror <its url>');
  });

  it('-o names the file, and an existing one stays unless --overwrite', async () => {
    writeFileSync(join(dir, 'mine.zip'), 'keep me');
    const refused = await runCli(['repo', 'download', 'shop', '-o', 'mine.zip']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('already exists');
    expect(readFileSync(join(dir, 'mine.zip'), 'utf8')).toBe('keep me');
    const replaced = await runCli(['repo', 'download', 'shop', '-o', 'mine.zip', '--overwrite']);
    expect(replaced.status).toBe(0);
    expect(readFileSync(join(dir, 'mine.zip'))).toEqual(ZIP);
  });

  it('a refusal is the backend\'s own words, and no file is left behind', async () => {
    const { status, stderr } = await runCli(['repo', 'download', 'nope']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('No such repository here');
    expect(() => readFileSync(join(dir, 'nope.zip'))).toThrow();
  });

  it('is listed in the repo usage line', async () => {
    const { stderr } = await runCli(['repo', 'frobnicate']);
    expect(stderr).toContain('download');
  });
});
