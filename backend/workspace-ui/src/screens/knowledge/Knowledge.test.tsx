import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type {
  WorkspaceKnowledgePageRecord,
  WorkspaceStateAnswer,
} from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import {
  agent, emptyState, homeShelf, knowledgePage, knowledgePageScript, scriptedApi, workspaceScript,
  type Answer,
} from '../../test/fixtures.js';

/**
 * Knowledge, end to end against a scripted API — the same things the legacy
 * page's grab()-based tests hold it to (telegram-miniapp-knowledge.test.ts:
 * the rows on home, the six-and-a-door rule, the screen behind that door, the
 * page itself with its files and its margin, and the row of agents a page can
 * be handed to), driven the way a person drives them.
 */

function open(state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}, path = '/') {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App api={scripted.api} />
    </MemoryRouter>,
  );
  return scripted;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
/** A workplace the reader stands in. (It was a room of one, while there were
 *  rooms — note #843.) */
const inWorkplace = (overrides: Partial<WorkspaceStateAnswer> = {}) => emptyState({ org, ...overrides });

/** N pages, most recently landed first, the way the backend hands them over. */
const manyPages = (count: number) => Array.from({ length: count }, (_, i) => knowledgePage({
  name: `page-${count - i}`, title: `Page ${count - i}`, description: 'What it is for',
}));

// The Knowledge card is the workplace's (note #566): Home's Workplace window.
const findHome = () => homeShelf('repositories');
const card = () => document.getElementById('knowledge')!;
const rows = () => [...card().querySelectorAll('.crow')];

/** The Knowledge screen opened cold, at its own address, once the state it
 *  draws has actually landed. */
async function openList(pages: WorkspaceStateAnswer['knowledge']) {
  open(inWorkplace({ knowledge: pages }), {}, '/knowledge?org=o1');
  await screen.findByRole('heading', { name: 'Knowledge' });
  await waitFor(() => expect(document.getElementById('screenKnowledge')!.getAttribute('aria-busy')).toBeNull());
  return () => [...document.getElementById('knowledgeList')!.querySelectorAll('.crow')];
}

