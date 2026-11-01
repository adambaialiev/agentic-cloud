import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacePeopleAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { WorkspaceApiError } from '../../api/client.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { PEOPLE_POLL_MS } from './usePeople.js';

/**
 * What an open People page does when the reader stops being a member.
 *
 * The backend already refuses them — the September 5 membership simulations
 * confirmed every scoped read returns 403 the moment the membership is gone.
 * The bug was entirely on this side: the page kept drawing the roster it had
 * loaded earlier, both people still shown, the removed one still "Here now",
 * until somebody reloaded. These tests are about the page believing the
 * refusal.
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'member', members: 2, seats: 1, seatProviders: ['claude'] };
const state = () => emptyState({
  org,
  organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'member', active: true, members: 2, agents: 1 }],
  agents: [agent({ id: 'a', name: 'Ada' })],
});
const members = (): WorkspacePeopleAnswer['people'] => [
  { userId: 'u1', name: 'Saddam', you: true, role: 'member', joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0, here: true },
  { userId: 'u2', name: 'Mira Chen', you: false, role: 'admin', joinedAt: '2026-08-20T00:00:00Z', agents: 2, workedMs: 0, here: true },
];
const people = (): WorkspacePeopleAnswer => ({
  org: { orgId: 'o1', name: 'Nomad Trading', role: 'member', workedMs: 0 }, people: members(),
});
const removed = () => {
  throw new WorkspaceApiError('You do not belong to this workplace.', 403, {
    error: 'You do not belong to this workplace.',
  });
};

afterEach(() => { vi.useRealTimers(); });

describe('a People page whose reader loses access', () => {
  it('stops showing the roster the moment a tick is refused', async () => {
    vi.useFakeTimers();
    let live: Answer = () => ({ people: members().map((person) => ({ userId: person.userId, here: true })) });
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => people(),
      'GET api/org/people/live': (call) => live(call),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText('Mira Chen')).toBeTruthy();

    // An admin removes them while the page is open.
    live = removed;
    await act(async () => { await vi.advanceTimersByTimeAsync(PEOPLE_POLL_MS + 50); });
    expect(screen.queryByText('Mira Chen')).toBeNull();
    expect(screen.getByText('You do not belong to this workplace.')).toBeTruthy();
  });

  it('keeps the roster through an ordinary failed tick', async () => {
    vi.useFakeTimers();
    let live: Answer = () => ({ people: members().map((person) => ({ userId: person.userId, here: true })) });
    const { calls } = renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => people(),
      'GET api/org/people/live': (call) => live(call),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    // A dropped connection says nothing about membership: the rows stay and
    // the tick keeps trying, exactly as before.
    live = () => { throw new WorkspaceApiError('the backend is restarting', 502, {}); };
    await act(async () => { await vi.advanceTimersByTimeAsync(PEOPLE_POLL_MS + 50); });
    expect(screen.getByText('Mira Chen')).toBeTruthy();
    const after = calls.filter((call) => call.path === 'api/org/people/live').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(PEOPLE_POLL_MS + 50); });
    expect(calls.filter((call) => call.path === 'api/org/people/live').length).toBeGreaterThan(after);
  });

  it('shows the refusal instead of an empty roster when the page opens without access', async () => {
    vi.useFakeTimers();
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': removed,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText('You do not belong to this workplace.')).toBeTruthy();
  });

  it('drops a member the tick no longer carries, without waiting for a reload', async () => {
    vi.useFakeTimers();
    let live: Answer = () => ({ people: members().map((person) => ({ userId: person.userId, here: true })) });
    renderAt('/workplace/people?org=o1', {
      ...workspaceScript(state),
      'GET api/org/people': () => people(),
      'GET api/org/people/live': (call) => live(call),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText('Mira Chen')).toBeTruthy();

    // Mira is removed by another admin. The tick answers with every current
    // member, so her absence from it is the fact that she has gone.
    live = () => ({ people: [{ userId: 'u1', here: true }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(PEOPLE_POLL_MS + 50); });
    expect(screen.queryByText('Mira Chen')).toBeNull();
    expect(screen.getByText('Saddam')).toBeTruthy();
  });
});
