import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sendRepoZip } from '../../services/repo-download.js';

/**
 * Download a repository (note #1199): the git host's zip is an ordinary git
 * repository once unpacked — every branch, tag and commit the server holds,
 * the default branch checked out, nothing of the server's own (hooks, the
 * webhook address) along for the ride — and `git push --mirror` from it
 * reproduces the server's refs exactly. Then the backend's pass-through says
 * the host's refusals in words.
 */

const HOST_SCRIPT = fileURLToPath(new URL('../../../../infra/git-host/git-host.mjs', import.meta.url));
const SECRET = 'download-secret';
const USER = 'user-1';

/** The test's own zip reader — no unzip binary on every CI machine, and a
 *  second implementation is a better witness than the writer's own. */
function unzipTo(zip: Buffer, into: string): string[] {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20);
    const usize = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    names.push(name);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data) >>> 0).toBe(crc);
    const target = join(into, name);
    if (name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(dirname(target), { recursive: true });
    if ((mode & 0o170000) === 0o120000) { symlinkSync(data.toString('utf8'), target); continue; }
    writeFileSync(target, data);
    chmodSync(target, mode & 0o777);
  }
  return names;
}

function waitForLine(child: ChildProcess, pattern: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('git-host did not start')), 15_000);
    let buffered = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const match = pattern.exec(buffered);
      if (match) { clearTimeout(timer); resolve(match); }
    });
  });
}