describe('the knowledge rows on home', () => {
  it('a page row says what the page is FOR, in words', async () => {
    open(inWorkplace({
      knowledge: [knowledgePage({
        name: 'deploy-runbook', title: 'Deploying the site',
        description: 'The steps, and what to check after.', updatedAt: '2026-08-15T10:00:00.000Z',
        // The answer still says which room the page came from; a row led
        // with it while there were rooms (note #566), and says nothing of it
        // since they left the product (note #843).
      })],
    }));
    await findHome();
    const row = rows()[0]!;
    expect(row.querySelector('.name')!.textContent).toBe('Deploying the site');
    expect(row.querySelector('.cline')!.textContent).toBe('The steps, and what to check after.');
    // No agent recorded (a page landed before attribution existed): the row
    // keeps its words and simply wears no face.
    expect(row.querySelector('.cline img')).toBeNull();
    expect(row.textContent).not.toContain('[object');
  });

  it('keeps individual Knowledge pages icon-free, like Notes', async () => {
    open(inWorkplace({ knowledge: manyPages(7) }));
    await findHome();
    const list = rows();
    expect(list.slice(0, 6).every((row) => !row.querySelector('.icon'))).toBe(true);
    // The "All pages" door is not a page row, so it keeps the knowledge mark
    // that tells the reader what opens when they take it — the bulb, drawn
    // rather than poured from a string, and tinted like the shelf.
    const mark = list[6]!.querySelector('.icon')!;
    expect(mark.className).toContain('ft-doc');
    expect(mark.querySelector('path')!.getAttribute('d')).toMatch(/^M15 14c/);
  });

  it('falls back to the name when a page has no description', async () => {
    open(inWorkplace({ knowledge: [knowledgePage({ name: 'notes', title: 'Notes' })] }));
    await findHome();
    expect(card().querySelector('.cline')!.textContent).toBe('notes');
  });

  it('a page row wears the face of the agent that last landed it', async () => {
    // Six agents write into ONE knowledge base, so "who wrote this?" is
    // otherwise unanswerable without opening the page and guessing.
    open(inWorkplace({
      knowledge: [knowledgePage({
        name: 'deploy-runbook', title: 'Deploying the site',
        description: 'The steps, and what to check after.',
        agentName: 'Alex', agentAvatarUrl: '/miniapp/avatars/alex',
      })],
    }));
    await findHome();
    const line = card().querySelector('.cline')!;
    const face = line.querySelector('img.face') as HTMLImageElement;
    expect(face.getAttribute('src')).toBe('/miniapp/avatars/alex');
    expect(face.getAttribute('alt')).toBe('');
    expect(line.textContent).toBe('Alex·The steps, and what to check after.');
    // The NAME never shrinks and the description does: a truncated "Al…"
    // identifies nobody, where a cut description still reads as far as it goes.
    expect(line.querySelector('.keep')!.textContent).toBe('Alex');
  });

  it('the face on a row opens the agent, and the rest of the row the page (note #640)', async () => {
    // The owner, on note #640: "when user presses on not own agent's avatar,
    // it should open agent's detail page." One row, two destinations — the
    // face is the more specific answer to a tap that lands on it, and the
    // press must not also open the page underneath.
    const scripted = open(inWorkplace({
      knowledge: [knowledgePage({
        name: 'deploy-runbook', title: 'Deploying the site', description: 'The steps.',
        agentName: 'Leo', agentAvatarUrl: '/miniapp/avatars/leo', agentId: 'leo',
      })],
    }), {
      'GET api/agents/leo/card': () => ({
        agent: { id: 'leo', name: 'Leo', cli: 'codex', status: 'ready', avatarUrl: '/miniapp/avatars/leo' },
        owner: { userId: 'u2', name: 'Dana Ives' },
      }),
    });
    await findHome();
    const face = card().querySelector('.cline img.face') as HTMLElement;
    expect(face.getAttribute('data-agent-door')).toBe('leo');
    fireEvent.click(face);
    expect(await screen.findByRole('heading', { name: 'Leo' })).toBeTruthy();
    // The page it came from is NOT what opened: one tap, one destination.
    expect(document.getElementById('screenKnowledgePage')).toBeNull();
    expect(scripted.calls.some((call) => call.path === 'api/agents/leo/card')).toBe(true);
  });

  it('a page landed by an agent the workplace has forgotten offers no door', async () => {
    // No id, no button: a tap that leads nowhere is worse than a picture
    // never offered as one.
    open(inWorkplace({
      knowledge: [knowledgePage({
        name: 'old-page', title: 'Old page', description: 'Landed long ago.',
        agentName: 'Ghost', agentAvatarUrl: '/miniapp/avatars/ghost',
      })],
    }));
    await findHome();
    const line = card().querySelector('.cline') as HTMLElement;
    expect(line.querySelector('img.face')).toBeTruthy();
    expect(line.querySelector('[data-agent-door]')).toBeNull();
  });

  it('an empty workplace keeps its Knowledge section and says who builds it (note #175)', async () => {
    open(inWorkplace({ knowledge: [] }));
    await findHome();
    expect(document.getElementById('knowledgeHead')!.hidden).toBe(false);
    expect(document.getElementById('knowledgeCard')!.hidden).toBe(false);
    expect(card().querySelector('.roomemptytitle')!.textContent).toBe('Start the workplace’s knowledge');
    expect(card().querySelector('.roomemptybody')!.textContent).toContain('Knowledge pages hold what agents have worked out');
    expect(card().querySelector('.roomemptybody')!.textContent)
      .toContain('Ask any agent to write the first one');
    expect(card().querySelector('.roomemptymark')!.classList.contains('ft-doc')).toBe(true);
    expect(card().querySelector('.crow')).toBeNull();
  });

  it('hides unavailable knowledge and an empty workspace with no workplace to own it', async () => {
    // No workplace a first page could belong to: no advert the reader cannot
    // use. (It asked for a room, while there were rooms — note #843.) A
    // personal workspace's Home is its one column, every shelf in it.
    open(emptyState({ knowledge: [] }));
    await homeShelf();
    expect(document.getElementById('knowledgeHead')!.hidden).toBe(true);
    expect(document.getElementById('knowledgeCard')!.hidden).toBe(true);
  });

  it('says nothing at all when this backend has no knowledge base', async () => {
    open(inWorkplace({ knowledge: null }));
    await findHome();
    expect(document.getElementById('knowledgeCard')!.hidden).toBe(true);
  });

  describe('the recent few, and the door to the rest (note #48)', () => {
    it('stops at six and offers the rest, saying how many there are in all', async () => {
      open(inWorkplace({ knowledge: manyPages(11) }));
      await findHome();
      const list = rows();
      // Six pages and the door: the seventh row is the way to the other five,
      // not a seventh page.
      expect(list).toHaveLength(7);
      expect(list.slice(0, 6).map((row) => row.querySelector('.name')!.textContent))
        .toEqual(['Page 11', 'Page 10', 'Page 9', 'Page 8', 'Page 7', 'Page 6']);
      // "All 11", not "5 more": the screen behind this row holds every page,
      // the six above it included.
      expect(list[6]!.querySelector('.name')!.textContent).toBe('All 11 pages');
      // A real button, so a keyboard reaches it.
      expect(list[6]!.tagName).toBe('BUTTON');
      // No time in the right-hand column: every row above carries the time IT
      // last changed, and one here reads as another page's.
      expect(list[6]!.querySelector('.cside')).toBeNull();
    });

    it('draws no door when the card already holds every page', async () => {
      open(inWorkplace({ knowledge: manyPages(6) }));
      await findHome();
      expect(rows()).toHaveLength(6);
      // A tap that gives nothing back is worse than no tap at all.
      expect(card().textContent).not.toContain('All 6 pages');
    });

    it('the door opens the screen at its own address, and it leaves nothing off', async () => {
      open(inWorkplace({ knowledge: manyPages(11) }));
      await findHome();
      fireEvent.click(rows()[6]!);
      expect(await screen.findByRole('heading', { name: 'Knowledge' })).toBeTruthy();
      const listed = [...document.getElementById('knowledgeList')!.querySelectorAll('.crow')];
      expect(listed).toHaveLength(11);
      expect(listed.map((row) => row.querySelector('.name')!.textContent))
        .toEqual(manyPages(11).map((page) => page.title));
      expect(document.getElementById('knowledgeSub')!.textContent)
        .toBe('11 pages, written by the workplace’s agents and shared across it.');
    });

    it('one page reads the same from either list, at the workplace’s address', async () => {
      const state = inWorkplace({ knowledge: manyPages(11) });
      open(state, knowledgePageScript('page-1', () => ({
        name: 'page-1', html: '<p>Only the screen shows this one.</p>',      })));
      await findHome();
      fireEvent.click(rows()[6]!);
      await screen.findByRole('heading', { name: 'Knowledge' });
      // The eleventh row: a page only the screen shows, which is the whole
      // point of it being here.
      const listed = [...document.getElementById('knowledgeList')!.querySelectorAll('.crow')];
      fireEvent.click(listed[10]!);
      expect(await screen.findByText('Only the screen shows this one.')).toBeTruthy();
    });

    it('shrinking under home’s threshold does not eject the reader from the list', async () => {
      // Down to six, home shows every one — but the named list URL remains a
      // valid destination: visibility on home is presentation, and must not
      // decide whether a durable route continues to exist.
      const listed = await openList(manyPages(6));
      expect(listed()).toHaveLength(6);
      expect(document.getElementById('screenKnowledge')).toBeTruthy();
    });

    it('keeps an empty durable list useful instead of ejecting the reader', async () => {
      await openList([]);
      expect(document.querySelector('#knowledgeList .roomemptytitle')!.textContent)
        .toBe('Start the workplace’s knowledge');
      expect(document.getElementById('knowledgeSub')!.textContent)
        .toBe('0 pages, written by the workplace’s agents and shared across it.');
    });

    it('says "One page" rather than "1 pages"', async () => {
      await openList(manyPages(1));
      expect(document.getElementById('knowledgeSub')!.textContent)
        .toBe('One page, written by the workplace’s agents and shared across it.');
    });

    it('says nothing about how full the shelf is until it has been read', async () => {
      // A pasted link arrives before the state does, and "0 pages" over an
      // empty-base sentence is a claim rather than a wait.
      const scripted = scriptedApi({
        ...workspaceScript(() => inWorkplace({ knowledge: manyPages(3) })),
        'GET api/state': () => new Promise(() => {}),
      });
      render(
        <MemoryRouter initialEntries={['/knowledge?org=o1']}>
          <App api={scripted.api} />
        </MemoryRouter>,
      );
      await screen.findByRole('heading', { name: 'Knowledge' });
      expect(document.getElementById('knowledgeSub')!.textContent).toBe('');
      expect(document.querySelector('#knowledgeList .empty')!.textContent).toBe('Loading…');
      expect(document.querySelector('#knowledgeList .roomemptytitle')).toBeNull();
    });
  });
});

