import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAgentsLiveAnswer, WorkspaceNotificationRow, WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { WorkspaceApiError, type WorkspaceApi } from '../../api/client.js';
import { agent, emptyState, homeShelf, note, pickerPage, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { forgetPreviews } from '../../ui/preview-urls.js';
import { LIVE_POLL_MS } from '../../workspace/WorkspaceProvider.js';

/**
 * Home, end to end against a scripted API: the same things the legacy
 * page's grab()-based tests hold its home screen to (telegram-miniapp-page,
 * -org and -knowledge tests), driven the way a person drives them.
 */

/** The address itself, and the browser's own Back: what Home writes into its
 *  entry (note #524) is only true if walking the entries proves it. */
function Address() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}
function BrowserBack() {
  const go = useNavigate();
  return <button type="button" onClick={() => go(-1)}>Browser Back</button>;
}
const at = () => screen.getByTestId('address').textContent;

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Address />
      <BrowserBack />
      <App api={api} />
    </MemoryRouter>,
  );
}

const home = (state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}) => {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  renderAt('/', scripted.api);
  return scripted;
};
const findHome = () => homeShelf();
/** A dialog over Home that is not its window or the agents picker (dialogs
 *  themselves since note #715): a confirm, a chooser, the picture viewer. */
const askDialog = () => screen.queryAllByRole('dialog').find((one) => one.id !== 'homeSheet' && one.id !== 'agentSwitchSheet') ?? null;
const findAskDialog = () => waitFor(() => { const ask = askDialog(); if (!ask) throw new Error('no dialog yet'); return ask; });
/** Home's Workplace window (note #715), opened from the Chief of Staff's
 *  name in the header. */
const openWorkplace = async () => {
  await waitFor(() => expect(document.getElementById('homeWorkplaceDoor')).toBeTruthy());
  fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
  await waitFor(() => expect(document.querySelector('#homeSheet #homeWorkplace')).toBeTruthy());
  return document.getElementById('homeWorkplace')!;
};
/** The agents picker by the message box (the owner's follow-up to note
 *  #715), which `homeShelf()` opens: one list of every agent since rooms
 *  left the product (note #843). Its tabs were the rooms before. */
const pickerTitle = () => document.getElementById('agentSwitchTitle')!;
// In the roster — the agents picker's list, or a personal workspace's Agents
// shelf — not the arriving card the Chief of Staff's chat draws for the same
// agent while it is being built (note #726).
const roster = () => (document.getElementById('agentSwitchGrid') ?? document.getElementById('agentsSection') ?? document.body) as HTMLElement;
const rowOf = (name: string) => within(roster()).getByText(name).closest('.crow') as HTMLElement;

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };

afterEach(() => { vi.useRealTimers(); forgetPreviews(); });

