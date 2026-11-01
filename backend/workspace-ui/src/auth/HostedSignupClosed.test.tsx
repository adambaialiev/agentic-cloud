import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import type { WorkspaceApi } from '../api/client.js';
import { emptyState, scriptedApi, signedIn, signedOut, workspaceScript, type Call } from '../test/fixtures.js';

/**
 * Our own sign-up door while new sign-ups are closed (note #823, the owner,
 * 2026-10-28: only the private copy is offered). Walking up says so and
 * points at the private copy's page and hello@, with no form; an invite
 * link into an open workplace still opens the form and carries the link, so
 * the request to join goes with the account; and an account in no
 * workplace waits rather than founding one.
 */
vi.mock('../../../src/shared/private-copy.js', () => ({ PRIVATE_COPY: false, SIGNUP_CLOSED: true, FIRST_ACCOUNT_FRAGMENT: 'first-account' }));

const body = (call: Call) => JSON.parse(String(call.init?.body ?? '{}')) as Record<string, string>;
const PASSWORD = 'correct horse battery staple';

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} />
    </MemoryRouter>,
  );
}

describe('our sign-up door with SIGNUP_CLOSED (note #823)', () => {
  it('walking up points at the private copy and adam@, draws no form, and keeps sign-in one tap away', async () => {
    const { api, calls } = scriptedApi({ 'GET auth/session': signedOut });
    renderAt('/signup', api);
    expect(await screen.findByRole('heading', { name: 'Run it in your own cloud.' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New accounts are closed here' })).toBeTruthy();
    expect(screen.getByText(/^New accounts on our cloud are closed\. Instead, build your own Agentic Cloud/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See how to build your own Agentic Cloud' }).getAttribute('href')).toBe('https://agenticcloudcomputer.com/own-cloud');
    expect(screen.getByRole('link', { name: 'Write to adam@agenticcloudcomputer.com' }).getAttribute('href')).toBe('mailto:adam@agenticcloudcomputer.com');
    expect(screen.queryByLabelText('Choose your address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/unlimited|twenty agents|Leaderboard/i);
    fireEvent.click(screen.getByRole('button', { name: 'Already have an account? Sign in' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(calls.some((call) => call.path === 'auth/email/register')).toBe(false);
  });

  it('an invite link still opens the form, and the account carries the link to its request', async () => {
    let authenticated = false;
    const { api } = scriptedApi({
      ...workspaceScript(() => emptyState({
        org: null, organizations: [], canCreateOrg: false,
        joining: { requestId: 'req-1', inviteToken: 'tok-1', orgName: 'Markedco' },
      })),
      'GET auth/session': () => (authenticated ? signedIn() : signedOut()),
      'GET auth/invite/tok-1': () => ({ status: 'available' }),
      'GET auth/email/address?local=bea': () => ({ local: 'bea', address: 'bea@agenticcloudcomputer.com', available: true }),
      'POST auth/email/register': (call) => {
        expect(body(call)).toMatchObject({ mailbox: 'bea', inviteToken: 'tok-1' });
        authenticated = true;
        return { authenticated: true, address: 'bea@agenticcloudcomputer.com' };
      },
      'GET api/org/invites/tok-1': () => ({ status: 'pending', requestId: 'req-1', orgId: 'o-team', name: 'Markedco' }),
      'GET api/org/join-requests/req-1': () => ({ status: 'pending', requestId: 'req-1', orgId: 'o-team', name: 'Markedco' }),
    });
    renderAt('/invite/tok-1', api);
    const invite = await screen.findByText('Your invite link is ready');
    expect(invite.closest('#authInvite')!.textContent).toContain('your request to join goes with it');
    expect(screen.queryByText('New accounts are closed here')).toBeNull();
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Bea' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText('Choose your address'), { target: { value: 'bea' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PASSWORD } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up my own workplace instead' })).toBeNull();
  });

  it('an account in no workplace and not waiting is told how people get in, in our own words', async () => {
    const { api } = scriptedApi(workspaceScript(() => emptyState({ org: null, organizations: [], canCreateOrg: false })));
    renderAt('/', api);
    expect(await screen.findByRole('heading', { name: 'You’re not in a workplace yet' })).toBeTruthy();
    expect(screen.getByText(/People join a workplace here through an invite link/)).toBeTruthy();
    expect(screen.queryByText(/belongs to one company/)).toBeNull();
  });
});
