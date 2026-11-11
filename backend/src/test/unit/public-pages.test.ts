import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { workspaceRootRoutes } from '../../routes/workspace-root.js';
import {
  DESCRIPTION_MAX, clip, injectPublicPage, markdownToHtml, publicPages, shellTakesPublicPage,
  type PublicPageReads, type PublicRepoPageData,
} from '../../routes/public-pages.js';
import type { WorkspacePublicPersonAnswer } from '../../shared/workspace-api.js';

/* The search report's larger fixes (note #1153): /apps, a public repository
   and a person's page carry their title, description, canonical, share tags
   and text for a crawler that runs no scripts; an address that is nobody's
   answers 404; a signed-in person gets the shell byte for byte. */

const SHELL_HTML = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Your workspace</title>\n<script type="module" crossorigin src="/workspace/app/assets/index.js"></script>\n</head>\n<body class="web-mode">\n<div id="root"></div>\n</body>\n</html>\n';

const ADAM: WorkspacePublicPersonAnswer = {
  handle: 'adam',
  name: 'Adam B',
  repos: [{ name: 'agentic-cloud', workplace: 'ACC', workplaceHandle: 'acc', publicUrl: 'https://agenticcloudcomputer.com/acc/agentic-cloud', commits: 42 }],
};

const README = [
  '# Agentic Cloud Computer',
  '',
  '**A few people, a fleet of agents, huge output.** It costs $& nothing to read <script>alert(1)</script> this.',
  '',
  '- Product: https://agenticcloudcomputer.com',
  '- Licence: [GNU AGPL-3.0](LICENSE) and [a trap](javascript:alert(1))',
  '',
  '| Customer | Platform |',
  '| --- | --- |',
  '| Fly | Control plane |',
  '',
  '```sh',
  'npm install <x>',
  '```',
].join('\n');

const REPO_PAGE: PublicRepoPageData = {
  name: 'agentic-cloud',
  handle: 'acc',
  cloneUrl: 'https://git.example/acc/agentic-cloud.git',
  branch: 'main',
  description: 'A few people, a fleet of agents, huge output.',
  license: 'GNU AGPL-3.0',
  entries: [{ name: 'backend', type: 'dir' }, { name: 'README.md', type: 'file' }],
  readme: { name: 'README.md', content: README },
  latest: { subject: 'Search: the quick fixes', at: '2026-11-11T10:20:00Z', authorName: 'Rosa' },
};

/** A session is the cookie `session=member`; the reads answer as the doors do. */
const reads: PublicPageReads & { calls: string[] } = {
  calls: [],
  async signedIn(req) { return /session=member/.test(String(req.headers.cookie ?? '')); },
  async apps() {
    reads.calls.push('apps');
    return [{
      name: 'ember-coffee', url: 'https://ember-coffee.agentbuilt.app', line: 'A coffee shop’s menu & orders.',
      builder: { name: 'Adam B', handle: 'adam' }, publishedAt: '2026-11-10T09:00:00Z', createdAt: '2026-11-01T09:00:00Z',
    }];
  },
  async address(handle, req) {
    reads.calls.push(`address:${handle}`);
    if (handle === 'adam') return { kind: 'person', person: ADAM };
    if (handle === 'acc' && /session=member/.test(String(req.headers.cookie ?? ''))) return { kind: 'workplace' };
    return null;
  },
  async repo(handle, name, req, withPage) {
    reads.calls.push(`repo:${handle}/${name}:${withPage}`);
    if (handle === 'acc' && name === 'agentic-cloud') return withPage ? { kind: 'public', page: REPO_PAGE } : { kind: 'public' };
    if (handle === 'acc' && name === 'private' && /session=member/.test(String(req.headers.cookie ?? ''))) return { kind: 'member' };
    return null;
  },
};

