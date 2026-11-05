import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCopyHealth, WorkspaceCopyUpdates, WorkspaceOrgDetail } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * A private copy's health on its workplace page (note #813): every part in
 * a line, a flag on what needs a look, and the diagnostics file downloaded
 * by the admin — for admins of a copy only.
 */
vi.mock('../../../../src/shared/private-copy.js', () => ({ PRIVATE_COPY: true, SIGNUP_CLOSED: false, FIRST_ACCOUNT_FRAGMENT: 'first-account' }));

const UPGRADE = 'To upgrade, whoever installed this Agentic Cloud runs node install.mjs upgrade in the folder they installed it from.';
const updates = (state: WorkspaceCopyUpdates['state'], latest: string | null): WorkspaceCopyUpdates => ({
  state, running: '2026.10.27.1', latest, reachedAt: state === 'unknown' ? null : '2026-10-27T17:00:00.000Z',
  triedAt: '2026-10-27T17:00:00.000Z', lastError: state === 'unknown' ? 'not reachable' : null,
  howToUpgrade: state === 'behind' ? UPGRADE : null,
});

let health: WorkspaceCopyHealth;
const baseHealth: WorkspaceCopyHealth = {
  release: '2026.10.27.1',
  commit: '8cc9f94bb2cc02d9487bd5bd2e8392ca1efea9f3',
  running: '2026.10.27.1',
  latest: '2026.10.27.1',
  updates: updates('current', '2026.10.27.1'),
  checkedAt: new Date().toISOString(),
  parts: [
    { key: 'workspace', name: 'Workspace', ok: true, line: 'Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b) · latest 2026.10.27.1' },
    { key: 'licence', name: 'Licence', ok: false, line: 'The licence ends in 10 days, on 26 October 2027.' },
    { key: 'database', name: 'Database', ok: true, line: '3 MB · backed up 3 h ago · every 24 h' },
    { key: 'mail-in', name: 'Mail in', ok: false, line: 'answering, but no certificate yet: mail arrives unencrypted' },
  ],
};

const detail = (role: 'admin' | 'member'): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Theirco', role, invites: [], joinRequests: [],
  fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Ada', you: true, role, joinedAt: '2026-10-27T00:00:00Z', agents: 0, workedMs: 0 }],
});

async function open(role: 'admin' | 'member') {
  vi.useFakeTimers();
  const org = { orgId: 'o1', name: 'Theirco', role, members: 2, seats: 0, seatProviders: [] };
  const state = () => emptyState({
    org, canCreateOrg: true,
    organizations: [{ orgId: 'o1', name: 'Theirco', role, active: true, members: 2, agents: 0 }],
  });
  const script: Record<string, Answer> = {
    ...workspaceScript(state),
    'GET api/org': () => ({ org: detail(role) }),
    'GET api/copy/health': () => health,
    'GET api/copy/diagnostics': () => ({ kind: 'acc-copy-diagnostics', generatedAt: '2026-10-27T18:00:00.000Z' }),
    'POST api/copy/licence': (call) => ({ state: 'valid', line: `Licensed until 26 October 2028 · ${JSON.parse(String(call.init?.body)).licence.length} chars` }),
  };
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={['/workplace?org=o1']}><App api={scripted.api} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  return scripted;
}

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => { health = baseHealth; });

