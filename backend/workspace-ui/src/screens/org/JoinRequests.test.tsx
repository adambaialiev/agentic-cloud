import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOrgDetail, WorkspaceOrgJoinRequest } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { JOIN_REQUEST_POLL_MS } from './useOrgDetail.js';

/**
 * The workplace screen's waiting list, which moves while an admin is
 * looking at it. Before this tick, an open screen kept showing an empty list
 * however long somebody stood at the door — the September 5 membership
 * simulations watched it stay wrong for 11.5 seconds and only a manual
 * Refresh put it right.
 *
 * Note #357 then took the pending count and the Refresh button off the screen,
 * which leaves this tick as the ONLY thing that moves the list. So these read
 * the list itself: the empty state when nobody is there, the person's name
 * when somebody is.
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] };
const state = () => emptyState({
  org, canCreateOrg: true,
  organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 1, agents: 1 }],
  agents: [agent({ id: 'a', name: 'Ada' })],
});
const orgDetail = (joinRequests: WorkspaceOrgJoinRequest[]): WorkspaceOrgDetail => ({
  name: 'Nomad Trading', role: 'admin', invites: [], joinRequests, fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Saddam', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0 }],
});
const waiting: WorkspaceOrgJoinRequest[] = [
  { requestId: 'jr1', userId: 'u9', name: 'Pat Quinn', requestedAt: '2026-09-05T10:00:00Z' },
];

afterEach(() => { vi.useRealTimers(); });

describe('the join requests an admin is shown', () => {
  it('shows somebody arriving without the admin touching Refresh', async () => {
    vi.useFakeTimers();
    let pending: WorkspaceOrgJoinRequest[] = [];
    const { calls } = renderAt('/workplace?org=o1', {
      ...workspaceScript(state),
      // The heavy record is read on open and answers what was true then.
      'GET api/org': () => ({ org: orgDetail([]) }),
      'GET api/org/join-requests': () => ({ joinRequests: pending }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText('No pending requests.')).toBeTruthy();

    // Somebody asks to join while the admin sits on the screen.
    pending = waiting;
    await act(async () => { await vi.advanceTimersByTimeAsync(JOIN_REQUEST_POLL_MS + 50); });
    expect(screen.getByText('Pat Quinn')).toBeTruthy();
    expect(screen.queryByText('No pending requests.')).toBeNull();

    // And the tick reads only the waiting list: `api/org` is a dozen reads
    // and a call out to the git host, which is why it stays on open only.
    expect(calls.filter((call) => call.path === 'api/org')).toHaveLength(1);
  });

  it('stops saying somebody is waiting once they have been decided', async () => {
    vi.useFakeTimers();
    let pending = waiting;
    renderAt('/workplace?org=o1', {
      ...workspaceScript(state),
      'GET api/org': () => ({ org: orgDetail(waiting) }),
      'GET api/org/join-requests': () => ({ joinRequests: pending }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText('Pat Quinn')).toBeTruthy();

    // Another admin approved them in the meantime.
    pending = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(JOIN_REQUEST_POLL_MS + 50); });
    expect(screen.getByText('No pending requests.')).toBeTruthy();
    expect(screen.queryByText('Pat Quinn')).toBeNull();
  });

  it('does not ask for a waiting list an ordinary member may not read', async () => {
    vi.useFakeTimers();
    const memberState = () => emptyState({
      org: { ...org, role: 'member' },
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'member', active: true, members: 1, agents: 1 }],
      agents: [agent({ id: 'a', name: 'Ada' })],
    });
    const { calls } = renderAt('/workplace?org=o1', {
      ...workspaceScript(memberState),
      // A member is sent no join requests at all — the block is hidden, not
      // drawn empty — so there is nothing for a tick to keep current.
      'GET api/org': () => ({ org: { ...orgDetail([]), role: 'member', invites: null, joinRequests: null } }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(JOIN_REQUEST_POLL_MS + 50); });
    expect(calls.some((call) => call.path === 'api/org/join-requests')).toBe(false);
  });
});
