import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../App.js';
import { WorkspaceApiError } from '../api/client.js';
import { emptyState, homeShelf, scriptedApi, signedOut, workspaceScript, type Answer, type Call } from '../test/fixtures.js';
import type { WorkspaceStateAnswer } from '../../../src/shared/workspace-api.js';

/**
 * Choosing your own address (note #509): the field on the signup form, and
 * the card in Settings every account that predates addresses picks one from.
 */

const PASSWORD = 'a-long-enough-password';
const org = { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 1, seats: 0, seatProviders: [] };
const body = (call: Call) => JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
const account = (mailbox?: { address: string }): Partial<WorkspaceStateAnswer> => ({
  user: {
    name: 'Saddam',
    profile: { firstName: 'Saddam', lastName: 'B', incomplete: false },
    account: {
      browserLogin: { enabled: true, method: 'email', email: 'saddam@example.com', secondFactorEnabled: false, verificationStatus: 'verified' },
      ...(mailbox ? { mailbox } : {}),
    },
  },
});

function renderAt(path: string, script: Record<string, Answer>) {
  const scripted = scriptedApi(script);
  render(<MemoryRouter initialEntries={[path]}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

describe('signing up IS choosing your address', () => {
  it('asks for a name and a password, then opens the Workspace with no email anywhere', async () => {
    const { api, calls } = scriptedApi({
      ...workspaceScript(() => emptyState({ org, ...account({ address: 'adam.b@agenticcloudcomputer.com' }) })),
      'GET auth/session': (() => { let signedIn = false; return () => { if (!signedIn) { signedIn = true; return signedOut(); } return { authenticated: true, username: 'adam.b@agenticcloudcomputer.com', displayName: 'adam.b', session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' } }; }; })(),
      'GET auth/email/address?local=adam.b': () => ({ local: 'adam.b', address: 'adam.b@agenticcloudcomputer.com', available: true }),
      'POST auth/email/register': (call) => {
        expect(body(call)).toEqual({ mailbox: 'adam.b', password: PASSWORD, firstName: 'Adam', lastName: 'Bell' });
        return { authenticated: true, address: 'adam.b@agenticcloudcomputer.com' };
      },
    });
    render(<MemoryRouter initialEntries={['/signup']}><App api={api} /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    // Nothing asks for an address somebody else hosts.
    expect(screen.queryByLabelText('Email')).toBeNull();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Adam' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Bell' } });
    fireEvent.change(screen.getByLabelText('Choose your address'), { target: { value: 'adam.b' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PASSWORD } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    // Straight into the Workspace: there is no confirmation to wait for.
    await waitFor(() => expect(calls.some((call) => call.path === 'auth/email/register')).toBe(true));
    await homeShelf();
    expect(document.body.classList.contains('browser-authenticated')).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Check your email' })).toBeNull();
  });

  it('will not send the form until the name is free', async () => {
    const { api, calls } = scriptedApi({
      'GET auth/session': signedOut,
      'GET auth/email/address?local=adam': () => ({ local: 'adam', address: 'adam@agenticcloudcomputer.com', available: false }),
    });
    render(<MemoryRouter initialEntries={['/signup']}><App api={api} /></MemoryRouter>);

    const create = () => screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement;
    // Off before a name is typed at all, and off again once one is taken.
    expect((await screen.findByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Choose your address'), { target: { value: 'adam' } });
    await waitFor(() => expect(screen.getByText('That name is taken. Try another.')).toBeTruthy());
    expect(create().disabled).toBe(true);
    expect(calls.some((call) => call.path === 'auth/email/register')).toBe(false);
  });

  it('refuses a reserved name in the browser, without asking the server whether it is free', async () => {
    const { api, calls } = scriptedApi({ 'GET auth/session': signedOut });
    render(<MemoryRouter initialEntries={['/signup']}><App api={api} /></MemoryRouter>);

    fireEvent.change(await screen.findByLabelText('Choose your address'), { target: { value: 'postmaster' } });
    await waitFor(() => expect(screen.getByText('That name is kept for the platform. Choose another.')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((call) => call.path.startsWith('auth/email/address'))).toBe(false);
  });

  it('signs an older account in with the outside email it was made with', async () => {
    const { api, calls } = scriptedApi({
      'GET auth/session': signedOut,
      'POST auth/email/login': (call) => {
        expect(body(call)).toEqual({ email: 'older@example.com', password: PASSWORD });
        return { authenticated: false, verificationRequired: true };
      },
    });
    render(<MemoryRouter initialEntries={['/']}><App api={api} /></MemoryRouter>);

    // The sign-in field takes a name here or an outside email; `type=email`
    // would have refused the bare name before the form was ever sent.
    const field = await screen.findByLabelText('Email') as HTMLInputElement;
    expect(field.type).toBe('text');
    fireEvent.change(field, { target: { value: 'older@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'auth/email/login')).toBe(true));
  });
});

describe('the address card in Settings', () => {
  it('shows the address a person already has', async () => {
    renderAt('/profile', {
      ...workspaceScript(() => emptyState({ org, ...account({ address: 'adam@agenticcloudcomputer.com' }) })),
    });
    expect(await screen.findByText('adam@agenticcloudcomputer.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose' })).toBeNull();
    // Nothing answered `api/mail/wake` here, so the card offers no choice at
    // all rather than a row that cannot say what it is doing (slice 11).
    expect(screen.queryByText('When mail arrives, wake')).toBeNull();
  });

  it('claims one for an account that signed up before addresses existed', async () => {
    let mailbox: { address: string } | undefined;
    const { calls } = renderAt('/profile', {
      ...workspaceScript(() => emptyState({ org, ...account(mailbox) })),
      'GET auth/email/address?local=adam': () => ({ local: 'adam', address: 'adam@agenticcloudcomputer.com', available: true }),
      'POST api/mail/address': (call) => {
        expect(body(call)).toEqual({ local: 'adam' });
        mailbox = { address: 'adam@agenticcloudcomputer.com' };
        return { mailbox };
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /Choose your address/ }));
    fireEvent.change(screen.getByLabelText('Choose your address'), { target: { value: 'adam' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Take this address' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Take this address' }));

    await waitFor(() => expect(calls.some((call) => call.path === 'api/mail/address')).toBe(true));
    // The card reads the new address back from the state, not from the form.
    expect(await screen.findByText('adam@agenticcloudcomputer.com')).toBeTruthy();
  });

  it('keeps the form open and says why when the name was taken in between', async () => {
    renderAt('/profile', {
      ...workspaceScript(() => emptyState({ org, ...account() })),
      'GET auth/email/address?local=adam': () => ({ local: 'adam', address: 'adam@agenticcloudcomputer.com', available: true }),
      'POST api/mail/address': () => { throw new WorkspaceApiError('That address is already taken. Choose another name.', 409, { code: 'mailbox_taken' }); },
    });

    fireEvent.click(await screen.findByRole('button', { name: /Choose your address/ }));
    fireEvent.change(screen.getByLabelText('Choose your address'), { target: { value: 'adam' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Take this address' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Take this address' }));

    expect((await screen.findByRole('alert')).textContent).toContain('That address is already taken.');
    expect(screen.getByLabelText('Choose your address')).toBeTruthy();
  });
});
