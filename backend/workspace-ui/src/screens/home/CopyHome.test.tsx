import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * Home in a private copy (note #814): no Leaderboard anywhere (Adam, 27 Oct
 * 2026) — not its door, not the account menu's row, not its address — and
 * the licence's line for an admin while it needs them.
 */
vi.mock('../../../../src/shared/private-copy.js', () => ({ PRIVATE_COPY: true, SIGNUP_CLOSED: false, FIRST_ACCOUNT_FRAGMENT: 'first-account' }));

function Address() {
  const location = useLocation();
  return <div data-testid="address">{location.pathname}</div>;
}

const org = { orgId: 'o1', name: 'Theirco', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
const state = (over: Partial<WorkspaceStateAnswer> = {}) => emptyState({
  org,
  agents: [agent({ id: 'a', name: 'Ada', lastActiveAt: new Date().toISOString() })],
  ...over,
});

function open(path: string, read: WorkspaceStateAnswer, extra: Record<string, Answer> = {}) {
  const scripted = scriptedApi({ ...workspaceScript(() => read), ...extra });
  render(<MemoryRouter initialEntries={[path]}><Address /><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

describe('Home in a private copy (note #814)', () => {
  it('has no Leaderboard row in the account menu, and never asks for a standing', async () => {
    const scripted = open('/', state());
    await waitFor(() => expect(document.getElementById('homeAccount')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Your account' }));
    await screen.findByRole('menu', { name: 'Your account' });
    expect(document.getElementById('accountMenuLeaderboard')).toBeNull();
    expect(document.getElementById('accountMenuApps')).toBeTruthy();
    expect(scripted.calls.some((call) => call.path.includes('leaderboard'))).toBe(false);
  });

  it('has no page at the Leaderboard\'s old address (gone everywhere since note #824)', async () => {
    open('/leaderboard', state());
    expect(await screen.findByRole('heading', { name: 'Nothing at this address' })).toBeTruthy();
  });

  it('tells an admin about the licence while it needs them', async () => {
    open('/', state({ copyLicence: { state: 'ending', line: 'The licence ends in 10 days, on 26 October 2027.' } }));
    // Above the message box, where it stays in view however long the chat.
    await waitFor(() => expect(document.getElementById('homeStanding')?.textContent).toBe('The licence ends in 10 days, on 26 October 2027.'));
  });
});
