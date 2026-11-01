import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The note verbs, RUN — against a stub backend, but through the real CLI file
 * the backend ships to every machine.
 *
 * Written for a crash that reached production: the row recap (v67) deleted the
 * `describe`/`task` commands and took `agoLabel` with them, while `note list`
 * and `note show` — its other two callers — kept calling it. Every `note list`
 * on every machine then died with `agoLabel is not defined`, and nothing in
 * the suite noticed, because a ReferenceError on a helper only happens when
 * the line that calls it is actually EXECUTED. The backend tests exercised the
 * routes, never the renderer; `npm run lint` would have flagged it, but lint
 * is advisory in CI and the CLI is a .mjs file the config never matched.
 *
 * So these tests spawn the CLI and read what a person would see. Anything that
 * makes a note row fail to render fails here, whatever the cause.
 */

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));

/** Fixed instants so the rendered "ago" labels are exact, not clock-dependent. */
const NOW = Date.now();
const MINUTES_AGO = (n: number) => new Date(NOW - n * 60_000).toISOString();

let server: Server;
let apiUrl: string;
/** Every path the CLI asked for, so a test can prove which route it hit. */
let requested: string[];

/**
 * Async on purpose. The stub backend runs on THIS process's event loop, so a
 * synchronous spawn deadlocks: the CLI waits on a fetch the blocked server can
 * never answer, and every test dies on its timeout looking like a CLI hang.
 */
