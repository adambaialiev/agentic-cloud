import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));

let root: string;
let clone: string;
let other: string;
let remote: string;
let server: Server;
let apiUrl: string;
let posted: unknown[];
let repoPrs: unknown[];
let readied: number[];

const git = (cwd: string, args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

const write = (dir: string, value: string) => writeFileSync(join(dir, 'shared.txt'), value);

function commit(dir: string, subject: string) {
  git(dir, ['add', 'shared.txt']);
  git(dir, ['commit', '-m', subject]);
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_CLI, ...args], {
      cwd: clone,
      env: {
        ...process.env,
        HOME: '/nonexistent-agentbuilt-pr-note-cli-test',
        AGENTBUILT_API_URL: apiUrl,
        AGENTBUILT_TOKEN: 'test-token',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentbuilt-pr-note-'));
  remote = join(root, 'test.git');
  clone = join(root, 'work');
  other = join(root, 'other');
  execFileSync('git', ['init', '--bare', remote]);
  execFileSync('git', ['clone', remote, clone]);
  for (const dir of [clone]) {
    git(dir, ['config', 'user.email', 'agent@example.test']);
    git(dir, ['config', 'user.name', 'Agent']);
  }
  git(clone, ['switch', '-c', 'main']);
  write(clone, 'base\n');
  commit(clone, 'Base');
  git(clone, ['push', '-u', 'origin', 'main']);
  git(clone, ['switch', '-c', 'note-work']);
  write(clone, 'feature\n');
  commit(clone, 'Implement request');

  execFileSync('git', ['clone', '--branch', 'main', remote, other]);
  git(other, ['config', 'user.email', 'other@example.test']);
  git(other, ['config', 'user.name', 'Other']);

  posted = [];
  repoPrs = [];
  readied = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && url.pathname === '/api/agent-cli/notes/99') {
        res.end(JSON.stringify({ note: { html: '<p>Do it</p>', work: { state: 'working', byYou: true } } }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/agent-cli/repos/test/prs') {
        res.end(JSON.stringify({ prs: repoPrs }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agent-cli/repos/test/prs') {
        posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.end(JSON.stringify({ pr: { number: 7 }, message: 'PR #7 opened.' }));
        return;
      }
      const ready = url.pathname.match(/^\/api\/agent-cli\/repos\/test\/prs\/(\d+)\/ready$/);
      if (req.method === 'POST' && ready) {
        readied.push(Number(ready[1]));
        res.end(JSON.stringify({ ok: true, message: `PR #${ready[1]} is with your user now.` }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `No stub for ${req.method} ${url.pathname}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe('agentbuilt pr create --note', () => {
  it('refuses a bare --note instead of silently opening an unlinked proposal', async () => {
    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--note needs a note number');
    expect(posted).toEqual([]);
  });

  it('fetches main and stops before proposing when newer main conflicts with the branch', async () => {
    write(other, 'main moved\n');
    commit(other, 'Move the shared file');
    git(other, ['push', 'origin', 'main']);

    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('conflicting changes in 1 file');
    expect(result.stderr).toContain('shared.txt');
    expect(result.stderr).toContain('No proposal was created');
    expect(posted).toEqual([]);
  });

  // The refusal this replaces: a shared filename is not a clash. Several
  // agents work one repo, the busiest files move every few minutes, and a
  // rebase plus a full re-run of the checks takes long enough for main to move
  // again — so refusing on the name alone refused work that merges cleanly.
  it('proposes when main moved in the same file but nowhere near the branch', async () => {
    // Both sides edit long.txt: main rewrites the first line, the branch the
    // last. Same file, different regions — git merges this without a murmur.
    const long = (first: string, last: string) => (
      [first, 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', last].join('\n') + '\n'
    );
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'long.txt'), long('first', 'last'));
    git(clone, ['add', 'long.txt']);
    git(clone, ['commit', '-m', 'Add the long file']);
    git(clone, ['push', 'origin', 'main']);
    git(other, ['pull', '--ff-only']);

    git(clone, ['switch', '-c', 'far-apart']);
    writeFileSync(join(clone, 'long.txt'), long('first', 'BRANCH TOUCHED THE END'));
    git(clone, ['commit', '-am', 'Change the end']);

    writeFileSync(join(other, 'long.txt'), long('MAIN TOUCHED THE START', 'last'));
    git(other, ['commit', '-am', 'Change the start']);
    git(other, ['push', 'origin', 'main']);

    const result = await runCli([
      'pr', 'create', '--from', 'far-apart', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(posted).toEqual([expect.objectContaining({ notes: [99], from: 'far-apart' })]);
    // Let through, but not silently: the checks ran against the older main.
    expect(result.stderr).toContain('still merges onto it cleanly');
    expect(result.stderr).toContain('long.txt');
    expect(result.stderr).toContain('checks ran against the earlier main');
  });

  it('sends the structured link after a clean current-main preflight', async () => {
    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('PR #7 opened');
    expect(posted).toEqual([expect.objectContaining({ notes: [99], from: 'note-work' })]);
  });

  // Note #759: three repos in Adam's Demonstrations workplace had no `main`
  // (the first push went to a branch), and this preflight's `git fetch origin
  // main` refused every note-linked first proposal — the work could not be
  // proposed at all. Nothing approved on the target means nothing to overlap.
  it('links the note in a protected repo whose main does not exist yet', async () => {
    execFileSync('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/main']);

    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('nothing has been approved on main yet');
    expect(posted).toEqual([expect.objectContaining({ notes: [99], from: 'note-work' })]);
  });

  it('links the note when main holds only its empty start, though the branch shares no history with it', async () => {
    // The start the git host gives every protected repo since note #759: no
    // parents, git's empty tree. An agent's own history never grew from it.
    const tree = execFileSync('git', ['--git-dir', remote, 'mktree'], { input: '', encoding: 'utf8' }).trim();
    const start = execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-m', 'Nothing approved yet'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'P', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'P', GIT_COMMITTER_EMAIL: 'p@x' },
    }).trim();
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', start]);

    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('nothing has been approved on main yet');
    expect(posted).toEqual([expect.objectContaining({ notes: [99], from: 'note-work' })]);
  });

  it('refuses in plain words, not a stack, when the branch shares no history with an approved main', async () => {
    git(other, ['checkout', '-q', '--orphan', 'elsewhere']);
    write(other, 'someone else\n');
    commit(other, 'Unrelated history');
    git(other, ['push', '-f', 'origin', 'elsewhere:main']);

    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('note-work shares no history with current main');
    expect(result.stderr).toContain('git rebase origin/main');
    expect(result.stderr).not.toContain('    at ');
    expect(posted).toEqual([]);
  });

  // A commit subject is only words, so this heuristic cannot be scoped and
  // must not refuse: a subject naming "#99" may be an older note that gave
  // that number up (per-room numbers before 12 Oct, renumbered when rooms
  // went, note #843), and it stays on main for good. Say it and let the
  // agent judge — the note read and the backend both still fence a real
  // duplicate.
  it('warns but proposes when a commit on main names the same short note number', async () => {
    writeFileSync(join(other, 'unrelated.txt'), 'shipped\n');
    git(other, ['add', 'unrelated.txt']);
    git(other, ['commit', '-m', 'Already shipped (note #99)']);
    git(other, ['push', 'origin', 'main']);

    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('contains a commit naming note #99');
    expect(result.stderr).toContain('Already shipped (note #99)');
    // Rooms are gone (note #843): the doubt is an older note that once
    // carried the number, never "another room's".
    expect(result.stderr).toContain('If that commit is for this same note — and not an older note that once carried its number — do not propose a second implementation.');
    expect(result.stderr).not.toMatch(/\brooms?\b/i);
    expect(posted).toEqual([expect.objectContaining({ notes: [99], from: 'note-work' })]);
  });

  // Note numbers are room-scoped (notes #108, #158), so a merged proposal in
  // ANOTHER room carrying the same short number must not refuse this one —
  // the block that stopped Growth's notes #125 and #128 for good. The stub
  // keeps serving that proposal: scan the repository's list by bare number
  // again and this goes red.
  it('proposes although another room merged a proposal with the same note number', async () => {
    repoPrs = [{
      number: 371,
      status: 'merged',
      title: 'Make New agent a compact fleet plate',
      quickNoteNumbers: [99],
    }];

    const result = await runCli([
      'pr', 'create', '--from', 'note-work', '--title', 'Implement request', '--note', '99',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(posted).toEqual([expect.objectContaining({ notes: [99], from: 'note-work' })]);
  });
});

/**
 * `pr ready` (note #293): the invitation as its own step. What the CLI owns
 * here is the no-number form — finding the quiet proposal from the branch the
 * clone is on — which is what lets `… && pr create … && pr ready` run as one
 * chain without the agent reading a number out of the previous line.
 */
describe('agentbuilt pr ready', () => {
  it('names the number it was given', async () => {
    const result = await runCli(['pr', 'ready', '7']);
    expect(result.status).toBe(0);
    expect(readied).toEqual([7]);
    expect(result.stdout).toContain('PR #7 is with your user now.');
  });

  it('without a number, finds the one quiet proposal from this branch', async () => {
    repoPrs = [
      { number: 3, status: 'open', from: 'other-work', to: 'main', draft: true, diffStat: { insertions: 1, deletions: 0 }, title: 'Other' },
      { number: 5, status: 'open', from: 'note-work', to: 'main', diffStat: { insertions: 1, deletions: 0 }, title: 'Already shown' },
      { number: 7, status: 'open', from: 'note-work', to: 'main', draft: true, diffStat: { insertions: 1, deletions: 0 }, title: 'Implement request' },
    ];
    const result = await runCli(['pr', 'ready']);
    expect(result.status).toBe(0);
    expect(readied).toEqual([7]);
  });

  it('stops rather than guess when this branch has no quiet proposal, or two', async () => {
    repoPrs = [];
    const none = await runCli(['pr', 'ready']);
    expect(none.status).not.toBe(0);
    expect(none.stderr).toContain('no quiet proposal comes from "note-work"');
    expect(readied).toEqual([]);

    repoPrs = [
      { number: 7, status: 'open', from: 'note-work', to: 'main', draft: true, diffStat: { insertions: 1, deletions: 0 }, title: 'One' },
      { number: 8, status: 'open', from: 'note-work', to: 'main', draft: true, diffStat: { insertions: 1, deletions: 0 }, title: 'Two' },
    ];
    const two = await runCli(['pr', 'ready']);
    expect(two.status).not.toBe(0);
    expect(two.stderr).toContain('2 quiet proposals come from "note-work"');
    expect(readied).toEqual([]);
  });

  it('marks a quiet proposal in the list, with the command that shows it', async () => {
    repoPrs = [
      { number: 7, status: 'open', from: 'note-work', to: 'main', draft: true, diffStat: { insertions: 1, deletions: 0 }, title: 'Implement request' },
    ];
    const result = await runCli(['pr', 'list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('quiet');
    expect(result.stdout).toContain('agentbuilt pr ready 7');
  });
});

