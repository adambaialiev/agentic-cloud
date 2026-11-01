import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceKnowledgeProposalDetailAnswer,
  WorkspaceProposalDetailAnswer,
} from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { BACK_LANDING_MS } from '../../chrome/history.js';
import { agent, emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';

/**
 * Note #742: Back on a proposal page did nothing on the owner's iPhone, and
 * Safari's own back arrow was grey — the tab had nothing under the page.
 *
 * These run under the BROWSER's router and jsdom's real session history, not
 * a MemoryRouter, because that is where the fault lives: the router keeps its
 * own count of the entries under a page (`history.state.idx`), Back trusted
 * it, and `navigate(-1)` with nothing under the page is a step the browser
 * silently refuses. jsdom has no Navigation API, so these are the browsers
 * that cannot say what is under a page — the ones only the landing check
 * saves.
 *
 * jsdom's history lives as long as this file. Every test but the last stands
 * on the FIRST entry of the tab (a replacement never adds one); the last one
 * pushes, and so stays last.
 */

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };

function proposal(): WorkspaceProposalDetailAnswer {
  return {
    pr: {
      id: 'p1', number: 1361, repoName: 'infinite-agents', title: 'Front-page film',
      body: 'The new cut.', from: 'note-207-film', to: 'main', diffStat: { insertions: 8, deletions: 5 },
      status: 'open', createdAt: new Date(Date.now() - 29 * 60_000).toISOString(), decidedAt: null,
      agentName: 'Clara', agentAvatarUrl: '/faces/clara.png', agentId: 'clara', userName: 'Adam',
      agentRuntime: { cli: 'claude', model: 'Opus', effort: 'xhigh' }, canDecide: true, comments: [],
    },
    checks: [],
    patch: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b',
    patchTruncated: false,
    commits: [{ sha: 'abc1234def', subject: 'Film', at: new Date().toISOString() }],
    diffStat: { files: 3, insertions: 8, deletions: 5 },
    headSha: 'abc1234def',
    requireChecks: false,
  } as WorkspaceProposalDetailAnswer;
}

function knowledge(): WorkspaceKnowledgeProposalDetailAnswer {
  return {
    proposal: {
      id: 'k1', number: 4, title: 'How a change reaches production', status: 'open',
      pages: ['how-a-change-reaches-production'], createdAt: new Date().toISOString(),
      agentName: 'Clara', agentAvatarUrl: '/faces/clara.png', agentId: 'clara', userName: 'Adam',
      agentRuntime: { cli: 'claude', model: 'Opus' }, canDecide: true, note: 'The deploy lane moved.',
      comments: [],
    },
    changes: [{
      page: 'how-a-change-reaches-production', action: 'edit', title: 'How a change reaches production',
      html: '<h1>How a change reaches production</h1>\n<p>one</p>', currentHtml: '<h1>How a change reaches production</h1>\n<p>two</p>',
    }],
  } as WorkspaceKnowledgeProposalDetailAnswer;
}

function openTab() {
  const state = emptyState({ org, agents: [agent({ id: 'clara', name: 'Clara' })] });
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/prs/p1': () => proposal(),
    'POST api/prs/p1/decision': () => ({ ok: true, status: 'merged' }),
    'GET api/prs/p1/delivery': () => ({
      status: 'merged', decidedAt: new Date().toISOString(),
      delivery: { sha: 'ffff111', branch: 'main', mergedAt: new Date().toISOString(), live: false, checks: [] },
    }),
    'GET api/knowledge/proposals/k1': () => knowledge(),
  });
  render(<BrowserRouter><App api={scripted.api} /></BrowserRouter>);
}

/** A tab whose first page is this one, carrying router state that counts
 *  pages under it — the state Back was standing on in the owner's report. */
function firstPageCounting(path: string) {
  window.history.replaceState({ usr: null, key: 'counted', idx: 3 }, '', path);
}

const back = () => fireEvent.click(document.getElementById('pageBack')!);

async function landsHome() {
  await waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: BACK_LANDING_MS * 4 });
}

describe('Back on a proposal page that has nothing under it (note #742)', () => {
  // jsdom draws no page, so it has nothing to scroll.
  beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });

  it('goes Home rather than doing nothing', async () => {
    firstPageCounting('/decisions/pr/p1');
    const before = window.history.length;
    openTab();
    await screen.findByRole('heading', { level: 1, name: 'Front-page film' });
    back();
    await landsHome();
    // Home REPLACES the proposal: not one more page for Back to walk through.
    expect(window.history.length).toBe(before);
  });

  it('goes Home after approving, too', async () => {
    firstPageCounting('/decisions/pr/p1');
    openTab();
    await screen.findByRole('heading', { level: 1, name: 'Front-page film' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve & merge' }));
    await waitFor(() => expect(document.querySelector('#prPills .pill')?.textContent).toMatch(/^Merged/));
    back();
    await landsHome();
  });

  it('goes Home from a knowledge proposal page as well', async () => {
    firstPageCounting('/decisions/knowledge/k1');
    openTab();
    await screen.findByRole('heading', { level: 1, name: 'How a change reaches production' });
    back();
    await landsHome();
  });

  it('goes Home at once where the browser can say the page is the first of the tab', async () => {
    firstPageCounting('/decisions/pr/p1');
    const navigation = { currentEntry: { index: 0 } };
    Object.defineProperty(window, 'navigation', { value: navigation, configurable: true });
    try {
      openTab();
      await screen.findByRole('heading', { level: 1, name: 'Front-page film' });
      back();
      // No landing wait: the browser's word settles it before any step back.
      await waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: BACK_LANDING_MS / 2 });
    } finally {
      Reflect.deleteProperty(window, 'navigation');
    }
  });

  // LAST: it pushes an entry, and the ones above need the first of the tab.
  it('still returns to the page it came from when there is one, and nothing fires after', async () => {
    // Home, then the proposal over it, as a forwarded card's door opens it.
    window.history.replaceState(null, '', '/');
    window.history.pushState({ usr: null, key: 'pr', idx: 1 }, '', '/decisions/pr/p1');
    openTab();
    await screen.findByRole('heading', { level: 1, name: 'Front-page film' });
    const before = window.history.length;
    back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    // It SPENT the entry — the first one of the tab is standing — rather
    // than replacing the proposal with Home.
    expect((window.history.state as { idx?: number } | null)?.idx ?? 0).toBe(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, BACK_LANDING_MS + 200)); });
    expect(window.location.pathname).toBe('/');
    expect(window.history.length).toBe(before);
  });
});