describe('the fleet', () => {
  /**
   * Note #144: a founding agent's row is a seat waiting on the WORKPLACE,
   * not a setup in progress — it says what the workplace still lacks and
   * wears no meter, which would promise progress nobody is making.
   */
  it('a planned founding agent’s row says what it waits for and wears no setup meter', async () => {
    home(emptyState({ org: { ...org, seatProviders: [] }, agents: [agent({ id: 'p1', name: 'Ruby', status: 'planned' })] }));
    await findHome();
    const row = rowOf('Ruby');
    expect(row.querySelector('.main .cline .ctext')!.textContent).toBe('Waiting for a subscription');
    expect(row.querySelector('[role="progressbar"]')).toBeNull();
  });

  /**
   * Note #564: a plate says how many durable jobs its agent left running,
   * and the count is its own door to the list that explains each one.
   */
  it('a plate counts its agent\'s background jobs and opens their list, not the agent', async () => {
    home(emptyState({
      agents: [
        agent({ id: 'felix', name: 'Felix', activeJobs: 2 }),
        agent({ id: 'solo', name: 'Solo', activeJobs: 1 }),
        agent({ id: 'quiet', name: 'Quiet' }),
      ],
    }), { 'GET api/agents/felix/jobs': () => ({ jobs: [] }) });
    await findHome();
    const door = rowOf('Felix').querySelector('.cjobs') as HTMLButtonElement;
    expect(door.textContent).toBe('2 background jobs');
    expect(door.getAttribute('aria-label')).toBe('2 background jobs running. Open details');
    expect(rowOf('Solo').querySelector('.cjobs')!.textContent).toBe('1 background job');
    expect(rowOf('Quiet').querySelector('.cjobs')).toBeNull();
    fireEvent.click(door);
    await screen.findByRole('heading', { name: 'Background jobs' });
    expect(document.getElementById('screenAgentJobs')).not.toBeNull();
  });

  /**
   * Note #553: what the newest message carried is ON the plate — the
   * pictures the recap talks about — and a tap opens them full screen with
   * the strip's other pictures one step away, without leaving the list.
   */
  it('a plate shows the files on its newest message, and a picture opens full screen in place', async () => {
    const saved: { href: string; download: string }[] = [];
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    const { calls } = home(emptyState({
      agents: [
        agent({ id: 'felix', name: 'Felix', recap: 'Delivered the screenshots.', lastFiles: [
          { id: 'f1', fileName: 'one.png', contentType: 'image/png', sizeBytes: 10, width: 1200, height: 600 },
          { id: 'f2', fileName: 'two.png', contentType: 'image/png', sizeBytes: 10 },
          { id: 'f3', fileName: 'site.zip', contentType: 'application/zip', sizeBytes: 99 },
        ] }),
        agent({ id: 'quiet', name: 'Quiet' }),
      ],
    }), {
      'GET api/agents/felix/chat/files/f1?preview=1': () => ({ url: 'blob:one', expiresAt: new Date(Date.now() + 900_000).toISOString() }),
      'GET api/agents/felix/chat/files/f2?preview=1': () => ({ url: 'blob:two', expiresAt: new Date(Date.now() + 900_000).toISOString(), width: 300, height: 600 }),
      'GET api/agents/felix/chat/files/f3': () => ({ url: 'blob:zip', fileName: 'site.zip' }),
    });
    await findHome();
    const felix = rowOf('Felix');
    const strip = felix.querySelector('.cfiles') as HTMLElement;
    expect(strip.getAttribute('role')).toBe('group');
    expect(rowOf('Quiet').querySelector('.cfiles')).toBeNull();
    // Two pictures and one archive, in the message's order; the pictures are
    // minted for preview and painted, the archive is its glyph and name.
    const marks = [...strip.querySelectorAll('.cfile')] as HTMLElement[];
    expect(marks.map((mark) => mark.className)).toEqual(['cfile pic', 'cfile pic', 'cfile doc']);
    expect(marks[2]!.textContent).toBe('site.zip');
    expect(marks[2]!.getAttribute('aria-label')).toBe('Download site.zip');
    await waitFor(() => expect(strip.querySelectorAll('.cfile.pic img')).toHaveLength(2));
    // A picture's proportions come from the row when it has them, else from
    // what the preview read measured.
    expect(marks[0]!.style.getPropertyValue('--thumb-ratio')).toBe('1200 / 600');
    await waitFor(() => expect(marks[1]!.style.getPropertyValue('--thumb-ratio')).toBe('300 / 600'));
    for (const mark of marks.slice(0, 2)) fireEvent.load(mark.querySelector('img')!);
    await waitFor(() => expect(marks[1]!.className).toBe('cfile pic painted'));
    expect(marks[1]!.getAttribute('aria-label')).toBe('Open two.png full screen');

    // The tap opens the viewer ON the tapped picture, with the other one a
    // step away — and the list is still under it: the plate's door did not
    // answer a tap that was the thumbnail's.
    fireEvent.click(marks[1]!);
    const viewer = await findAskDialog();
    expect(viewer.id).toBe('imageViewer');
    expect(document.getElementById('imageViewerName')!.textContent).toBe('two.png');
    expect((document.getElementById('imageViewerImage') as HTMLImageElement).getAttribute('src')).toBe('blob:two');
    expect(document.getElementById('imageViewerCount')!.textContent).toBe('2 of 2');
    fireEvent.click(document.getElementById('imageViewerPrev')!);
    await waitFor(() => expect(document.getElementById('imageViewerName')!.textContent).toBe('one.png'));
    expect(at()).toBe('/');
    fireEvent.click(document.getElementById('imageViewerClose')!);
    await waitFor(() => expect(askDialog()).toBeNull());

    // The archive is saved through a URL minted at the tap, and the list
    // stays put for that too.
    fireEvent.click(marks[2]!);
    await waitFor(() => expect(saved).toEqual([{ href: 'blob:zip', download: 'site.zip' }]));
    expect(calls.filter((call) => call.path === 'api/agents/felix/chat/files/f3')).toHaveLength(1);
    expect(at()).toBe('/');
    // And the plate is still a door for everything that is not a file — to
    // the conversation (note #573).
    fireEvent.click(felix.querySelector('.cabout')!);
    await waitFor(() => expect(at()).toBe('/chat/felix'));
    anchor.mockRestore();
  });

  it('a Markdown file on a plate opens as a page, in place (note #677)', async () => {
    home(emptyState({
      agents: [agent({ id: 'felix', name: 'Felix', recap: 'Wrote the plan.', lastFiles: [
        { id: 'm1', fileName: 'plan.md', contentType: 'text/markdown', sizeBytes: 40 },
      ] })],
    }), {
      'GET api/agents/felix/chat/files/m1/text': () => ({ kind: 'markdown', fileName: 'plan.md', content: '# The plan\n\n1. Ship' }),
    });
    await findHome();
    const mark = rowOf('Felix').querySelector('.cfiles .cfile') as HTMLElement;
    expect(mark.getAttribute('aria-label')).toBe('Open plan.md');
    fireEvent.click(mark);
    const viewer = await findAskDialog();
    expect(viewer.className).toBe('mdviewer');
    expect(document.getElementById('pdfViewerStage')!.querySelector('h1')!.textContent).toBe('The plan');
    expect(at()).toBe('/');
  });

  it('an agent row says what it runs, its state, then its latest-work recap', async () => {
    const today = new Date().toISOString();
    const fifteenHours = new Date(Date.now() - 15 * 3_600_000).toISOString();
    home(emptyState({
      agents: [
        agent({ id: 'felix', name: 'Felix', model: 'Opus', effort: 'high', working: true, activity: 'Bash: npm test', activitySince: today, now: 'Ship the page', recap: 'Built the landing page.', avatarUrl: '/faces/felix.png', context: { usedPercent: 71, tokens: 1, window: 2, at: today } }),
        agent({ id: 'mira', name: 'Mira', cli: 'codex', doing: { kind: 'proposal', count: 2, number: 9 }, now: 'stale words' }),
        agent({ id: 'otto', name: 'Otto', lastActiveAt: fifteenHours, doing: { kind: 'site', count: 2, host: 'shop.agentbuilt.app' } }),
        agent({ id: 'quiet', name: 'Quiet' }),
        agent({ id: 'lim', name: 'Lim', sessionLimit: { hitAt: 'h', resetAt: 'r', resumeReady: true } }),
        agent({ id: 'old', name: 'Old', cli: 'kimi', status: 'retired' }),
        agent({ id: 'new', name: 'New', status: 'setting-up' }),
      ],
    }));
    await findHome();
    const felix = rowOf('Felix');
    expect(felix.querySelector('.cruntime')!.textContent).toBe('Opus · high');
    const line = felix.querySelector('.cline')!;
    expect(line.querySelector('.livedot')).toBeTruthy();
    expect(line.querySelector('.ctext')!.textContent).toBe('Now');
    expect(line.querySelector('.crun')!.textContent).toMatch(/^\d+:\d\d$/);
    expect(line.querySelector('.cact')!.textContent).toBe('Bash: npm test');
    expect(felix.querySelector('.cabout')!.textContent).toBe('Built the landing page.');
    expect(felix.querySelector('.ctask')!.textContent).toBe('NowShip the page');
    const contextRing = felix.querySelector('.ctxring.warn') as HTMLElement;
    expect(contextRing.getAttribute('aria-label')).toBe('Context window 71% full');
    expect(contextRing.style.getPropertyValue('--ctx-hue')).toBe('41');
    expect((felix.querySelector('img.avatar') as HTMLImageElement).getAttribute('src')).toBe('/faces/felix.png');

    const mira = rowOf('Mira');
    // The bot glyph is drawn, not poured from a string.
    expect(mira.querySelector('.agenthead svg')).toBeTruthy();
    expect(within(mira).getByText('Codex')).toBeTruthy();
    expect(mira.querySelector('.ctext')!.textContent).toBe('2 proposals waiting on you');
    // The job line shows only while the turn runs.
    expect(mira.querySelector('.ctask')).toBeNull();
    // Note #574: an age, not a calendar day — "15h ago" says more than "today".
    expect(rowOf('Otto').querySelector('.ctext')!.textContent).toBe('Active 15h ago');
    expect(rowOf('Otto').querySelector('.cabout')!.textContent).toBe('Runs shop.agentbuilt.app and 1 more');
    expect(rowOf('Quiet').querySelector('.ctext')!.textContent).toBe('Ready');
    expect(rowOf('Quiet').querySelector('.cabout')).toBeNull();
    const lim = rowOf('Lim');
    expect(lim.querySelector('.ctext.limit')!.textContent).toBe('Ready to resume');
    expect(lim.querySelector('.limitmark')).toBeTruthy();
    expect(rowOf('Old').querySelector('.ctext')!.textContent).toBe('Retired — it can no longer run');
    // A harness this product no longer runs has no model to name, so the
    // runtime line falls back to the harness itself rather than vanishing.
    expect(rowOf('Old').querySelector('.cruntime')!.textContent).toBe('kimi');
    const fresh = rowOf('New');
    expect(fresh.querySelector('.ctext')!.textContent).toBe('Setting up — a minute or two');
    expect(fresh.querySelector('.working')).toBeTruthy();
    expect(fresh.querySelector('.steps')!.getAttribute('aria-label')).toBe('Setup step 1 of 3');
    expect(fresh.querySelectorAll('.steps > span')[0]!.className).toBe('now live');
  });

  it('says what each agent runs ON, under what it thinks with — and nothing when nobody has looked', async () => {
    home(emptyState({
      agents: [
        agent({ id: 'felix', name: 'Felix', model: 'Opus', effort: 'high', machineSize: { cpuKind: 'performance', cpus: 4, memoryMb: 8192 } }),
        agent({ id: 'ada', name: 'Ada', model: 'Opus', machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 } }),
        // Shared is the fact that explains an agent gone mysteriously slow,
        // so the row says the word rather than a size code (note #268).
        agent({ id: 'ben', name: 'Ben', model: 'Haiku', machineSize: { cpuKind: 'shared', cpus: 1, memoryMb: 2048 } }),
        // Nothing has read this machine yet. The row must say LESS, never
        // fill in the fleet default and tell its owner something plausible.
        agent({ id: 'eva', name: 'Eva', model: 'Opus' }),
      ],
    }));
    await findHome();
    const felix = rowOf('Felix');
    // Under the runtime, not instead of it: two identity facts, in order —
    // and the harness is no longer among them (note #396). It is the tab
    // above the grid and it is implied by the model; on a half-plate it was
    // 40% of a line that could not hold the model and the effort.
    expect(felix.querySelector('.cruntime')!.textContent).toBe('Opus · high');
    expect(felix.querySelector('.cmachine')!.textContent).toBe('4 dedicated cores · 8 GB');
    // Both out of the name's column and into the plate's full width, in
    // that order, so neither has to end in an ellipsis.
    expect(felix.querySelector('.agentidentity .cruntime')).toBeNull();
    expect([...felix.querySelectorAll('.agentfacts > *')].map((node) => node.className))
      .toEqual(['cruntime', 'cmachine']);
    expect(rowOf('Ada').querySelector('.cmachine')!.textContent).toBe('2 dedicated cores · 4 GB');
    // One core, one word for it.
    expect(rowOf('Ben').querySelector('.cmachine')!.textContent).toBe('1 shared core · 2 GB');
    expect(rowOf('Eva').querySelector('.cmachine')).toBeNull();
    expect(rowOf('Eva').querySelector('.cruntime')!.textContent).toBe('Opus');
    // Each fact is its own box so the line can fold between them; the words
    // it reads out are still the words it always was.
    expect([...felix.querySelectorAll('.cmachine .fact')].map((node) => node.textContent))
      .toEqual(['4 dedicated cores', ' · 8 GB']);
  });

  it('marks the agents running their CLI\u2019s flagship with a crown beside the name, and nobody else', async () => {
    home(emptyState({
      agents: [
        agent({ id: 'ruby', name: 'Ruby', model: 'fable', effort: 'xhigh', avatarUrl: '/faces/ruby.png' }),
        agent({ id: 'mira', name: 'Mira', cli: 'codex', model: 'gpt-6-astra', avatarUrl: '/faces/mira.png' }),
        agent({ id: 'felix', name: 'Felix', model: 'opus', avatarUrl: '/faces/felix.png' }),
        agent({ id: 'nova', name: 'Nova', cli: 'codex', model: 'gpt-5.6-sol', avatarUrl: '/faces/nova.png' }),
      ],
    }));
    await findHome();
    // Note #296. The crown is a sibling of the name's own text, inside the
    // name box: the stylesheet turns that box into a flex line so a long name
    // takes the ellipsis and the mark stays whole.
    const ruby = rowOf('Ruby');
    const name = ruby.querySelector('.name')!;
    expect(name.querySelector('.nametext')!.textContent).toBe('Ruby');
    expect(name.querySelector('svg.crown')).toBeTruthy();
    // Nothing was added to the face, which is where it used to be.
    expect(ruby.querySelector('.ctxring .crown')).toBeNull();
    expect((ruby.querySelector('img.avatar') as HTMLImageElement).getAttribute('src')).toBe('/faces/ruby.png');
    // Note #324: the mark is the CLI's flagship, not one product's model, so a
    // Codex agent on Astra earns exactly the same crown in the same place.
    const mira = rowOf('Mira');
    expect(mira.querySelector('.name > .nametext')!.textContent).toBe('Mira');
    expect(mira.querySelector('.name > svg.crown')).toBeTruthy();
    expect(mira.querySelector('.ctxring .crown')).toBeNull();
    // Any other model \u2014 on EITHER harness \u2014 keeps the bare text node it
    // always had. Both of these sit a rung below their flagship, which is also
    // what an agent that never picked a model is resolved to.
    for (const other of ['Felix', 'Nova']) {
      const row = rowOf(other);
      expect([other, row.querySelector('.crown')]).toEqual([other, null]);
      expect(row.querySelector('.name')!.textContent).toBe(other);
      expect(row.querySelector('.name > .nametext')).toBeNull();
    }
  });

  // It showed the agents of the room being shown, and counted them, until
  // rooms left the product (note #843): the picker is every agent of the
  // workplace, whatever room an older record still names.
  it('lists every agent of the workplace, and a row opens its conversation', async () => {
    home(emptyState({
      org,
      agents: [
        agent({ id: 'a', name: 'Ada', working: true }),
        agent({ id: 'b', name: 'Bo' }),
        agent({ id: 'c', name: 'Cy' }),
      ],
    }));
    await findHome();
    // Working first (note #775), then the fleet's own order.
    expect([...roster().querySelectorAll<HTMLElement>('.crow[data-agent]')].map((row) => row.dataset.agent)).toEqual(['a', 'b', 'c']);
    // The plate opens the conversation (note #573), which draws its own
    // header rather than standing under the persistent one.
    fireEvent.click(rowOf('Bo'));
    await waitFor(() => expect(at()).toBe('/chat/b'));
    expect(await screen.findByRole('heading', { name: 'Bo' })).toBeTruthy();
    expect(document.getElementById('screenAgentChat')).toBeTruthy();
    expect(document.getElementById('pageHead')).toBeNull();
    // Everything ABOUT the agent is one tap on, through the header's name.
    // That destination wears the persistent header, never Home does, and
    // Back is its only generic way out (note #426) — each Back spending one
    // entry, so the walk home is the walk in, reversed.
    fireEvent.click(screen.getByRole('link', { name: 'Bo: open agent details' }));
    await waitFor(() => expect(at()).toBe('/agents/b'));
    expect(await screen.findByRole('heading', { name: 'Bo' })).toBeTruthy();
    expect(document.getElementById('pageHead')).toBeTruthy();
    expect(document.getElementById('pageHome')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(at()).toBe('/chat/b'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await findHome();
    // Back to Home — the picker put away by the walk, `findHome` opens it
    // again — and no persistent header, Home has none.
    expect(at()).toBe('/');
    expect(pickerTitle().textContent).toBe('Your agents');
    expect(document.getElementById('pageHead')).toBeNull();
  });

  // Note #412: the fleet is one list. The All / Claude Code / Codex tabs are
  // gone, so every agent stands in the grid and the counts describe the whole
  // fleet rather than a chosen slice of it. The counts head a personal
  // workspace's Agents shelf; they headed a room's too, while there were
  // rooms (note #843).
  it('shows the fleet whole, with no harness tabs to narrow it', async () => {
    home(emptyState({
      agents: [
        agent({ id: 'a', name: 'Ada', working: true }),
        agent({ id: 'b', name: 'Bo' }),
        agent({ id: 'c', name: 'Cy', cli: 'codex', working: true }),
      ],
    }));
    await findHome();
    const names = [...document.querySelectorAll('#agents .crow .name')].map((row) => row.textContent);

    expect(names).toEqual(['Ada', 'Bo', 'Cy']);
    expect(document.getElementById('agentFilters')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Show agents by harness' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Claude Code' })).toBeNull();
    expect(document.querySelector('#agentsSection .chip')).toBeNull();
    expect(document.getElementById('agentCounts')!.getAttribute('aria-label'))
      .toBe('3 agents total, 2 active, 1 idle');
    expect(document.getElementById('agentCounts')!.textContent).toBe('3 total · 2 active · 1 idle');
  });

  // Note #983: the plate of a paused agent with no matching seat used to lead
  // only to the sign-in, so an agent whose sign-in had lapsed had no way to
  // its own screen — the one place it is deleted. The plate opens that
  // screen now, and the line that names the sign-in is the sign-in's door.
  it('a paused agent with no matching seat opens its own screen, and its line opens the sign-in', async () => {
    home(emptyState({
      org: { ...org, seatProviders: ['codex'] },
      agents: [
        agent({ id: 'p', name: 'Paused', status: 'needs-seat' }),
        agent({ id: 'q', name: 'Choose', cli: 'codex', status: 'needs-seat' }),
      ],
    }));
    await findHome();
    expect(rowOf('Paused').querySelector('.ctext.act')!.textContent).toBe('Paused — sign in Claude');
    expect(rowOf('Choose').querySelector('.ctext.act')!.textContent).toBe('Paused — choose a subscription');
    // A seat it can have is chosen on its own screen: that line is words.
    expect(rowOf('Choose').querySelector('.ctext.act')!.hasAttribute('data-row-door')).toBe(false);
    fireEvent.click(rowOf('Paused').querySelector('.ctext.act')!);
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
  });

  // Note #573: the plate is the door to the conversation. A plate whose line
  // names something to fix still opens where it is fixed — the agent's own
  // screen, with the Subscription row or the Resume button on it — because
  // a chat with an agent that cannot answer invites a message nobody reads.
  it('a plate opens the chat of an agent that can take a message, and its own screen otherwise', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    // A conversation leaves the picker; an agent's own screen opens inside
    // it, as a page over its list (note #722).
    const cases: Array<[string, string]> = [
      ['Idle', '/chat/idle'],
      ['Busy', '/chat/busy'],
      ['Choose', 'page /agents/choose'],
      ['Paused', 'page /agents/paused'],
      ['Making', 'page /agents/making'],
      ['Limited', 'page /agents/limited'],
      ['Gone', 'page /agents/gone'],
    ];
    for (const [name, address] of cases) {
      const { unmount } = renderAt('/', scriptedApi(workspaceScript(() => emptyState({
        org: { ...org, seatProviders: ['codex'] },
        agents: [
          agent({ id: 'idle', name: 'Idle' }),
          agent({ id: 'busy', name: 'Busy', working: true }),
          agent({ id: 'choose', name: 'Choose', cli: 'codex', status: 'needs-seat' }),
          agent({ id: 'paused', name: 'Paused', status: 'needs-seat' }),
          agent({ id: 'making', name: 'Making', status: 'setting-up' }),
          agent({ id: 'limited', name: 'Limited', sessionLimit: { hitAt: soon, resetAt: soon, resumeReady: false } }),
          agent({ id: 'gone', name: 'Gone', status: 'retired' }),
        ],
      }))).api);
      await findHome();
      fireEvent.click(rowOf(name));
      await waitFor(() => expect([name, pickerPage() ? `page ${pickerPage()}` : at()]).toEqual([name, address]));
      unmount();
    }
  });

  it('puts New agent on the empty card', async () => {
    const { unmount } = render(<div />);
    unmount();
    home(emptyState({ org, agents: [] }));
    await findHome();
    const card = document.querySelector('.agentemptycard')!;
    expect(card.id).toBe('agentSwitchEmpty');
    expect(within(card as HTMLElement).getByText('Start with an agent')).toBeTruthy();
    const door = card.querySelector('#newAgentBtn') as HTMLButtonElement;
    expect(door.tagName).toBe('BUTTON');
    expect(door.disabled).toBe(false);
    expect(door.textContent).toContain('New agent');
  });

  // With no room the door waited — "Start with a room", "Create a room
  // first" — until rooms left the product (note #843). A state that still
  // lists none must not bring that back.
  it('never makes the door wait for a room', async () => {
    home(emptyState({ org, agents: [] }));
    await findHome();
    expect(screen.getByText('Start with an agent')).toBeTruthy();
    expect((document.getElementById('newAgentBtn') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Start with a room')).toBeNull();
    expect(screen.queryByText('Create a room first')).toBeNull();
  });
});