describe('a private copy\'s health, for its admins (note #813)', () => {
  it('reads every part in a line and flags the one that needs a look', async () => {
    await open('admin');
    expect(screen.getByText('This copy')).toBeTruthy();
    expect(screen.getByText('Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b) · latest 2026.10.27.1')).toBeTruthy();
    expect(screen.getByText('3 MB · backed up 3 h ago · every 24 h')).toBeTruthy();
    const mail = document.querySelector('[data-part="mail-in"]')!;
    expect(mail.textContent).toContain('Needs a look');
    expect(document.querySelector('[data-part="database"]')!.textContent).not.toContain('Needs a look');
  });

  it('green: says the copy is up to date, with no upgrade sentence (note #1005)', async () => {
    await open('admin');
    const row = document.querySelector('[data-part="workspace"]')!;
    expect(row.getAttribute('data-updates')).toBe('current');
    const badge = document.getElementById('orgCopyUpdatesBadge')!;
    expect(badge.textContent).toBe('Up to date');
    expect(badge.className).toBe('badge ok');
    expect(row.textContent).not.toContain('Needs a look');
    expect(document.getElementById('orgCopyUpgradeHint')).toBeNull();
  });

  it('amber: names the newer release and says how to upgrade today (note #1005)', async () => {
    health = {
      ...baseHealth, latest: '2026.11.03.0', updates: updates('behind', '2026.11.03.0'),
      parts: [{ key: 'workspace', name: 'Workspace', ok: true, line: 'Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b) · latest 2026.11.03.0' }, ...baseHealth.parts.slice(1)],
    };
    await open('admin');
    expect(screen.getByText('Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b) · latest 2026.11.03.0')).toBeTruthy();
    const badge = document.getElementById('orgCopyUpdatesBadge')!;
    expect(badge.textContent).toBe('Newer release');
    expect(badge.className).toBe('badge amber');
    const hint = document.getElementById('orgCopyUpgradeHint')!;
    expect(hint.textContent).toBe(UPGRADE);
    expect(hint.querySelector('code')!.textContent).toBe('node install.mjs upgrade');
    // No button: upgrading from the Workspace is a later piece.
    // (Its one button is the What's new link, note #1006.)
    expect([...document.querySelectorAll('[data-part="workspace"] button')].map((b) => b.textContent)).toEqual(['What\'s new']);
  });

  it('unknown: says when the update service was last reached, in grey (note #1005)', async () => {
    const line = 'Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b) · latest unknown, update service not reached since 27 Oct 2026, 15:00 UTC';
    health = {
      ...baseHealth, latest: null, updates: updates('unknown', null),
      parts: [{ key: 'workspace', name: 'Workspace', ok: true, line }, ...baseHealth.parts.slice(1)],
    };
    await open('admin');
    expect(screen.getByText(line)).toBeTruthy();
    const badge = document.getElementById('orgCopyUpdatesBadge')!;
    expect(badge.textContent).toBe('Can\'t tell');
    expect(badge.className).toBe('badge mut');
    expect(document.getElementById('orgCopyUpgradeHint')).toBeNull();
  });

  it('off: no badge when the company turned the check off (note #1005)', async () => {
    health = {
      ...baseHealth, latest: null, updates: { ...updates('off', null), reachedAt: null, triedAt: null },
      parts: [{ key: 'workspace', name: 'Workspace', ok: true, line: 'Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b) · update checks are off' }, ...baseHealth.parts.slice(1)],
    };
    await open('admin');
    expect(screen.getByText('Up 3 h 0 min · release 2026.10.27.1 (8cc9f94b) · update checks are off')).toBeTruthy();
    expect(document.getElementById('orgCopyUpdatesBadge')).toBeNull();
  });

  it('downloads the diagnostics file to the admin\'s own computer', async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => { created.push(blob); return 'blob:diagnostics'; });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    await open('admin');
    await act(async () => {
      fireEvent.click(screen.getByText('Download diagnostics'));
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(clicked).toEqual(['copy-diagnostics-2026-10-27.json']);
    vi.useRealTimers();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0]!);
    });
    expect(created[0]!.type).toBe('application/json');
    expect(JSON.parse(text)).toMatchObject({ kind: 'acc-copy-diagnostics' });
    click.mockRestore();
  });

  it('takes a pasted licence and says what it now is', async () => {
    const scripted = await open('admin');
    expect(document.querySelector('[data-part="licence"]')!.textContent).toContain('Needs a look');
    await act(async () => {
      fireEvent.click(screen.getByText('Paste a licence'));
      await vi.advanceTimersByTimeAsync(20);
    });
    fireEvent.change(document.getElementById('orgCopyLicenceText')!, { target: { value: '  acc1.abc.def  ' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save licence'));
      await vi.advanceTimersByTimeAsync(20);
    });
    const posted = scripted.calls.find((call) => call.path === 'api/copy/licence')!;
    expect(JSON.parse(String(posted.init?.body))).toEqual({ licence: 'acc1.abc.def' });
    expect(screen.getByText('Licensed until 26 October 2028 · 12 chars')).toBeTruthy();
    expect(document.getElementById('orgCopyLicenceText')).toBeNull();
  });

  it('shows a member nothing of it', async () => {
    const scripted = await open('member');
    expect(screen.queryByText('This copy')).toBeNull();
    expect(scripted.calls.some((call) => call.path.startsWith('api/copy/'))).toBe(false);
  });
});
