import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import type { WorkspaceApi } from '../api/client.js';
import { emptyState, scriptedApi, signedIn, signedOut, workspaceScript, type Call } from '../test/fixtures.js';

/**
 * A private copy's door (note #808): no open sign-up. Walking up to it says
 * accounts come with an invite; the installer's first-account code opens the
 * form once; and an account made from an invite link carries the link, so
 * its request to join is filed with it and there is no spare workplace.
 */
vi.mock('../../../src/shared/private-copy.js', () => ({ PRIVATE_COPY: true, SIGNUP_CLOSED: false, FIRST_ACCOUNT_FRAGMENT: 'first-account' }));

const body = (call: Call) => JSON.parse(String(call.init?.body ?? '{}')) as Record<string, string>;
const PASSWORD = 'correct horse battery staple';

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} />
    </MemoryRouter>,
  );
}

async function fillAccount() {
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Bea' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Copy' } });
  fireEvent.change(screen.getByLabelText('Choose your address'), { target: { value: 'bea' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PASSWORD } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('a private copy’s sign-up door (note #808)', () => {
  it('walking up says accounts come with an invite, draws no form, and keeps sign-in one tap away', async () => {
    const { api, calls } = scriptedApi({ 'GET auth/session': signedOut });
    renderAt('/signup', api);
    expect(await screen.findByRole('heading', { name: 'Accounts here come with an invite.' })).toBeTruthy();
    expect(screen.getByText(/Ask an admin of your workplace for its invite link/)).toBeTruthy();
    expect(screen.queryByLabelText('Choose your address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Already have an account? Sign in' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(calls.some((call) => call.path === 'auth/email/register')).toBe(false);
  });

  it('the installer’s first-account link opens the form and sends its code, out of the address bar', async () => {
    window.history.replaceState(null, '', '/signup#first-account=the-installers-code-123');
    let authenticated = false;
    const { api } = scriptedApi({
      ...workspaceScript(() => emptyState()),
      'GET auth/session': () => (authenticated ? signedIn() : signedOut()),
      'GET auth/email/address?local=bea': () => ({ local: 'bea', address: 'bea@agenticcloudcomputer.com', available: true }),
      'POST auth/email/register': (call) => {
        expect(body(call)).toMatchObject({ mailbox: 'bea', firstAccountCode: 'the-installers-code-123' });
        expect(body(call)).not.toHaveProperty('inviteToken');
        authenticated = true;
        return { authenticated: true, address: 'bea@agenticcloudcomputer.com' };
      },
    });
    renderAt('/signup', api);
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    // Note #828: the first admin is told the computers run in the company's
    // own cloud account, already connected, never our hosted "free, no
    // cloud account to connect", and no word "copy" reaches them.
    const needs = document.getElementById('authNeeds')!.textContent ?? '';
    expect(needs).toContain('Your agents’ computers run in your company’s own cloud account, which pays for them. It was connected when your Agentic Cloud was installed.');
    expect(needs).not.toMatch(/free|no cloud account to connect|\bcopy\b/i);
    await fillAccount();
    await waitFor(() => expect(authenticated).toBe(true));
    window.history.replaceState(null, '', '/');
  });

  it('an account made from an invite carries the link and lands on its request, with no workplace to escape to', async () => {
    let authenticated = false;
    const waiting = () => emptyState({
      org: null,
      organizations: [],
      canCreateOrg: false,
      joining: { requestId: 'req-1', inviteToken: 'tok-1', orgName: 'Theirco' },
    });
    const { api } = scriptedApi({
      ...workspaceScript(waiting),
      'GET auth/session': () => (authenticated ? signedIn() : signedOut()),
      'GET auth/invite/tok-1': () => ({ status: 'available' }),
      'GET auth/email/address?local=bea': () => ({ local: 'bea', address: 'bea@agenticcloudcomputer.com', available: true }),
      'POST auth/email/register': (call) => {
        expect(body(call)).toMatchObject({ mailbox: 'bea', inviteToken: 'tok-1' });
        authenticated = true;
        return { authenticated: true, address: 'bea@agenticcloudcomputer.com' };
      },
      'GET api/org/invites/tok-1': () => ({ status: 'pending', requestId: 'req-1', orgId: 'o-team', name: 'Theirco' }),
      'GET api/org/join-requests/req-1': () => ({ status: 'pending', requestId: 'req-1', orgId: 'o-team', name: 'Theirco' }),
    });
    renderAt('/invite/tok-1', api);
    const invite = await screen.findByText('Your invite link is ready');
    expect(invite.closest('#authInvite')!.textContent).toContain('your request to join goes with it');
    await fillAccount();
    // The request went with the account: the page is already waiting, with
    // nothing to press and no workplace of their own to set up instead.
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request to join' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up my own workplace instead' })).toBeNull();
  });

  it('holds a newcomer with no workplace on their request wherever they go', async () => {
    const { api } = scriptedApi({
      ...workspaceScript(() => emptyState({
        org: null, organizations: [], canCreateOrg: false,
        joining: { requestId: 'req-1', inviteToken: 'tok-1', orgName: 'Theirco' },
      })),
      'GET api/org/join-requests/req-1': () => ({ status: 'pending', requestId: 'req-1', orgId: 'o-team', name: 'Theirco' }),
    });
    renderAt('/', api);
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(document.getElementById('screenHome')).toBeNull();
  });

  it('an account in no workplace and not waiting (declined, or removed) is told how people get in, not shown an empty Workspace', async () => {
    const { api } = scriptedApi(workspaceScript(() => emptyState({ org: null, organizations: [], canCreateOrg: false })));
    renderAt('/', api);
    expect(await screen.findByRole('heading', { name: 'You’re not in a workplace yet' })).toBeTruthy();
    expect(screen.getByText(/Ask an admin of your workplace for the link/)).toBeTruthy();
    expect(screen.queryByText('Write a note')).toBeNull();
    expect(screen.queryByText('Add a secret')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