/**
 * Note #707: "room should have button that reset agents that are completed,
 * safe to reset". One door under the fleet, there only while somebody here is
 * safe to reset — finished by the summarizer's verdict and held by nothing on
 * the records — which asks first, naming them, and reports who was asked.
 * It stood under a room's agents, and counted only that room's, until rooms
 * left the product (note #843): it is the picker's, under every agent.
 */
describe('the fleet’s reset button', () => {
  const reading = (at = 't1') => ({ usedPercent: 31, tokens: 310_000, window: 1_000_000, at });
  const fleet = () => [
    agent({ id: 'oscar', name: 'Oscar', finished: true, context: reading() }),
    agent({ id: 'ada', name: 'Ada', finished: true, context: reading() }),
    agent({ id: 'noah', name: 'Noah', context: reading() }),
    agent({ id: 'iris', name: 'Iris', finished: true, working: true, context: reading() }),
    agent({ id: 'alex', name: 'Alex', finished: true }),
    agent({ id: 'rosa', name: 'Rosa', finished: true, context: reading(), doing: { kind: 'proposal', count: 1, number: 12 } }),
    agent({ id: 'clara', name: 'Clara', finished: true, context: reading(), activeJobs: 1 }),
    agent({ id: 'theo', name: 'Theo', finished: true, context: reading() }),
  ];
  const held = note({ id: 'n1', number: 1, title: 'The pricing page', work: { state: 'working', agentId: 'theo', agentName: 'Theo' } });
  const door = () => document.getElementById('freshChatsBtn') as HTMLButtonElement | null;

  it('stands under the fleet only for the agents that are safe to reset', async () => {
    home(emptyState({ org, agents: fleet(), notes: [held] }));
    await findHome();
    // Oscar and Ada: idle, finished, a conversation to clear and nothing that
    // comes back to them.
    expect(door()!.textContent).toBe('Reset 2 finished agents');
    expect(door()!.closest('#agentSwitchList')).not.toBeNull();
    expect(roster().compareDocumentPosition(door()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('counts every agent of the workplace, whatever room an older record names (note #843)', async () => {
    home(emptyState({ org, agents: [...fleet(), agent({ id: 'sam', name: 'Sam', finished: true, context: reading() })], notes: [held] }));
    await findHome();
    expect(door()!.textContent).toBe('Reset 3 finished agents');
  });

  it('is absent when nobody here is safe to reset', async () => {
    home(emptyState({ org, agents: fleet().filter((row) => !['oscar', 'ada'].includes(row.id)), notes: [held] }));
    await findHome();
    expect(within(roster()).getByText('Noah')).toBeTruthy();
    expect(door()).toBeNull();
  });

  it('asks first, naming them, then asks each and says who was asked and who was left alone', async () => {
    const sent: unknown[] = [];
    let state = emptyState({ org, agents: fleet(), notes: [held] });
    home(state, {
      'GET api/state': () => state,
      'POST api/agents/fresh-chats': (call) => {
        sent.push(JSON.parse(String(call.init?.body)));
        // Ada turned busy between the drawing and the press.
        state = { ...state, agents: state.agents!.map((row) => (row.id === 'oscar' || row.id === 'ada' ? { ...row, working: true } : row)) };
        return { asked: [{ id: 'oscar', name: 'Oscar' }], skipped: [{ id: 'ada', name: 'Ada', reason: 'is working right now' }] };
      },
    });
    await findHome();
    fireEvent.click(door()!);
    const ask = askDialog()!;
    expect(ask.textContent).toContain('Reset 2 finished agents?');
    expect(ask.textContent).toContain('Oscar and Ada have finished their work, and nothing is waiting on them.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Reset 2' }));
    await screen.findByText(
      'Asked Oscar to start a fresh chat — it answers in its chat. Left as it is: Ada is working right now.',
    );
    expect(sent).toEqual([{ agentIds: ['oscar', 'ada'] }]);
    await waitFor(() => expect(door()).toBeNull());
  });

  it('sends nothing when the question is answered no', async () => {
    const scripted = home(emptyState({ org, agents: fleet(), notes: [held] }));
    await findHome();
    fireEvent.click(door()!);
    fireEvent.click(within(askDialog()!).getByRole('button', { name: 'Cancel' }));
    expect(askDialog()).toBeNull();
    expect(scripted.calls.some((call) => call.path === 'api/agents/fresh-chats')).toBe(false);
    expect(door()!.textContent).toBe('Reset 2 finished agents');
  });

  it('rises on the live tick, which carries the verdict written after the turn-end read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finished: string[] = [];
    home(emptyState({ org, agents: [agent({ id: 'oscar', name: 'Oscar', context: reading() })] }), {
      'GET api/agents/live': () => ({ agents: [], recaps: [], sessionLimits: [], finished } satisfies WorkspaceAgentsLiveAnswer),
    });
    await findHome();
    expect(door()).toBeNull();
    finished = ['oscar'];
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 50); });
    await waitFor(() => expect(door()!.textContent).toBe('Reset 1 finished agent'));
  });
});

