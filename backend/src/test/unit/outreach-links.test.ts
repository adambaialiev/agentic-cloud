import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OutreachService } from '../../services/outreach.js';
import { InMemoryOutreachStore } from '../../services/outreach-storage.js';
import { SqliteOutreachStore } from '../../services/sqlite/sqlite-outreach-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { outreachLinkRoutes } from '../../routes/outreach-links.js';
import { isReservedHandle } from '../../shared/handles.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OUTREACH_LINK_PREVIEWS, OUTREACH_PREVIEW_IMAGE, fillOutreachLinks, isOutreachCode, outreachKnown, outreachLinkTarget, outreachPreviewApp, outreachReader, parseOutreachWrite, type OutreachLinkCodes, type OutreachTouch } from '../../shared/outreach.js';
import { fixtureOutreachWrite } from '../../shared/outreach-fixtures.js';

/**
 * The letters' short links (note #1106; Adam, 9 Nov 2026, 17:48 UTC): two
 * codes per company, agenticcloudcomputer.com/go/<code>, one to the home
 * page and one to the page for agents, each a redirect with the UTM data and
 * a visit on the company's timeline. Made-up companies only (outreach-app).
 */
const ROWAN = { agentId: 'agent-rowan', name: 'Rowan' };

async function world(opts: { sqlite?: boolean } = {}) {
  let clock = new Date('2026-11-09T18:00:00Z');
  const store = opts.sqlite ? new SqliteOutreachStore(openSqliteDb(':memory:')) : new InMemoryOutreachStore();
  const service = new OutreachService({ store, outbox: () => undefined, now: () => clock });
  const parsed = parseOutreachWrite(fixtureOutreachWrite());
  if (!parsed.ok) throw new Error(parsed.error);
  await service.write('user-adam', ROWAN, parsed.write);
  return { service, store, at: (iso: string) => { clock = new Date(iso); } };
}

const visits = async (store: InMemoryOutreachStore | SqliteOutreachStore, id: string) =>
  (await store.touches('user-adam', id)).filter((touch): touch is Extract<OutreachTouch, { kind: 'visit' }> => touch.kind === 'visit');

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CLAUDE = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)';

