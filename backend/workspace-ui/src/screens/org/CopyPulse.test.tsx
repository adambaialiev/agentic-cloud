import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCopyPulse, WorkspaceOrgDetail } from '../../../../src/shared/workspace-api.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * "What we tell Agentic Cloud" (note #1057): the copy's daily report as its
 * admin sees it — the contact person, the off switch, and the last report
 * exactly as sent.
 */
vi.mock('../../../../src/shared/private-copy.js', () => ({ PRIVATE_COPY: true, SIGNUP_CLOSED: false, FIRST_ACCOUNT_FRAGMENT: 'first-account' }));

const BODY = JSON.stringify({ copyId: 'abcdefghabcdefghabcdefgh', domain: 'agents.theirco.test', contactName: 'Theirco IT', contactEmail: 'it@theirco.test', reason: 'daily', people: 4 });
const base = (): WorkspaceCopyPulse => ({
  copyId: 'abcdefghabcdefghabcdefgh',
  contactName: 'Theirco IT',
  contactEmail: 'it@theirco.test',
  contactFrom: 'install',
  pulseEnabled: true,
  licenceKeepsOn: false,
  sendsTo: 'https://api.agenticcloudcomputer.com/api/copy-pulse',
  lastPulse: { body: BODY, sentAt: new Date(Date.now() - 3_600_000).toISOString(), reason: 'daily', delivered: true },
  lastDeliveredAt: new Date(Date.now() - 3_600_000).toISOString(),
  nextDailyAt: new Date(Date.now() + 3_600_000).toISOString(),
});

const detail = (role: 'admin' | 'member'): WorkspaceOrgDetail => ({
  orgId: 'o1', name: 'Theirco', role, invites: [], joinRequests: [],
  fly: { connected: false, hosted: true, agents: { used: 0, limit: 20 }, sites: { used: 0, limit: 30 } },
  members: [{ userId: 'u1', name: 'Ada', you: true, role, joinedAt: '2026-10-27T00:00:00Z', agents: 0, workedMs: 0 }],
});

async function open(role: 'admin' | 'member', pulse: WorkspaceCopyPulse) {
  vi.useFakeTimers();
  let current = pulse;
  const org = { orgId: 'o1', name: 'Theirco', role, members: 2, seats: 0, seatProviders: [] };
  const state = () => emptyState({
    org, canCreateOrg: true,
    organizations: [{ orgId: 'o1', name: 'Theirco', role, active: true, members: 2, agents: 0 }],
  });
  const script: Record<string, Answer> = {
    ...workspaceScript(state),
    'GET api/org': () => ({ org: detail(role) }),
    'GET api/copy/pulse': () => current,
    'POST api/copy/pulse/contact': (call) => {
      const { name, email } = JSON.parse(String(call.init?.body));
      current = { ...current, contactName: name, contactEmail: email, contactFrom: 'admin', lastPulse: { ...current.lastPulse!, reason: 'contact-changed' } };
      return current;
    },
    'POST api/copy/pulse/enabled': (call) => {
      const { on } = JSON.parse(String(call.init?.body));
      current = { ...current, pulseEnabled: on, lastPulse: { ...current.lastPulse!, reason: 'contact-changed' } };
      return current;
    },
  };
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={['/workplace?org=o1']}><App api={scripted.api} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  return scripted;
}

afterEach(() => { vi.useRealTimers(); });

describe('What we tell Agentic Cloud (note #1057)', () => {
  it('says what is sent in plain words, who the contact is, and when it last went', async () => {
    await open('admin', base());
    expect(screen.getByText('What we tell Agentic Cloud')).toBeTruthy();
    const about = document.querySelector('#orgCopyPulseAbout')!.textContent!;
    expect(about).toContain('Counts only');
    expect(about).toContain('on purpose');
    expect(document.querySelector('#orgCopyPulseContact')!.textContent).toContain('Theirco IT · it@theirco.test');
    expect(document.querySelector('#orgCopyPulseLast')!.textContent).toContain('the daily report. Delivered.');
    expect(document.querySelector('#orgCopyPulseSwitch')!.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the last report exactly as sent, on request', async () => {
    await open('admin', base());
    expect(document.querySelector('#orgCopyPulseBody')).toBeNull();
    await act(async () => { fireEvent.click(document.querySelector('#orgCopyPulseShow')!); });
    const shown = document.querySelector('#orgCopyPulseBody')!.textContent!;
    expect(JSON.parse(shown)).toEqual(JSON.parse(BODY));
  });

  it('changes the contact', async () => {
    const scripted = await open('admin', base());
    await act(async () => { fireEvent.click(document.querySelector('#orgCopyPulseContact')!); });
    fireEvent.change(document.querySelector('#orgCopyPulseName')!, { target: { value: 'Ops desk' } });
    fireEvent.change(document.querySelector('#orgCopyPulseEmail')!, { target: { value: 'ops@theirco.test' } });
    await act(async () => { fireEvent.click(document.querySelector('#orgCopyPulseSave')!); await vi.advanceTimersByTimeAsync(20); });
    const call = scripted.calls.find((c) => c.path === 'api/copy/pulse/contact' && c.init?.method === 'POST');
    expect(JSON.parse(String(call?.init?.body))).toEqual({ name: 'Ops desk', email: 'ops@theirco.test' });
    expect(document.querySelector('#orgCopyPulseContact')!.textContent).toContain('Ops desk · ops@theirco.test');
  });

  it('turns the report off, and says one last report told Agentic Cloud so', async () => {
    await open('admin', base());
    await act(async () => { fireEvent.click(document.querySelector('#orgCopyPulseSwitch')!); await vi.advanceTimersByTimeAsync(20); });
    const row = document.querySelector('#orgCopyPulseSwitch')!;
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(row.textContent).toContain('One last report told Agentic Cloud so');
  });

  it('with the licence on, the switch stays on and cannot be turned off', async () => {
    await open('admin', { ...base(), licenceKeepsOn: true, pulseEnabled: false });
    const row = document.querySelector('#orgCopyPulseSwitch') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(row.textContent).toContain('Your licence includes the daily report');
  });

  it('says plainly when the last report did not arrive', async () => {
    await open('admin', { ...base(), lastPulse: { body: BODY, sentAt: new Date().toISOString(), reason: 'boot', delivered: false, error: 'not reachable' } });
    expect(document.querySelector('#orgCopyPulseLast')!.textContent).toContain('Not delivered: not reachable');
  });

  it('is not there for a member', async () => {
    await open('member', base());
    expect(document.querySelector('#orgCopyPulse')).toBeNull();
  });
});
