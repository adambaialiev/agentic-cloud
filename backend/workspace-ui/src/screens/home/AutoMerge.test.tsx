import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AUTO_APPROVE_SETTING_WORDS } from '../../../../src/shared/auto-approve.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';
import { autoMergeMeta } from './AutoMerge.js';

/**
 * Auto-merge (note #944), each person's own ("Each user should enable
 * disable for itself", Adam, 1 Nov 2026): the switch in the Workplace
 * window, asked once more on the way on, and the yellow "Auto-merge on" in
 * the Chief of Staff's header while it is on.
 */
const details = {
  orgId: 'o1', agentId: 'workspace-1',
  agent: { name: 'Workspace Agent', started: true, working: false, waiting: [] },
  settings: { cli: 'claude' as const, model: 'opus', effort: 'high' },
  machine: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 },
};

function open(path: string, role: 'admin' | 'member' = 'member', initial?: { on: boolean; changedAt?: string }) {
  let autoMerge = initial;
  const state = () => emptyState({
    org: { orgId: 'o1', name: 'Studio', role, members: 2, seats: 0, seatProviders: [], ...(autoMerge ? { autoMerge } : {}) },
  });
  const scripted = scriptedApi({
    ...workspaceScript(state),
    'GET api/recap/agent': () => details,
    'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: details.settings, models: [] }),
    'GET api/recap/chat': () => ({ orgId: 'o1', messages: [], working: false, waiting: [] }),
    'GET api/recap/agent/proactive': () => { throw new Error('not needed here'); },
    'PUT api/org/auto-approve': (call) => {
      const { on } = JSON.parse(String(call.init?.body)) as { on: boolean };
      autoMerge = { on, changedAt: new Date().toISOString() };
      return { ...autoMerge, ok: true, changed: true };
    },
  });
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
const findSwitch = () => waitFor(() => {
  const toggle = document.getElementById('homeAutoMergeSwitch') as HTMLButtonElement | null;
  if (!toggle) throw new Error('the switch has not drawn yet');
  return toggle;
});
const puts = (calls: ReturnType<typeof open>['calls']) => calls
  .filter((c) => c.path === 'api/org/auto-approve' && c.init?.method === 'PUT')
  .map((c) => JSON.parse(String(c.init!.body)) as { on: boolean });

describe('auto-merge, each person\'s own (note #944)', () => {
  it('is off by default in the Workplace window, says what it does, and the header says nothing', async () => {
    open('/overview?org=o1&half=workplace');
    const toggle = await findSwitch();
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // A member flips their own: nothing disables it for want of a role.
    expect(toggle.disabled).toBe(false);
    expect(toggle.textContent).toContain(AUTO_APPROVE_SETTING_WORDS);
    expect(document.getElementById('homeAutoMergeState')!.textContent).toBe('Off · every proposal waits for you');
    expect(document.getElementById('recapAutoMerge')).toBeNull();
  });

  it('turning it on asks once more, then the header says Auto-merge on; off is not asked and the line goes', async () => {
    const { calls } = open('/overview?org=o1&half=workplace');
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(screen.getByText('Turn on auto-merge?')).toBeTruthy());
    expect(puts(calls)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(document.getElementById('homeAutoMergeSwitch')!.getAttribute('aria-checked')).toBe('true'));
    expect(puts(calls)).toEqual([{ on: true }]);
    expect(document.getElementById('homeAutoMergeState')!.textContent).toMatch(/^On · turned on /);
    await waitFor(() => expect(document.getElementById('recapAutoMerge')?.textContent).toBe('Auto-merge on'));

    fireEvent.click(document.getElementById('homeAutoMergeSwitch')!);
    await waitFor(() => expect(document.getElementById('homeAutoMergeSwitch')!.getAttribute('aria-checked')).toBe('false'));
    expect(puts(calls)).toEqual([{ on: true }, { on: false }]);
    await waitFor(() => expect(document.getElementById('recapAutoMerge')).toBeNull());
  });

  it('on, the Chief of Staff header says it in yellow under the model line', async () => {
    open('/', 'member', { on: true, changedAt: new Date().toISOString() });
    await waitFor(() => expect(document.getElementById('recapAutoMerge')?.textContent).toBe('Auto-merge on'));
    expect(document.getElementById('recapAutoMerge')!.className).toContain('automergeon');
  });

  it('words the state line from the record alone', () => {
    const now = Date.parse('2026-11-01T15:10:00Z');
    expect(autoMergeMeta({ on: false }, now)).toBe('Off · every proposal waits for you');
    expect(autoMergeMeta({ on: true, changedAt: '2026-11-01T15:02:00Z' }, now)).toBe('On · turned on 8m ago');
  });
});
