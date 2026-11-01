import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceOrgDetail, WorkspaceOrgInvite } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * The invite page the workplace menu's "Invite to this workplace" opens:
 * the workplace's invite link, ready to copy. What these pin is the promise in that sentence — arriving
 * never leaves an admin without a link, never mints a second one beside a
 * live one, and never mints one back after they revoked it.
 */

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

const state = (role = 'admin') => emptyState({
  org: { orgId: 'o1', name: 'Nomad Trading', role, members: 1, seats: 1, seatProviders: ['claude'] },
  agents: [agent({ id: 'a', name: 'Ada' })],
});
const detail = (invites: WorkspaceOrgInvite[] | null, role = 'admin'): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Nomad Trading', role, invites, joinRequests: role === 'admin' ? [] : null, fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Saddam', you: true, role, joinedAt: '2026-08-01T00:00:00Z', agents: 1, workedMs: 0 }],
});
/** `madeMinsAgo` orders the links; nothing about one expires. */
const link = (token: string, madeMinsAgo = 0): WorkspaceOrgInvite => ({
  token, link: `https://workspace.test/invite/${token}`,
  createdAt: new Date(Date.now() - madeMinsAgo * 60_000).toISOString(),
});

function withClipboard<T>(run: (clipboard: { write: ReturnType<typeof vi.fn>; writeText: ReturnType<typeof vi.fn> }) => Promise<T>, writeText = vi.fn().mockResolvedValue(undefined)) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const clipboard = { write: vi.fn().mockRejectedValue(new Error('no ClipboardItem')), writeText };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  return run(clipboard).finally(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });
}

describe('the invite page', () => {
  it('makes the first link on arrival, once, and copies it from the workplace screen’s own invite-link row', () => withClipboard(async (clipboard) => {
    let minted = 0;
    renderAt('/workplace/invite?org=o1', {
      ...workspaceScript(state),
      'GET api/org': () => ({ org: detail([]) }),
      'GET api/org/join-requests': () => ({ joinRequests: [] }),
      'POST api/org/invites': (call) => { expect(call.scope?.org).toBe('o1'); minted += 1; return { ok: true, invite: link('fresh') }; },
    });
    expect((await screen.findByDisplayValue(link('fresh').link!)).closest('#inviteLinkCard .orgjoin-link')).toBeTruthy();
    expect(minted).toBe(1);
    expect(document.getElementById('inviteHint')!.textContent).toBe('Works until you revoke it. You approve everyone who asks to join.');

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await screen.findByRole('button', { name: 'Invite link copied' });
    expect(clipboard.writeText).toHaveBeenCalledWith(link('fresh').link);
    expect(minted).toBe(1);
  }));

  it('hands over the newest live link instead of minting beside it', () => withClipboard(async (clipboard) => {
    const post = vi.fn();
    renderAt('/workplace/invite?org=o1', {
      ...workspaceScript(state),
      'GET api/org': () => ({ org: detail([link('old', 90), link('new', 5)]) }),
      'GET api/org/join-requests': () => ({ joinRequests: [] }),
      'POST api/org/invites': () => { post(); return { ok: true, invite: link('extra') }; },
    });
    await screen.findByDisplayValue(link('new').link!);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'All 2 invite links' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(link('new').link));
  }));

  it('selects the link for copying by hand when the clipboard refuses', () => withClipboard(async () => {
    renderAt('/workplace/invite?org=o1', {
      ...workspaceScript(state),
      'GET api/org': () => ({ org: detail([link('only')]) }),
      'GET api/org/join-requests': () => ({ joinRequests: [] }),
    });
    await screen.findByDisplayValue(link('only').link!);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Select the link to copy it manually.');
  }, vi.fn().mockRejectedValue(new Error('denied'))));

  it('does not mint a link back after the admin revoked the last one', async () => {
    let invites = [link('only')];
    const post = vi.fn();
    renderAt('/workplace/invite?org=o1', {
      ...workspaceScript(state),
      'GET api/org': () => ({ org: detail(invites) }),
      'GET api/org/join-requests': () => ({ joinRequests: [] }),
      'DELETE api/org/invites/only': () => { invites = []; return { ok: true }; },
      'POST api/org/invites': () => { post(); return { ok: true, invite: link('again') }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke link' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const door = await screen.findByRole('button', { name: 'Create invite link' });
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(door);
    await screen.findByDisplayValue(link('again').link!);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('tells a member plainly, and asks the server for nothing', async () => {
    const post = vi.fn();
    renderAt('/workplace/invite?org=o1', {
      ...workspaceScript(() => state('member')),
      'GET api/org': () => ({ org: detail(null, 'member') }),
      'POST api/org/invites': () => { post(); return { ok: true, invite: link('no') }; },
    });
    await screen.findByText('Only an admin can invite people.');
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('says invites are closed, and mints nothing, while the backend has them switched off', async () => {
    let minted = 0;
    renderAt('/workplace/invite?org=o1', {
      ...workspaceScript(() => ({ ...state(), invitesClosed: true })),
      'GET api/org': () => ({ org: detail(null) }),
      'POST api/org/invites': () => { minted += 1; return { ok: true, invite: link('fresh') }; },
    });
    await screen.findByText(/Inviting people to a workplace is switched off for now/);
    expect(document.getElementById('inviteMakeBtn')).toBeNull();
    expect(document.getElementById('inviteRefused')).toBeNull();
    expect(minted).toBe(0);
  });
});
