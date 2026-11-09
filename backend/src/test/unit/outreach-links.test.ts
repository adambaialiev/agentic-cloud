import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OutreachService } from '../../services/outreach.js';
import { InMemoryOutreachStore } from '../../services/outreach-storage.js';
import { SqliteOutreachStore } from '../../services/sqlite/sqlite-outreach-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { outreachLinkRoutes } from '../../routes/outreach-links.js';
import { isReservedHandle } from '../../shared/handles.js';
import { isOutreachCode, outreachLinkTarget, outreachReader, parseOutreachWrite, type OutreachTouch } from '../../shared/outreach.js';
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
    it(`gives every company two short codes of its own, kept across reads and writes (${sqlite ? 'sqlite' : 'memory'})`, async () => {
      const { service } = await world({ sqlite });
      const rows = await service.agentList('user-adam');
      const codes = rows.flatMap((row) => [row.links.home, row.links.agents].map((link) => link.replace('https://agenticcloudcomputer.com/go/', '')));
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
    expect(first).toEqual({ location: 'https://agenticcloudcomputer.com/?utm_source=outreach&utm_medium=email&utm_campaign=cold-email&utm_content=northwind-health', recorded: true });
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
      expect(await service.visit(code, { userAgent: CHROME })).toEqual({ location: 'https://agenticcloudcomputer.com/', recorded: false });
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
    const draft = (await service.detail('user-adam', 'fernhill-labs'))!.draft!;
    expect(draft.text).toBe(`Hi Otto,\n\nSee ${links.home} or have your agent read ${links.agents}.\n\nAdam`);
    expect(draft.text).not.toMatch(/[{}]/);
    // Saving the filled words unchanged is not a version of his own.
    await service.letter('user-adam', 'fernhill-labs', { action: 'save', subject: draft.subject, text: draft.text });
    expect((await service.detail('user-adam', 'fernhill-labs'))!.draft!.from).toBe('written');
  });
});