describe('The letters\' short links (note #1106)', () => {
  for (const sqlite of [false, true]) {
    it(`gives every company its short codes, kept across reads and writes (${sqlite ? 'sqlite' : 'memory'})`, async () => {
      const { service } = await world({ sqlite });
      const rows = await service.agentList('user-adam');
      const codes = rows.flatMap((row) => [row.links.home, row.links.agents, row.links.install!].map((link) => link.replace('https://agenticcloudcomputer.com/go/', '')));
      expect(codes.every(isOutreachCode)).toBe(true);
      expect(new Set(codes).size).toBe(codes.length);
      const shown = (await service.agentShow('user-adam', 'Northwind Health'))!;
      expect(shown.links).toEqual(rows.find((row) => row.id === 'northwind-health')!.links);
      expect((await service.detail('user-adam', 'northwind-health'))!.links).toEqual(shown.links);
      // A later write of the same company keeps its codes: a letter that went carries them.
      const again = parseOutreachWrite(fixtureOutreachWrite());
      if (!again.ok) throw new Error(again.error);
      again.write.targets[0]!.firstEmail!.body += '\nP.S.';
      await service.write('user-adam', ROWAN, again.write);
      expect((await service.agentShow('user-adam', 'Northwind Health'))!.links).toEqual(shown.links);
    });
  }

  it('sends a visit to its page with the UTM data, and puts it on the company\'s timeline: which link, and who it looked like', async () => {
    const { service, store, at } = await world();
    const links = (await service.agentShow('user-adam', 'Northwind Health'))!.links;
    const home = links.home.split('/go/')[1]!;
    const agents = links.agents.split('/go/')[1]!;
    const first = await service.visit(home, { userAgent: CHROME, method: 'GET' });
    expect(first).toEqual({ location: 'https://agenticcloudcomputer.com/?utm_source=outreach&utm_medium=email&utm_campaign=cold-email&utm_content=northwind-health', recorded: true, link: 'home' });
    const agent = await service.visit(agents, { userAgent: CLAUDE });
    expect(agent.location).toBe(outreachLinkTarget('agents', 'northwind-health'));
    expect(agent.location).toMatch(/^https:\/\/agenticcloudcomputer\.com\/workplace\.md\?utm_source=outreach&/);
    // The same reader on the same link within a minute is one visit; after it, another.
    expect((await service.visit(home, { userAgent: CHROME })).recorded).toBe(false);
    at('2026-11-09T18:02:00Z');
    expect((await service.visit(home, { userAgent: CHROME })).recorded).toBe(true);
    const seen = await visits(store, 'northwind-health');
    expect(seen.map((touch) => [touch.link, touch.reader, touch.client])).toEqual([
      ['home', 'browser', 'Chrome'], ['agents', 'agent', 'Claude'], ['home', 'browser', 'Chrome'],
    ]);
    // Nothing else about the reader is kept.
    expect(Object.keys(seen[0]!).sort()).toEqual(['at', 'client', 'id', 'kind', 'link', 'reader', 'targetId']);
    expect(JSON.stringify(seen)).not.toContain('Macintosh');
    // It is on the owner's timeline for the company, and nowhere else.
    expect((await service.detail('user-adam', 'northwind-health'))!.touches.filter((touch) => touch.kind === 'visit')).toHaveLength(3);
    expect(await visits(store, 'fernhill-labs')).toEqual([]);
  });

  it('lands an unknown or malformed code on the home page and records nothing', async () => {
    const { service, store } = await world();
    for (const code of ['zzzzzz', 'NOPE', '../../etc', '', 'abcdefghij']) {
      expect(await service.visit(code, { userAgent: CHROME })).toEqual({ location: 'https://agenticcloudcomputer.com/', recorded: false, link: null });
    }
    expect((await store.touches('user-adam')).filter((touch) => touch.kind === 'visit')).toEqual([]);
  });

  it('tells a browser, an agent and a mail system checking the link apart by its own words', () => {
    expect(outreachReader(CHROME)).toEqual({ reader: 'browser', client: 'Chrome' });
    expect(outreachReader(SAFARI_PHONE)).toEqual({ reader: 'browser', client: 'Safari' });
    expect(outreachReader('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toEqual({ reader: 'browser', client: 'Edge' });
    expect(outreachReader(CLAUDE)).toEqual({ reader: 'agent', client: 'Claude' });
    expect(outreachReader('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot')).toEqual({ reader: 'agent', client: 'ChatGPT' });
    expect(outreachReader('curl/8.5.0')).toEqual({ reader: 'agent', client: 'curl' });
    expect(outreachReader('python-requests/2.32.3')).toEqual({ reader: 'agent', client: 'Python' });
    expect(outreachReader('node')).toEqual({ reader: 'agent', client: 'Node' });
    expect(outreachReader('Mozilla/5.0 (compatible; proofpoint)')).toEqual({ reader: 'check', client: 'Proofpoint' });
    expect(outreachReader('Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)')).toEqual({ reader: 'check', client: 'Google' });
    expect(outreachReader(CHROME, 'HEAD')).toEqual({ reader: 'check', client: null });
    expect(outreachReader('', 'HEAD')).toEqual({ reader: 'check', client: null });
    expect(outreachReader(null)).toEqual({ reader: 'agent', client: null });
  });

  it('answers /go/<code> with a 302 that is never cached, an error included, and keeps the word from anyone\'s address', async () => {
    const { service } = await world();
    const app = express();
    let live: OutreachService | null = service;
    app.use(outreachLinkRoutes(() => live));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (path: string, ua = 'curl/8.5.0') => fetch(`${base}${path}`, { redirect: 'manual', headers: { 'User-Agent': ua } });
    try {
      const code = (await service.agentShow('user-adam', 'Lakeview Data'))!.links.agents.split('/go/')[1]!;
      const answer = await get(`/go/${code}`);
      expect(answer.status).toBe(302);
      expect(answer.headers.get('location')).toBe('https://agenticcloudcomputer.com/workplace.md?utm_source=outreach&utm_medium=email&utm_campaign=cold-email&utm_content=lakeview-data');
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(answer.headers.get('set-cookie')).toBeNull();
      expect((await get('/go/unknown')).headers.get('location')).toBe('https://agenticcloudcomputer.com/');
      // A private copy has no Outreach; a store that fails still lands the reader home.
      live = null;
      expect((await get(`/go/${code}`)).headers.get('location')).toBe('https://agenticcloudcomputer.com/');
      live = { visit: async () => { throw new Error('disk full'); } } as unknown as OutreachService;
      const failed = await get(`/go/${code}`);
      expect([failed.status, failed.headers.get('location')]).toEqual([302, 'https://agenticcloudcomputer.com/']);
    } finally {
      server.close();
    }
    expect(isReservedHandle('go')).toBe(true);
  });
});

describe('The link placeholders in shared words (note #1106)', () => {
  it('fills {home link} and {agents link} with the company\'s own links in the Send box, a follow-up included', async () => {
    const { service } = await world();
    const parsed = parseOutreachWrite(fixtureOutreachWrite());
    if (!parsed.ok) throw new Error(parsed.error);
    const write = parsed.write;
    write.targets = [{ ...write.targets.find((target) => target.company === 'Fernhill Labs')!, firstEmail: { ...write.targets.find((target) => target.company === 'Fernhill Labs')!.firstEmail!, body: 'Hi Otto,\n\nSee {home link} or have your agent read {agents link}.\n\nAdam' } }];
    await service.write('user-adam', ROWAN, write);
    const links = (await service.agentShow('user-adam', 'Fernhill Labs'))!.links;
    // Since note #1157 the Send box is empty and nothing is filled for him; the filler still turns stored words into the company's links.
    const answer = (await service.detail('user-adam', 'fernhill-labs'))!;
    expect(answer.draft).toMatchObject({ subject: '', text: '', from: 'blank' });
    const record = (await (service as unknown as { deps: { store: { target(u: string, id: string): Promise<{ links?: OutreachLinkCodes }> } } }).deps.store.target('user-adam', 'fernhill-labs'));
    const filled = fillOutreachLinks(answer.seed.firstEmail!.body, record.links);
    expect(filled).toBe(`Hi Otto,\n\nSee ${links.home} or have your agent read ${links.agents}.\n\nAdam`);
    expect(filled).not.toMatch(/[{}]/);
  });
});

describe('The third link, the setup guide (note #1120)', () => {
  it('gives every company an install code too, leading to /own-cloud.md with the same UTM data; a record from before keeps its two codes and gains the third', async () => {
    const { service, store } = await world();
    const before = (await service.agentShow('user-adam', 'Northwind Health'))!.links;
    expect(before.install).toMatch(/^https:\/\/agenticcloudcomputer\.com\/go\/[a-z2-9]{6}$/);
    expect(new Set([before.home, before.agents, before.install]).size).toBe(3);
    expect(outreachLinkTarget('install', 'northwind-health')).toBe('https://agenticcloudcomputer.com/own-cloud.md?utm_source=outreach&utm_medium=email&utm_campaign=cold-email&utm_content=northwind-health');
    // As every record was stored before note #1120: two codes only.
    const record = (await store.target('user-adam', 'lakeview-data'))!;
    const two = { home: record.links!.home, agents: record.links!.agents };
    await store.putTarget({ ...record, links: two });
    const after = (await service.detail('user-adam', 'lakeview-data'))!.links;
    expect(after.home).toBe(`https://agenticcloudcomputer.com/go/${two.home}`);
    expect(after.agents).toBe(`https://agenticcloudcomputer.com/go/${two.agents}`);
    expect(after.install).toMatch(/\/go\/[a-z2-9]{6}$/);
    expect((await service.detail('user-adam', 'lakeview-data'))!.links).toEqual(after);
    const install = after.install!.split('/go/')[1]!;
    const visit = await service.visit(install, { userAgent: CLAUDE });
    expect(visit).toEqual({ location: outreachLinkTarget('install', 'lakeview-data'), recorded: true, link: 'install' });
    expect((await visits(store, 'lakeview-data')).map((touch) => [touch.link, touch.reader])).toEqual([['install', 'agent']]);
  });

  it('fills {install link} in a letter and a follow-up like the other two', async () => {
    const { service } = await world();
    const parsed = parseOutreachWrite(fixtureOutreachWrite());
    if (!parsed.ok) throw new Error(parsed.error);
    const write = parsed.write;
    const fernhill = write.targets.find((target) => target.company === 'Fernhill Labs')!;
    write.targets = [{ ...fernhill, firstEmail: { ...fernhill.firstEmail!, body: 'Hi Otto,\n\nYour agent sets it up from one line: {install link}\n\nWhat it does: {agents link}\n\nAdam\n{home link}' } }];
    write.words = { audience: 'customer', source: null, generatedBy: null, generatedAt: null, followUps: { day4: { text: 'Setup: {install link}', wordCount: 2 } } };
    await service.write('user-adam', ROWAN, write);
    const links = (await service.agentShow('user-adam', 'Fernhill Labs'))!.links;
    const answer = (await service.detail('user-adam', 'fernhill-labs'))!;
    const record = (await (service as unknown as { deps: { store: { target(u: string, id: string): Promise<{ links?: OutreachLinkCodes }> } } }).deps.store.target('user-adam', 'fernhill-labs'));
    const filled = fillOutreachLinks(answer.seed.firstEmail!.body, record.links);
    expect(filled).toBe(`Hi Otto,\n\nYour agent sets it up from one line: ${links.install}\n\nWhat it does: ${links.agents}\n\nAdam\n${links.home}`);
    expect(filled).not.toMatch(/[{}]/);
  });
});

describe('A guest agent from a letter\'s link (note #1139)', () => {
  for (const sqlite of [false, true]) {
    it(`names the company and puts one guest touch on its timeline; an unknown id records nothing (${sqlite ? 'sqlite' : 'memory'})`, async () => {
      const { service, store } = await world({ sqlite });
      // The home link lands with the company's id in utm_content: that is what a guest carries.
      expect(outreachLinkTarget('home', 'northwind-health')).toContain('utm_content=northwind-health');
      expect(await service.company('user-adam', 'northwind-health')).toEqual({ id: 'northwind-health', name: 'Northwind Health' });
      expect(await service.company('user-adam', 'nobody')).toBeNull();
      expect(await service.company('someone-else', 'northwind-health')).toBeNull();

      expect(await service.guestStarted('user-adam', 'northwind-health', { agentId: 'g1', name: 'Theo', country: 'NL' })).toBe(true);
      expect(await service.guestStarted('user-adam', 'northwind-health', { agentId: 'g1', name: 'Theo', country: 'NL' })).toBe(false);
      expect(await service.guestStarted('user-adam', 'nobody', { agentId: 'g2', name: 'Gus', country: null })).toBe(false);
      const guests = (await store.touches('user-adam', 'northwind-health')).filter((touch) => touch.kind === 'guest');
      expect(guests).toEqual([expect.objectContaining({ kind: 'guest', agentId: 'g1', name: 'Theo', country: 'NL' })]);
      // A guest is a fact on the timeline, not a step: the state does not move.
      expect((await service.detail('user-adam', 'northwind-health'))!.row.state).toBe('not-contacted');
    });
  }
});

/* Note #1148 (Adam, 11 Nov 2026, 09:27 UTC): "If customer shares a link that
   it received through our email, I want the links to have preview". */
const PREVIEWERS: Array<[string, string]> = [
  ['TelegramBot (like TwitterBot)', 'Telegram'],
  ['WhatsApp/2.23.20.0', 'WhatsApp'],
  ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Facebook'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'iMessage'],
  ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Slack'],
  ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'Discord'],
  ['LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 'LinkedIn'],
  ['Twitterbot/1.0', 'X'],
  ['Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com', 'Teams or Skype'],
  ['Mozilla/5.0 (compatible; Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/))', 'Google Chat'],
];

describe('A link preview of a letter\'s short link (note #1148)', () => {
  it('names the app drawing a preview, and never a browser or an agent', () => {
    for (const [ua, app] of PREVIEWERS) {
      expect(outreachPreviewApp(ua), ua).toBe(app);
      expect(outreachReader(ua), ua).toEqual({ reader: 'preview', client: app });
    }
    for (const ua of [CHROME, SAFARI_PHONE, CLAUDE, 'curl/8.5.0', 'Mozilla/5.0 (compatible; proofpoint)', '']) expect(outreachPreviewApp(ua)).toBeNull();
  });

  it('keeps the home link\'s card the home page\'s own, and the picture the site\'s', () => {
    const indexHtml = readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'index.html'), 'utf8');
    const meta = (key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(indexHtml)?.[1];
    expect(OUTREACH_LINK_PREVIEWS.home.title).toBe(meta('og:title'));
    expect(OUTREACH_LINK_PREVIEWS.home.description).toBe(meta('og:description'));
    expect(OUTREACH_PREVIEW_IMAGE.url).toBe(meta('og:image'));
    expect(OUTREACH_PREVIEW_IMAGE.alt).toBe(meta('og:image:alt'));
    expect(String(OUTREACH_PREVIEW_IMAGE.width)).toBe(meta('og:image:width'));
    for (const card of Object.values(OUTREACH_LINK_PREVIEWS)) expect(card.description.length).toBeLessThan(150);
  });

  it('answers a preview app with the link\'s card and og:url the short link, a person and an agent with the redirect, and records the share plainly', async () => {
    const { service, store, at } = await world();
    const app = express();
    app.use(outreachLinkRoutes(() => service));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (p: string, ua: string) => fetch(`${base}${p}`, { redirect: 'manual', headers: { 'User-Agent': ua } });
    try {
      const links = (await service.agentShow('user-adam', 'Northwind Health'))!.links;
      for (const kind of ['home', 'agents', 'install'] as const) {
        const code = links[kind]!.split('/go/')[1]!;
        for (const [ua] of PREVIEWERS) {
          const answer = await get(`/go/${code}`, ua);
          expect(answer.status, ua).toBe(200);
          expect(answer.headers.get('content-type')).toMatch(/^text\/html/);
          expect(answer.headers.get('cache-control')).toBe('no-store');
          const page = await answer.text();
          expect(page).toContain(`<meta property="og:title" content="${OUTREACH_LINK_PREVIEWS[kind].title}">`);
          expect(page).toContain(`<meta property="og:url" content="https://agenticcloudcomputer.com/go/${code}">`);
          expect(page).toContain(`<meta property="og:image" content="${OUTREACH_PREVIEW_IMAGE.url}">`);
          expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
          // Nothing names the company: not its name, and not its id in the tags.
          expect(page).not.toMatch(/northwind/i);
        }
        for (const ua of [CHROME, SAFARI_PHONE, CLAUDE, 'curl/8.5.0']) {
          const answer = await get(`/go/${code}`, ua);
          expect([answer.status, answer.headers.get('location')], ua).toEqual([302, outreachLinkTarget(kind, 'northwind-health')]);
        }
      }
      // An unknown code still draws the home card, and records nothing.
      const unknown = await (await get('/go/zzzzzz', 'TelegramBot (like TwitterBot)')).text();
      expect(unknown).toContain(`content="${OUTREACH_LINK_PREVIEWS.home.title}"`);
      // On the timeline: each app's preview once per link and minute, as a share, never as a follow.
      const seen = (await visits(store, 'northwind-health')).filter((touch) => touch.reader === 'preview');
      expect(seen.filter((touch) => touch.link === 'agents').map((touch) => touch.client).sort()).toEqual(PREVIEWERS.map(([, app]) => app).sort());
      at('2026-11-09T18:05:00Z');
      const known = outreachKnown(await store.touches('user-adam', 'northwind-health'));
      expect(known.shared).toBe(PREVIEWERS.length * 3);
      expect(known.followed?.times).toBe(3 * 4);
      expect(known.checked).toBe(0);
    } finally {
      server.close();
    }
  });
});