describe('the knowledge screen on one shelf for the whole workplace (note #566)', () => {
  const shelf = () => [
    ...Array.from({ length: 5 }, (_, i) => knowledgePage({
      name: `runbook-${i + 1}`, title: `Runbook ${i + 1}`, description: 'How a change ships.',
    })),
    knowledgePage({ name: 'landing-copy-rules', title: 'Copy rules', description: 'What the landing page may claim.' }),
    knowledgePage({ name: 'membership-simulations', title: 'Membership journeys', description: 'Run them locally.' }),
  ];

  // The screen grouped the pages by the room they came from, the room on
  // screen first, and the filter matched a room's name too, until rooms left
  // the product (note #843): one card, and only a page's own words.
  it('lists the whole shelf in one card, whatever rooms the answer still files its pages under', async () => {
    const list = await openList(shelf());
    expect(document.querySelector('#knowledgeList .kgroup')).toBeNull();
    expect(list()).toHaveLength(7);
    const copy = list().find((row) => row.querySelector('.name')!.textContent === 'Copy rules')!;
    expect(copy.querySelector('.cline')!.textContent).toBe('What the landing page may claim.');
  });

  it('filters by words across name and description, and says so when nothing matches', async () => {
    const list = await openList(shelf());
    const box = screen.getByLabelText('Filter knowledge pages');
    expect(box.getAttribute('placeholder')).toBe('Filter by name or words');
    fireEvent.change(box, { target: { value: 'landing' } });
    expect(list().map((row) => row.querySelector('.name')!.textContent)).toEqual(['Copy rules']);
    fireEvent.change(box, { target: { value: 'ships runbook-3' } });
    expect(list().map((row) => row.querySelector('.name')!.textContent)).toEqual(['Runbook 3']);
    // A room's name is not a page's words.
    fireEvent.change(box, { target: { value: 'growth' } });
    expect(document.getElementById('knowledgeNoMatch')!.textContent).toContain('No page matches “growth”.');
    fireEvent.change(box, { target: { value: '' } });
    expect(list()).toHaveLength(7);
  });

  it('offers no filter on a short shelf', async () => {
    const list = await openList([knowledgePage({ name: 'deploy-runbook', title: 'Deploying', description: 'The steps.' })]);
    expect(list()).toHaveLength(1);
    expect(screen.queryByLabelText('Filter knowledge pages')).toBeNull();
  });
});

