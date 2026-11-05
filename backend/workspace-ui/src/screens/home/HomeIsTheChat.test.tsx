import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * 2026-10-10, the owner: "let's create a special chat screen for workspace
 * agent. Let this screen be the home." Then note #715, the same day: Home
 * becomes "Chief of Staff", with Workplace and Rooms in a picker.
 *
 * Home (`/`) is the Chief of Staff's conversation, with its face and its
 * name; both open the Workplace window over it, in the agents picker's
 * shell, as one history entry of Home's address (`home-sheet.ts`). The
 * agents picker by the message box (the owner's follow-up, 2026-10-11) had
 * a tab for every room, each the room's whole view, until rooms left the
 * product (note #843): it is one list of every agent now. These hold the
 * front door, the window's way in and out, and the picker's way in and out
 * and its pages. The conversation's own behaviour is
 * `RecapChatScreen.test.tsx`, what the window and the picker HOLD is
 * `Home.test.tsx`, and the agent's cards `RecapAgent.test.tsx`.
 *
 * The Back tests mount on `BrowserRouter`: the window lives in the browser's
 * history, so only the browser's own `history.back()` — which jsdom answers
 * with a `popstate` — proves them. A memory router's Back would walk a
 * history the window is not in.
 */

function Address() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}
const at = () => screen.getByTestId('address').textContent;
const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const workplace = () => emptyState({
  org, driveAvailable: true,
  agents: [agent({ id: 'felix', name: 'Felix' }), agent({ id: 'bo', name: 'Bo' })],
});

function open(path: string, state = workplace(), extra: Record<string, Answer> = {}) {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  render(<MemoryRouter initialEntries={[path]}><Address /><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
/** The same, on the browser's own history: `path` becomes the document's address. */
function openInBrowser(path: string | null, state = workplace(), extra: Record<string, Answer> = {}) {
  // `null`: the document's own address and entry, as a reload keeps them.
  if (path !== null) window.history.replaceState(null, '', path);
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  const view = render(<BrowserRouter><Address /><App api={scripted.api} /></BrowserRouter>);
  return { ...scripted, unmount: view.unmount };
}
const sheet = () => document.getElementById('homeSheet');
const title = () => document.getElementById('homeSheetTitle')?.textContent;
const levels = () => ((window.history.state as { usr?: { homeSheet?: unknown[] } } | null)?.usr?.homeSheet ?? []).length;
/** The browser's Back, and the `popstate` jsdom queues for it. */
const back = async () => { await act(async () => { window.history.back(); await new Promise((done) => setTimeout(done, 0)); }); };
const home = async () => { await waitFor(() => expect(document.getElementById('homeWorkplaceDoor')).toBeTruthy()); };
const picker = () => document.getElementById('agentSwitchSheet');
/** The agents picker, from the stack by the message box. (Its rooms were
 *  entered from a tab each until rooms left the product — note #843.) */
const openPicker = async () => {
  await waitFor(() => expect(document.getElementById('agentChatSwitch')).toBeTruthy());
  fireEvent.click(document.getElementById('agentChatSwitch')!);
  await waitFor(() => expect(picker()).toBeTruthy());
  return picker()!;
};
/** The agents the picker's one list shows, in its order. */
const cards = () => [...document.querySelectorAll<HTMLElement>('#agentSwitchGrid .crow[data-agent]')].map((card) => card.dataset.agent);

afterEach(() => {
  document.body.classList.remove('agent-chat-open');
  window.history.replaceState(null, '', '/');
});

describe('Home is the Chief of Staff\'s conversation', () => {
  it('opens the chat at the front door: its face and its name as the door to the Workplace, the workplace switch and the reader\'s picture', async () => {
    const { calls } = open('/');
    await home();
    const heading = screen.getByRole('heading', { name: 'Chief of Staff' });
    expect(heading.id).toBe('recapChatTitle');
    expect(heading.closest('a')).toBeNull();
    const head = document.querySelector('#screenHome .chathead')!;
    // The face is back (the owner, 2026-10-11), in its context ring, as a
    // door; out of the reading order, because the name says the same.
    const face = head.querySelector('#recapChatFace')!;
    expect(face.tagName).toBe('BUTTON');
    expect(face.getAttribute('aria-hidden')).toBe('true');
    expect(face.querySelector('.ctxring .avatar, .ctxring .icon')).toBeTruthy();
    const door = document.getElementById('homeWorkplaceDoor')!;
    expect(door.closest('h1')).toBe(heading);
    expect(door.textContent).toBe('Chief of Staff');
    expect(door.getAttribute('aria-expanded')).toBe('false');
    // No doors beside the name any more.
    expect(document.getElementById('homeDoors')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rooms' })).toBeNull();
    // The front door has nothing beneath it, so nothing to go back to — and
    // no persistent header standing over the chat's own.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(document.getElementById('pageHead')).toBeNull();
    expect(head.querySelector('#homeOrganizations')!.textContent).toContain('Nomad Trading');
    expect(head.querySelector('#homeAccount')).toBeTruthy();
    // It says what it is for before anything has been said to it.
    expect((await screen.findByText(/^I run your agents\./)).closest('#chiefOfStaffEmpty')?.className).toBe('chatempty cosempty');
    // Nothing of the window or the picker until opened: no fleet, no tabs.
    expect(sheet()).toBeNull();
    expect(picker()).toBeNull();
    expect(document.getElementById('agentsSection')).toBeNull();
    expect(calls.find((call) => call.path === 'api/recap/chat')?.scope).toMatchObject({ org: 'o1' });
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false);
    expect(at()).toBe('/');
  });

  // It wore the mark for any ROOM with something waiting until rooms left
  // the product (note #843); it is one question about the reader now.
  it('the agents stack wears the mark while a decision waits on the reader, and drops it once the picker is open', async () => {
    open('/', emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix' })],
      prs: [{
        id: 'pr-1', number: 4, repoName: 'shop', title: 'Add checkout', body: null, from: 'checkout', to: 'main',
        status: 'open', createdAt: 't', decidedAt: null, agentName: 'Felix', agentId: 'felix', canDecide: true,
      }],
    }));
    await home();
    const stack = await waitFor(() => screen.getByRole('button', { name: 'Your agents, something is waiting for you' }));
    expect(stack.classList.contains('attention')).toBe(true);
    expect(document.getElementById('homeWorkplaceDoor')!.classList.contains('attention')).toBe(false);
    fireEvent.click(stack);
    await waitFor(() => expect(picker()).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Your agents' }).classList.contains('attention')).toBe(false);
  });

  it('wears no mark for a decision the reader is not the one to take', async () => {
    open('/', emptyState({
      org,
      agents: [agent({ id: 'felix', name: 'Felix' })],
      prs: [{
        id: 'pr-1', number: 4, repoName: 'shop', title: 'Add checkout', body: null, from: 'checkout', to: 'main',
        status: 'open', createdAt: 't', decidedAt: null, agentName: 'Felix', agentId: 'felix', canDecide: false,
      }],
    }));
    await home();
    const stack = await waitFor(() => screen.getByRole('button', { name: 'Your agents' }));
    expect(stack.classList.contains('attention')).toBe(false);
  });

  it('opens the chat for a tab still standing on the old Home\'s address, and drops the half, room and shelf from it', async () => {
    open('/?half=rooms&room=r2&content=notes');
    await home();
    await waitFor(() => expect(at()).toBe('/'));
    expect(document.getElementById('screenOverview')).toBeNull();
    expect(sheet()).toBeNull();
    expect(picker()).toBeNull();
  });

  it('keeps every other word of that address, the workplace among them', async () => {
    open('/?org=o1&half=workplace&content=secrets');
    await home();
    await waitFor(() => expect(at()).toBe('/?org=o1'));
  });

  it('sends the conversation\'s old address to Home', async () => {
    open('/recap?org=o1');
    await home();
    expect(at()).toBe('/');
  });

  it('keeps a personal account, which has no Chief of Staff, on the one-column overview', async () => {
    open('/', emptyState({ agents: [agent({ id: 'felix', name: 'Felix' })] }));
    await waitFor(() => expect(document.getElementById('agentsSection')).toBeTruthy());
    expect(document.getElementById('screenOverview')).toBeTruthy();
    expect(document.getElementById('recapChatTitle')).toBeNull();
    expect(document.getElementById('homeWorkplaceDoor')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Workplace' })).toBeNull();
    // Every shelf in the one column, the workplace's among them.
    expect(document.getElementById('roomContentPanel-knowledge')).toBeTruthy();
  });
});

describe('the Workplace window (note #715)', () => {
  it('opens over the conversation from the name, in the picker\'s shell, holding the workplace\'s shelves and the agent\'s own cards', async () => {
    openInBrowser('/');
    await home();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    // Named for the workplace and its head count (note #960).
    const dialog = await screen.findByRole('dialog', { name: /^Nomad Trading/ });
    expect(dialog.id).toBe('homeSheet');
    expect(dialog.classList.contains('agentsheet')).toBe(true);
    expect(document.getElementById('homeWorkplaceDoor')!.getAttribute('aria-expanded')).toBe('true');
    // The conversation is still there under it, at Home's address.
    expect(document.getElementById('screenHome')).toBeTruthy();
    expect(at()).toBe('/');
    // The people lead where there is a team; the agent counts stand only
    // where there is none (note #1009).
    expect(dialog.querySelector('#homeWorkplace #peopleSection')).toBeTruthy();
    expect(dialog.querySelector('#homeWorkplace #agentActivity')).toBeNull();
    expect(dialog.querySelector('#homeWorkplace #seatsHomeSection')).toBeTruthy();
    // An index since note #960: a row per shelf, the agent's own cards one
    // of them, on a screen of their own.
    expect(dialog.querySelector('#homeWorkplace #indexRepositories')).toBeTruthy();
    expect(dialog.querySelector('#homeWorkplace #indexChiefOfStaff')).toBeTruthy();
    expect(dialog.querySelector('#homeWorkplace #recapAgentFacts')).toBeNull();
    // No agents in it: they are the picker's (and so were the rooms, while
    // there were rooms — note #843).
    expect(dialog.querySelector('.crow[data-agent]')).toBeNull();
    expect(dialog.querySelector('#homeRoom')).toBeNull();
    expect(document.getElementById('homeSheetBack')).toBeNull();
    expect(levels()).toBe(1);
  });

  it('…and from the face', async () => {
    openInBrowser('/');
    await home();
    fireEvent.click(document.getElementById('recapChatFace')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    expect(levels()).toBe(1);
  });

  it('the browser\'s Back closes the window — never leaving Home', async () => {
    openInBrowser('/');
    await home();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    expect(levels()).toBe(1);
    await back();
    await waitFor(() => expect(sheet()).toBeNull());
    expect(levels()).toBe(0);
    expect(document.getElementById('screenHome')).toBeTruthy();
    expect(at()).toBe('/');
  });

  it('Escape does the same', async () => {
    openInBrowser('/');
    await home();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(sheet()).toBeNull());
    expect(levels()).toBe(0);
    expect(document.getElementById('screenHome')).toBeTruthy();
  });

  it('Close spends the entry, so the next Back leaves no dead entry behind', async () => {
    openInBrowser('/');
    await home();
    const entry = (window.history.state as { key?: string } | null)?.key;
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    fireEvent.click(document.getElementById('homeSheetClose')!);
    await waitFor(() => expect(sheet()).toBeNull());
    expect(levels()).toBe(0);
    // Back on Home's own entry, the one the window was opened from.
    expect((window.history.state as { key?: string } | null)?.key).toBe(entry);
  });

  it('a reload stands the window up again', async () => {
    const { unmount } = openInBrowser('/');
    await home();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    // A reload: the same document address with the same entry state.
    unmount();
    openInBrowser(null);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    expect(levels()).toBe(1);
  });

  it('the overview\'s old workplace address opens Home with the window, and its Back closes the window rather than leaving; a bare /overview too', async () => {
    const { unmount } = openInBrowser('/overview?org=o1&half=workplace');
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    expect(at()).toBe('/');
    expect(document.getElementById('screenOverview')).toBeNull();
    expect(levels()).toBe(1);
    await back();
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.getElementById('screenHome')).toBeTruthy();
    expect(at()).toBe('/');
    unmount();
    openInBrowser('/overview?org=o1');
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
  });

  // Note #717: the window is an entry of Home's own address, so the router
  // sees no arrival, and the copy Home last read can be minutes old on a
  // quiet fleet — the live tick buys a full read only when a turn starts or
  // ends. Opening the window is what asks again.
  const usage = (percent: number) => {
    const state = workplace();
    return {
      ...state,
      org: { ...state.org!, seatUsage: [{ seatId: 's1', provider: 'claude' as const, label: 'Claude · 1 Oct', planText: 'Max 20x', selected: true, windows: [{ usedPercent: percent, percentText: String(percent), trackText: '5 hours' }] }] },
    };
  };
  const shownUsage = () => document.querySelector('#homeSheet #seatsHome .pct')?.textContent;
  const shownBy = (state: ReturnType<typeof usage>) => state.org.seatUsage[0]!.windows[0]!.usedPercent;

  it('re-reads the workplace each time it opens, standing on the copy in hand until the answer lands', async () => {
    let current = usage(12);
    const { calls } = openInBrowser('/', current, { 'GET api/state': () => current });
    const reads = () => calls.filter((call) => call.path === 'api/state').length;
    await home();
    // Spent while the reader sat in the conversation.
    current = usage(32);
    const before = reads();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    await waitFor(() => expect(shownUsage()).toBe('32%'));
    expect(reads()).toBe(before + 1);
    // Closed and opened again: asked again.
    current = usage(47);
    fireEvent.click(document.getElementById('homeSheetClose')!);
    await waitFor(() => expect(sheet()).toBeNull());
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(shownUsage()).toBe('47%'));
    expect(reads()).toBe(before + 2);
  });

  it('an open while that read is still out shares it rather than asking twice', async () => {
    let current = usage(12);
    // The first read that would carry the new reading is held at the door.
    const gate: { release?: () => void } = {};
    const { calls } = openInBrowser('/', current, {
      'GET api/state': () => (!gate.release && shownBy(current) === 32
        ? new Promise((resolve) => { gate.release = () => resolve(current); })
        : current),
    });
    const reads = () => calls.filter((call) => call.path === 'api/state').length;
    await home();
    current = usage(32);
    const before = reads();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    // The copy in hand stands while the read is out.
    expect(shownUsage()).toBe('12%');
    await back();
    await waitFor(() => expect(sheet()).toBeNull());
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    expect(reads()).toBe(before + 1);
    await act(async () => { gate.release!(); });
    await waitFor(() => expect(shownUsage()).toBe('32%'));
    expect(reads()).toBe(before + 1);
  });

  it('a tap on the dim closes the window', async () => {
    openInBrowser('/');
    await home();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(title()).toBe('Nomad Trading · 3 people'));
    fireEvent.click(sheet()!.parentElement!);
    await waitFor(() => expect(sheet()).toBeNull());
    expect(levels()).toBe(0);
  });
});

