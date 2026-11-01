import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AUTO_APPROVE_SETTING_WORDS } from '../../../../src/shared/auto-approve.js';
import type { WorkspaceOrgAutoApproveAnswer, WorkspaceOrgDetail } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import { autoApproveMeta } from './AutoApproveSection.js';

/**
 * Auto-approve mode (note #944) on the workplace's own page: one switch,
 * worded with what it does, that an admin turns on (asked once more) and
 * off (not asked), and that a member reads but cannot flip.
 */
const detail = (role: 'admin' | 'member'): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Studio', role, invites: [], joinRequests: [],
  fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Adam', you: true, role, joinedAt: '2026-10-27T00:00:00Z', agents: 0, workedMs: 0 }],
});

function open(role: 'admin' | 'member', initial: Partial<WorkspaceOrgAutoApproveAnswer> = {}) {
  let stored: WorkspaceOrgAutoApproveAnswer = { on: false, canChange: role === 'admin', ...initial };
  const org = { orgId: 'o1', name: 'Studio', role, members: 1, seats: 0, seatProviders: [] };
  const state = () => emptyState({
    org, organizations: [{ orgId: 'o1', name: 'Studio', role, active: true, members: 1, agents: 0 }],
  });
  const script: Record<string, Answer> = {
    ...workspaceScript(state),
    'GET api/org': () => ({ org: detail(role) }),
    'GET api/org/auto-approve': () => stored,
    'PUT api/org/auto-approve': (call) => {
      const { on } = JSON.parse(String(call.init?.body)) as { on: boolean };
      stored = { ...stored, on, changedAt: new Date().toISOString(), changedByName: 'Adam' };
      return { ...stored, ok: true, changed: true };
    },
  };
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={['/workplace?org=o1']}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
/** The switch, once the section has read its state and drawn. */
const findSwitch = () => waitFor(() => {
  const toggle = document.getElementById('orgAutoApproveSwitch') as HTMLButtonElement | null;
  if (!toggle) throw new Error('the switch has not drawn yet');
  return toggle;
});
const puts = (calls: ReturnType<typeof open>['calls']) => calls
  .filter((c) => c.path === 'api/org/auto-approve' && c.init?.method === 'PUT')
  .map((c) => JSON.parse(String(c.init!.body)) as { on: boolean });

describe('auto-approve on the workplace page (note #944)', () => {
  it('is off by default, and says in its own words what turning it on does', async () => {
    open('admin');
    const toggle = await findSwitch();
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Auto-approve');
    expect(toggle.textContent).toContain(AUTO_APPROVE_SETTING_WORDS);
    expect(AUTO_APPROVE_SETTING_WORDS).toBe('Every code proposal your agents make ready is merged without asking you. Checks must still pass.');
    expect(document.getElementById('orgAutoApproveState')!.textContent).toBe('Off · every proposal waits for its owner');
  });

  it('an admin turns it on only after saying yes once more, and off without being asked', async () => {
    const { calls } = open('admin');
    const toggle = await findSwitch();
    fireEvent.click(toggle);
    // Asked: from now on nobody reads a proposal before it merges.
    await waitFor(() => expect(screen.getByText('Turn on auto-approve?')).toBeTruthy());
    expect(puts(calls)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(document.getElementById('orgAutoApproveSwitch')!.getAttribute('aria-checked')).toBe('true'));
    expect(puts(calls)).toEqual([{ on: true }]);
    expect(document.getElementById('orgAutoApproveState')!.textContent).toMatch(/^On · turned on by Adam /);

    fireEvent.click(document.getElementById('orgAutoApproveSwitch')!);
    await waitFor(() => expect(document.getElementById('orgAutoApproveSwitch')!.getAttribute('aria-checked')).toBe('false'));
    expect(puts(calls)).toEqual([{ on: true }, { on: false }]);
  });

  it('a member sees the state, and that only an admin can change it', async () => {
    const { calls } = open('member', { on: true, changedAt: new Date().toISOString(), changedByName: 'Adam' });
    const toggle = await findSwitch();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(true);
    expect(document.getElementById('orgAutoApproveState')!.textContent).toMatch(/^On · turned on by Adam .* · only an admin can change this$/);
    fireEvent.click(toggle);
    expect(puts(calls)).toEqual([]);
  });

  it('words the state line from the record alone', () => {
    const now = Date.parse('2026-11-01T15:10:00Z');
    expect(autoApproveMeta({ on: false, canChange: true }, now)).toBe('Off · every proposal waits for its owner');
    expect(autoApproveMeta({ on: true, canChange: true, changedAt: '2026-11-01T15:02:00Z', changedByName: 'Adam' }, now))
      .toMatch(/^On · turned on by Adam 8/);
  });
});
