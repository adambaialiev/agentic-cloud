import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { WorkspaceOrgDetail, WorkspacePeopleAnswer, WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { toFor } from '../../routes.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * The doors into a conversation with a teammate (29 Oct 2026, direct
 * messages back on). The state's `messagesAvailable` decides them all: it is
 * true only where there can be someone to write to (routes/workspace.ts).
 * A teammate's plate carries a small send mark, read by the row like an
 * agent's face; their own page keeps its real Message button. Never on your
 * own plate, and nowhere while Messages is not offered.
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

const state = (offered: boolean): WorkspaceStateAnswer => emptyState({
  org: { orgId: 'o1', name: 'ACC', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] },
  organizations: [{ orgId: 'o1', name: 'ACC', role: 'admin', active: true, members: 2, agents: 0 }],
  messagesAvailable: offered,
});
const members: WorkspaceOrgDetail['members'] = [
  { userId: 'u1', name: 'Adam B', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 0, workedMs: 0 },
  { userId: 'u2', name: 'Mira Chen', you: false, role: 'member', joinedAt: '2026-08-20T00:00:00Z', agents: 0, workedMs: 0 },
];
const detail: WorkspaceOrgDetail = {
  orgId: 'o1', name: 'ACC', role: 'admin', invites: null, joinRequests: null, canDelete: false,
  fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members,
};
const people: WorkspacePeopleAnswer = { org: { orgId: 'o1', name: 'ACC', role: 'admin', workedMs: 0 }, people: members };
const script = (offered: boolean): Record<string, Answer> => ({
  ...workspaceScript(() => state(offered)),
  'GET api/org': () => ({ org: detail }),
  'GET api/org/people': () => people,
  'GET api/org/people/live': () => ({ people: [] }),
  'GET api/org/spend': () => ({ spend: null }),
  'GET api/messages/u2': () => ({ orgName: 'ACC', person: { userId: 'u2', name: 'Mira Chen', available: true }, viewerId: 'u1', messages: [], hasMore: false }),
  'GET api/messages/unread': () => ({ unread: 0 }),
});

const plate = (userId: string) => document.querySelector(`#people [data-person="${userId}"]`) as HTMLElement | null;

describe('a conversation with a teammate is one tap from where they are shown', () => {
  it('a teammate’s plate carries the send mark, pointing at their conversation; your own does not', async () => {
    renderAt('/workplace/people?org=o1', script(true));
    await screen.findByText('Mira Chen');
    const mark = plate('u2')!.querySelector('[data-row-door]')!;
    expect(mark.getAttribute('data-row-door')).toBe(toFor({ kind: 'directMessage', id: 'u2', orgId: 'o1' }));
    expect(mark.getAttribute('title')).toBe('Message Mira Chen');
    // One control per plate: the mark is not a second focus stop.
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(plate('u1')!.querySelector('[data-row-door]')).toBeNull();
  });

  it('a tap on the mark opens the conversation', async () => {
    renderAt('/workplace/people?org=o1', script(true));
    await screen.findByText('Mira Chen');
    fireEvent.click(plate('u2')!.querySelector('[data-row-door]')!);
    await waitFor(() => expect(document.getElementById('screenDirectMessage')).toBeTruthy());
    expect(document.getElementById('screenPeople')).toBeNull();
  });

  it('a tap on the plate away from the mark still opens the person', async () => {
    renderAt('/workplace/people?org=o1', script(true));
    await screen.findByText('Mira Chen');
    fireEvent.click(plate('u2')!.querySelector('.name')!);
    expect(await screen.findByRole('button', { name: 'Message Mira Chen' })).toBeTruthy();
    expect(document.getElementById('screenDirectMessage')).toBeNull();
  });

  it('their own page has the real Message button', async () => {
    renderAt('/workplace/members/u2?org=o1', script(true));
    expect(await screen.findByRole('button', { name: 'Message Mira Chen' })).toBeTruthy();
  });

  it('nowhere while the workplace is not offered Messages', async () => {
    renderAt('/workplace/people?org=o1', script(false));
    await screen.findByText('Mira Chen');
    expect(document.querySelector('#people [data-row-door]')).toBeNull();
  });
});
