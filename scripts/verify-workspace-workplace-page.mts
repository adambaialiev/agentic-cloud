/**
 * A workplace's word and its repositories at their address (knowledge page
 * "public-addresses", slice 6), in the real shell: a workplace has no
 * public page (the owner, 2026-10-12, note #748), so `/nomad-trading` says
 * "Nothing at this address" to a stranger exactly as a word nobody holds
 * does; `/nomad-trading/site` is the public source browser at the
 * repository's own address, its workplace half words rather than a door; a
 * private or missing repository says there is nothing at this address; a
 * signed-in member is sent on to the workplace's own screen, and from a
 * repository to its full screen.
 * Since 2026-09-27 the repository page also says what happened in it: the
 * mark and the name over it open the front page, the title reads
 * `workplace / repository`, the newest commit sits over the tree, and
 * History and Proposals open the whole history, one commit's diff, every
 * proposal and one proposal whole — a member is sent on from each.
 *
 *   npx tsx scripts/verify-workspace-workplace-page.mts [--shell backend/dist/workspace-ui]
 *
 * Screenshots land in $OUT_DIR (default ~/mini-preview).
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { emptyState, signedIn } from '../backend/workspace-ui/src/test/fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const out = process.env.OUT_DIR || path.join(process.env.HOME!, 'mini-preview');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME!, '.cache/puppeteer/chrome');
const chrome = process.env.CHROME || path.join(cache, readdirSync(cache).sort().at(-1)!, 'chrome-linux64/chrome');
const shellArg = process.argv.indexOf('--shell');
const shell = shellArg > 0 ? path.resolve(process.argv[shellArg + 1]!) : path.join(root, 'backend/dist/workspace-ui');

let session: 'stranger' | 'member' = 'stranger';
// Which workplace the public door says the member belongs to; the tab stands in o1.
let memberOrg = 'o1';
const sessionReads: string[] = [];
const org = { orgId: 'o1', name: 'Nomad Trading', handle: 'nomad-trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] };
const state = emptyState({
  org,
  organizations: [{ ...org, active: true, members: 2, agents: 1 }],
  agents: [],
});
const detail = {
  orgId: 'o1', name: 'Nomad Trading', handle: 'nomad-trading', role: 'admin', canDelete: true,
  members: [{ userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0 }],
  invites: [], joinRequests: [],
  fly: { connected: true, orgSlug: 'nomad-trading', peer: 'up' },
};
const tree = {
  name: 'site', cloneUrl: 'https://git.agenticcloudcomputer.com/nomad-trading/site.git', path: '', branch: 'main',
  entries: [
    { name: 'src', type: 'dir' },
    { name: 'LICENSE', type: 'file', sizeBytes: 1072 },
    { name: 'README.md', type: 'file', sizeBytes: 412 },
    { name: 'package.json', type: 'file', sizeBytes: 803 },
  ],
};
const errors: string[] = [];
const app = express();
app.get('/workspace/auth/session', (req, res) => { sessionReads.push(String(req.query.org ?? '')); res.json(session === 'member' ? signedIn() : { authenticated: false }); });
// As the server answers it (note #748): a workplace's word is a 404 to
// anyone but its own member, who is only told which workplace it is.
app.get('/workspace/api/public/addresses/:handle', (req, res) => {
  if (req.params.handle !== 'nomad-trading' || session !== 'member') return res.status(404).json({ error: 'Nothing at this address.' });
  return res.json({ kind: 'workplace', workplace: { member: { orgId: memberOrg } } });
});
app.get('/workspace/api/public/workplaces/:handle/repos/:repo/tree', (req, res) => {
  if (session === 'member' && req.params.handle === 'nomad-trading') return res.json({ member: { orgId: memberOrg } });
  if (req.params.handle !== 'nomad-trading' || req.params.repo !== 'site') return res.status(404).json({ error: 'Nothing at this address.' });
  const at = String(req.query.path ?? '');
  return res.json(at ? { ...tree, path: at, entries: [{ name: 'main.ts', type: 'file', sizeBytes: 90 }] } : tree);
});
app.get('/workspace/api/public/workplaces/:handle/repos/:repo/file', (req, res) => res.json({
  name: 'site', cloneUrl: tree.cloneUrl, path: String(req.query.path ?? ''), branch: 'main', sizeBytes: 412,
  content: '# Site\n\nThe workplace\'s public site.\n',
}));
const commits = [
  { sha: 'b'.repeat(40), authorName: 'Willow', at: new Date(Date.now() - 3 * 3600e3).toISOString(), subject: 'Serve the public tree with its latest commit' },
  { sha: 'a'.repeat(40), authorName: 'Saddam Baialiev', at: new Date(Date.now() - 2 * 86400e3).toISOString(), subject: 'First commit' },
];
const patch = 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,2 +1,3 @@\n export const site = true;\n+export const open = true;\n-// old\n';
const proposals = [
  { number: 2, title: 'Open the repository to the public', from: 'public-page', to: 'main', status: 'merged', createdAt: new Date(Date.now() - 2 * 86400e3).toISOString(), decidedAt: new Date(Date.now() - 86400e3).toISOString(), diffStat: { files: 2, insertions: 40, deletions: 3 }, agentName: 'Willow' },
  { number: 1, title: 'Add a licence', from: 'licence', to: 'main', status: 'open', createdAt: new Date(Date.now() - 3600e3).toISOString(), decidedAt: null, diffStat: { files: 1, insertions: 21, deletions: 0 }, agentName: 'Willow' },
];
app.get('/workspace/api/public/workplaces/:handle/repos/:repo/commits', (req, res) => {
  if (session === 'member' && req.params.handle === 'nomad-trading') return res.json({ member: { orgId: memberOrg } });
  if (req.params.handle !== 'nomad-trading' || req.params.repo !== 'site') return res.status(404).json({ error: 'Nothing at this address.' });
  const limit = Number(req.query.limit);
  return res.json({ name: 'site', branch: 'main', commits: limit ? commits.slice(0, limit) : commits });
});
app.get('/workspace/api/public/workplaces/:handle/repos/:repo/commits/:sha', (req, res) => {
  if (session === 'member' && req.params.handle === 'nomad-trading') return res.json({ member: { orgId: memberOrg } });
  const commit = commits.find((c) => c.sha.startsWith(req.params.sha));
  if (!commit) return res.status(404).json({ error: 'That commit is not in this repository.' });
  return res.json({ name: 'site', ...commit, body: 'The newest commit sits over the tree.', parents: [commits[1]!.sha], diffStat: { files: 1, insertions: 1, deletions: 1 }, patch, patchTruncated: false });
});
app.get('/workspace/api/public/workplaces/:handle/repos/:repo/proposals', (req, res) => {
  if (session === 'member' && req.params.handle === 'nomad-trading') return res.json({ member: { orgId: memberOrg } });
  if (req.params.handle !== 'nomad-trading' || req.params.repo !== 'site') return res.status(404).json({ error: 'Nothing at this address.' });
  return res.json({ name: 'site', prs: proposals });
});
app.get('/workspace/api/public/workplaces/:handle/repos/:repo/proposals/:number', (req, res) => {
  const pr = proposals.find((p) => String(p.number) === req.params.number);
  if (session === 'member' && req.params.handle === 'nomad-trading' && pr) return res.json({ member: { orgId: memberOrg, id: `pr-${pr.number}` } });
  if (!pr) return res.status(404).json({ error: 'Nothing at this address.' });
  return res.json({
    name: 'site', pr: { ...pr, body: 'What changed and **why**: the page now says what happened.' },
    commits: [{ sha: commits[0]!.sha, subject: commits[0]!.subject, at: commits[0]!.at }],
    patch, patchTruncated: false,
  });
});
app.get('/workspace/api/public/workplaces/:handle/repos/:repo/about', (req, res) => {
  if (session === 'member' && req.params.handle === 'nomad-trading') return res.json({ member: { orgId: memberOrg } });
  if (req.params.handle !== 'nomad-trading' || req.params.repo !== 'site') return res.status(404).json({ error: 'Nothing at this address.' });
  return res.json({
    name: 'site', branch: 'main', description: 'The workplace’s public site, built by its agents.', license: { name: 'MIT', file: 'LICENSE' },
    sizeBytes: 4096, publishedAt: new Date(Date.now() - 26 * 86400e3).toISOString(), lastPushAt: commits[0]!.at, commits: 42, proposals: 2,
    contributors: [
      { name: 'Willow', avatarUrl: '/faces/ada.jpg', commits: 30, insertions: 900, deletions: 120 },
      { name: 'Saddam Baialiev', avatarUrl: '/faces/kai.jpg', commits: 8, insertions: 200, deletions: 40 },
      { name: 'Emma', avatarUrl: '/faces/james.svg', commits: 3, insertions: 30, deletions: 2 },
      { name: 'Ben', commits: 1, insertions: 4, deletions: 0 },
    ],
    countedAt: new Date(Date.now() - 600e3).toISOString(),
  });
});
app.use('/faces', express.static(path.join(root, 'public/agent-avatars')));
app.use('/fonts', express.static(path.join(root, 'public/fonts')));
app.get('/workspace/api/state', (_req, res) => res.json(state));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({ notifications: [], unread: 0, push: { available: false, subscriptions: 0 } }));
app.get('/workspace/api/org', (_req, res) => res.json({ org: detail }));
app.get('/workspace/api/org/seats', (_req, res) => res.json({ seats: [] }));
app.get('/workspace/api/org/signin', (_req, res) => res.json({ signin: null }));
app.get('/workspace/api/org/cloud', (_req, res) => res.json({
  orgId: 'o1', role: 'admin', fly: detail.fly, machines: { active: 1, sleeping: 0, checkedAt: new Date().toISOString() },
}));
app.get('/workspace/api/repos/:name/tree', (_req, res) => res.json({ branch: 'main', entries: tree.entries }));
app.get('/workspace/api/repos/:name/commits', (_req, res) => res.json({ branch: 'main', commits }));
app.get('/workspace/api/repos/:name/contributors', (_req, res) => res.json({ contributors: [] }));
app.get('/workspace/api/repos/:name/prs', (_req, res) => res.json({ prs: [] }));
app.get('/workspace/api/repos/:name/checks', (_req, res) => res.json({ runs: [] }));
app.get('/workspace/api/prs/:id', (req, res) => res.json({
  pr: { id: req.params.id, number: 2, repoName: 'site', title: 'Open the repository to the public', body: null, from: 'public-page', to: 'main',
    status: 'merged', createdAt: proposals[0]!.createdAt, decidedAt: proposals[0]!.decidedAt, agentName: 'Willow', canDecide: false, comments: [] },
  checks: [], patch, patchTruncated: false, commits: [], headSha: 'h', requireChecks: false,
}));
app.get('/workspace/api/repos/:name/file', (req, res) => res.json({ branch: 'main', path: String(req.query.path ?? ''), sizeBytes: 12, content: '# Site\n' }));
app.get('/workspace/api/repos/:name', (_req, res) => res.json({ repo: { name: 'site', cloneUrl: tree.cloneUrl, sizeBytes: 4096, createdAt: '2026-09-01T00:00:00Z', publicUrl: '/nomad-trading/site', publishedAt: '2026-09-01T00:00:00Z' } }));
app.get('/workspace/api/repos', (_req, res) => res.json({ repos: [{ name: 'site', cloneUrl: tree.cloneUrl, sizeBytes: 4096, createdAt: '2026-09-01T00:00:00Z' }] }));
app.use(['/api', '/auth', '/workspace/api', '/workspace/auth'], (req, res) => {
  errors.push(`Unscripted ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Unscripted request' });
});
app.use('/workspace/app/assets', express.static(path.join(shell, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(shell, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const text = (selector: string) => page.$eval(selector, (node) => node.textContent ?? '');

  // 1. A stranger at a workplace's word reads exactly what a word nobody
  //    holds says: nothing here, no name, no picture, no repositories.
  const missing = async (word: string) => {
    await page.goto(`http://127.0.0.1:${port}/${word}`);
    await page.waitForSelector('#personMissing');
    return { words: (await text('#personMissing')).replace(word, '<word>'), title: (await page.title()).replace(word, '<word>') };
  };
  const nobody = await missing('nobody-here');
  const workplace = await missing('nomad-trading');
  assert.match(workplace.words, /^Nothing at this address/);
  assert.deepEqual(workplace, nobody, 'a workplace’s word reads like a word nobody holds');
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /Nomad Trading|Public repositories/);
  assert.equal(await page.$('#workplaceName'), null);
  assert.equal(await page.$$eval('#publicDoors a', (nodes) => nodes.length), 2, 'Sign in and Build yours over nothing too');
  await page.screenshot({ path: path.join(out, 'workplace-page.png'), fullPage: true });
  console.log('PASS: a stranger at /nomad-trading reads “Nothing at this address”, as at a word nobody holds');

  // 2. A public repository still opens at its own address, with the tree and the clone URL.
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site`);
  await page.waitForSelector('#publicRepoTree');
  assert.equal(new URL(page.url()).pathname, '/nomad-trading/site');
  // The title reads `workplace / repository`: the repository a door to its
  // root, the workplace only words (there is no page to open, note #748);
  // the mark and the name over it open the front page; no crumb repeats it.
  assert.deepEqual(await page.$$eval('#publicRepoName a', (nodes) => nodes.map((a) => [a.textContent, a.getAttribute('href')])), [['site', '/nomad-trading/site']]);
  assert.deepEqual(await page.$eval('#publicRepoName .owner', (node) => [node.tagName, node.textContent]), ['SPAN', 'nomad-trading']);
  assert.equal(await page.$eval('.public-repo-brand', (a) => a.getAttribute('href')), '/');
  // A visitor with no account: Sign in and Build yours in the header (Sign up
  // until note #822 closed our sign-up); "Public" beside the name.
  assert.deepEqual(await page.$$eval('#publicDoors a', (nodes) => nodes.map((a) => [a.textContent, a.getAttribute('href')])), [['Sign in', '/login'], ['Build yours→', '/own-cloud']]);
  // The landing page's header, as that page draws it: fixed over the page,
  // the site's Inter at 16px, the row 48px tall on a phone.
  assert.deepEqual(await page.$eval('.public-repo-head', (h) => [getComputedStyle(h).position, getComputedStyle(h).fontSize, Math.round(h.querySelector('nav')!.getBoundingClientRect().height)]), ['fixed', '16px', 48]);
  assert.doesNotMatch(await text('.public-repo-head'), /Public repository/);
  assert.equal(await text('#publicRepoBadge'), 'Public');
  assert.match(await page.$eval('.public-repo-brand .mark', (mark) => getComputedStyle(mark).maskImage || getComputedStyle(mark).webkitMaskImage), /logo-bw.*\.png/, 'the mark is drawn');
  assert.equal(await page.$('.public-repo-crumb'), null, 'no crumb at the root');
  assert.equal(await page.$eval('.public-repo-clone button', (b) => getComputedStyle(b).borderLeftWidth), '0px');
  assert.match(await text('.public-repo-clone code'), /nomad-trading\/site\.git/);
  assert.equal(await page.$$eval('#publicRepoTree .trow', (nodes) => nodes.length), 4);
  // The newest commit, over the tree.
  await page.waitForSelector('#publicRepoLatest');
  assert.match(await text('#publicRepoLatest'), /Serve the public tree with its latest commit.*Willow.*3h ago.*bbbbbbb/);
  assert.equal(await page.$eval('#publicRepoLatest', (a) => a.getAttribute('href')), `/nomad-trading/site/commits/${'b'.repeat(40)}`);
  assert.deepEqual(await page.$$eval('.public-repo-tabs a', (nodes) => nodes.map((a) => a.textContent)), ['Code', 'History', 'Proposals']);
  // The About strip: the README's first line, the facts, who wrote it.
  await page.waitForSelector('#publicRepoAbout');
  assert.equal(await text('#publicRepoDescription'), 'The workplace’s public site, built by its agents.');
  assert.deepEqual(await page.$$eval('#publicRepoFacts > *', (nodes) => nodes.map((n) => n.textContent)),
    ['MIT licence', '4 KB', '42 commits', '2 proposals', 'published 26d ago', 'last push 3h ago']);
  assert.deepEqual(await page.$$eval('#publicRepoFacts a', (nodes) => nodes.map((a) => a.getAttribute('href'))),
    ['/nomad-trading/site/commits', '/nomad-trading/site/proposals']);
  assert.match(await text('#publicRepoPeople'), /4 contributors.*Willow, Saddam Baialiev, Emma and 1 more/);
  assert.equal(await page.$$eval('#publicRepoPeople .faces img.face', (nodes) => nodes.filter((img) => (img as HTMLImageElement).naturalWidth > 0).length), 3, 'three faces drawn');
  assert.equal(await page.$eval('#publicRepoPeople', (a) => a.getAttribute('href')), '/nomad-trading/site/contributors');
  await page.waitForSelector('.public-repo-readme');
  await page.screenshot({ path: path.join(out, 'workplace-repo.png'), fullPage: true });
  // Into a folder: the address carries the path, and the crumb appears.
  await page.click('#publicRepoTree a.trow');
  await page.waitForFunction("location.search === '?path=src'", { timeout: 5000 });
  await page.waitForFunction("document.querySelectorAll('#publicRepoTree .trow').length === 1", { timeout: 5000 });
  await page.waitForSelector('.public-repo-crumb');
  assert.equal(await page.$('#publicRepoLatest'), null, 'the latest commit belongs to the root');
  console.log('PASS: a public repository opens at /nomad-trading/site, folders at ?path=');

  // 2b. History: every commit, each opening its diff.
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site`);
  await page.waitForSelector('.public-repo-tabs');
  await page.click('.public-repo-tabs a:nth-child(2)');
  await page.waitForSelector('#publicRepoCommits');
  assert.equal(new URL(page.url()).pathname, '/nomad-trading/site/commits');
  assert.equal(await page.$$eval('#publicRepoCommits a.crow', (nodes) => nodes.length), 2);
  assert.match(await text('#publicRepoCommits a.crow'), /Serve the public tree.*Willow.*3h ago.*bbbbbbb/);
  assert.equal(await page.$eval('.public-repo-tabs a.current', (a) => a.textContent), 'History');
  assert.equal(await page.title(), 'History · nomad-trading/site');
  await page.screenshot({ path: path.join(out, 'workplace-repo-history.png'), fullPage: true });
  await page.click('#publicRepoCommits a.crow');
  await page.waitForSelector('#publicRepoCommit .difffile');
  assert.equal(new URL(page.url()).pathname, `/nomad-trading/site/commits/${'b'.repeat(40)}`);
  assert.match(await text('#publicRepoCommit h2'), /Serve the public tree/);
  assert.match(await text('#publicRepoCommit'), /Willow.*3h ago.*bbbbbbb.*The newest commit sits over the tree.*1 file changed/s);
  await page.screenshot({ path: path.join(out, 'workplace-repo-commit.png'), fullPage: true });
  console.log('PASS: History lists every commit, and a commit opens with its diff at /commits/<sha>');

  // 2c. Proposals: every one ever shown, and one whole.
  await page.click('.public-repo-tabs a:nth-child(3)');
  await page.waitForSelector('#publicRepoProposals');
  assert.equal(new URL(page.url()).pathname, '/nomad-trading/site/proposals');
  assert.equal(await page.$$eval('#publicRepoProposals a.crow', (nodes) => nodes.length), 2);
  assert.match(await text('#publicRepoProposals a.crow'), /Open the repository to the public.*Merged.*public-page.*1d ago.*#2/);
  assert.match(await text('#publicRepoProposals a.crow:nth-child(2)'), /Add a licence.*Awaiting approval.*#1/);
  await page.screenshot({ path: path.join(out, 'workplace-repo-proposals.png'), fullPage: true });
  await page.click('#publicRepoProposals a.crow');
  await page.waitForSelector('#publicRepoProposal .difffile');
  assert.equal(new URL(page.url()).pathname, '/nomad-trading/site/proposals/2');
  assert.match(await text('#publicRepoProposal h2'), /Open the repository to the public/);
  assert.match(await text('#publicRepoProposal'), /Merged.*public-page.*main.*#2.*Willow.*proposed 2d ago.*merged 1d ago/s);
  assert.equal(await page.$eval('#publicRepoProposal .md strong, #publicRepoProposal strong', (b) => b.textContent), 'why');
  assert.equal(await page.$$eval('#publicRepoProposalCommits a.crow', (nodes) => nodes.length), 1);
  assert.equal(await page.title(), '#2 Open the repository to the public · nomad-trading/site');
  await page.screenshot({ path: path.join(out, 'workplace-repo-proposal.png'), fullPage: true });
  // 2d. Contributors: names and numbers, no addresses.
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site`);
  await page.waitForSelector('#publicRepoPeople');
  await page.click('#publicRepoPeople');
  await page.waitForSelector('#publicRepoContributors');
  assert.equal(new URL(page.url()).pathname, '/nomad-trading/site/contributors');
  assert.equal(await page.$$eval('#publicRepoContributors .crow', (nodes) => nodes.length), 4);
  assert.match(await text('#publicRepoContributors .crow'), /Willow.*30 commits.*\+900.*−120/);
  assert.equal(await page.$$eval('#publicRepoContributors img.aface', (nodes) => nodes.length), 3, 'a face on every row that has one');
  assert.doesNotMatch(await text('#publicRepo'), /@/);
  await page.screenshot({ path: path.join(out, 'workplace-repo-contributors.png'), fullPage: true });
  console.log('PASS: the About strip says licence, size, counts and dates; Contributors lists names and numbers');

  // A proposal nobody may see is nothing at this address.
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site/proposals/9`);
  await page.waitForSelector('#repoMissing');
  console.log('PASS: Proposals lists every proposal shown, and one opens whole at /proposals/<n>');

  // A wider look, the way the owner reads it.
  await page.setViewport({ width: 1180, height: 900, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site`);
  await page.waitForSelector('#publicRepoLatest');
  await page.waitForSelector('.public-repo-readme');
  await page.screenshot({ path: path.join(out, 'workplace-repo-wide.png'), fullPage: true });
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // 3. A private or missing repository: nothing at this address.
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/secret`);
  await page.waitForSelector('#repoMissing');
  assert.match(await text('#repoMissing'), /Nothing at this address/);
  assert.equal(await page.$('#publicRepoBadge'), null, 'no "Public" badge over nothing');
  assert.equal(await page.$$eval('#publicDoors a', (nodes) => nodes.length), 2, 'the doors stay over nothing');
  await page.screenshot({ path: path.join(out, 'workplace-repo-missing.png') });
  console.log('PASS: a private or missing repository says there is nothing at this address');

  // 4. A member is sent on: the workplace's own screen, and the repository's full screen.
  session = 'member';
  await page.goto(`http://127.0.0.1:${port}/nomad-trading`);
  await page.waitForFunction("location.pathname === '/workplace' && location.search === '?org=o1'", { timeout: 10000 });
  await page.waitForSelector('#screenOrg');
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /agenticcloudcomputer\.com\/nomad-trading/, 'the workplace screen names no address');
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site?path=src`);
  await page.waitForFunction("location.pathname === '/repositories/site' && location.search === '?org=o1&path=src'", { timeout: 10000 });
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site/commits`);
  await page.waitForFunction("location.pathname === '/repositories/site/history' && location.search === '?org=o1'", { timeout: 10000 });
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site/proposals/2`);
  await page.waitForFunction("location.pathname === '/decisions/pr/pr-2'", { timeout: 10000 });
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site/contributors`);
  await page.waitForFunction("location.pathname === '/repositories/site/contributors' && location.search === '?org=o1'", { timeout: 10000 });
  console.log('PASS: a member lands on the workplace’s own screen, and on the repository’s full screen, history and proposal');

  // 5. A member of ANOTHER workplace than the one this tab stands in: the
  // hop is a fresh document at the address, which stands in that workplace
  // before its first read — so the repository is read as its own workplace's.
  memberOrg = 'o2';
  sessionReads.length = 0;
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site`);
  await page.waitForFunction("location.pathname === '/repositories/site' && location.search === '?org=o2'", { timeout: 10000 });
  await page.waitForFunction("performance.getEntriesByType('navigation').length === 1 && !document.querySelector('#publicRepo')", { timeout: 10000 });
  assert.ok(sessionReads.includes('o2'), `the fresh document asked for its session as o2: ${JSON.stringify(sessionReads)}`);
  await page.goto(`http://127.0.0.1:${port}/nomad-trading/site/proposals/2`);
  await page.waitForFunction("location.pathname === '/decisions/pr/pr-2' && location.search === '?org=o2'", { timeout: 10000 });
  memberOrg = 'o1';
  console.log('PASS: a member of another workplace is carried into it, not left reading as this tab’s workplace');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
