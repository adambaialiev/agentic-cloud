import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCopyHealth, WorkspaceCopyReleases, WorkspaceOrgDetail } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { notesBody, releaseDay } from './CopyReleasesScreen.js';

/**
 * What's new in a company's own Agentic Cloud (note #1006): linked from the
 * health page's Workspace line, every release newer than the running one
 * with its notes, newest first, then what the running one brought. Admins.
 */
vi.mock('../../../../src/shared/private-copy.js', () => ({ PRIVATE_COPY: true, SIGNUP_CLOSED: false, FIRST_ACCOUNT_FRAGMENT: 'first-account' }));

const UPGRADE = 'To upgrade, whoever installed this Agentic Cloud runs node install.mjs upgrade in the folder they installed it from.';
const notes = (title: string, item: string) => `# ${title}\n\n## What's new\n\n- ${item}\n\n## Fixed\n\n- Nothing.\n\n## Needs you\n\n- Nothing.\n`;
const behind = {
  state: 'behind', running: '2026.11.01.1', latest: '2026.11.16.0', reachedAt: '2026-11-05T14:00:00.000Z',
  triedAt: '2026-11-05T14:00:00.000Z', lastError: null, howToUpgrade: UPGRADE,
} as const;
const releases: WorkspaceCopyReleases = {
  updates: behind,
  releases: [
    { version: '2026.11.16.0', date: '2026-11-16', summary: 'Upgrades from the Workspace', notes: null, running: false },
    { version: '2026.11.09.0', date: '2026-11-09', summary: 'Release notes on every upgrade', notes: notes('Release notes on every upgrade', 'A What\'s new screen for admins.'), running: false },
    { version: '2026.11.01.1', date: '2026-11-01', summary: 'Email set up from the Workspace', notes: notes('Email set up from the Workspace', 'Email is set up after the install.'), running: true },
  ],
};
const health = (updates: WorkspaceCopyHealth['updates']): WorkspaceCopyHealth => ({
  release: '2026.11.01.1', commit: null, running: '2026.11.01.1', latest: updates.latest, updates, checkedAt: new Date().toISOString(),
  parts: [{ key: 'workspace', name: 'Workspace', ok: true, line: `Up 2 days · release 2026.11.01.1 · latest ${updates.latest}` }],
});

const detail = (role: 'admin' | 'member'): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Theirco', role, invites: [], joinRequests: [],
  fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Ada', you: true, role, joinedAt: '2026-10-27T00:00:00Z', agents: 0, workedMs: 0 }],
});

async function open(path: string, role: 'admin' | 'member', copyHealth = health(behind)) {
  vi.useFakeTimers();
  const org = { orgId: 'o1', name: 'Theirco', role, members: 2, seats: 0, seatProviders: [] };
  const state = () => emptyState({
    org, canCreateOrg: true,
    organizations: [{ orgId: 'o1', name: 'Theirco', role, active: true, members: 2, agents: 0 }],
  });
  const script: Record<string, Answer> = {
    ...workspaceScript(state),
    'GET api/org': () => ({ org: detail(role) }),
    'GET api/copy/health': () => copyHealth,
    'GET api/copy/releases': () => releases,
  };
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  return scripted;
}

afterEach(() => { vi.useRealTimers(); });

describe('What\'s new, in a company\'s own Agentic Cloud (note #1006)', () => {
  it('opens from the health page\'s Workspace line when a newer release is out', async () => {
    await open('/workplace?org=o1', 'admin');
    const link = document.getElementById('orgCopyWhatsNew')!;
    expect(link.textContent).toBe('What\'s new');
    await act(async () => {
      fireEvent.click(link);
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(document.getElementById('screenCopyReleases')).toBeTruthy();
  });

  it('says "What this release brought" on the line when the copy is up to date', async () => {
    await open('/workplace?org=o1', 'admin', health({ ...behind, state: 'current', latest: '2026.11.01.1', howToUpgrade: null }));
    expect(document.getElementById('orgCopyWhatsNew')!.textContent).toBe('What this release brought');
  });

  it('has no link when update checks are off', async () => {
    await open('/workplace?org=o1', 'admin', health({ ...behind, state: 'off', latest: null, howToUpgrade: null }));
    expect(document.getElementById('orgCopyWhatsNew')).toBeNull();
  });

  it('lists the newer releases newest first, each with its notes, then what the running one brought', async () => {
    await open('/workplace/whats-new?org=o1', 'admin');
    const cards = [...document.querySelectorAll('.copyrelease')];
    expect(cards.map((card) => card.getAttribute('data-version'))).toEqual(['2026.11.16.0', '2026.11.09.0', '2026.11.01.1']);
    expect(cards[0]!.querySelector('h2')!.textContent).toBe('2026.11.16.0 · 16 November 2026');
    expect(cards[0]!.textContent).toContain('Upgrades from the Workspace');
    expect(cards[0]!.textContent).toContain('could not be read');
    expect(cards[1]!.textContent).toContain('A What\'s new screen for admins.');
    expect([...cards[1]!.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['What\'s new', 'Fixed', 'Needs you']);
    expect(cards[2]!.querySelector('h2')!.textContent).toBe('What this release brought · 2026.11.01.1 · 1 November 2026');
    expect(cards[2]!.textContent).toContain('Email is set up after the install.');
    expect(screen.getByText('2 releases are newer than the one you run, newest first.')).toBeTruthy();
    expect(document.getElementById('orgCopyUpgradeHint')!.querySelector('code')!.textContent).toBe('node install.mjs upgrade');
  });

  it('tells a member it is for admins, and asks nothing', async () => {
    const scripted = await open('/workplace/whats-new?org=o1', 'member');
    expect(screen.getByText('Only an admin of this workplace sees what each release brings.')).toBeTruthy();
    expect(scripted.calls.some((call) => call.path === 'api/copy/releases')).toBe(false);
  });

  it('reads a notes file into a title and its sections, and a date into words', () => {
    expect(notesBody(notes('T', 'x'))).toEqual({ title: 'T', body: '### What\'s new\n\n- x\n\n### Fixed\n\n- Nothing.\n\n### Needs you\n\n- Nothing.' });
    expect(releaseDay('2026-11-03')).toBe('3 November 2026');
    expect(releaseDay(null)).toBeNull();
  });
});