describe('download a repository with its whole history (note #1199)', () => {
  let dir: string;
  let reposRoot: string;
  let host: ChildProcess;
  let hostUrl: string;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const refsOf = (gitDir: string) => execFileSync('git', ['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname) %(refname)'], { env, encoding: 'utf8' });
  const control = (path: string, body: unknown) => fetch(`${hostUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-git-host-secret': SECRET }, body: JSON.stringify(body),
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'repo-download-'));
    reposRoot = join(dir, 'repos');
    const bare = join(reposRoot, USER, 'shop.git');
    mkdirSync(dirname(bare), { recursive: true });
    git(['init', '--quiet', '--bare', '-b', 'main', bare], dir);
    // What a server repository carries that a person's copy must NOT: its
    // gate and its webhook address.
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n');
    git(['--git-dir', bare, 'config', 'agentgit.webhookUrl', 'https://ci.internal/hook'], dir);

    const work = join(dir, 'work');
    git(['init', '--quiet', '-b', 'main', work], dir);
    writeFileSync(join(work, 'README.md'), '# Shop\n');
    mkdirSync(join(work, 'bin'));
    writeFileSync(join(work, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
    chmodSync(join(work, 'bin', 'run.sh'), 0o755);
    symlinkSync('README.md', join(work, 'readme-link'));
    writeFileSync(join(work, 'naïve café.txt'), 'über\n');
    git(['add', '-A'], work);
    git(['commit', '--quiet', '-m', 'first'], work);
    git(['tag', 'v1'], work);
    git(['checkout', '--quiet', '-b', 'feature/basket'], work);
    writeFileSync(join(work, 'basket.txt'), 'basket\n');
    git(['add', '-A'], work);
    git(['commit', '--quiet', '-m', 'basket'], work);
    git(['tag', '-a', 'v2', '-m', 'annotated'], work);
    git(['checkout', '--quiet', 'main'], work);
    writeFileSync(join(work, 'README.md'), '# Shop\n\nNow open.\n');
    git(['commit', '--quiet', '-am', 'open'], work);
    git(['push', '--quiet', bare, '--all'], work);
    git(['push', '--quiet', bare, '--tags'], work);
    git(['--git-dir', bare, 'init', '--quiet', '--bare', join(reposRoot, USER, 'empty.git')], dir);

    const { NODE_OPTIONS: _ignored, ...cleanEnv } = process.env;
    host = spawn(process.execPath, [HOST_SCRIPT], {
      env: { ...cleanEnv, PORT: '0', REPOS_ROOT: reposRoot, GIT_HOST_SECRET: SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = await waitForLine(host, /listening on 127\.0\.0\.1:(\d+)/);
    hostUrl = `http://127.0.0.1:${match[1]}`;
  }, 40_000);

  afterAll(() => {
    host?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says what the download will hold before anyone asks for it', async () => {
    const response = await control('/internal/repos/download-info', { userId: USER, name: 'shop' });
    expect(response.status).toBe(200);
    const info = await response.json() as Record<string, unknown>;
    expect(info).toMatchObject({ defaultBranch: 'main', branches: 2, tags: 2, commits: 3, tooLarge: false });
    expect(info.estimateBytes).toBe(Number(info.historyBytes) + Number(info.filesBytes));
  });

  it('unzips into an ordinary repository with every branch, tag and commit, and pushes --mirror to an identical copy', async () => {
    const response = await control('/internal/repos/download', { userId: USER, name: 'shop' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const zip = Buffer.from(await response.arrayBuffer());
    // An upper bound, said before the tap: the file never comes out bigger.
    expect(zip.length).toBeLessThanOrEqual(Number(response.headers.get('x-download-estimate-bytes')) + 64 * 1024);
    const out = join(dir, 'unzipped');
    const names = unzipTo(zip, out);
    expect(names[0]).toBe('shop/');
    const copy = join(out, 'shop');
    const server = join(reposRoot, USER, 'shop.git');

    // The default branch's files, as they stand — modes and links included.
    expect(readFileSync(join(copy, 'README.md'), 'utf8')).toBe('# Shop\n\nNow open.\n');
    expect(readFileSync(join(copy, 'naïve café.txt'), 'utf8')).toBe('über\n');
    expect(execFileSync('readlink', [join(copy, 'readme-link')], { encoding: 'utf8' }).trim()).toBe('README.md');
    expect(execFileSync('stat', ['-c', '%a', join(copy, 'bin', 'run.sh')], { encoding: 'utf8' }).trim()).toBe('755');
    expect(existsSync(join(copy, 'basket.txt'))).toBe(false);

    // An ordinary working repository: on main, nothing changed, intact.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], copy).trim()).toBe('main');
    expect(git(['status', '--porcelain'], copy)).toBe('');
    git(['fsck', '--strict', '--no-dangling'], copy);
    // Every ref exactly as the server holds it, and the same history.
    expect(refsOf(join(copy, '.git'))).toBe(refsOf(server));
    expect(git(['log', '--all', '--format=%H %P %s'], copy)).toBe(git(['--git-dir', server, 'log', '--all', '--format=%H %P %s'], dir));
    expect(git(['branch', '--format=%(refname:short)'], copy).split('\n').filter(Boolean)).toEqual(['feature/basket', 'main']);

    // Nothing of the server's own came along.
    const config = readFileSync(join(copy, '.git', 'config'), 'utf8');
    expect(config).not.toContain('webhookUrl');
    expect(config).not.toContain('[remote');
    expect(config).toMatch(/bare = false/);
    expect(readdirSync(join(copy, '.git', 'hooks'))).toEqual([]);

    // The move the screen describes: an empty repository elsewhere, then one push.
    const elsewhere = join(dir, 'elsewhere.git');
    git(['init', '--quiet', '--bare', elsewhere], dir);
    git(['push', '--quiet', '--mirror', elsewhere], copy);
    expect(refsOf(elsewhere)).toBe(refsOf(server));

    // The scratch copy it was built from is gone.
    expect(existsSync(join(dir, 'downloads')) ? readdirSync(join(dir, 'downloads')) : []).toEqual([]);
  });

  it('a repository with no commits arrives as its history alone', async () => {
    const response = await control('/internal/repos/download', { userId: USER, name: 'empty' });
    expect(response.status).toBe(200);
    const out = join(dir, 'unzipped-empty');
    unzipTo(Buffer.from(await response.arrayBuffer()), out);
    expect(git(['rev-parse', '--git-dir'], join(out, 'empty')).trim()).toBe('.git');
    expect(refsOf(join(out, 'empty', '.git'))).toBe('');
  });

  it('a repository the host does not have is a 404, not an empty zip', async () => {
    const response = await control('/internal/repos/download', { userId: USER, name: 'nope' });
    expect(response.status).toBe(404);
  });
});

describe('the backend passes the zip through, and the refusals in words', () => {
  const serve = async (download: () => Promise<Response>) => {
    const app = express();
    app.get('/zip', (_req, res) => { void sendRepoZip({ download }, { userId: 'u', name: 'shop' }, res); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/zip`);
    const body = Buffer.from(await response.arrayBuffer());
    server.close();
    return { response, body };
  };

  it('streams the bytes with a filename the browser saves it under', async () => {
    const { response, body } = await serve(async () => new Response('PK-bytes', {
      status: 200, headers: { 'content-type': 'application/zip', 'x-download-estimate-bytes': '1234' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="shop.zip"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-download-estimate-bytes')).toBe('1234');
    expect(body.toString()).toBe('PK-bytes');
  });

  it.each([
    [429, 429, 'Another download is being prepared'],
    [413, 413, 'too big for one zip'],
    [507, 507, 'short of disk'],
    [500, 502, 'could not make this download'],
  ])('host %i → %i, said in words', async (hostStatus, status, words) => {
    const { response, body } = await serve(async () => new Response(JSON.stringify({ error: 'x' }), { status: hostStatus }));
    expect(response.status).toBe(status);
    expect(JSON.parse(body.toString()).error).toContain(words);
  });

  it('a host from before downloads is "not available yet", not "no such repository"', async () => {
    const { response, body } = await serve(async () => new Response(JSON.stringify({ error: 'no such control route' }), { status: 404 }));
    expect(response.status).toBe(503);
    expect(JSON.parse(body.toString()).error).toContain('not available on this repository\'s code host yet');
  });

  it('an unreachable host is a 502 with a sentence', async () => {
    const { response } = await serve(async () => { throw new Error('ECONNREFUSED'); });
    expect(response.status).toBe(502);
  });
});