function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_CLI, ...args], {
      env: {
        ...process.env,
        // No ~/.agentbuilt/config.json to fall back on: the env vars below are
        // the only credentials, so a test can never reach the real backend.
        HOME: '/nonexistent-agentbuilt-note-cli-test',
        AGENTBUILT_API_URL: apiUrl,
        AGENTBUILT_TOKEN: 'test-token',
      },
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
  server = createServer((req, res) => {
    requested.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://stub');
    res.setHeader('content-type', 'application/json');

    if (url.pathname === '/api/agent-cli/notes' && req.method === 'POST') {
      res.end(JSON.stringify({
        message: 'Note #13 saved — "New note".',
        note: { number: 13, href: '/workspace/notes/13?org=o1&room=r1' },
      }));
      return;
    }

    if (url.pathname === '/api/agent-cli/notes' && req.method === 'GET') {
      const archived = url.searchParams.get('archived');
      if (archived === '1') {
        res.end(JSON.stringify({
          notes: [{ number: 7, title: 'Put away last month', updatedAt: MINUTES_AGO(60 * 24 * 3) }],
        }));
        return;
      }
      res.end(JSON.stringify({
        notes: [
          // The user's own note, with comments and a file: every optional
          // branch of the row on one line.
          {
            number: 12, title: 'Reset and stop', updatedAt: MINUTES_AGO(29),
            byUser: true, comments: 2, files: 1,
            work: { state: 'working', agentName: 'Ben', byYou: true },
          },
          {
            number: 11, title: 'An agent wrote this one', updatedAt: MINUTES_AGO(60 * 5),
            work: { state: 'unclaimed' },
          },
          // Handed, both ways round (notes #234/#258): the user gave this one
          // to THIS agent, and that one to somebody else.
          {
            number: 10, title: 'Yours to start', updatedAt: MINUTES_AGO(3),
            work: { state: 'handed', agentName: 'Ben', byYou: true },
          },
          {
            number: 9, title: 'Asked of Ivy', updatedAt: MINUTES_AGO(4),
            work: { state: 'handed', agentName: 'Ivy' },
          },
        ],
        archived: 3,
      }));
      return;
    }

    if (url.pathname === '/api/agent-cli/notes/12' && req.method === 'GET') {
      res.end(JSON.stringify({
        note: {
          html: '<p>Reset and stop</p>',
          href: '/workspace/notes/12?org=o1&room=r1',
          comments: [
            { by: 'Ben', text: 'Both modes already exist.', createdAt: MINUTES_AGO(60 * 24 * 7) },
            // No createdAt: the label is skipped, and the comment still prints.
            { by: 'Nina', text: 'Undated remark.' },
          ],
          attachments: [{ fileName: 'shot.png', sizeBytes: 2048 }],
          work: { state: 'working', agentName: 'Ben', byYou: true },
        },
      }));
      return;
    }

    if (url.pathname === '/api/agent-cli/notes/12' && req.method === 'PUT') {
      res.end(JSON.stringify({
        message: 'Note #12 updated — "Reset and stop".',
        note: { number: 12, href: '/workspace/notes/12?org=o1&room=r1' },
      }));
      return;
    }

    if (url.pathname === '/api/agent-cli/notes/12/claim' && req.method === 'POST') {
      res.end(JSON.stringify({
        outcome: 'renewed',
        message: 'Renewed your claim on note #12 until later.',
        note: {
          html: '<p>Reset and stop</p>',
          href: '/workspace/notes/12?org=o1&room=r1',
          work: { state: 'working', agentName: 'Ben', byYou: true },
          comments: [{ by: 'Nina', text: 'Read this too.' }],
        },
      }));
      return;
    }

    if (url.pathname === '/api/agent-cli/notes/12/claim' && req.method === 'DELETE') {
      res.end(JSON.stringify({ message: 'Released note #12; it is Unclaimed again.' }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: `stub has no route for ${url.pathname}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('agentbuilt note, rendered', () => {
  it('lists notes without crashing, and dates every row', async () => {
    const result = await runCli(['note', 'list']);

    // The assertion the crash would have failed: a non-zero exit with the
    // renderer's own error on stderr.
    expect(result.stderr).toBe('');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    expect(result.stdout).toContain('#12');
    expect(result.stdout).toContain('Reset and stop');
    // agoLabel's output, which is the part that went missing.
    expect(result.stdout).toContain('(29m ago)');
    expect(result.stdout).toContain('(5h ago)');
    // The optional row decorations, each on its own branch.
    expect(result.stdout).toContain('(your user wrote this)');
    expect(result.stdout).toContain('[2 comments]');
    expect(result.stdout).toContain('[1 file]');
    expect(result.stdout).toContain('[Working by you]');
    expect(result.stdout).toContain('[Unclaimed]');
    // The two readings of Handed that mean opposite things to the agent
    // reading its own list: a request already addressed TO IT, and one
    // already asked of somebody else.
    expect(result.stdout).toContain('[Handed to you]');
    expect(result.stdout).toContain('[Handed to Ivy]');
    // The archive pointer — the only place an agent learns it has anything.
    expect(result.stdout).toContain('3 notes in the archive');
  });

  it('renders the archived list too', async () => {
    const result = await runCli(['note', 'list', '--archived']);

    expect(result.stderr).toBe('');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(requested).toContain('/api/agent-cli/notes?archived=1');
    expect(result.stdout).toContain('Put away last month');
    expect(result.stdout).toContain('(3d ago)');
  });

  it('shows a note, and dates its comments on stderr', async () => {
    const result = await runCli(['note', 'show', '12']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The note's exact source and nothing else on stdout: `note show 12 >
    // note.html` has to stay editable, so the margin goes to stderr.
    expect(result.stdout).toBe('<p>Reset and stop</p>\n');
    expect(result.stderr).toContain('[comment · Ben · (7d ago)]');
    expect(result.stderr).toContain('Both modes already exist.');
    // A comment with no timestamp still prints, with no label and no crash.
    expect(result.stderr).toContain('[comment · Nina]');
    expect(result.stderr).toContain('file: shot.png');
    expect(result.stderr).toContain('status: Working by you');
    expect(result.stderr).toContain('Open: /workspace/notes/12?org=o1&room=r1');
  });

  it('starts by atomically claiming and printing the current note', async () => {
    const result = await runCli(['note', 'start', '12']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(requested).toContain('/api/agent-cli/notes/12/claim');
    expect(result.stdout).toBe('<p>Reset and stop</p>\n');
    expect(result.stderr).toContain('Renewed your claim on note #12');
    expect(result.stderr).toContain('status: Working by you');
    expect(result.stderr).toContain('[comment · Nina]');
    expect(result.stderr).toContain('Open: /workspace/notes/12?org=o1&room=r1');
  });

  it('prints the backend-authored route after creating and editing a note', async () => {
    const added = await runCli(['note', 'add', '<h2>New note</h2>']);
    expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0);
    expect(added.stdout).toContain('Note #13 saved');
    expect(added.stderr).toContain('Open: /workspace/notes/13?org=o1&room=r1');

    const edited = await runCli(['note', 'edit', '12', '<p>Reset and stop</p>']);
    expect(edited.status, `${edited.stdout}\n${edited.stderr}`).toBe(0);
    expect(edited.stdout).toContain('Note #12 updated');
    expect(edited.stderr).toContain('Open: /workspace/notes/12?org=o1&room=r1');
  });

  it('releases a claim explicitly', async () => {
    const result = await runCli(['note', 'release', '12']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Unclaimed again');
  });
});
