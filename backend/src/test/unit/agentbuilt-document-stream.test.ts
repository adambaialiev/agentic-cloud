import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A DOCUMENT the CLI prints stays whole when the caller merged the streams.
 *
 * `knowledge show` and `note show` put the document on stdout and the margin
 * — comments, status, files — on stderr. Writing to stdout is asynchronous
 * when stdout is a pipe while stderr goes out straight away, so a caller who
 * merged the two (`... 2>&1 | …`, the natural thing to write when you want
 * the page and its margin together) used to get the margin spliced into the
 * MIDDLE of the document, at the pipe's 64 KiB boundary, with no error and
 * exit status 0.
 *
 * Nothing was lost, which is what made it dangerous: a reader that stops at
 * the first `[comment · ` marker kept the first two thirds of a page and could
 * not tell. The page on stdout is exactly what gets edited and proposed back,
 * so the silent short read turns into a confident wrong edit.
 *
 * These tests spawn the real CLI through a shell that merges the streams, and
 * assert the document arrives before any margin line. They only fail once the
 * document is larger than the pipe buffer, which is why the fixture is big.
 */

const SOURCE_CLI = fileURLToPath(new URL('../../../../cli/agentbuilt/agentbuilt.mjs', import.meta.url));

/** Comfortably past the 64 KiB pipe buffer, where the splice used to land. */
const LINES = 2000;
const PAGE_HTML = Array.from({ length: LINES }, (_, i) => `<p>line ${i} ${'pad '.repeat(15)}</p>`).join('\n');
const LAST_LINE = `<p>line ${LINES - 1} `;

let server: Server;
let apiUrl: string;

/**
 * Run the CLI with stderr redirected ONTO stdout, the way a caller does, and
 * give back the one merged stream. `sh -c` is what makes the two file
 * descriptors the same pipe; spawning with two 'pipe' stdio slots would give
 * them separate pipes and could never reproduce this.
 */
function runMerged(args: string[]): Promise<{ status: number | null; merged: string }> {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(SOURCE_CLI)} ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1 | cat`;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      env: {
        ...process.env,
        HOME: '/nonexistent-agentbuilt-document-stream-test',
        AGENTBUILT_API_URL: apiUrl,
        AGENTBUILT_TOKEN: 'test-token',
      },
    });
    let merged = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { merged += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { merged += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, merged }); });
  });
}

beforeEach(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    res.setHeader('content-type', 'application/json');

    if (url.pathname.startsWith('/api/agent-cli/knowledge/pages/')) {
      res.end(JSON.stringify({
        page: {
          name: 'big-page',
          html: PAGE_HTML,
          comments: [
            { by: 'Nina', createdAt: new Date().toISOString(), text: 'stale since the deploy moved' },
            { by: 'Oscar', createdAt: new Date().toISOString(), text: 'checked, still true' },
          ],
        },
      }));
      return;
    }

    if (url.pathname.startsWith('/api/agent-cli/notes/')) {
      res.end(JSON.stringify({
        note: {
          number: 7,
          html: PAGE_HTML,
          href: '/workspace/notes/7?org=o1&room=r1',
          work: { state: 'unclaimed' },
          comments: [{ by: 'Nina', createdAt: new Date().toISOString(), text: 'I called, they are closed Mondays' }],
        },
      }));
      return;
    }

    if (url.pathname.startsWith('/api/agent-cli/mail/')) {
      res.end(JSON.stringify({
        message: {
          id: 'm1',
          direction: 'received',
          from: { address: 'stranger@example.com' },
          subject: 'hello',
          text: PAGE_HTML,
          attachments: [{ id: 'f1', fileName: 'invoice.pdf', size: 2048 }],
          rawSize: 4096,
        },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a printed document survives 2>&1', () => {
  it('keeps a knowledge page whole, with every comment after it', async () => {
    const { status, merged } = await runMerged(['knowledge', 'show', 'big-page']);
    expect(status).toBe(0);

    const lines = merged.split('\n');
    const firstComment = lines.findIndex((line) => line.startsWith('[comment · '));
    const lastPageLine = lines.findLastIndex((line) => line.startsWith(LAST_LINE));

    expect(firstComment).toBeGreaterThan(-1);
    expect(lastPageLine).toBeGreaterThan(-1);
    // The whole point: no margin line lands inside the document.
    expect(lastPageLine).toBeLessThan(firstComment);

    // And the document that a naive reader extracts is the real one.
    const extracted = lines.slice(0, firstComment).join('\n').trimEnd();
    expect(extracted).toBe(PAGE_HTML);
  });

  it('keeps an untrusted mail body inside its frame, with our own lines after it', async () => {
    const { status, merged } = await runMerged(['mail', 'show', 'm1']);
    expect(status).toBe(0);

    const lines = merged.split('\n');
    const lastBodyLine = lines.findLastIndex((line) => line.startsWith(LAST_LINE));
    const closingRule = lines.findIndex((line) => line.startsWith('--- the message from') && line.includes('ends'));
    const ourFileList = lines.findIndex((line) => line.startsWith('Files:'));

    // The frame is an injection defence: nothing of ours may appear between
    // the rules, or a stranger's words can be made to read as the platform's.
    expect(closingRule).toBeGreaterThan(lastBodyLine);
    expect(ourFileList).toBeGreaterThan(lastBodyLine);
  });

  it('keeps a note whole, with its status and margin after it', async () => {
    const { status, merged } = await runMerged(['note', 'show', '7']);
    expect(status).toBe(0);

    const lines = merged.split('\n');
    const lastPageLine = lines.findLastIndex((line) => line.startsWith(LAST_LINE));
    const firstMargin = lines.findIndex((line) => line.startsWith('Open: ') || line.startsWith('status: ') || line.startsWith('[comment · '));

    expect(firstMargin).toBeGreaterThan(-1);
    expect(lastPageLine).toBeLessThan(firstMargin);
  });
});