/**
 * The agents picker (the owner, 2026-10-11). It had a tab for every room —
 * All first, then each room, whose tab was the room's whole view, read in
 * that room — until rooms left the product (note #843). What stayed is All:
 * one list of every agent in the workplace, its search over it.
 */
describe('the agents picker (the owner, 2026-10-11)', () => {
  it('opens on one list of every agent, with no tabs and no room view, and nothing in the address or the history', async () => {
    const { calls } = open('/');
    await home();
    const reads = calls.filter((call) => call.path === 'api/state').length;
    const dialog = await openPicker();
    expect(dialog.querySelector('#agentSwitchTabs')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(dialog.querySelector('#agentSwitchSearch')).toBeTruthy();
    expect(document.getElementById('agentSwitchTitle')!.textContent).toBe('Your agents');
    await waitFor(() => expect(cards()).toEqual(['felix', 'bo']));
    expect(dialog.querySelector('#homeRoom')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Manage rooms' })).toBeNull();
    // Opening it reads nothing of the state: there is no room to stand in.
    expect(calls.filter((call) => call.path === 'api/state')).toHaveLength(reads);
    expect(at()).toBe('/');
    expect(levels()).toBe(0);
  });

  it('the overview\'s old rooms address opens Home with the whole picker, whatever room it names', async () => {
    openInBrowser('/overview?org=o1&half=rooms&room=r2');
    await waitFor(() => expect(picker()).toBeTruthy());
    await waitFor(() => expect(cards()).toEqual(['felix', 'bo']));
    expect(at()).toBe('/');
    expect(document.getElementById('screenOverview')).toBeNull();
    expect(sheet()).toBeNull();
    expect(levels()).toBe(0);
    fireEvent.click(document.getElementById('agentSwitchClose')!);
    await waitFor(() => expect(picker()).toBeNull());
    expect(document.getElementById('screenHome')).toBeTruthy();
    // Put away, it is off the entry too: a reload does not stand it again.
    expect((window.history.state as { usr?: { agentSwitch?: unknown } } | null)?.usr?.agentSwitch).toBeUndefined();
  });

  it('the overview\'s agents address does the same', async () => {
    openInBrowser('/overview?org=o1&half=agents');
    await waitFor(() => expect(picker()).toBeTruthy());
    expect(at()).toBe('/');
    expect(sheet()).toBeNull();
  });

  it('an old link to a room\'s notes shelf opens the workplace\'s notes (note #843)', async () => {
    openInBrowser('/overview?org=o1&half=rooms&room=r2&content=notes');
    await waitFor(() => expect(document.getElementById('screenNotes')).toBeTruthy());
    expect(at()).toBe('/notes?org=o1');
    expect(picker()).toBeNull();
    expect(sheet()).toBeNull();
  });

  // Note #722, the owner: "rooms window has its own internal navigation
  // stack. If user traverse the content, it should be rendered inside of the
  // window." What a row opens is a page inside the picker, over its list;
  // Back — the page's, the browser's, Escape — closes the page on top.
  const proposalRow = {
    id: 'pr-1', number: 4, repoName: 'shop', title: 'Add checkout', body: null, from: 'checkout', to: 'main',
    status: 'open', createdAt: 't', decidedAt: null, agentName: 'Felix', agentId: 'felix', canDecide: true,
  } as const;
  // The row is the picker's decision queue's, which it reads for itself.
  const proposalScript = {
    'GET api/decisions': () => ({ prs: [{ ...proposalRow }], knowledgeProposals: [] }),
    'GET api/prs/pr-1': () => ({
      pr: proposalRow, checks: [], patch: null, patchTruncated: false, commits: [], headSha: 'sha', requireChecks: false,
    }),
  };
  const pickerEntry = () => (window.history.state as { usr?: { agentSwitch?: { pages?: unknown[] } } } | null)?.usr?.agentSwitch;
  /** The page standing on top of the picker, if one does. */
  const page = () => [...document.querySelectorAll<HTMLElement>('#agentSwitchSheet .windowpage:not([hidden])')].at(-1) ?? null;
  const openProposal = async () => {
    if (!picker()) await openPicker();
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('#agentSwitchDecisions .crow');
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(row);
    await waitFor(() => expect(page()?.dataset.address).toBe('/decisions/pr/pr-1'));
  };

  it('a proposal opened from the picker opens inside it, over its list, and its Back comes back to the list', async () => {
    openInBrowser('/', emptyState({ ...workplace(), prs: [{ ...proposalRow }] }), proposalScript);
    await home();
    await openProposal();
    // The proposal's own screen, its name in the page's head; the list is
    // under it, hidden; the address and the conversation are Home's.
    expect(page()!.querySelector('#screenPr')).toBeTruthy();
    await waitFor(() => expect(page()!.querySelector('.windowhead h1')?.textContent).toBe('Add checkout'));
    expect(document.getElementById('agentSwitchGrid')!.closest('.sheetlevel')!.hasAttribute('hidden')).toBe(true);
    expect(picker()!.classList.contains('paged')).toBe(true);
    expect(at()).toBe('/');
    expect(document.getElementById('screenHome')!.hidden).toBe(false);
    // One browser entry of Home's address, carrying the page.
    expect(pickerEntry()?.pages).toHaveLength(1);
    // The page's Back: the list again, as it was.
    fireEvent.click(document.getElementById('windowBack')!);
    await waitFor(() => expect(page()).toBeNull());
    expect(document.getElementById('agentSwitchGrid')!.closest('.sheetlevel')!.hasAttribute('hidden')).toBe(false);
    expect(picker()!.classList.contains('paged')).toBe(false);
    // The browser's Back does the same, and never leaves Home.
    await openProposal();
    await back();
    await waitFor(() => expect(page()).toBeNull());
    expect(cards()).toEqual(['felix', 'bo']);
    expect(at()).toBe('/');
    // And Escape, at a desk.
    await openProposal();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(page()).toBeNull());
    expect(picker()).toBeTruthy();
  });

  it('a proposal decided inside the picker leaves its waiting list the moment it lands, though others still wait (note #743)', async () => {
    // The owner's trip: Home, the picker, the proposal at the top of its
    // queue, Approve inside the picker, the page's Back. Nothing the state
    // read says about the queue moves (it lists neither proposal — they
    // waited in another room when this was found, before note #843), and
    // the list in hand was read before the decision.
    let merged = false;
    const knowledgeRow = {
      id: 'kp-3', number: 3, title: 'Fractions handbook', status: 'open', pages: ['fractions'],
      createdAt: 't', agentName: 'Bo', agentId: 'bo', canDecide: true,
    };
    const world = workplace();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    openInBrowser('/', world, {
      'GET api/decisions': () => ({ prs: merged ? [] : [{ ...proposalRow }], knowledgeProposals: [knowledgeRow] }),
      'GET api/prs/pr-1': () => ({
        pr: { ...proposalRow, status: merged ? 'merged' : 'open' },
        checks: [], patch: null, patchTruncated: false, commits: [], headSha: 'sha', requireChecks: false,
      }),
      'POST api/prs/pr-1/decision': () => { merged = true; return { ok: true, status: 'merged' }; },
      'GET api/prs/pr-1/delivery': () => ({
        status: 'merged', decidedAt: 't', delivery: { sha: 'ffff111', branch: 'main', mergedAt: 't', live: false, checks: [] },
      }),
    });
    await home();
    const shelf = await openPicker();
    const listed = () => [...shelf.querySelectorAll('#agentSwitchDecisions .crow .name')].map((row) => row.textContent);
    await waitFor(() => expect(listed()).toEqual(['Add checkout', 'Fractions handbook']));
    fireEvent.click(shelf.querySelector<HTMLElement>('#agentSwitchDecisions .crow')!);
    await waitFor(() => expect(page()?.dataset.address).toBe('/decisions/pr/pr-1'));
    fireEvent.click(await within(page()!).findByRole('button', { name: 'Approve & merge' }));
    await waitFor(() => expect(page()!.querySelector('#prPills .pill')?.textContent).toMatch(/^Merged/));
    fireEvent.click(document.getElementById('windowBack')!);
    await waitFor(() => expect(page()).toBeNull());
    await waitFor(() => expect(listed()).toEqual(['Fractions handbook']));
  });

  describe('the picker\'s waiting list, remembered (note #745)', () => {
    const knowledgeRow = {
      id: 'kp-3', number: 3, title: 'Fractions handbook', status: 'open', pages: ['fractions'],
      createdAt: 't', agentName: 'Bo', agentId: 'bo', canDecide: true,
    };
    /** A server whose queue read can be held open, as a slow phone network
     *  holds it: `hold()` and every read after it waits until `answer()`. */
    function queue(first: () => unknown) {
      let held: Array<(value: unknown) => void> = [];
      let holding = false;
      return {
        read: () => (holding ? new Promise((resolve) => { held.push(resolve); }) : first()),
        hold: () => { holding = true; },
        answer: (value: unknown) => { holding = false; const waiting = held; held = []; for (const resolve of waiting) resolve(value); },
      };
    }
    const listedIn = (shelf: HTMLElement) => [...shelf.querySelectorAll('#agentSwitchDecisions .crow .name')].map((row) => row.textContent);
    const closePicker = async () => {
      fireEvent.click(document.getElementById('agentSwitchClose')!);
      await waitFor(() => expect(picker()).toBeNull());
    };

    it('opens again on the list it last read, at once, and the read replaces it in place', async () => {
      const server = queue(() => ({ prs: [{ ...proposalRow }], knowledgeProposals: [knowledgeRow] }));
      openInBrowser('/', workplace(), { 'GET api/decisions': () => server.read() });
      await home();
      let shelf = await openPicker();
      await waitFor(() => expect(listedIn(shelf)).toEqual(['Add checkout', 'Fractions handbook']));
      await closePicker();
      // The network is slow now: the reopened sheet cannot wait for it.
      server.hold();
      shelf = await openPicker();
      expect(listedIn(shelf)).toEqual(['Add checkout', 'Fractions handbook']);
      // The read lands with something new: it is drawn in place.
      await act(async () => { server.answer({ prs: [], knowledgeProposals: [knowledgeRow] }); });
      await waitFor(() => expect(listedIn(shelf)).toEqual(['Fractions handbook']));
    });

    it('never hands back from memory a proposal decided in this tab (note #743)', async () => {
      let merged = false;
      const server = queue(() => ({ prs: merged ? [] : [{ ...proposalRow }], knowledgeProposals: [knowledgeRow] }));
      vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
      openInBrowser('/', workplace(), {
        'GET api/decisions': () => server.read(),
        'GET api/prs/pr-1': () => ({
          pr: { ...proposalRow, status: merged ? 'merged' : 'open' },
          checks: [], patch: null, patchTruncated: false, commits: [], headSha: 'sha', requireChecks: false,
        }),
        'POST api/prs/pr-1/decision': () => { merged = true; return { ok: true, status: 'merged' }; },
        'GET api/prs/pr-1/delivery': () => ({
          status: 'merged', decidedAt: 't', delivery: { sha: 'ffff111', branch: 'main', mergedAt: 't', live: false, checks: [] },
        }),
      });
      await home();
      let shelf = await openPicker();
      await waitFor(() => expect(listedIn(shelf)).toEqual(['Add checkout', 'Fractions handbook']));
      // Remembered while it waited; then decided.
      server.hold();
      fireEvent.click(shelf.querySelector<HTMLElement>('#agentSwitchDecisions .crow')!);
      await waitFor(() => expect(page()?.dataset.address).toBe('/decisions/pr/pr-1'));
      fireEvent.click(await within(page()!).findByRole('button', { name: 'Approve & merge' }));
      await waitFor(() => expect(page()!.querySelector('#prPills .pill')?.textContent).toMatch(/^Merged/));
      fireEvent.click(document.getElementById('windowBack')!);
      await waitFor(() => expect(page()).toBeNull());
      await closePicker();
      // Opened again with the read still out: what was remembered, less what
      // was decided.
      shelf = await openPicker();
      expect(listedIn(shelf)).toEqual(['Fractions handbook']);
      await act(async () => { server.answer({ prs: [], knowledgeProposals: [knowledgeRow] }); });
      expect(listedIn(shelf)).toEqual(['Fractions handbook']);
    });
  });

  it('a conversation opened from a page leaves the picker, and Back from it finds the picker standing on that page', async () => {
    openInBrowser('/', emptyState({ ...workplace(), prs: [{ ...proposalRow }] }), proposalScript);
    await home();
    await openProposal();
    fireEvent.click(await waitFor(() => {
      const door = page()!.querySelector<HTMLElement>('#prChat');
      expect(door).toBeTruthy();
      return door!;
    }));
    await waitFor(() => expect(at()).toBe('/chat/felix'));
    expect(picker()).toBeNull();
    await back();
    await waitFor(() => expect(page()?.dataset.address).toBe('/decisions/pr/pr-1'));
    expect(at()).toBe('/');
    expect(picker()!.parentElement!.classList.contains('still')).toBe(true);
    // The list is under the page, as it was left.
    expect(document.getElementById('agentSwitchGrid')!.closest('.sheetlevel')!.hasAttribute('hidden')).toBe(true);
    fireEvent.click(document.getElementById('windowBack')!);
    await waitFor(() => expect(page()).toBeNull());
    expect(cards()).toEqual(['felix', 'bo']);
  });

  it('Close puts the whole picker away from a page, spending its entries', async () => {
    openInBrowser('/', emptyState({ ...workplace(), prs: [{ ...proposalRow }] }), proposalScript);
    await home();
    await openProposal();
    fireEvent.click(document.getElementById('windowClose')!);
    await waitFor(() => expect(picker()).toBeNull());
    await waitFor(() => expect(pickerEntry()).toBeUndefined());
    expect(at()).toBe('/');
  });

  // A note opened, or written, from a room's Notes shelf was a page of the
  // picker too, until rooms left the product (note #843): the notes are the
  // Workplace window's now, whose doors go to the notes screens
  // (`Home.test.tsx`).

  it('a picker put away is off the entry: a reload, or a Back to it, opens the conversation alone', async () => {
    const { unmount } = openInBrowser('/');
    await home();
    await openPicker();
    expect(pickerEntry()).toEqual({ standing: true });
    fireEvent.click(document.getElementById('agentSwitchClose')!);
    await waitFor(() => expect(picker()).toBeNull());
    expect(pickerEntry()).toBeUndefined();
    unmount();
    openInBrowser(null);
    await home();
    expect(picker()).toBeNull();
  });

  it('the picker\'s Close, the dim and Escape each put it away', async () => {
    open('/');
    await home();
    await openPicker();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(picker()).toBeNull());
    await openPicker();
    fireEvent.click(document.getElementById('agentSwitchClose')!);
    await waitFor(() => expect(picker()).toBeNull());
    await openPicker();
    fireEvent.click(picker()!.parentElement!);
    await waitFor(() => expect(picker()).toBeNull());
    expect(document.getElementById('screenHome')).toBeTruthy();
    expect(at()).toBe('/');
  });
});
