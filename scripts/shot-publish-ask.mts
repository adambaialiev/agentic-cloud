// Photographs the repository screen's standing CI-secrets grant and
// publishing link (`agentbuilt repo ci-secrets` / `repo publish`; granted at
// once since note #739, so there is no request to photograph) in real Chrome,
// at phone width. The built shell
// is served by a bare node:http server that answers every read from the
// component tests' own fixtures, so the picture is of the same data the tests
// pin. Screenshots land in ~/mini-preview/.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/shot-publish-ask.mts
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import {
  emptyState, repo, repoScreenScript, workspaceScript, type Answer,
} from '../backend/workspace-ui/src/test/fixtures.js';
import type { WorkspaceRepoRow } from '../backend/src/shared/workspace-api.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SHELL = path.join(REPO, 'backend/dist/workspace-ui');
const OUT = path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });

function findChrome(): string {
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).sort().pop()!;
  return path.join(root, build, 'chrome-linux64/chrome');
}

const org = { orgId: 'o1', name: 'Startup game', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };

function scriptFor(extra: Partial<WorkspaceRepoRow>): Record<string, Answer> {
  const state = emptyState({ org, repos: [repo({ name: 'ship-it', ...extra })] } as never);
  return { ...workspaceScript(() => state), ...repoScreenScript('ship-it', () => ({ branch: 'main', entries: [] })) };
}

async function serve(script: Record<string, Answer>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/workspace/app/assets/')) {
      const file = path.join(SHELL, url.pathname.slice('/workspace/app/'.length));
      if (existsSync(file)) {
        res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(file));
        return;
      }
    }
    if (url.pathname.startsWith('/workspace/api/') || url.pathname.startsWith('/workspace/auth/')) {
      for (const scope of ['room', 'org']) url.searchParams.delete(scope);
      const query = url.searchParams.toString();
      const key = `${req.method} ${url.pathname.slice('/workspace/'.length)}${query ? `?${query}` : ''}`;
      const handler = script[key];
      res.setHeader('content-type', 'application/json');
      if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ error: `unscripted ${key}` })); return; }
      try {
        res.end(JSON.stringify(handler({ path: key, scoped: true } as never) ?? {}));
      } catch (error) {
        res.statusCode = (error as { status?: number }).status ?? 500;
        res.end(JSON.stringify({ error: String((error as Error).message) }));
      }
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(readFileSync(path.join(SHELL, 'index.html')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || findChrome(), args: ['--no-sandbox'] });
try {
  const shots: Array<[string, Partial<WorkspaceRepoRow>]> = [
    ['ci-secrets-grant', { ciSecrets: { names: ['DEPLOY_TOKEN'] } }],
    ['publish-link', { publishesTo: 'startup-game' }],
  ];
  for (const [name, extra] of shots) {
    const { server, port } = await serve(scriptFor(extra));
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 1400, deviceScaleFactor: 3 });
    await page.goto(`http://127.0.0.1:${port}/workspace/repositories/ship-it?org=o1`, { waitUntil: 'networkidle0' });
    const target = name === 'ci-secrets-grant' ? '#repoCiSecrets:not([hidden])' : '#repoPublishing:not([hidden])';
    await page.waitForSelector(target, { timeout: 15_000 });
    const subject = name === 'ci-secrets-grant' ? '#repoCiSecrets' : '#repoPublishing';
    const box = await page.$eval(subject, (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, text: (el.textContent ?? '').slice(0, 300) };
    });
    console.log(name, JSON.stringify(box));
    // The section and a little of what sits above it, so it reads in place.
    const clipTop = Math.max(0, box.top - 60);
    await page.screenshot({
      path: path.join(OUT, `${name}.png`),
      // The link's explanation sits under its card, so that shot runs on.
      clip: { x: 0, y: clipTop, width: 420, height: Math.min(900, box.height + (box.top - clipTop) + 110) },
    });
    await page.close();
    server.close();
  }
} finally {
  await browser.close();
}