describe('Home’s two windows (note #715)', () => {
  // The overview's two tabs are two windows over Home now: Workplace, and
  // the agents picker — which had a room under each of its tabs until rooms
  // left the product (note #843). `homeShelf()` opens the one a shelf is in.
  const halved = (over: Partial<WorkspaceStateAnswer> = {}) => emptyState({
    org, driveAvailable: true,
    agents: [agent({ id: 'a', name: 'Ada', lastActiveAt: new Date().toISOString() })],
    ...over,
  });
  const node = (id: string) => document.getElementById(id)!;
  const workplaceWindow = openWorkplace;

  it('Workplace holds the workplace’s shelves as an index, and no agents: the fleet is the picker’s', async () => {
    home(halved());
    const workplace = await workplaceWindow();
    expect(workplace.closest('#homeSheet')).toBeTruthy();
    // One row per shelf (note #960), each a link onto its own screen.
    expect(within(node('indexDrive')).getByText('Drive')).toBeTruthy();
    expect(node('indexDrive').getAttribute('href')).toMatch(/\/drive\?org=o1$/);
    expect(document.getElementById('homeRoom')).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Agents/ })).toBeNull();
  });

  // The notes were a room's shelf, under a tab of the picker, until rooms
  // left the product (note #843): they are the workplace's one list, a row
  // of its window since note #960, saying how many and how many wait — the
  // notes themselves are on their screen. The Workspace Agent's own notes
  // card (note #468) stays gone: its notes are among these.
  it('holds the workplace’s notes as one row before Drive, and the picker holds none', async () => {
    home(halved({ notes: [note({ number: 3, title: 'The pricing page' })] }));
    const workplace = await workplaceWindow();
    const row = node('indexNotes');
    expect(row.closest('#homeWorkplace')).toBe(workplace);
    expect(row.textContent).toBe('Notes1 note');
    expect(within(workplace).queryByText('The pricing page')).toBeNull();
    const before = (a: string, b: string) =>
      Boolean(node(a).compareDocumentPosition(node(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before('indexNotes', 'indexDrive')).toBe(true);
    expect(workplace.querySelector('#workspaceNotesCard')).toBeNull();
    expect(workplace.querySelector('#notesCard')).toBeNull();
    await homeShelf();
    expect(document.querySelector('#agentSwitchSheet #notesCard')).toBeNull();
  });

  it('the Notes row in Workplace opens the notes screen', async () => {
    home(halved({ notes: [note({ number: 3, title: 'The pricing page' })] }));
    await workplaceWindow();
    fireEvent.click(node('indexNotes'));
    await waitFor(() => expect(at()).toBe('/notes?org=o1'));
  });

  it('a workplace with no notes says so on the row', async () => {
    home(halved({ notes: [] }));
    await workplaceWindow();
    expect(node('indexNotes').textContent).toBe('NotesNo notes yet');
  });

  // The counts stand only where there is no team (note #1009): with people
  // cards, the reader's own card says the same with faces and dots.
  it('opens a workplace with no team on the agent counts (note #614)', async () => {
    home(halved({
      org: { ...org, members: 1 }, invitesClosed: true, 
      agents: [
        agent({ id: 'ada', name: 'Ada', working: true }),
        agent({ id: 'theo', name: 'Theo', working: true }),
        agent({ id: 'milo', name: 'Milo' }),
      ],
    }));
    const workplace = await workplaceWindow();
    const activity = node('agentActivity');
    expect(workplace.firstElementChild).toBe(activity);
    // The briefing was each room's (note #688), and left with the rooms
    // (note #843): none stands here.
    expect(workplace.querySelector('#workspaceRecap')).toBeNull();
    expect(activity.querySelector('[role=status]')!.getAttribute('aria-label'))
      .toBe('2 of your agents working now; 3 agents of yours in this workplace');
    expect([...activity.querySelectorAll('.agentactivitynumber')].map((n) => n.textContent)).toEqual(['2', '3']);
  });

  // The owner, 2026-09-23: "It should show only information about my agents,
  // not my teammates agents." Theirs are shown where they work, not here.
  it('counts only the reader’s own agents in the workplace pulse, never a teammate’s', async () => {
    home(halved({
      org: { ...org, members: 1 }, invitesClosed: true, 
      agents: [agent({ id: 'ada', name: 'Ada', working: true })],
      teamAgents: [
        { id: 'leo', name: 'Leo', status: 'ready', working: true, owner: { userId: 'dana', name: 'Dana Ives' } },
        { id: 'nora', name: 'Nora', status: 'ready', owner: { userId: 'dana', name: 'Dana Ives' } },
      ],
    }));
    await workplaceWindow();
    expect([...node('agentActivity').querySelectorAll('.agentactivitynumber')].map((n) => n.textContent)).toEqual(['1', '1']);
  });

  it('puts Direct messages and Mail after the people, with no briefing (notes #606, #688, 2026-10-28)', async () => {
    home(halved({
      messagesAvailable: true,
      user: {
        name: 'Saddam',
        profile: { firstName: 'Saddam', lastName: '', incomplete: false },
        account: {
          browserLogin: { enabled: true, method: 'email', email: 'saddam@example.com', secondFactorEnabled: false, verificationStatus: 'verified' },
          mailbox: { address: 'saddam@agenticcloudcomputer.com' },
        },
      },
    }));
    const workplace = await workplaceWindow();
    const before = (a: string, b: string) =>
      Boolean(node(a).compareDocumentPosition(node(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    // The people stand first, and in place of the agent counts (note #1009).
    expect(workplace.firstElementChild).toBe(node('peopleSection'));
    expect(document.getElementById('agentActivity')).toBeNull();
    expect(before('peopleSection', 'humanMessagesCard')).toBe(true);
    expect(workplace.querySelector('#workspaceRecap')).toBeNull();
    expect([...node('humanMessagesCard').querySelectorAll('.crow .name')].map((row) => row.textContent))
      .toEqual(['Direct messages', 'Mail']);
  });

  /**
   * The team, back in the Workplace window (Adam, 2026-10-28: "let's bring
   * back the team UI where I can see my teammates and their statuses and
   * what their agents cooking"): one plate per person with here-now or last
   * seen, and under each their agents as faces and names, the blue dot on
   * the working ones and no recap (note #1009).
   */
  it('stands the people deck in Workplace, each person with what their agents are doing', async () => {
    const seen = new Date().toISOString();
    home(halved(), {
      'GET api/org/people': () => ({
        org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', workedMs: 0 },
        people: [
          { userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0, lastSeenAt: seen, here: true,
            agentFaces: [{ id: 'a', name: 'Ada' }] },
          { userId: 'u2', name: 'Mira Chen', you: false, role: 'member', joinedAt: '2026-08-20T00:00:00Z', agents: 1, workedMs: 0,
            lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString(),
            agentFaces: [{ id: 'leo', name: 'Leo', working: true, recap: 'Fixing the footer on the landing page.' }] },
        ],
      }),
      'GET api/org/people/live': () => ({ people: [] }),
    });
    await workplaceWindow();
    const deck = await waitFor(() => { const node = document.querySelector('#homeSheet #homePeople'); if (!node?.querySelector('.crow')) throw new Error('no plates yet'); return node as HTMLElement; });
    expect(node('peopleCounts').textContent).toBe('2 total · 1 here');
    const mira = deck.querySelector('.crow[data-person="u2"]') as HTMLElement;
    expect(within(mira).getByText('Active 4m ago')).toBeTruthy();
    const leo = mira.querySelector('.cagent[data-agent-door="leo"]') as HTMLElement;
    expect(leo.querySelector('.livedot')!.getAttribute('aria-label')).toBe('Working');
    expect(leo.textContent).toBe('Leo');
    expect(deck.textContent).not.toContain('Fixing the footer');
    // Two people, two columns: the full-width card is for one (note #1009).
    expect(deck.classList.contains('solo')).toBe(false);
    expect(document.getElementById('peopleHeadShown')!.textContent).toBe('People');
    expect(within(deck.querySelector('.crow[data-person="u1"]') as HTMLElement).getByText('Here now')).toBeTruthy();
  });

  // One person is one card across the window, not half of it (note #1009).
  it('draws a workplace of one that can grow as one full-width card', async () => {
    home(halved({ org: { ...org, members: 1 } }), {
      'GET api/org/people': () => ({
        org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', workedMs: 0 },
        people: [{ userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0, here: true, agentFaces: [{ id: 'a', name: 'Ada', working: true }] }],
      }),
    });
    await workplaceWindow();
    const deck = await waitFor(() => { const found = document.querySelector('#homeSheet #homePeople'); if (!found?.querySelector('.crow')) throw new Error('no plates yet'); return found as HTMLElement; });
    expect(deck.classList.contains('solo')).toBe(true);
    expect(document.getElementById('agentActivity')).toBeNull();
  });

  it('leaves the deck out — and makes no read for it — in a workplace of one nobody can join (note #205)', async () => {
    const { calls } = home(halved({ org: { ...org, members: 1 }, invitesClosed: true }));
    await workplaceWindow();
    expect(document.getElementById('peopleSection')).toBeNull();
    expect(calls.some((call) => call.path === 'api/org/people')).toBe(false);
  });

  it('puts an admin’s live join request in Workplace and removes the card after approval', async () => {
    let pending = [{
      requestId: 'jr1', userId: 'u2', name: 'Mira Chen', username: 'mira@agenticcloudcomputer.com',
      requestedAt: new Date().toISOString(),
    }];
    const { calls } = home(halved(), {
      'GET api/org/join-requests': (call) => {
        expect(call.scope?.org).toBe('o1');
        return { joinRequests: pending };
      },
      'POST api/org/join-requests/jr1/decision': (call) => {
        expect(JSON.parse(String(call.init?.body))).toEqual({ decision: 'approve' });
        expect(call.scope?.org).toBe('o1');
        pending = [];
        return { ok: true, status: 'approved' };
      },
    });
    await workplaceWindow();
    const approve = await screen.findByRole('button', { name: 'Approve Mira Chen' });
    const requestCard = document.getElementById('homeJoinRequests')!;
    expect(requestCard.closest('#homeWorkplace')).toBeTruthy();
    expect(within(requestCard).getByText('Join request')).toBeTruthy();
    expect(within(requestCard).queryByText(/waiting/)).toBeNull();
    expect(within(requestCard).getByText('mira@agenticcloudcomputer.com')).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() => expect(document.getElementById('homeJoinRequests')).toBeNull());
    expect(calls.some((call) => call.path === 'api/org/join-requests/jr1/decision')).toBe(true);
  });

  it('does not ask for or show join requests to a workplace member', async () => {
    const { calls } = home(halved({ org: { ...org, role: 'member' } }));
    await workplaceWindow();
    expect(document.getElementById('homeJoinRequests')).toBeNull();
    expect(calls.some((call) => call.path === 'api/org/join-requests')).toBe(false);
  });

  it('has no settings card: the header picture opens the account menu, with People, Apps and Settings (note #634)', async () => {
    home(halved({
      user: {
        name: 'Saddam',
        profile: { firstName: 'Saddam', lastName: '', incomplete: false, photoUrl: '/faces/saddam.png' },
        account: {
          browserLogin: { enabled: true, method: 'email', email: 'saddam@example.com', secondFactorEnabled: false, verificationStatus: 'verified' },
        },
      },
    }));
    await waitFor(() => expect(document.getElementById('homeAccount')).toBeTruthy());
    expect(document.getElementById('settingsCard')).toBeNull();
    const picture = screen.getByRole('button', { name: 'Your account' });
    // Last in the header, after the workplace switch.
    expect(document.querySelector('#screenHome .chathead')!.lastElementChild).toBe(picture);
    expect(picture.querySelector('img')!.getAttribute('src')).toBe('/faces/saddam.png');
    expect(picture.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(picture);
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    expect(picture.getAttribute('aria-expanded')).toBe('true');
    expect(within(menu).getByText('Saddam')).toBeTruthy();
    expect(within(menu).getByText('saddam@example.com')).toBeTruthy();
    expect(within(menu).getAllByRole('menuitem').map((row) => row.querySelector('.orgmenuname')!.textContent))
      .toEqual(['People', 'Apps', 'Settings']);
    expect(within(menu).getByText('Profile, picture and sign-in')).toBeTruthy();
    // Escape closes it without going anywhere.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Your account' })).toBeNull());
    fireEvent.click(picture);
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Your account' })).getByRole('menuitem', { name: /Settings/ }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('menu', { name: 'Your account' })).toBeNull();
  });

  it('the account menu’s People row opens the workplace’s People page (note #634)', async () => {
    home(halved());
    await waitFor(() => expect(document.getElementById('homeAccount')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Your account' }));
    const people = within(await screen.findByRole('menu', { name: 'Your account' })).getByRole('menuitem', { name: /People/ });
    expect(people.textContent).toContain(`${org.members} ${org.members === 1 ? 'person' : 'people'} in ${org.name}`);
    fireEvent.click(people);
    await waitFor(() => expect(document.getElementById('screenHome')).toBeNull());
    expect(screen.queryByRole('menu', { name: 'Your account' })).toBeNull();
  });

  // The Leaderboard's two doors went with the board (Adam, 28 Oct 2026,
  // note #824): the account menu's name opens the reader's own page instead.
  it('has no Leaderboard row under the agent counts, and never asks where the reader stands', async () => {
    const { calls } = home(halved({ org: { ...org, members: 1 }, invitesClosed: true }));
    await workplaceWindow();
    expect(node('agentActivity').textContent).not.toMatch(/Leaderboard/);
    expect(document.getElementById('leaderboardDoor')).toBeNull();
    expect(calls.some((call) => call.path.includes('leaderboard'))).toBe(false);
  });

  // A room's tab brought that room's shelves into the picker until rooms
  // left the product (note #843); the picker is the agents alone.
  it('the picker holds the agents, and none of the workplace’s shelves', async () => {
    home(halved());
    await homeShelf();
    expect(roster().closest('#agentSwitchSheet')).toBeTruthy();
    expect(document.getElementById('homeWorkplace')).toBeNull();
    expect(document.getElementById('homeRoom')).toBeNull();
    expect(pickerTitle().textContent).toBe('Your agents');
    expect(within(rowOf('Ada')).getByText('Ada')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Drive' })).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('a face in the picker opens the agent’s own screen; Back returns to Home, the picker put away', async () => {
    home(halved());
    await homeShelf();
    fireEvent.click(rowOf('Ada'));
    await screen.findByRole('heading', { name: 'Ada' });
    expect(document.getElementById('agentSwitchSheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    expect(document.getElementById('agentSwitchSheet')).toBeNull();
  });

  // It wore the mark while any ROOM had something waiting until rooms left
  // the product (note #843): an unread reply from one of the reader's agents
  // is one of the two things that light it now (a decision they can take is
  // the other, `HomeIsTheChat.test.tsx`).
  it('the agents stack wears the mark while a reply from one of the reader’s agents is unread', async () => {
    home(halved(), {
      'GET api/notifications': () => ({
        unread: 1,
        notifications: [{
          notificationId: 'n1', userId: 'u', kind: 'agent_completed', title: '', body: '', url: '/chat/a',
          source: 'direct_agent_chat', dedupeKey: 'n1', createdAt: '2026-09-02T10:00:00Z',
        } satisfies WorkspaceNotificationRow],
      }),
    });
    const stack = await waitFor(() => screen.getByRole('button', { name: 'Your agents, something is waiting for you' }));
    expect(stack.classList.contains('attention')).toBe(true);
    fireEvent.click(stack);
    await waitFor(() => expect(document.getElementById('agentSwitchSheet')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Your agents' }).classList.contains('attention')).toBe(false);
  });

  it('a personal workspace has nothing to divide, so it keeps its one column', async () => {
    home(emptyState({ agents: [agent({ id: 'a', name: 'Ada' })] }));
    await findHome();
    expect(screen.queryByRole('tab', { name: 'Workplace' })).toBeNull();
    expect(document.getElementById('homeDoors')).toBeNull();
    // The row stays for the reader's own picture alone: Home's one door into
    // their settings (note #634).
    expect(node('homeTabs').hidden).toBe(false);
    expect([...node('homeTabs').children].map((child) => child.id)).toEqual(['homeAccount']);
    expect(node('homeWorkplace').hidden).toBe(true);
    expect(node('homeRoom').hidden).toBe(false);
    expect(screen.getByRole('heading', { name: /^Agents/ })).toBeTruthy();
  });
});

/**
 * The picker stood in a room (note #715, the owner's follow-up): a room was
 * entered from its tab and the state read there, and the overview's old
 * address named one and was read in it from the first read — until rooms
 * left the product (note #843). No read names a room now.
 */
describe('no room to stand in', () => {
  it('opens an old address that names a room on the whole picker, with one state read that names none', async () => {
    const scripted = scriptedApi(workspaceScript(() => emptyState({
      org, driveAvailable: true,
      agents: [agent({ id: 'a', name: 'Ada' }), agent({ id: 'b', name: 'Bo' })],
    })));
    renderAt('/overview?half=rooms&room=r2', scripted.api);
    await waitFor(() => expect(document.getElementById('agentSwitchSheet')).toBeTruthy());
    expect(await within(roster()).findByText('Bo')).toBeTruthy();
    expect(within(roster()).getByText('Ada')).toBeTruthy();
    expect(at()).toBe('/');
    const reads = scripted.calls.filter((call) => call.path === 'api/state');
    expect(reads).toHaveLength(1);
    expect(scripted.calls.filter((call) => /[?&]room=/.test(call.path) || 'room' in (call.scope ?? {}))).toEqual([]);
  });
});

/**
 * Where the shelves stand. A room had a selector of its own shelves — Agents
 * and Notes — under the picker's tab until rooms left the product (note
 * #843); the agents are the picker's and every other shelf is Workplace's.
 */
describe('the shelves', () => {
  const roomState = (over: Partial<WorkspaceStateAnswer> = {}) => emptyState({
    org,
    agents: [agent({ id: 'a', name: 'Ada' })],
    notes: [note({ number: 12, title: 'Plan the lesson' })],
    repos: [], knowledge: [], secrets: [], sites: [],
    ...over,
  });

  it('puts repositories, knowledge and sites in Workplace, below Drive, in that order (note #566), each a row', async () => {
    home(roomState({
      driveAvailable: true,
      sites: [{
        name: 'shop', url: 'https://shop.agentbuilt.app', preset: 'static',
        status: 'live', kind: 'site', createdAt: '2026-09-01T00:00:00.000Z',
      }],
    }));
    await openWorkplace();
    const workplace = document.getElementById('homeWorkplace')!;
    const rows = [...workplace.querySelectorAll('a.indexrow')].map((row) => row.querySelector('.name')!.textContent);
    const place = (name: string) => rows.indexOf(name);
    expect(place('Drive')).toBeGreaterThanOrEqual(0);
    expect(place('Repositories')).toBeGreaterThan(place('Drive'));
    expect(place('Knowledge')).toBeGreaterThan(place('Repositories'));
    expect(place('Sites')).toBeGreaterThan(place('Knowledge'));
    expect(document.getElementById('indexSites')!.textContent).toBe('Sites1 site on agentbuilt.app');
    // The row opens the Sites screen, which lists it (note #960).
    const sites = await homeShelf('sites');
    expect(sites.querySelector('#sitesCard')!.textContent).toContain('shop');
    expect(at()).toBe('/sites?org=o1');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    // …and nowhere in the picker (nor in a room, while there were rooms).
    await homeShelf();
    const picker = document.getElementById('agentSwitchSheet')!;
    expect(picker.querySelector('#repos')).toBeNull();
    expect(picker.querySelector('#knowledge')).toBeNull();
    expect(picker.querySelector('#sitesCard')).toBeNull();
  });

  it('hides Sites in Workplace until the workplace has one', async () => {
    home(roomState({ driveAvailable: true }));
    await openWorkplace();
    expect(document.getElementById('indexSites')).toBeNull();
    expect(document.querySelector('#homeWorkplace #indexRepositories')).toBeTruthy();
  });

  it('opens a copied link to a room\'s old Knowledge shelf on Workplace, where knowledge is a row now', async () => {
    const state = roomState();
    const scripted = scriptedApi(workspaceScript(() => state));
    renderAt('/overview?content=knowledge', scripted.api);
    await waitFor(() => expect(document.querySelector('#homeSheet #homeWorkplace')).toBeTruthy());
    expect(document.querySelector('#homeWorkplace #indexKnowledge')).toBeTruthy();
  });

  // It opened the picker, in that room, on that shelf, until rooms left the
  // product (note #843): a room's notes are the workplace's one list now.
  it('opens a copied link to a room\'s old Notes shelf on the notes, and one to its Agents shelf on the picker', async () => {
    const state = roomState();
    const { unmount } = renderAt('/overview?content=notes&room=r1', scriptedApi(workspaceScript(() => state)).api);
    await waitFor(() => expect(document.getElementById('screenNotes')).toBeTruthy());
    expect(at()).toBe('/notes');
    unmount();
    renderAt('/overview?content=agents&room=r1', scriptedApi(workspaceScript(() => state)).api);
    await waitFor(() => expect(document.getElementById('agentSwitchSheet')).toBeTruthy());
    expect(at()).toBe('/');
  });

  it('keeps a personal account\'s one column whole: no Workplace window, so the three stay in it', async () => {
    home(emptyState({ repos: [], knowledge: [] }));
    await findHome();
    expect(document.getElementById('homeDoors')).toBeNull();
    expect(document.querySelector('#homeRoom #repos')).toBeTruthy();
    expect(document.querySelector('#homeWorkplace #repos')).toBeNull();
  });

  it('keeps workplace-wide Drive in Workplace, and out of the picker', async () => {
    home(emptyState({ org, driveAvailable: true }));
    await openWorkplace();
    const drive = document.getElementById('indexDrive')!;
    expect(drive.closest('#homeWorkplace')).toBeTruthy();
    expect(drive.querySelector('.name')!.textContent).toBe('Drive');
    // "Shared across all rooms" while there were rooms (note #843).
    expect(drive.textContent).toContain('Files for the whole workplace');
    await homeShelf();
    expect(document.querySelector('#agentSwitchSheet #indexDrive')).toBeNull();
  });

  // The room tabs (note #740), the one-time "Name existing work" door to the
  // rooms screen, and the room switch with its veil and its stale-answer
  // guard all left with the rooms (note #843). What a state that still says
  // work waits for a room must not do is hold the agents back.
  it('lists the agents even while an older state says work waits to be named', async () => {
    home(emptyState({ org, agents: [agent({ id: 'a', name: 'Ada' })] }));
    await findHome();
    expect(within(roster()).getByText('Ada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Name existing work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage rooms' })).toBeNull();
  });

  it('has no window and no picker door without a workplace and an agent', async () => {
    home(emptyState());
    await findHome();
    expect(document.getElementById('homeWorkplaceDoor')).toBeNull();
    expect(document.getElementById('agentChatSwitch')).toBeNull();
  });
});

describe('the decision queue', () => {
  it('lists what waits on this reader — change proposals first (note #463) — with the row parts, and opens each', async () => {
    home(emptyState({
      prs: [
        { id: 'pr-1', number: 4, repoName: 'shop', title: 'Add checkout', body: null, from: 'checkout', to: 'main', status: 'open', createdAt: 't', decidedAt: null, agentName: 'Bo', agentAvatarUrl: '/faces/bo.png', canDecide: true, checks: { total: 1, failing: 1, pending: 0, worst: 'failure' }, diffStat: { insertions: 12, deletions: 3 } },
        { id: 'pr-2', number: 5, repoName: 'shop', title: 'Somebody else’s', body: null, from: 'x', to: 'main', status: 'open', createdAt: 't', decidedAt: null, agentName: 'Zed', canDecide: false },
      ],
      knowledgeProposals: [
        { id: 'kp-1', number: 7, title: 'Deploy runbook', status: 'open', pages: ['deploys', 'rollbacks'], createdAt: 't', agentName: 'Bo', agentAvatarUrl: '/faces/bo.png', canDecide: true },
      ],
    }), {
      // Each row is a door onto the screen that decides it (slice 4).
      'GET api/prs/pr-1': () => ({
        pr: {
          id: 'pr-1', number: 4, repoName: 'shop', title: 'Add checkout', body: null, from: 'checkout',
          to: 'main', status: 'open', createdAt: 't', decidedAt: null, agentName: 'Bo', canDecide: true,
        },
        checks: [], patch: null, patchTruncated: false, commits: [], headSha: 'sha', requireChecks: false,
      }),
      'GET api/knowledge/proposals/kp-1': () => ({
        proposal: {
          id: 'kp-1', number: 7, title: 'Deploy runbook', status: 'open', pages: ['deploys'],
          createdAt: 't', agentName: 'Bo', canDecide: true,
        },
        changes: [],
      }),
    });
    await findHome();
    expect(screen.getByRole('heading', { name: 'Waiting for your decision' })).toBeTruthy();
    const rows = [...document.querySelectorAll('#prs .crow')];
    expect(rows.map((row) => row.querySelector('.name')!.textContent)).toEqual(['Add checkout', 'Deploy runbook']);
    const kp = rows[1]!;
    expect([...kp.querySelectorAll('.bname')].map((node) => node.textContent)).toEqual(['deploys', 'rollbacks']);
    expect(kp.querySelector('.num')!.textContent).toBe('#7');
    expect(kp.querySelector('img.face')).toBeTruthy();
    const pr = rows[0]!;
    expect(pr.querySelector('.bname')!.textContent).toBe('checkout');
    expect(pr.querySelector('.ctext')!.textContent).toBe('· shop');
    expect(pr.querySelector('.num')!.textContent).toBe('#4');
    expect(pr.querySelector('.pip')!.className).toBe('pip bad');
    expect(pr.querySelector('.stat')!.textContent).toBe('+12−3');
    fireEvent.click(pr);
    expect(await screen.findByRole('heading', { level: 1, name: 'Add checkout' })).toBeTruthy();
    expect(document.getElementById('screenPr')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await findHome();
    fireEvent.click(document.querySelector('#prs .crow:nth-child(2)')!);
    expect(await screen.findByRole('heading', { level: 1, name: 'Deploy runbook' })).toBeTruthy();
    expect(document.getElementById('screenKp')).toBeTruthy();
  });

  // Note #295: the face is all a queue row says about the agent behind it, and
  // a reader with a pointer can ask it for the rest.
  it('a pointer resting on a queue face raises who it is, what it runs, whether it is working and what it did', async () => {
    const queued = {
      id: 'pr-1', number: 4, repoName: 'shop', title: 'Add checkout', body: null, from: 'checkout',
      to: 'main', status: 'open', createdAt: 't', decidedAt: null, canDecide: true,
      agentName: 'Bo', agentAvatarUrl: '/faces/bo.png', agentId: 'bo',
    };
    home(emptyState({
      agents: [agent({
        id: 'bo', name: 'Bo', model: 'Opus', effort: 'high', avatarUrl: '/faces/bo.png',
        working: true, recap: 'Rebuilt the checkout and proposed #4.',
      })],
      prs: [queued],
    }));
    await findHome();
    const face = document.querySelector('#prs .crow .facehover')!;
    expect(document.querySelector('.agentcard')).toBeNull();
    fireEvent.mouseOver(face);
    const card = document.querySelector('.agentcard')!;
    expect(card.querySelector('.name')!.textContent).toBe('Bo');
    expect(card.querySelector('.cruntime')!.textContent).toBe('Claude Code · Opus · high');
    expect(card.querySelector('.headstate')!.className).toBe('headstate active');
    expect(card.querySelector('.statetext')!.textContent).toBe('Active');
    // The line that tells one face from another: what this agent has been on.
    expect(card.querySelector('.cabout')!.textContent).toBe('Rebuilt the checkout and proposed #4.');
    // It is drawn OUT of the queue's card, which clips its own overflow.
    expect(card.closest('#prs')).toBeNull();
    fireEvent.mouseOut(face);
    expect(document.querySelector('.agentcard')).toBeNull();
  });

  // An idle agent says so in the same pill, and one the fleet no longer has
  // keeps its name rather than the card inventing a runtime for it.
  it('the card reads the live fleet, and says only what it knows', async () => {
    const queued = (agentId: string) => ({
      id: `pr-${agentId}`, number: 4, repoName: 'shop', title: `Add ${agentId}`, body: null, from: 'checkout',
      to: 'main', status: 'open', createdAt: 't', decidedAt: null, canDecide: true,
      agentName: 'Bo', agentAvatarUrl: '/faces/bo.png', agentId,
    });
    home(emptyState({
      agents: [agent({ id: 'bo', name: 'Bo', avatarUrl: '/faces/bo.png' })],
      prs: [queued('bo'), queued('gone')],
    }));
    await findHome();
    const faces = [...document.querySelectorAll('#prs .crow .facehover')];
    fireEvent.mouseOver(faces[0]!);
    expect(document.querySelector('.agentcard .headstate')!.className).toBe('headstate idle');
    expect(document.querySelector('.agentcard .statetext')!.textContent).toBe('Ready');
    // Nothing to report is no line, not an empty one.
    expect(document.querySelector('.agentcard .cabout')).toBeNull();
    fireEvent.mouseOut(faces[0]!);
    fireEvent.mouseOver(faces[1]!);
    const card = document.querySelector('.agentcard')!;
    expect(card.querySelector('.name')!.textContent).toBe('Bo');
    expect(card.querySelector('.cruntime')).toBeNull();
    expect(card.querySelector('.headstate')).toBeNull();
    expect(card.querySelector('.cabout')).toBeNull();
  });

  // Note #369: the same live dot the fleet's own rows wear, on the face of
  // the agent that proposed it — and on nothing else.
  it('marks the face of a proposing agent that is mid-turn, and only that one', async () => {
    const queued = (agentId: string, name: string) => ({
      id: `pr-${agentId}`, number: 4, repoName: 'shop', title: `Add ${name}`, body: null, from: 'checkout',
      to: 'main', status: 'open', createdAt: 't', decidedAt: null, canDecide: true,
      agentName: name, agentAvatarUrl: `/faces/${agentId}.png`, agentId,
    });
    home(emptyState({
      agents: [
        agent({ id: 'bo', name: 'Bo', avatarUrl: '/faces/bo.png', working: true }),
        agent({ id: 'ada', name: 'Ada', avatarUrl: '/faces/ada.png' }),
      ],
      prs: [queued('bo', 'Bo'), queued('ada', 'Ada'), queued('gone', 'Ghost')],
      knowledgeProposals: [{
        id: 'kp-1', number: 7, title: 'Deploy runbook', status: 'open', pages: ['deploys'],
        createdAt: 't', agentName: 'Bo', agentAvatarUrl: '/faces/bo.png', agentId: 'bo', canDecide: true,
      }],
    }));
    await findHome();
    const rows = [...document.querySelectorAll('#prs .crow')];
    expect(rows.map((row) => Boolean(row.querySelector('.cline .livedot')))).toEqual([true, false, false, true]);
    // Next to the face, not adrift in the line: the mark's neighbour is the
    // picture it is about, and the branch chip is on the other side of it.
    const dot = rows[0]!.querySelector('.cline .livedot')!;
    expect(dot.previousElementSibling!.classList.contains('facehover')).toBe(true);
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(rows[0]!.querySelector('.cline .sr-only')!.textContent).toBe('Bo is working now');
    // An idle agent's row is left exactly as it was, and so is one whose
    // agent this reader was sent no id for.
    expect(rows[1]!.querySelector('.cline .sr-only')).toBeNull();
    expect(rows[2]!.querySelector('.cline .sr-only')).toBeNull();
  });

  // 2026-09-23: a teammate's agent wears the mark too — the live tick says
  // which of theirs are mid-turn, where it used to have no answer to give.
  it('marks a teammate’s proposing agent that is mid-turn as well', async () => {
    home(emptyState({
      prs: [{
        id: 'pr-leo', number: 5, repoName: 'shop', title: 'Add Leo', body: null, from: 'leo-branch',
        to: 'main', status: 'open', createdAt: 't', decidedAt: null, canDecide: true,
        agentName: 'Leo', agentAvatarUrl: '/faces/leo.png', agentId: 'leo',
      }],
      teamAgents: [{ id: 'leo', name: 'Leo', status: 'ready', working: true, owner: { userId: 'dana', name: 'Dana Ives' } }],
    }));
    await findHome();
    const row = document.querySelector('#prs .crow')!;
    expect(row.querySelector('.cline .livedot')).toBeTruthy();
    expect(row.querySelector('.cline .sr-only')!.textContent).toBe('Leo is working now');
  });

  it('is gone when nothing waits', async () => {
    home(emptyState());
    await findHome();
    expect(document.getElementById('prs')!.hidden).toBe(true);
    expect(document.getElementById('prsHead')!.hidden).toBe(true);
  });
});

describe('unread messages', () => {
  // They were the viewed room's (room-scoped) until rooms left the product
  // (note #843): the picker draws every agent's.
  it('draws unread direct replies in the picker, grouped, for every agent, and opens the chat', async () => {
    const note = (id: string, url: string, createdAt: string, extra: Partial<WorkspaceNotificationRow> = {}): WorkspaceNotificationRow => ({
      notificationId: id, userId: 'u', kind: 'agent_completed', title: '', body: '', url, source: 'direct_agent_chat', dedupeKey: id, createdAt, ...extra,
    });
    home(emptyState({
      org,
      agents: [
        agent({ id: 'a', name: 'Ada', lastReply: { text: '**Done** — the page is `live`.', at: 't' } }),
        agent({ id: 'b', name: 'Bo' }),
        agent({ id: 'c', name: 'Cy' }),
        agent({ id: 'd', name: 'Di', lastReply: { text: 'One answer, already read out.', at: 't' } }),
      ],
    }), {
      'GET api/notifications': () => ({
        unread: 4,
        notifications: [
          note('1', '/chat/a', '2026-09-02T10:00:00Z'),
          note('2', '/chat/a', '2026-09-02T11:00:00Z'),
          note('3', '/chat/b', '2026-09-02T12:00:00Z'),
          note('4', '/chat/c', '2026-09-02T13:00:00Z'),
          note('5', '/chat/b', '2026-09-02T09:00:00Z', { source: undefined }),
          note('6', '/chat/d', '2026-09-02T08:00:00Z'),
        ],
      }),
    });
    await findHome();
    await screen.findByRole('heading', { name: 'Unread messages' });
    const rows = [...document.querySelectorAll('#agentSwitchSheet #unreadMessages .crow')];
    // Cy too, whatever room an older record names: newest first.
    expect(rows.map((row) => row.querySelector('.name')!.textContent)).toEqual(['Cy', 'Bo', 'Ada', 'Di']);
    // Every unread row wears the dot that replaced the "new" pill (note #271),
    // and nothing else: the pill's word is the reader's only under a heading
    // that already says it, so it survives for a screen reader alone.
    expect(rows.every((row) => row.querySelector('.unreaddot'))).toBe(true);
    expect(rows.some((row) => row.querySelector('.badge'))).toBe(false);
    expect(rows[1]!.querySelector('.sr-only')!.textContent).toBe('Unread');
    // A reply with no words of its own falls back to saying what waits — and
    // then must NOT repeat it as a second fact on the same line.
    expect(rows[1]!.querySelector('.ctext')!.textContent).toBe('New reply');
    expect(rows[1]!.querySelector('.ctext.keep')).toBeNull();
    // The number the pill was carrying is what the dot cannot say, so it moves
    // onto the line of facts beside the time.
    expect(rows[2]!.querySelector('.ctext')!.textContent).toBe('Done — the page is live.');
    expect(rows[2]!.querySelector('.ctext.keep')!.textContent).toBe('· 2 replies');
    expect(rows[2]!.querySelector('.cwhen')!.textContent).toMatch(/^· /);
    // One waiting reply is the ordinary row, and it says no number at all: the
    // dot IS "one", and "1 reply" beside it would be the pill back in words.
    expect(rows[3]!.querySelector('.ctext')!.textContent).toBe('One answer, already read out.');
    expect(rows[3]!.querySelector('.ctext.keep')).toBeNull();
    fireEvent.click(rows[2]!);
    // The unread row opens the conversation itself, not a card about it.
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeTruthy();
  });
});

describe('making an agent', () => {
  it('asks which harness to run instead of quietly making a Claude Code agent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created: unknown[] = [];
    let fleet: WorkspaceStateAnswer['agents'] = [];
    const scripted = scriptedApi({
      ...workspaceScript(() => emptyState({
        org: { ...org, seatProviders: ['claude', 'codex'] }, agents: fleet,
      })),
      'POST api/agents': (call) => {
        created.push(JSON.parse(String(call.init?.body)));
        // The record is reserved just AFTER the response lands, so the first
        // reload can still come back without it.
        setTimeout(() => { fleet = [agent({ id: 'new', name: 'New one', status: 'setting-up' })]; }, 2000);
        return { ok: true };
      },
    });
    renderAt('/', scripted.api);
    await findHome();
    fireEvent.click(document.getElementById('newAgentBtn')!);
    await screen.findByRole('heading', { name: 'New agent' });
    const ask = askDialog()!;
    expect(within(ask).getByText('Claude Code')).toBeTruthy();
    expect(within(ask).getByText('Codex')).toBeTruthy();
    fireEvent.click(within(ask).getByText('Codex').closest('button')!);
    // The harness alone rides the body: the agent is the workplace's. (The
    // viewed room rode it too, pinned at the tap, until note #843.)
    await waitFor(() => expect(created).toEqual([{ cli: 'codex' }]));
    // A plate stands in for the agent until its record arrives — last, where
    // the real row will land.
    await waitFor(() => expect(screen.getByText('Getting it started…')).toBeTruthy());
    const door = document.getElementById('newAgentBtn') as HTMLButtonElement;
    // The pending agent plate owns progress; the door stays a normal-looking
    // New agent action. Its handler absorbs a repeat tap instead of changing
    // the button into a disabled/loading state.
    expect(door.disabled).toBe(false);
    expect(document.getElementById('newAgentLabel')!.textContent).toBe('New agent');
    fireEvent.click(door);
    expect(askDialog()).toBeNull();
    expect(created).toEqual([{ cli: 'codex' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    await waitFor(() => expect(within(roster()).getByText('New one')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Getting it started…')).toBeNull());
  });

  it('drops the stand-in the moment the real row lands, never both at once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fleet: WorkspaceStateAnswer['agents'] = [];
    const scripted = scriptedApi({
      ...workspaceScript(() => emptyState({
        org: { ...org, seatProviders: ['claude', 'codex'] }, agents: fleet,
      })),
      'POST api/agents': () => {
        setTimeout(() => { fleet = [agent({ id: 'new', name: 'Noah', status: 'setting-up' })]; }, 2000);
        return { ok: true };
      },
    });
    renderAt('/', scripted.api);
    await findHome();
    fireEvent.click(document.getElementById('newAgentBtn')!);
    await screen.findByRole('heading', { name: 'New agent' });
    const ask = askDialog()!;
    fireEvent.click(within(ask).getByText('Codex').closest('button')!);
    await waitFor(() => expect(screen.getByText('Getting it started…')).toBeTruthy());
    // Note #315: the record arrives and its row draws the SAME setup meter,
    // so a stand-in beside it is the one agent twice. The read that brings
    // the row is the read that ends the plate — not a later one.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(within(roster()).getByText('Noah')).toBeTruthy();
    expect(screen.queryByText('Getting it started…')).toBeNull();
    expect(document.querySelectorAll('#agentSwitchGrid .crow')).toHaveLength(1);
  });

  it('cancelling the chooser starts nothing', async () => {
    const scripted = scriptedApi(workspaceScript(() => emptyState({ org, agents: [] })));
    renderAt('/', scripted.api);
    await findHome();
    fireEvent.click(document.getElementById('newAgentBtn')!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(askDialog()).toBeNull());
    expect(scripted.calls.some((call) => call.path === 'api/agents')).toBe(false);
  });

  it('without the matching subscription it walks to the seats screen, not the server', async () => {
    const scripted = scriptedApi(workspaceScript(() => emptyState({
      org: { ...org, seatProviders: ['claude'] }, agents: [agent({ id: 'a', name: 'Ada' })],
    })));
    renderAt('/', scripted.api);
    await findHome();
    fireEvent.click(document.getElementById('newAgentBtn')!);
    await screen.findByRole('heading', { name: 'New agent' });
    fireEvent.click(within(askDialog()!).getByText('Codex').closest('button')!);
    // The server refuses this too; walking them to the sign-in beats bouncing
    // them off that refusal.
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('sign it in here first');
    expect(scripted.calls.some((call) => call.path === 'api/agents')).toBe(false);
  });

  it('a ChatGPT-only first user signs in first too — no agent waits on a machine for it', async () => {
    // Emma's first-user audit (2026-09-05) once needed this user to create
    // the Codex agent first, because the ChatGPT sign-in ran on its machine.
    // The server asks OpenAI itself now (2026-09-22), so with no agent at
    // all the chooser walks to the sign-in exactly as it does for Claude.
    const scripted = scriptedApi(workspaceScript(() => emptyState({
      org: { ...org, seatProviders: [] }, agents: [],
    })));
    renderAt('/', scripted.api);
    await findHome();
    fireEvent.click(document.getElementById('newAgentBtn')!);
    await screen.findByRole('heading', { name: 'New agent' });
    fireEvent.click(within(askDialog()!).getByText('Codex').closest('button')!);
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('sign it in here first');
    expect(scripted.calls.some((call) => call.path === 'api/agents')).toBe(false);
  });

  it('a Codex agent is never created without its sign-in when a paused ChatGPT grant is the problem', async () => {
    const scripted = scriptedApi(workspaceScript(() => emptyState({
      org: { ...org, seatProviders: [], paymentRequiredSeatProviders: ['codex'] }, agents: [],
    })));
    renderAt('/', scripted.api);
    await findHome();
    fireEvent.click(document.getElementById('newAgentBtn')!);
    await screen.findByRole('heading', { name: 'New agent' });
    fireEvent.click(within(askDialog()!).getByText('Codex').closest('button')!);
    expect(await screen.findByRole('heading', { name: 'Your subscriptions' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('ChatGPT access needs attention');
    expect(scripted.calls.some((call) => call.path === 'api/agents')).toBe(false);
  });
});

describe('Home workplace navigation', () => {
  it('removes the reader identity header and names the active workplace in the header switch', async () => {
    home(emptyState({
      org, organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 3, agents: 2 }, { orgId: 'o2', name: 'Other', role: 'member', active: false, members: 1, agents: 0 }],
      user: { name: 'Saddam', profile: { firstName: 'Saddam', lastName: '', photoUrl: '/me.png', incomplete: true }, account: { browserLogin: { enabled: true, method: 'totp', username: 'saddam' } } },
    }));
    await waitFor(() => expect(document.getElementById('homeOrganizations')).toBeTruthy());
    const navigation = document.querySelector('#screenHome .chathead')!;
    expect(document.getElementById('orgSection')).toBeNull();
    expect(navigation.querySelector('.orgwho, .orgname, .orgplace')).toBeNull();
    expect(navigation.querySelector('#homeWorkplaceDoor')).toBeTruthy();
    expect(navigation.querySelector('.orgswapname')?.textContent).toBe('Nomad Trading');
  });

  it('drops a menu of workplaces under the switch instead of leaving Home (note #609)', async () => {
    let active = 'o1';
    const { calls } = home(emptyState({
      org, canCreateOrg: true,
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 3, agents: 2 }, { orgId: 'o2', name: 'Other', role: 'member', active: false, members: 1, agents: 0 }],
    }), {
      'POST api/org/active': (call) => { active = JSON.parse(String(call.init?.body)).orgId; return { ok: true, orgId: active, name: 'Other' }; },
    });
    await findHome();
    const toggle = screen.getByRole('button', { name: 'Switch workplace' });
    expect(toggle.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(toggle);
    const menu = await screen.findByRole('menu', { name: 'Workplaces' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Still Home underneath: no picker screen, no navigation.
    expect(screen.queryByRole('heading', { name: 'Switch workplace' })).toBeNull();
    expect(document.getElementById('screenHome')).toBeTruthy();
    const rows = within(menu).getAllByRole('menuitemradio');
    expect(rows.map((row) => row.querySelector('.orgmenunametext')?.textContent)).toEqual(['Nomad Trading', 'Other']);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(rows[0]!.textContent).toContain('Admin');
    expect(rows[0]!.textContent).toContain('3 people · 2 agents');
    expect(within(menu).getByRole('menuitem', { name: 'Workplace settings' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'New workplace' })).toBeTruthy();

    // Escape, a tap outside, and the switch itself all close it.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.click(toggle);
    await screen.findByRole('menu');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.click(toggle);
    await screen.findByRole('menu');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    // Choosing another workplace switches right there.
    fireEvent.click(toggle);
    fireEvent.click(within(await screen.findByRole('menu')).getByText('Other').closest('button')!);
    await waitFor(() => expect(active).toBe('o2'));
    expect(calls.some((call) => call.path === 'api/org/active')).toBe(true);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // Landing in the other workplace is the confirmation: no toast (note #616).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.getElementById('banner')).toBeNull();
  });

  it('opens the workplace settings and the founder form from the menu', async () => {
    home(emptyState({
      org, canCreateOrg: true,
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 3, agents: 2 }],
    }));
    await findHome();
    fireEvent.click(screen.getByRole('button', { name: 'Switch workplace' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'New workplace' }));
    expect(await screen.findByRole('heading', { name: 'New workplace' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('invites a person from the menu, straight onto the page with the link ready (note #620)', async () => {
    const invite = { token: 't', link: 'https://workspace.test/invite/t', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString() };
    let minted = 0;
    home(emptyState({
      org, canCreateOrg: true,
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 3, agents: 2 }],
    }), {
      'GET api/org': () => ({ org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', invites: [invite], joinRequests: [], fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } }, members: [] } }),
      'GET api/org/join-requests': () => ({ joinRequests: [] }),
      'POST api/org/invites': () => { minted += 1; return { ok: true, invite }; },
    });
    await findHome();
    fireEvent.click(screen.getByRole('button', { name: 'Switch workplace' }));
    const menu = await screen.findByRole('menu', { name: 'Workplaces' });
    // Above the settings, the first of the active workplace's own doors.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Invite to this workplace', 'Workplace settings', 'New workplace']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Invite to this workplace' }));
    expect((await screen.findByDisplayValue(invite.link)).closest('#inviteLinkCard')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Invite to this workplace' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    // The tap itself makes nothing: a live link is handed over as it is.
    expect(minted).toBe(0);
  });

  it('offers no invitation while invites are switched off, even to an admin (owner, 2026-10-11)', async () => {
    home(emptyState({
      org, canCreateOrg: true, invitesClosed: true,
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 3, agents: 2 }],
    }));
    await findHome();
    fireEvent.click(screen.getByRole('button', { name: 'Switch workplace' }));
    const menu = await screen.findByRole('menu', { name: 'Workplaces' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Workplace settings', 'New workplace']);
  });

  it('offers no invitation to a member — only an admin can let somebody in', async () => {
    home(emptyState({
      org: { ...org, role: 'member' }, canCreateOrg: false,
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'member', active: true, members: 3, agents: 2 }],
    }));
    await findHome();
    fireEvent.click(screen.getByRole('button', { name: 'Switch workplace' }));
    const menu = await screen.findByRole('menu', { name: 'Workplaces' });
    expect(within(menu).queryByRole('menuitem', { name: 'Invite to this workplace' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Workplace settings' })).toBeTruthy();
  });

  it('keeps the switch for one workplace because its current row is now the details door', async () => {
    home(emptyState({
      org, canCreateOrg: false,
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 3, agents: 2 }],
    }));
    await findHome();
    fireEvent.click(screen.getByRole('button', { name: 'Switch workplace' }));
    const menu = await screen.findByRole('menu', { name: 'Workplaces' });
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1);
    expect(within(menu).getByRole('menuitem', { name: 'Workplace settings' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'New workplace' })).toBeNull();
  });

  it('keeps workplace creation in the new navigation row when there is no workplace yet', async () => {
    home(emptyState({ canCreateOrg: true, agents: [agent({ id: 'a', name: 'Ada' })] }));
    await findHome();
    const navigation = document.getElementById('homeTabs')!;
    expect(navigation.hidden).toBe(false);
    expect(navigation.querySelector('#homeDoors')).toBeNull();
    expect(navigation.querySelector('.orgswapname')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create workplace' }));
    expect(await screen.findByRole('heading', { name: 'New workplace' })).toBeTruthy();
  });
});

describe('keeping Home current', () => {
  it('re-reads Home when navigating back to it', async () => {
    const { calls } = home(emptyState({ agents: [agent({ id: 'a', name: 'Ada' })] }));
    await findHome();
    const stateReads = () => calls.filter((call) => call.path === 'api/state').length;
    expect(stateReads()).toBe(1);
    fireEvent.click(rowOf('Ada'));
    await screen.findByRole('heading', { name: 'Ada' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await findHome();
    await waitFor(() => expect(stateReads()).toBe(2));
  });

  it('re-reads Home when its browser window regains focus', async () => {
    const { calls } = home(emptyState());
    await findHome();
    const stateReads = () => calls.filter((call) => call.path === 'api/state').length;
    expect(stateReads()).toBe(1);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(stateReads()).toBe(2));
  });

  it('a live tick patches the working line without a state read, and buys one when the working set moves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live: WorkspaceAgentsLiveAnswer = { agents: [{ id: 'a', working: true, activity: 'Read: x', activitySince: new Date().toISOString() }], recaps: [], sessionLimits: [] };
    const { calls } = home(emptyState({ agents: [agent({ id: 'a', name: 'Ada', working: true, activity: 'Read: x' }), agent({ id: 'b', name: 'Bo' })] }), {
      'GET api/agents/live': () => live,
    });
    await findHome();
    const stateReads = () => calls.filter((call) => call.path === 'api/state').length;
    expect(stateReads()).toBe(1);
    live = { ...live, agents: [{ ...live.agents[0]!, activity: 'Bash: npm test' }] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(rowOf('Ada').querySelector('.cact')!.textContent).toBe('Bash: npm test'));
    expect(stateReads()).toBe(1);
    // The turn ends: the row can no longer say everything on its own.
    live = { agents: [], recaps: [{ id: 'a', recap: 'Finished the page.', recapAt: 'now' }], sessionLimits: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(stateReads()).toBe(2));
  });

  /**
   * Note #588, the owner: "in a room, I see the agent card in the agent list
   * without a background job. I opened the chat screen, I started seeing a
   * background job. Went back to the agent card, and started seeing a
   * background job." The count was recorded whenever the backend looked at
   * the machine, but it only reached an open list on a full state read — so
   * the chat, which reads it live, looked like the thing that created it.
   */
  it('a job starting and finishing reaches the plate on the tick, with no state read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live: WorkspaceAgentsLiveAnswer = { agents: [], recaps: [], sessionLimits: [], jobs: [] };
    const { calls } = home(emptyState({ agents: [agent({ id: 'a', name: 'Ada' })] }), { 'GET api/agents/live': () => live });
    await findHome();
    expect(rowOf('Ada').querySelector('.cjobs')).toBeNull();

    live = { ...live, jobs: [{ id: 'a', count: 1 }] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(rowOf('Ada').querySelector('.cjobs')!.textContent).toBe('1 background job'));

    live = { ...live, jobs: [{ id: 'a', count: 2 }] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(rowOf('Ada').querySelector('.cjobs')!.textContent).toBe('2 background jobs'));

    live = { ...live, jobs: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(rowOf('Ada').querySelector('.cjobs')).toBeNull());

    // All of it on the tick: the whole state was read once, when Home opened.
    expect(calls.filter((call) => call.path === 'api/state')).toHaveLength(1);
  });

  it('a recap that lands mid-turn arrives on the row without a state read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live: { agents: never[]; recaps: Array<{ id: string; recap: string; recapAt?: string }>; sessionLimits: never[] } = { agents: [], recaps: [], sessionLimits: [] };
    const { calls } = home(emptyState({ agents: [agent({ id: 'a', name: 'Ada', recap: 'Old words.' })] }), { 'GET api/agents/live': () => live });
    await findHome();
    live = { agents: [], recaps: [{ id: 'a', recap: 'New words.', recapAt: 'later' }], sessionLimits: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(rowOf('Ada').querySelector('.cabout')!.textContent).toBe('New words.'));
    expect(rowOf('Ada').querySelector('.cabout.arrived')).toBeTruthy();
    expect(calls.filter((call) => call.path === 'api/state')).toHaveLength(1);
  });

  it('re-reads the state every few seconds only while something is mid-transition', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status: 'setting-up' | 'ready' = 'setting-up';
    const { calls } = home(emptyState(), { 'GET api/state': () => emptyState({ agents: [agent({ id: 'a', name: 'Ada', status })] }) });
    await findHome();
    const stateReads = () => calls.filter((call) => call.path === 'api/state').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    await waitFor(() => expect(stateReads()).toBe(2));
    status = 'ready';
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    await waitFor(() => expect(stateReads()).toBe(3));
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(stateReads()).toBe(3);
  });

  it('pauses the tick while the page is hidden and catches up when it is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = home(emptyState({ agents: [agent({ id: 'a', name: 'Ada' })] }));
    await findHome();
    const ticks = () => calls.filter((call) => call.path === 'api/agents/live').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10); });
    await waitFor(() => expect(ticks()).toBe(1));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3); });
    expect(ticks()).toBe(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(ticks()).toBe(2));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('says when the Workspace could not be read, and tries again on request', async () => {
    let fail = true;
    home(emptyState(), {
      'GET api/state': () => {
        if (fail) throw new WorkspaceApiError('The backend is away.', 502, {});
        return emptyState();
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('The backend is away.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await findHome();
  });
});

describe('the persistent header', () => {
  it('Back on a pasted address, with nothing of ours beneath it, replaces it with Home', async () => {
    const { api } = scriptedApi(workspaceScript(() => emptyState()));
    renderAt('/repositories/infinite-agents?org=o1&room=r1', api);
    await screen.findByRole('heading', { name: 'infinite-agents' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await findHome();
    expect(document.getElementById('pageHead')).toBeNull();
  });
});