describe('the public pages, as a crawler and as a browser read them (note #1153)', () => {
  let shellDir: string;
  let server: Server;
  let base: string;
  const get = async (url: string, cookie?: string) => {
    const res = await fetch(base + url, { headers: cookie ? { cookie } : {} });
    return { status: res.status, html: await res.text(), headers: res.headers };
  };

  beforeAll(async () => {
    shellDir = mkdtempSync(path.join(tmpdir(), 'public-pages-'));
    mkdirSync(path.join(shellDir, 'assets'));
    writeFileSync(path.join(shellDir, 'index.html'), SHELL_HTML);
    const app = express();
    app.use(workspaceRootRoutes({
      workspaceUiDir: shellDir,
      publicPage: publicPages(reads, {
        origin: 'https://agenticcloudcomputer.com',
        host: 'agenticcloudcomputer.com',
        image: { url: 'https://agenticcloudcomputer.com/og-image.png?v=33', alt: 'The card' },
        memoMs: 0,
      }),
    }));
    app.use((_req, res) => { res.status(418).send('passed on'); });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(shellDir, { recursive: true, force: true });
  });

  it('writes /apps with its title, description, canonical, share tags and every card', async () => {
    const { status, html, headers } = await get('/apps');
    expect(status).toBe(200);
    expect(html).toContain('<title>Apps — Agentic Cloud Computer</title>');
    expect(html).toMatch(/<meta name="description" content="1 app built and launched on Agentic Cloud Computer/);
    expect(html).toContain('<link rel="canonical" href="https://agenticcloudcomputer.com/apps">');
    expect(html).toContain('<meta property="og:title" content="Apps — Agentic Cloud Computer">');
    expect(html).toContain('<meta property="og:image" content="https://agenticcloudcomputer.com/og-image.png?v=33">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<h1>Apps</h1>');
    expect(html).toContain('A coffee shop’s menu &amp; orders.');
    expect(html).toContain('<a href="/adam">Adam B</a>');
    expect(html).not.toContain('Your workspace');
    // The app itself is untouched: the same script, and the text hidden
    // from any browser that runs it.
    expect(html).toContain('<script type="module" crossorigin src="/workspace/app/assets/index.js"></script>');
    expect(html).toContain('@media (scripting:enabled){#root>[data-public-text]{display:none}}');
    expect(headers.get('vary')).toBe('Cookie');
    expect(headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('sends a signed-in person the shell byte for byte, and reads nothing for it', async () => {
    reads.calls.length = 0;
    for (const url of ['/apps', '/adam', '/acc/agentic-cloud']) {
      const { status, html } = await get(url, 'session=member');
      expect(status, url).toBe(200);
      expect(html, url).toBe(SHELL_HTML);
    }
    expect(reads.calls).not.toContain('apps');
    expect(reads.calls).toContain('repo:acc/agentic-cloud:false');
  });

  it('writes a person’s page, with their repositories', async () => {
    const { status, html } = await get('/adam');
    expect(status).toBe(200);
    expect(html).toContain('<title>Adam B (adam)</title>');
    expect(html).toContain('<link rel="canonical" href="https://agenticcloudcomputer.com/adam">');
    expect(html).toContain('<meta property="og:type" content="profile">');
    expect(html).toContain('Public repositories: agentic-cloud.');
    expect(html).toContain('<a href="https://agenticcloudcomputer.com/acc/agentic-cloud">ACC / agentic-cloud</a> · 42 commits');
  });

  it('answers 404 at a word that is nobody’s, and at a workplace’s word to a stranger', async () => {
    for (const url of ['/nobody-here-zq7x', '/acc']) {
      const { status, html } = await get(url);
      expect(status, url).toBe(404);
      expect(html).toContain('<h1>Nothing at this address</h1>');
      expect(html).toContain(`<title>agenticcloudcomputer.com${url}</title>`);
      expect(html).not.toContain('og:title');
      expect(html).toContain('<script type="module"');
    }
    // A member is sent on to the workplace by the app, as before.
    expect((await get('/acc', 'session=member')).status).toBe(200);
    // Signed in, the word is still nobody's: 404, the same shell.
    const signedIn = await get('/nobody-here-zq7x', 'session=member');
    expect(signedIn.status).toBe(404);
    expect(signedIn.html).toBe(SHELL_HTML);
    // A reserved word was never a public address: passed on, as before.
    expect((await get('/ops')).status).toBe(418);
  });

  it('writes a public repository with its README, safely, and leaves its inner views to the app', async () => {
    const { status, html } = await get('/acc/agentic-cloud');
    expect(status).toBe(200);
    expect(html).toContain('<title>agentic-cloud · Public repository</title>');
    expect(html).toContain('<link rel="canonical" href="https://agenticcloudcomputer.com/acc/agentic-cloud">');
    expect(html).toContain('<meta name="description" content="agentic-cloud: A few people, a fleet of agents, huge output.">');
    expect(html).toContain('<h2>Agentic Cloud Computer</h2>');
    expect(html).toContain('git clone https://git.example/acc/agentic-cloud.git');
    expect(html).toContain('<td>Control plane</td>');
    expect(html).toContain('It costs $&amp; nothing');
    expect(html).toContain('npm install &lt;x&gt;');
    expect(html).not.toMatch(/<script>|javascript:/);
    expect(html).toContain('<a href="https://agenticcloudcomputer.com" rel="nofollow">');
    const inner = await get('/acc/agentic-cloud?path=backend');
    expect(inner.status).toBe(200);
    expect(inner.html).toBe(SHELL_HTML);
    expect((await get('/acc/private')).status).toBe(404);
    expect((await get('/acc/private', 'session=member')).status).toBe(200);
    expect((await get('/acc/no-such-repo')).status).toBe(404);
  });
});

describe('the pieces', () => {
  it('turns raw HTML and unsafe links in markdown into text', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)> [go](javascript:alert(1)) ![pic](https://x/y.png) `<b>`');
    expect(html).not.toMatch(/<img|onerror=alert\(1\)>|javascript:|<b>/);
    expect(html).toContain('go');
    expect(html).toContain('<code>&lt;b&gt;</code>');
  });

  it('clips a description at a word, never past the limit', () => {
    const long = 'word '.repeat(80);
    expect(clip(long).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(clip(long).endsWith('…')).toBe(true);
    expect(clip('short line')).toBe('short line');
  });

  it('leaves a shell it cannot write into as it is', () => {
    const odd = '<html><body><main></main></body></html>';
    expect(injectPublicPage(odd, { status: 200, head: { title: 'x' }, body: 'y' })).toBe(odd);
  });

  it('finds both places in the Workspace shell the build ships', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'workspace-ui', 'index.html'), 'utf8');
    expect(shellTakesPublicPage(source)).toBe(true);
  });
});
