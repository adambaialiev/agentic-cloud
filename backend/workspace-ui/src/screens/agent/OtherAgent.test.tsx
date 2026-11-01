import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { agent, emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * Somebody else's agent (note #640).
 *
 * The reader taps a face on a shared shelf — a knowledge page, a note, a
 * site — and most of those faces are a teammate's agent, which stands in no
 * fleet this reader holds. What opens is this: the facts, and nothing to
 * press. These tests hold it to both halves, because a read-only screen that
 * quietly grew a control would be the whole point of it lost.
 */

function open(state: WorkspaceStateAnswer, extra: Record<string, Answer> = {}, path = '/agents/leo') {
  const scripted = scriptedApi({ ...workspaceScript(() => state), ...extra });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App api={scripted.api} />
    </MemoryRouter>,
  );
  return scripted;
}

const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 3, seats: 1, seatProviders: ['claude'] };
/** The reader's OWN fleet — Leo is not in it, which is the whole case. */
const mine = (overrides: Partial<WorkspaceStateAnswer> = {}) => emptyState({
  org, agents: [agent({ id: 'felix', name: 'Felix' })], ...overrides,
});

const leoCard = (overrides: Record<string, unknown> = {}) => ({
  agent: {
    id: 'leo',
    name: 'Leo',
    cli: 'codex',
    model: 'GPT-5.1',
    effort: 'high',
    avatarUrl: '/miniapp/avatars/leo',
    status: 'ready',
    // The card may still say which room the agent worked in; the screen
    // drew it as a Room fact until rooms left the product (note #843).
    roomId: 'r1',
    roomName: 'Math school',
    recap: 'Rewrote the landing page copy',
    lastActiveAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    ...overrides,
  },
  owner: { userId: 'u2', name: 'Dana Ives', photoUrl: '/photos/dana.png' },
});

describe('a teammate’s agent', () => {
  it('says what it is, what it runs, whose it is and what it last did', async () => {
    open(mine(), { 'GET api/agents/leo/card': () => leoCard() });
    await screen.findByRole('heading', { name: 'Leo' });
    expect(document.getElementById('otherAgentRuntime')!.textContent).toBe('Codex · GPT-5.1 · high');
    // WHOSE it is, first and in plain words: the reader is standing on a page
    // with no buttons, and the reason is not that something failed.
    expect(document.getElementById('otherAgentAbout')!.textContent)
      .toBe('Dana Ives’s agent. You can see what it is and what it has been doing; only Dana Ives can message it or change how it runs.');
    const facts = document.getElementById('otherAgentFacts')!;
    expect(document.getElementById('otherAgentState')!.textContent).toContain('Ready');
    expect(facts.textContent).not.toContain('Math school');
    expect(facts.textContent).not.toContain('Room');
    // WHO DRIVES IT wears their own face, as it does on the reader's own
    // agent screen — a name alone is the answer for a member with no picture,
    // never the shape of this row.
    const owner = document.getElementById('otherAgentOwner')!;
    expect(owner.textContent).toContain('Dana Ives');
    expect((owner.querySelector('img.aface') as HTMLImageElement).getAttribute('src')).toBe('/photos/dana.png');
    expect(document.getElementById('otherAgentWork')!.textContent).toContain('Rewrote the landing page copy');
  });

  it('offers not one control — no chat, no runtime, no machine, no delete', async () => {
    open(mine(), { 'GET api/agents/leo/card': () => leoCard() });
    await screen.findByRole('heading', { name: 'Leo' });
    const buttons = screen.getAllByRole('button').map((node) => node.textContent ?? '');
    for (const forbidden of ['Chat', 'Delete', 'Update', 'Move', 'Machine', 'Reset']) {
      expect(buttons.some((label) => label.includes(forbidden))).toBe(false);
    }
    // And it asked for nothing but the card: the control room's reads are
    // refused for somebody else's agent, and must never be attempted.
    expect(document.querySelector('#agentFacts')).toBeNull();
  });

  it('opens the member who drives it', async () => {
    open(mine(), { 'GET api/agents/leo/card': () => leoCard() });
    await screen.findByRole('heading', { name: 'Leo' });
    fireEvent.click(screen.getByRole('button', { name: 'Dana Ives' }));
    expect(await screen.findByText(/Loading…|not in this workplace/)).toBeTruthy();
    expect(document.getElementById('screenOrgMember')).toBeTruthy();
  });

  it('names a member who has set no picture, with no gap where one would be', async () => {
    open(mine(), {
      'GET api/agents/leo/card': () => ({
        agent: { id: 'leo', name: 'Leo', cli: 'codex', status: 'ready' },
        owner: { userId: 'u2', name: 'Dana Ives' },
      }),
    });
    await screen.findByRole('heading', { name: 'Leo' });
    const owner = document.getElementById('otherAgentOwner')!;
    expect(owner.textContent).toContain('Dana Ives');
    expect(owner.querySelector('img')).toBeNull();
  });

  it('says a working agent is working', async () => {
    open(mine(), { 'GET api/agents/leo/card': () => leoCard({ working: true }) });
    await screen.findByRole('heading', { name: 'Leo' });
    expect(document.getElementById('otherAgentState')!.textContent).toContain('Active');
  });

  it('says so when the workplace has no such agent', async () => {
    open(mine(), {
      'GET api/agents/leo/card': () => { throw new Error('No such agent in this workplace.'); },
    });
    expect(await screen.findByRole('heading', { name: 'That agent is not here' })).toBeTruthy();
    expect(document.getElementById('otherAgentGone')!.textContent).toContain('No such agent in this workplace.');
    // Nothing to ask again, so the way out: the reader's own agents, where
    // "Back to Rooms" went while there were rooms (note #843).
    fireEvent.click(screen.getByRole('button', { name: 'Back to your agents' }));
    expect(await screen.findByRole('heading', { name: 'Your agents' })).toBeTruthy();
    expect(document.getElementById('agentSwitchGrid')).toBeTruthy();
  });

  it('says where the controls are when the agent turns out to be the reader’s own', async () => {
    // The route picks this screen off the fleet, so an agent of the reader's
    // that the fleet is not carrying — one being deleted, a read that has not
    // landed — lands here too. It says so, and points at the fleet: a
    // redirect would go straight back to the address that chose this screen.
    open(
      emptyState({ org, agents: [] }),
      {
        'GET api/agents/felix/card': () => ({
          agent: { id: 'felix', name: 'Felix', cli: 'claude', status: 'ready' },
          owner: { userId: 'u1', name: 'Owner Example', you: true },
          yours: true,
        }),
      },
      '/agents/felix',
    );
    await screen.findByRole('heading', { name: 'Felix' });
    expect(document.getElementById('otherAgentAbout')!.textContent)
      .toBe('Your own agent. Open it from your agents on Home to change what it runs or message it.');
  });
});
