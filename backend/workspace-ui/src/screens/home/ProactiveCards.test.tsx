import { fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import { DEFAULT_WORKSPACE_AGENT_PROACTIVE, type WorkspaceAgentProactive, type WorkspaceAgentProactiveAnswer } from '../../../../src/shared/workspace-agent-proactive.js';
import { emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';

/**
 * Note #716: the Chief of Staff on its own, on its details in the Workplace
 * window — the switch for event turns, the waits and quiet hours under it,
 * the standing permissions, and what it noticed lately.
 */
const state = emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 0, seatProviders: [] },
});
const details = {
  orgId: 'o1', agentId: 'workspace-1',
  agent: { name: 'Workspace Agent', started: true, working: false, waiting: [] },
  settings: { cli: 'claude' as const, model: 'opus', effort: 'high' },
  machine: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 },
};

function setup(initial: Partial<WorkspaceAgentProactive> = {}, recent: WorkspaceAgentProactiveAnswer['recent'] = []) {
  let stored: WorkspaceAgentProactive = { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE, ...initial };
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/recap/agent': () => details,
    'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: details.settings, models: [] }),
    'GET api/recap/chat': () => ({ orgId: 'o1', messages: [], working: false, waiting: [] }),
    'GET api/recap/agent/proactive': () => ({ orgId: 'o1', settings: stored, recent }),
    'PUT api/recap/agent/proactive': (call) => {
      const change = JSON.parse(String(call.init?.body)) as Partial<WorkspaceAgentProactive>;
      stored = {
        ...stored, ...change,
        thresholds: { ...stored.thresholds, ...change.thresholds },
        permissions: { ...stored.permissions, ...change.permissions },
      };
      return { orgId: 'o1', settings: stored, recent };
    },
  });
  render(<MemoryRouter initialEntries={['/overview?org=o1&half=workplace']}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
const puts = (calls: ReturnType<typeof setup>['calls']) => calls.filter((c) => c.path === 'api/recap/agent/proactive' && c.init?.method === 'PUT').map((c) => JSON.parse(String(c.init!.body)) as Record<string, unknown>);

describe('the Chief of Staff on its own (note #716)', () => {
  it('starts off: one switch that says what turning it on means, and nothing else to set', async () => {
    setup();
    await waitFor(() => expect(document.getElementById('recapEventTurns')).toBeTruthy());
    const toggle = document.getElementById('recapEventTurns')!;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Off · it runs only when you write or an agent answers it');
    expect(document.getElementById('recapProactiveHint')!.textContent).toContain('tells you only when something needs you');
    expect(document.getElementById('recapPermissionsCard')).toBeNull();
    expect(document.getElementById('recapWaitProposal')).toBeNull();
  });

  it('turning it on sends the reader\'s own time zone, and opens the waits, quiet hours and standing permissions', async () => {
    const { calls } = setup();
    await waitFor(() => expect(document.getElementById('recapEventTurns')).toBeTruthy());
    fireEvent.click(document.getElementById('recapEventTurns')!);
    await waitFor(() => expect(document.getElementById('recapEventTurns')!.getAttribute('aria-checked')).toBe('true'));
    expect(puts(calls)[0]).toEqual({ events: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(document.getElementById('recapEventTurns')!.textContent).toContain('On · quiet 23:00–08:00, except red checks and failed turns');
    expect((document.getElementById('recapWaitProposal') as HTMLSelectElement).value).toBe('24');
    expect((document.getElementById('recapWaitNote') as HTMLSelectElement).value).toBe('48');
    const permissions = document.getElementById('recapPermissionsCard')!;
    expect([...permissions.querySelectorAll('[role="switch"]')].map((row) => [row.querySelector('.name')!.textContent, row.getAttribute('aria-checked')])).toEqual([
      ['Reset a finished agent’s chat', 'false'],
      ['Hand an unclaimed note to a free agent', 'false'],
      ['Ask a silent agent to report', 'false'],
      ['Archive a finished note', 'false'],
    ]);
    fireEvent.click(document.getElementById('recapPermission-hand-unclaimed-note')!);
    await waitFor(() => expect(document.getElementById('recapPermission-hand-unclaimed-note')!.getAttribute('aria-checked')).toBe('true'));
    expect(puts(calls)[1]).toMatchObject({ permissions: { 'hand-unclaimed-note': true } });
    fireEvent.change(document.getElementById('recapWaitNote')!, { target: { value: '72' } });
    await waitFor(() => expect((document.getElementById('recapWaitNote') as HTMLSelectElement).value).toBe('72'));
    expect(puts(calls)[2]).toMatchObject({ thresholds: { noteHours: 72 } });
    fireEvent.change(document.getElementById('recapQuietFrom')!, { target: { value: '22' } });
    await waitFor(() => expect(document.getElementById('recapEventTurns')!.textContent).toContain('quiet 22:00–08:00'));
  });

  it('lists what it noticed lately and what came of it, quiet turns included', async () => {
    setup({ events: true, timeZone: 'Asia/Bishkek' }, [
      { at: new Date(Date.now() - 2 * 60_000).toISOString(), noticed: ['Checks failed on proposal #4 "Booking page" by Theo: ci/checks.', 'x'], outcome: 'told', actions: 1, summary: 'Checks failed on #4.' },
      { at: new Date(Date.now() - 3 * 3_600_000).toISOString(), noticed: ['Note #12 "Pricing" has been unclaimed for 2 days.'], outcome: 'quiet', actions: 0, summary: 'It is a reference note, not a request.' },
    ]);
    await waitFor(() => expect(document.getElementById('recapNoticedCard')).toBeTruthy());
    const rows = [...document.getElementById('recapNoticedCard')!.querySelectorAll('.row')].map((row) => row.textContent);
    expect(rows[0]).toContain('Checks failed on proposal #4 "Booking page" by Theo: ci/checks. (+1 more)');
    expect(rows[0]).toContain('Told you in its chat · 1 action');
    expect(rows[1]).toContain('Kept quiet: It is a reference note, not a request.');
    expect(document.getElementById('recapProactiveHint')!.textContent).toContain('Times are Asia/Bishkek.');
  });
});
