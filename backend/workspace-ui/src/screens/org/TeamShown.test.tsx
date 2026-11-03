import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { WorkspaceOrgDetail, WorkspacePeopleAnswer, WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, homeShelf, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * Who sees the team (Adam, 2026-10-28: "let's bring back the team UI").
 * Note #205 (2026-10-11) hid people and roles whenever inviting was switched
 * off (`state.invitesClosed`), because a workplace was then one person's.
 * The rule now is the team itself (`workplaceHasTeam`): people, roles and
 * the People doors show wherever invites are open OR more than one person
 * is already in the workplace. Only a workplace of one that nobody can join
 * keeps #205's quiet — "Admin", "just you" and a People door there could say
 * nothing but that a team feature is missing.
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

// `closed` is the workplace this tab stands in (o1) and `two` whether a
// teammate has already joined it; `otherClosed` the second row, since each
// workplace says for itself whether it takes people (note #805).
const state = (closed: boolean, otherClosed = closed, two = false): WorkspaceStateAnswer => emptyState({
  org: { orgId: 'o1', name: 'ACC', role: 'admin', members: two ? 2 : 1, seats: 1, seatProviders: ['claude'] },
  canCreateOrg: true,
  organizations: [
    { orgId: 'o1', name: 'ACC', role: 'admin', active: true, members: two ? 2 : 1, agents: 11, ...(closed ? { invitesClosed: true as const } : {}) },
    { orgId: 'o2', name: 'Jone’s workplace', role: 'member', active: false, members: 2, agents: 1, ...(otherClosed ? { invitesClosed: true as const } : {}) },
  ],
  agents: [agent({ id: 'a', name: 'Ada' })],
  ...(closed ? { invitesClosed: true as const } : {}),
});
const detail = (two = false): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'ACC', role: 'admin', invites: null, joinRequests: null, canDelete: false, blocked: 'ACC still has 11 agents.',
  fly: { connected: false, hosted: true, agents: { used: 11, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [
    { userId: 'u1', name: 'Adam B', you: true, role: 'admin', joinedAt: '2026-08-01T00:00:00Z', agents: 11, workedMs: 0 },
    ...(two ? [{ userId: 'u2', name: 'Mira Chen', you: false, role: 'member', joinedAt: '2026-08-20T00:00:00Z', agents: 3, workedMs: 0 }] : []),
  ],
});
const people = (two: boolean): WorkspacePeopleAnswer => ({
  org: { orgId: 'o1', name: 'ACC', role: 'admin', workedMs: 0 },
  people: detail(two).members,
});
const script = (closed: boolean, otherClosed = closed, two = false): Record<string, Answer> => ({
  ...workspaceScript(() => state(closed, otherClosed, two)),
  'GET api/org': () => ({ org: detail(two) }),
  'GET api/org/people': () => people(two),
  'GET api/org/people/live': () => ({ people: [] }),
  'GET api/org/spend': () => ({ spend: null }),
});

async function openMenu(name: 'Switch workplace' | 'Your account') {
  await homeShelf();
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('menu', { name: name === 'Your account' ? 'Your account' : 'Workplaces' });
}

describe('a workplace of one that nobody can join keeps people and roles quiet (note #205)', () => {
  it('the account menu has no People row', async () => {
    renderAt('/', script(true));
    const menu = await openMenu('Your account');
    expect(within(menu).getAllByRole('menuitem').map((row) => row.querySelector('.orgmenuname')!.textContent))
      .toEqual(['Apps', 'Settings']);
    expect(menu.textContent).not.toMatch(/person|people/i);
  });

  it('the workplace switcher names it and its agents, with no role and no head count', async () => {
    renderAt('/', script(true));
    const menu = await openMenu('Switch workplace');
    expect(within(menu).queryByText('Admin')).toBeNull();
    expect(menu.textContent).not.toMatch(/just you/);
    expect(within(menu).getByText('11 agents')).toBeTruthy();
  });

  it('the workplaces list says the same as the switcher', async () => {
    renderAt('/workplaces', script(true));
    const list = await waitFor(() => { const node = document.getElementById('orgPickerList'); if (!node?.textContent?.includes('Jone')) throw new Error('not yet'); return node; });
    expect(list.textContent).not.toMatch(/Admin|just you/);
    expect(list.textContent).toContain('11 agents');
  });

  it('Workplace settings drops the head count, the role and the People card', async () => {
    renderAt('/workplace?org=o1', script(true));
    expect(await screen.findByRole('heading', { name: 'ACC' })).toBeTruthy();
    await waitFor(() => expect(document.getElementById('orgPeopleCard')).toBeNull());
    expect(document.getElementById('orgSub')?.textContent ?? '').not.toMatch(/person|people|admin/i);
    expect(document.getElementById('orgPeopleDoor')).toBeNull();
  });

  it('the People page, if somebody reaches it, names no role', async () => {
    renderAt('/workplace/people?org=o1', script(true));
    expect(await screen.findByText('Adam B')).toBeTruthy();
    expect(document.getElementById('people')!.textContent).not.toMatch(/Admin|Member/);
    expect(document.getElementById('peopleSub')?.textContent ?? '').not.toMatch(/people|person|just you/i);
  });

  it('their own page names no role', async () => {
    renderAt('/workplace/members/u1?org=o1', script(true));
    expect(await screen.findByRole('heading', { name: 'Adam B' })).toBeTruthy();
    expect(document.getElementById('orgMemberSub')!.textContent).toBe('ACC — this is you');
  });
});

describe('the team shows wherever the workplace can have one (2026-10-28)', () => {
  it('the account menu has its People row while invites are open, even alone', async () => {
    renderAt('/', script(false));
    const menu = await openMenu('Your account');
    expect(within(menu).getByText('1 person in ACC')).toBeTruthy();
  });

  it('and once a teammate is in, whether or not anyone else may join', async () => {
    renderAt('/', script(true, true, true));
    const menu = await openMenu('Your account');
    expect(within(menu).getByText('2 people in ACC')).toBeTruthy();
  });

  it('the workplace switcher keeps the role and the head count while invites are open', async () => {
    renderAt('/', script(false));
    const menu = await openMenu('Switch workplace');
    expect(within(menu).getByText('Admin')).toBeTruthy();
    expect(within(menu).getByText('just you · 11 agents')).toBeTruthy();
    expect(within(menu).getByText('2 people · 1 agent')).toBeTruthy();
  });

  it('a shut workplace of two still shows its people beside one marked to invite (note #805)', async () => {
    renderAt('/', script(false, true));
    const menu = await openMenu('Switch workplace');
    expect(within(menu).getByText('Admin')).toBeTruthy();
    expect(within(menu).getByText('just you · 11 agents')).toBeTruthy();
    expect(within(menu).getByText('2 people · 1 agent')).toBeTruthy();
    expect(document.getElementById('workplaceMenuInvite')).toBeTruthy();
  });

  it('a shut workplace of one shows only its agents beside a team, and offers no invite', async () => {
    renderAt('/', script(true, false));
    const menu = await openMenu('Switch workplace');
    expect(within(menu).queryByText('Admin')).toBeNull();
    expect(within(menu).getByText('11 agents')).toBeTruthy();
    expect(within(menu).getByText('2 people · 1 agent')).toBeTruthy();
    expect(document.getElementById('workplaceMenuInvite')).toBeNull();
  });

  it('Workplace settings keeps the head count, the role and the People door for a team of two', async () => {
    renderAt('/workplace?org=o1', script(true, true, true));
    expect(await screen.findByText('2 people · you’re an admin')).toBeTruthy();
    expect(document.getElementById('orgPeopleDoor')).toBeTruthy();
  });

  it('the People page names roles and heads for a team of two', async () => {
    renderAt('/workplace/people?org=o1', script(true, true, true));
    expect(await screen.findByText('Mira Chen')).toBeTruthy();
    // The admin is named so; a member wears no role word (note #833).
    expect(document.querySelector('#people [data-person="u1"] .personname')!.textContent).toBe('Adam BYou · Admin');
    expect(document.querySelector('#people [data-person="u2"] .personname')!.textContent).toBe('Mira Chen');
    expect(document.getElementById('peopleSub')!.textContent).toContain('2 people');
  });

  it('a teammate’s own page keeps the role and its change', async () => {
    renderAt('/workplace/members/u2?org=o1', script(true, true, true));
    expect(await screen.findByText('Member of ACC')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make admin' })).toBeTruthy();
  });
});