describe('one page, on the screen a page is read on', () => {
  const runbook = (overrides: Partial<WorkspaceKnowledgePageRecord> = {}): WorkspaceKnowledgePageRecord => ({
    name: 'deploys',
    title: 'Deploys',
    description: 'How the deploy goes.',
    html: '<!doctype html><title>Deploys</title><h1>Deploys</h1><p>The words.</p>'
      + '<ul><li>one</li><li>two</li></ul>',
    // The answer still has a field for the room the margin was kept in;
    // nothing on screen reads it since rooms left the product (note #843).
    ...overrides,
  });

  const openPage = (state: WorkspaceStateAnswer, page: () => WorkspaceKnowledgePageRecord) =>
    open(state, knowledgePageScript('deploys', page), '/knowledge/deploys?org=o1');

  it('renders the page as elements, under the title and what it is for', async () => {
    openPage(inWorkplace({ knowledge: [knowledgePage({ name: 'deploys', title: 'Deploys' })] }), runbook);
    expect(await screen.findByText('The words.')).toBeTruthy();
    expect(document.getElementById('kpageTitle')!.textContent).toBe('Deploys');
    expect(document.getElementById('kpageSub')!.textContent).toBe('How the deploy goes.');
    expect([...document.querySelectorAll('#kpageBody li')].map((li) => li.textContent))
      .toEqual(['one', 'two']);
    // A page nearly always opens with an <h1> of its own title, and the screen
    // is already titled with it — printed twice it reads as a rendering fault.
    expect(document.querySelectorAll('#kpageBody h1')).toHaveLength(0);
    expect(document.querySelector('#kpageBody .kpage')).toBeTruthy();
  });

  it('lists the page\u2019s history and puts it back in one tap (note #746)', async () => {
    const history = [
      { number: 9, action: 'edit' as const, title: 'Update "Deploys"', note: 'rewrote the rollback step', at: '2026-10-12T10:00:00.000Z', agentName: 'Ben', agentId: 'agent-a', canRestore: true },
      { number: 4, action: 'create' as const, title: 'Add "Deploys"', at: '2026-10-01T10:00:00.000Z', agentName: 'Ben', agentId: 'agent-a', canRestore: true },
    ];
    let restored = 0;
    const { calls } = open(
      inWorkplace({ knowledge: [knowledgePage({ name: 'deploys', title: 'Deploys' })] }),
      {
        ...knowledgePageScript('deploys', () => runbook({ history })),
        'POST api/knowledge/pages/deploys/restore': () => {
          restored += 1;
          return { ok: true, number: 10, page: runbook({ html: '<!doctype html><title>Deploys</title><p>The earlier words.</p>', history: [{ number: 10, action: 'edit', title: 'Put "deploys" back as it was before #9', at: '2026-10-12T11:00:00.000Z', agentName: null, restore: true, canRestore: true }, ...history] }) };
        },
      },
      '/knowledge/deploys?org=o1',
    );
    expect(await screen.findByText('The words.')).toBeTruthy();
    const rows = [...document.querySelectorAll('#kpageHistory .khist')];
    expect(rows.map((row) => row.getAttribute('data-number'))).toEqual(['9', '4']);
    expect(rows[0]!.textContent).toContain('rewrote the rollback step');
    expect(rows[0]!.textContent).toContain('Ben');
    // The newest row undoes itself; an older row restores exactly its version.
    expect(within(rows[0]! as HTMLElement).getByRole('button', { name: 'Put back' })).toBeTruthy();
    expect(within(rows[1]! as HTMLElement).getByRole('button', { name: 'Put back to this' })).toBeTruthy();

    fireEvent.click(within(rows[0]! as HTMLElement).getByRole('button', { name: 'Put back' }));
    expect(await screen.findByText('The earlier words.')).toBeTruthy();
    expect(restored).toBe(1);
    const call = calls.find((c) => c.path === 'api/knowledge/pages/deploys/restore')!;
    expect(JSON.parse(String(call.init?.body))).toEqual({});
    expect([...document.querySelectorAll('#kpageHistory .khist')].map((row) => row.getAttribute('data-number'))).toEqual(['10', '9', '4']);
    expect(document.getElementById('kpageSaid')!.textContent).toBe('Put back as change #10.');
  });

  it('opens warm on the row the reader tapped, before the page itself lands', async () => {
    open(
      inWorkplace({
        knowledge: [knowledgePage({
          name: 'deploys', title: 'Deploys', description: 'How the deploy goes.',
        })],
      }),
      // Never answered: the heading must already be right without it.
      { 'GET api/knowledge/pages/deploys': () => new Promise(() => {}) },
      '/knowledge/deploys?org=o1',
    );
    expect(await screen.findByRole('heading', { name: 'Deploys' })).toBeTruthy();
    expect(document.getElementById('kpageSub')!.textContent).toBe('How the deploy goes.');
    expect(document.querySelector('#kpageBody .empty')!.textContent).toBe('Loading…');
  });

  it('says why rather than showing a blank page when the read fails', async () => {
    open(
      inWorkplace({ knowledge: [] }),
      { 'GET api/knowledge/pages/deploys': () => { throw new Error('No such knowledge page.'); } },
      '/knowledge/deploys?org=o1',
    );
    expect(await screen.findByText('No such knowledge page.')).toBeTruthy();
    // Nothing to hand over and nothing to say about a page that is not there.
    expect(document.getElementById('kpageHandsHead')).toBeNull();
    expect(document.getElementById('kpageCommentsHead')).toBeNull();
  });

  it('puts the page’s own picture in the img, from the files it arrived with', async () => {
    openPage(inWorkplace(), () => runbook({
      html: '<p>Here it is.</p><img src="files/plan.png" alt="the plan">',
      files: { 'plan.png': 'https://signed.test/plan' },
    }));
    await screen.findByText('Here it is.');
    const img = document.querySelector('#kpageBody img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://signed.test/plan');
    expect(img.getAttribute('alt')).toBe('the plan');
    // A page's picture is its evidence, so a tap opens it at full size.
    expect(img.classList.contains('openimage')).toBe(true);
  });

  it('reads the margin and takes a remark, on the page’s own thread', async () => {
    const posted: unknown[] = [];
    open(
      inWorkplace(),
      {
        ...knowledgePageScript('deploys', () => runbook({
          comments: [{
            text: '<p>Checked, still true.</p>', createdAt: '2026-09-01T10:00:00.000Z',
            agentName: 'Alex', agentAvatarUrl: '/faces/alex.png',
          }],
        })),
        'POST api/knowledge/pages/deploys/comments': (call) => {
          posted.push(JSON.parse(String(call.init?.body)));
          return { ok: true, comments: [] };
        },
      },
      '/knowledge/deploys?org=o1',
    );
    expect(await screen.findByText('Checked, still true.')).toBeTruthy();
    expect(document.getElementById('kpageCommentsCard')!.hidden).toBe(false);
    fireEvent.click(within(document.getElementById('kpageCommentsCard')!).getByRole('button', { name: /comment/i }));
    const box = document.querySelector('#kpageCommentsCard textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'The lane moved on Tuesday.' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(posted).toEqual([{ text: 'The lane moved on Tuesday.' }]));
  });

  it('keeps the margin whole when this backend has none to keep', async () => {
    openPage(inWorkplace(), () => runbook());
    await screen.findByText('The words.');
    // No `comments` key at all: the card is not offered, exactly as the note
    // screen's Files card is not.
    expect(document.getElementById('kpageCommentsCard')!.hidden).toBe(true);
  });
});

describe('handing a knowledge page to an agent', () => {
  const page = (): WorkspaceKnowledgePageRecord => ({
    name: 'miniapp-screenshots', title: 'Looking at a change', description: 'The traps.',
    html: '<p>Screens.</p>',  });
  const ben = () => agent({
    id: 'a', name: 'Ben', model: 'Opus 5', effort: 'high',
    recap: 'Shipped the deploy runbook',
  });
  const stella = () => agent({ id: 'b', name: 'Stella', cli: 'codex' });

  const openPage = (state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}) => open(
    state,
    { ...knowledgePageScript('miniapp-screenshots', page), ...extra },
    '/knowledge/miniapp-screenshots?org=o1',
  );
  const hands = () => document.getElementById('kpageHands')!;

  it('draws a card per idle agent of the workplace, under the page', async () => {
    openPage(inWorkplace({
      agents: [
        ben(), stella(),
        // Mid-turn: it could not take this page on.
        agent({ id: 'c', name: 'Oscar', working: true }),
        // Filed under another room by the answer, and walled off by it while
        // there were rooms (note #85); every agent reads the workplace's
        // pages since they left the product (note #843).
        agent({ id: 'd', name: 'Ruby' }),
      ],
    }));
    await screen.findByText('Screens.');
    expect(document.getElementById('kpageHandsHead')!.hidden).toBe(false);
    // A page is handed over like a note is; only the decision screens ask for
    // a review instead (note #390).
    expect(document.getElementById('kpageHandsHead')!.textContent).toBe('Hand it to an agent');
    expect([...hands().querySelectorAll('.hand .hname')].map((n) => n.textContent))
      .toEqual(['Ben', 'Stella', 'Ruby', 'Create agent']);
    // The same card the note draws: harness, model, effort and the home
    // list's own recap, so the choice is made on what the agent IS.
    const first = hands().querySelector('.hand')!;
    expect(first.querySelector('.hharness')!.textContent).toBe('Claude Code');
    expect(first.querySelector('.hmodel')!.textContent).toBe('Opus 5');
    expect(first.querySelector('.habout')!.textContent).toBe('Shipped the deploy runbook');
  });

  it('says "page" where the note says "note" — in the hint and in the label', async () => {
    openPage(inWorkplace({ agents: [ben()] }));
    await screen.findByText('Screens.');
    expect(document.getElementById('kpageHandsHint')!.textContent)
      .toBe('Tap a face for agent details. Tap the rest of its card to hand over this page;'
        + " the answer lands in that agent's Workspace conversation.");
    // The visible text is already in the card, so the label names the ACT —
    // and names it about the right kind of document.
    expect(hands().querySelector('.handpick')!.getAttribute('aria-label'))
      .toBe('Send Ben — Claude Code, Opus 5, high effort — a message about this page.'
        + ' Shipped the deploy runbook');
  });

  it('opens the message on the page it was tapped under, named by title AND ID', async () => {
    openPage(inWorkplace({ agents: [ben()] }));
    await screen.findByText('Screens.');
    fireEvent.click(hands().querySelector('.hand')!);
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeTruthy();
    const box = document.getElementById('noteSendText') as HTMLTextAreaElement;
    // "read", not "pick up": a page carries knowledge, and what is wanted
    // after it has been read is the reader's to say. No context reading on
    // this agent, so no reset is asked for.
    expect(box.value).toBe('read the knowledge page “Looking at a change” (ID: miniapp-screenshots)');
    expect(document.getElementById('noteSendCount')!.textContent).toBe(`${box.value.length} / 10000`);
    // No footer under Send (note #618): the screen is the box and the button.
    expect(document.getElementById('noteSendHint')).toBeNull();
  });

  it('asks a loaded agent to clear its chat first', async () => {
    openPage(inWorkplace({
      agents: [agent({
        id: 'a', name: 'Ben',
        context: { usedPercent: 64, tokens: 1, window: 2, at: '2026-09-02T10:00:00.000Z' },
      })],
    }));
    await screen.findByText('Screens.');
    fireEvent.click(hands().querySelector('.hand')!);
    await screen.findByRole('heading', { name: 'Ben' });
    expect((document.getElementById('noteSendText') as HTMLTextAreaElement).value)
      .toBe('reset chat and read the knowledge page “Looking at a change” (ID: miniapp-screenshots)');
  });

  it('sends it, says who took it, and comes back to the page', async () => {
    const sent: unknown[] = [];
    openPage(
      inWorkplace({ agents: [ben()] }),
      {
        'POST api/agents/a/message': (call) => {
          sent.push(JSON.parse(String(call.init?.body)));
          return { ok: true, name: 'Ben' };
        },
      },
    );
    await screen.findByText('Screens.');
    fireEvent.click(hands().querySelector('.hand')!);
    await screen.findByRole('heading', { name: 'Ben' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      message: 'read the knowledge page “Looking at a change” (ID: miniapp-screenshots)',
    });
    // Back onto the page the card was tapped on, and the banner says where
    // the answer will land.
    expect(await screen.findByRole('heading', { name: 'Looking at a change' })).toBeTruthy();
    expect(document.getElementById('banner')!.textContent)
      .toContain('Ben is on it — the answer lands in its chat.');
  });

  it('leaves the reader on the Send with the refusal when the agent took a turn first', async () => {
    openPage(
      inWorkplace({ agents: [ben()] }),
      {
        'POST api/agents/a/message': () => { throw new Error('Ben is working right now.'); },
      },
    );
    await screen.findByText('Screens.');
    fireEvent.click(hands().querySelector('.hand')!);
    await screen.findByRole('heading', { name: 'Ben' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.getElementById('banner')!.textContent)
      .toContain('Ben is working right now.'));
    // Nothing was sent, so nothing was lost: the message is still here.
    expect((document.getElementById('noteSendText') as HTMLTextAreaElement).value).toContain('read the knowledge page');
  });

  it('closes the Send on Back rather than spending a history entry', async () => {
    openPage(inWorkplace({ agents: [ben()] }));
    await screen.findByText('Screens.');
    fireEvent.click(hands().querySelector('.hand')!);
    await screen.findByRole('heading', { name: 'Ben' });
    fireEvent.click(document.getElementById('pageBack')!);
    expect(await screen.findByRole('heading', { name: 'Looking at a change' })).toBeTruthy();
  });

  it('opens the agent from its face without handing over the page', async () => {
    openPage(inWorkplace({ agents: [ben()] }), {
      'GET api/agents/a/version': () => ({ cliLabel: 'Claude Code', cliUpdateAvailable: false, busy: false, turnCount: 0, docs: { file: 'CLAUDE.md', version: 4, latest: 4, current: true } }),
      'GET api/agents/a/chat/latest': () => ({ message: null }),
      'GET api/agents/a/prs': () => ({ prs: [] }),
    });
    await screen.findByText('Screens.');
    const face = hands().querySelector('.handface') as HTMLButtonElement;
    expect(face.getAttribute('aria-label')).toBe('Open Ben details');
    fireEvent.click(face);
    // The agent's own screen, not the Send.
    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeTruthy();
    expect(document.getElementById('noteSendText')).toBeNull();
    expect(document.getElementById('screenAgent')).toBeTruthy();
  });

  it('keeps the row when every agent is busy, and says whose fleet that is', async () => {
    openPage(inWorkplace({
      agents: [
        agent({ id: 'a', name: 'Ben', working: true }),
        agent({ id: 'b', name: 'Stella', working: true }),
      ],
    }));
    await screen.findByText('Screens.');
    // The card stays: "the row I saw yesterday" going missing needs an answer.
    expect(document.getElementById('kpageHandsCard')!.hidden).toBe(false);
    expect(hands().querySelectorAll('.hand:not(.createhand)')).toHaveLength(0);
    expect(document.getElementById('kpageHandsHint')!.textContent)
      .toBe('Every agent here is working right now. This row comes back when one is free.');
  });

  it('offers to create the workplace its first agent, and names the page in the ask', async () => {
    openPage(inWorkplace());
    await screen.findByText('Screens.');
    expect(hands().querySelector('.createhand .hname')!.textContent).toBe('Create agent');
    expect(document.getElementById('kpageHandsHint')!.textContent)
      .toBe('Create an agent, then hand it this page when it is ready.');
  });

  it('draws nothing at all for a legacy workspace with no workplace', async () => {
    // No fleet and nowhere to put a new agent: an advert the reader cannot
    // act on is worse than the quiet screen they had. (It asked for a room
    // to put one in, while there were rooms — note #843.)
    open(
      emptyState(),
      knowledgePageScript('miniapp-screenshots', page),
      '/knowledge/miniapp-screenshots',
    );
    await screen.findByText('Screens.');
    expect(document.getElementById('kpageHandsHead')!.hidden).toBe(true);
    expect(document.getElementById('kpageHandsCard')!.hidden).toBe(true);
  });

  it('sits under the words and above the margin, exactly as the note’s does', async () => {
    openPage(inWorkplace({ agents: [ben()] }));
    await screen.findByText('Screens.');
    // What the page SAYS, then who could act on it, then what has been said
    // about it: the row is the one thing on the screen that makes something
    // happen, and it belongs above a thread that only comments.
    const screenNode = document.getElementById('screenKnowledgePage')!;
    const at = (id: string) => [...screenNode.children].findIndex((node) => node.id === id
      || Boolean(node.querySelector(`#${id}`)));
    expect(at('kpageHandsHead')).toBeGreaterThan(at('kpageBody'));
    expect(at('kpageHandsHead')).toBeLessThan(at('kpageCommentsHead'));
  });
});
