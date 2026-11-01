import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { WorkspaceSessionAnswer, WorkspaceStateAnswer } from '../../src/shared/workspace-api.js';
import { WORKSPACE_ROUTE_KINDS, workspaceRoutePath } from '../../src/shared/workspace-routes.js';
import { App } from './App.js';
import { WorkspaceApiError, type WorkspaceApi } from './api/client.js';
import { emptyState, homeShelf, scriptedApi, signedIn, signedOut, workspaceScript, type Call } from './test/fixtures.js';
import { WAIT_QUIET_MS } from './ui/wait.js';
import { FIRST_VISIT_KEY } from '../../src/shared/first-visit.js';

/**
 * The door and the router, end to end against a scripted API: the same
 * flows docs/standalone-workspace-web-app.md lists under "Browser flows",
 * driven the way a person drives them — typing, tapping, reading what the
 * screen says next.
 */

const body = (call: Call) => JSON.parse(String(call.init?.body ?? '{}')) as Record<string, string>;
const PASSWORD = 'correct horse battery staple';

/** The Workspace reads that follow a sign-in, minus the session read itself. */
function quietReads() {
  const reads = workspaceScript(() => emptyState());
  delete reads['GET auth/session'];
  return reads;
}

/** A session that flips to signed-in once a sign-in door has been used,
 *  and the quiet Workspace reads that follow. */
function sessionScript() {
  let authenticated = false;
  return {
    signIn() { authenticated = true; },
    signOut() { authenticated = false; },
    session: () => (authenticated ? signedIn() : signedOut()),
    ...quietReads(),
  };
}

/** Home has no title; its first section heading is the sign that it opened. */
const findHome = () => homeShelf();

function renderAt(path: string, api: WorkspaceApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} />
    </MemoryRouter>,
  );
}

describe('the door', () => {
  it('shows sign-in when nobody is signed in, and the Workspace once they are', async () => {
    const state = sessionScript();
    const { api, calls } = scriptedApi({
      ...state,
      'GET auth/session': state.session,
      'POST auth/email/login': (call) => {
        expect(body(call)).toEqual({ email: 'saddam@example.com', password: PASSWORD });
        state.signIn();
        return { authenticated: true };
      },
    });
    renderAt('/', api);
    const field = await screen.findByLabelText('Email') as HTMLInputElement;
    // Note #562: no example name in the box, and the door offers neither a
    // new Workspace nor the authenticator login — only the way back in.
    expect(field.placeholder).toBe('');
    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use an existing authenticator login' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Forgot your password?' })).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Saddam@Example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await findHome();
    expect(document.body.classList.contains('browser-authenticated')).toBe(true);
    // The truth came from the session read, not from the login call alone.
    expect(calls.filter((call) => call.path === 'auth/session')).toHaveLength(2);
  });

  it('says what went wrong and lets the person try again', async () => {
    const { api } = scriptedApi({
      'GET auth/session': signedOut,
      'POST auth/email/login': () => { throw new WorkspaceApiError('Invalid name or password.', 400, {}); },
    });
    renderAt('/', api);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'saddam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid name or password.');
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not offer a way back from the forgotten-password screen', async () => {
    const { api } = scriptedApi({ 'GET auth/session': signedOut });
    renderAt('/', api);

    fireEvent.click(await screen.findByRole('button', { name: 'Forgot your password?' }));

    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to sign in' })).toBeNull();
  });

  it.each([false, true])('creates an account from an address here and keeps the invite link: %s', async (fromInvite) => {
    const inviteToken = 'register-link-token-123';
    // Where this browser first came from rides along when it has a record
    // (shared/first-visit.ts); one variant has one, the other none.
    const firstVisit = { from: 't.co', page: '/', at: '2026-10-09T08:00:00.000Z' };
    window.localStorage.removeItem(FIRST_VISIT_KEY);
    if (fromInvite) window.localStorage.setItem(FIRST_VISIT_KEY, JSON.stringify(firstVisit));
    const state = sessionScript();
    // Held until the button has been seen saying what it is doing.
    let release!: () => void;
    const made = new Promise<void>((resolve) => { release = resolve; });
    const { api } = scriptedApi({
      ...state,
      'GET auth/session': state.session,
      [`GET auth/invite/${inviteToken}`]: () => ({ status: 'available' }),
      [`GET api/org/invites/${inviteToken}`]: () => ({ status: 'available', orgId: 'o1', name: 'Nomad' }),
      'GET auth/email/address?local=new.person': () => ({ local: 'new.person', address: 'new.person@agenticcloudcomputer.com', available: true }),
      'POST auth/email/register': (call) => {
        // No outside email is collected, and no invite rides the body: the
        // person stays on the invite's own address while they sign up.
        expect(body(call)).toEqual({
          mailbox: 'new.person', password: PASSWORD, firstName: 'Aigerim', lastName: 'Baialieva',
          ...(fromInvite ? { firstVisit } : {}),
        });
        return made.then(() => {
          state.signIn();
          return { authenticated: true, address: 'new.person@agenticcloudcomputer.com' };
        });
      },
    });
    renderAt(fromInvite ? `/invite/${inviteToken}` : '/signup', api);
    if (fromInvite) {
      const invite = await screen.findByText('Your invite link is ready');
      expect(invite.closest('#authInvite')!.classList.contains('authinvite')).toBe(true);
      expect(document.querySelector('.join-entry-steps')).toBeNull();
      // A join link opens on sign-up, and says so: nothing to tap first.
      expect(invite.closest('#authInvite')!.textContent).toContain('Create your account below, then send your request.');
    }
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Agentic Cloud Computer' })).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use an existing authenticator login' })).toBeNull();
    if (fromInvite) {
      // A joiner walks into a workplace that is already set up.
      expect(document.getElementById('authNeeds')).toBeNull();
    } else {
      const needs = screen.getByText('After you create your account').closest('#authNeeds')!;
      expect(needs.textContent).not.toMatch(/room/i);
      // One thing to bring now (note #664): agents' computers run on our
      // cloud, so there is no Fly account to connect first.
      const subscription = screen.getByText('Sign in Codex or Claude');
      const nothingElse = screen.getByText('Nothing else');
      expect(subscription.compareDocumentPosition(nothingElse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(needs.textContent).not.toMatch(/Fly/);
    }
    // Their name comes first (note #144): it is what the Workspace Agent
    // calls them on the next screen.
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Aigerim ' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Baialieva' } });
    fireEvent.change(screen.getByLabelText('Choose your address'), { target: { value: 'new.person' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PASSWORD } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    // A wait that says what it is waiting for (2026-09-22).
    expect(((await screen.findByRole('button', { name: 'Creating your account…' })) as HTMLButtonElement).disabled).toBe(true);
    release();

    // Signed in at once. From an invite that means its join screen, not Home.
    if (fromInvite) await screen.findByRole('button', { name: 'Request to join' });
    else await findHome();
    window.localStorage.removeItem(FIRST_VISIT_KEY);
  });

  it('keeps an unverified password login outside and delays a uniform resend', async () => {
    const { api, calls } = scriptedApi({
      'GET auth/session': signedOut,
      'POST auth/email/login': () => ({ authenticated: false, verificationRequired: true }),
      'POST auth/email/resend': () => ({ accepted: true }),
    });
    renderAt('/', api);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'pending@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send again' }));
    expect((await screen.findByRole('status')).textContent).toContain('If this address is awaiting confirmation');
    expect(calls.some((call) => call.path === 'auth/email/resend')).toBe(true);
    expect((screen.getByRole('button', { name: 'Send again in 1:00' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('pending@example.com')).toBeTruthy();
    expect(screen.getByText('Didn’t receive it? Check spam or junk.')).toBeTruthy();
    // Back to the sign-in panel, not to account creation: this waiting room is
    // reached by an older account signing in, and creating one no longer
    // involves an outside address at all.
    fireEvent.click(screen.getByRole('button', { name: 'Change email address' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('pending@example.com');
  });

  it('consumes a fragment confirmation without leaving the bearer in browser history', async () => {
    window.location.hash = 'token=confirmation-token';
    const { api, calls } = scriptedApi({
      'GET auth/session': signedOut,
      'POST auth/email/verify': (call) => {
        expect(body(call)).toEqual({ token: 'confirmation-token' });
        return { verified: true, authenticated: true };
      },
    });
    renderAt('/verify-email', api);
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(calls.filter((call) => call.path === 'auth/email/verify')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Continue to Workspace' })).toBeTruthy();
  });

  it('gently prompts a grandfathered account without blocking its Workspace', async () => {
    const baseSession = signedIn('owner@example.com');
    if (!baseSession.authenticated) throw new Error('signed-in fixture is not signed in');
    const legacySession: WorkspaceSessionAnswer = {
      ...baseSession,
      emailVerification: { email: 'owner@example.com', status: 'legacy' },
    };
    const { api, calls } = scriptedApi({
      ...workspaceScript(() => emptyState()),
      'GET auth/session': () => legacySession,
      'POST auth/email/resend': () => ({ accepted: true }),
    });
    renderAt('/', api);
    await findHome();
    expect(screen.getByText('Your access stays unchanged. Confirm when convenient so this address is known to be yours.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'auth/email/resend')).toBe(true));
    expect(screen.getByRole('button', { name: 'Link requested' })).toBeTruthy();
  });

  it('shows a waiting joiner their request instead of the workplace their account came with', async () => {
    window.sessionStorage.clear();
    const state = () => emptyState({
      org: {
        orgId: 'o-spare', name: 'Leo’s workplace', role: 'admin', members: 1,
        seats: 0, seatProviders: [], unnamed: true,
      },
      organizations: [{ orgId: 'o-spare', name: 'Leo’s workplace', role: 'admin', active: true, members: 1, agents: 0 }],
      canCreateOrg: true,
      joining: { requestId: 'req-1', inviteToken: 'join_token_of_the_team_link', orgName: 'Northstar Studio' },
    });
    const { api } = scriptedApi({
      ...workspaceScript(state),
      'GET api/org/join-requests/req-1': () => ({ orgId: 'o-team', name: 'Northstar Studio', requestId: 'req-1', status: 'pending' }),
    });
    renderAt('/?org=o-spare', api);

    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(document.getElementById('screenHome')).toBeNull();
    // …and their own workplace is one tap away if that is what they want:
    // Home — the Chief of Staff's conversation — at once, with no gate in
    // front of it (note #726).
    fireEvent.click(await screen.findByRole('button', { name: 'Set up my own workplace instead' }));
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    expect(document.getElementById('requiredSetup')).toBeNull();
    window.sessionStorage.clear();
  });

  it('opens a brand-new workplace on Home at once: no subscription, no agents, and nothing in front of it (note #726)', async () => {
    // The workplace an account comes with, as the server answers it since
    // note #726: the account default for a name, no plan signed in, and
    // nothing furnished — the Chief of Staff's conversation is the first
    // and only thing the person sees.
    const state = () => emptyState({
      org: {
        orgId: 'o-new', name: 'Sam’s workplace', role: 'admin', members: 1,
        seats: 0, seatProviders: [], unnamed: true,
      },
      organizations: [{ orgId: 'o-new', name: 'Sam’s workplace', role: 'admin', active: true, members: 1, agents: 0 }],
      canCreateOrg: true,
    });
    const { api, calls } = scriptedApi(workspaceScript(state));
    renderAt('/', api);

    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    expect(document.getElementById('recapChatTitle')!.textContent).toBe('Chief of Staff');
    // No gate, no naming form, no arriving screen, no step addresses.
    expect(document.getElementById('requiredSetup')).toBeNull();
    expect(document.getElementById('teamArriving')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sign in a subscription' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your team is arriving' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Name your workplace' })).toBeNull();
    // Nothing is written on the way in — no naming, no stepping in, no
    // cloud — and the state is read, not polled, for a founding moment.
    expect(calls.some((call) => call.path === 'api/org/name' || call.path === 'api/org/arrived')).toBe(false);
    expect(calls.some((call) => call.path === 'api/org/fly')).toBe(false);
    expect(screen.queryByLabelText('Org deploy token')).toBeNull();
    // (The greeting, the starters and the sign-in card are the chat's own
    // tests, where a transcript is scripted: RecapChatScreen.test.tsx.)
  });

  it('holds no address of a bare workplace back — a member included (note #726)', async () => {
    const state = () => emptyState({
      org: {
        orgId: 'o-shared', name: 'Shared Studio', role: 'member', members: 4,
        seats: 0, seatProviders: [],
      },
      organizations: [{ orgId: 'o-shared', name: 'Shared Studio', role: 'member', active: true, members: 4, agents: 0 }],
      secrets: [],
    });
    const { api, calls } = scriptedApi(workspaceScript(state));
    renderAt('/secrets?org=o-shared', api);

    await waitFor(() => expect(document.getElementById('screenSecrets')).toBeTruthy());
    expect(document.getElementById('requiredSetup')).toBeNull();
    expect(document.getElementById('appLoadingSkeleton')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sign in a subscription' })).toBeNull();
    expect(calls.some((call) => call.path.startsWith('api/org/cloud'))).toBe(false);
  });

  it('lets a person with several workplaces switch out of a bare one from Home’s own header (notes #653, #726)', async () => {
    let active = 'o-new';
    const state = () => (active === 'o-new'
      ? emptyState({
        org: {
          orgId: 'o-new', name: 'New Company', role: 'member', members: 2,
          seats: 0, seatProviders: [],
        },
        organizations: [
          { orgId: 'o-new', name: 'New Company', role: 'member', active: true, members: 2, agents: 0 },
          { orgId: 'o-home', name: 'Nomad Trading', role: 'admin', active: false, members: 1, agents: 3 },
        ],
      })
      : emptyState({
        org: { orgId: 'o-home', name: 'Nomad Trading', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'], founded: true },
        organizations: [
          { orgId: 'o-new', name: 'New Company', role: 'member', active: false, members: 2, agents: 0 },
          { orgId: 'o-home', name: 'Nomad Trading', role: 'admin', active: true, members: 1, agents: 3 },
        ],
      }));
    const { api, calls } = scriptedApi({
      ...workspaceScript(state),
      'POST api/org/active': (call) => { active = JSON.parse(String(call.init?.body)).orgId; return { ok: true, orgId: active, name: 'Nomad Trading' }; },
    });
    renderAt('/?org=o-new', api);

    // The bare workplace is Home like any other, and the way out that stood
    // on the gate's steps is the workplace switch in Home's header.
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    expect(document.getElementById('requiredSetup')).toBeNull();
    expect(document.querySelector('#homeOrganizations .orgswapname')!.textContent).toBe('New Company');
    fireEvent.click(document.getElementById('homeOrganizations')!);
    await waitFor(() => expect(document.getElementById('workplaceMenu')).toBeTruthy());
    const other = [...document.querySelectorAll<HTMLButtonElement>('#workplaceMenu .orgmenurow')].find((row) => /Nomad Trading/.test(row.textContent ?? ''));
    expect(other).toBeTruthy();
    fireEvent.click(other!);
    // Home in the other workplace, its name on the switch. (It was proved by
    // the picker standing in that workplace's room until note #843.)
    await homeShelf();
    await waitFor(() => expect(document.querySelector('#homeOrganizations .orgswapname')!.textContent).toBe('Nomad Trading'));
    expect(calls.some((call) => call.path === 'api/org/active' && call.scope?.org === 'o-home')).toBe(true);
  });

  it('lands every old setup address on Home, and a detour on where the reader was going (note #726)', async () => {
    const state = () => emptyState({
      org: {
        orgId: 'o-new', name: 'New Company', role: 'admin', members: 1,
        seats: 0, seatProviders: [],
      },
      organizations: [{ orgId: 'o-new', name: 'New Company', role: 'admin', active: true, members: 1, agents: 0 }],
      canCreateOrg: true,
    });
    const Where = () => { const here = useLocation(); return <div data-testid="where">{here.pathname}</div>; };
    for (const address of ['/setup/team?org=o-new', '/setup/subscription?org=o-new', '/setup/subscription/claude?org=o-new', '/setup/cloud?org=o-new', '/setup?org=o-new']) {
      const { api } = scriptedApi(workspaceScript(state));
      const view = render(
        <MemoryRouter initialEntries={[address]}>
          <App api={api} />
          <Routes><Route path="*" element={<Where />} /></Routes>
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
      await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
      expect(screen.queryByRole('heading', { name: 'Sign in a subscription' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Your team is arriving' })).toBeNull();
      view.unmount();
    }
    // A link made while the gate stood in front of somewhere else still
    // carries where it was going.
    const { api } = scriptedApi(workspaceScript(state));
    render(
      <MemoryRouter initialEntries={[{ pathname: '/setup/subscription', search: '?org=o-new', state: { afterSetup: '/workplaces' } }]}>
        <App api={api} />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/workplaces'));
  });

  it('sends a setup address to Home once the workplace is set up', async () => {
    const { api } = scriptedApi(workspaceScript(() => emptyState({
      org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'] },
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 2, agents: 0 }],
    })));
    const Where = () => { const here = useLocation(); return <div data-testid="where">{here.pathname}</div>; };
    render(
      <MemoryRouter initialEntries={['/setup/subscription/chatgpt?org=o1']}>
        <App api={api} />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
    expect(document.getElementById('requiredSetup')).toBeNull();
  });

  it('brings a sign-in opened from the Chief of Staff’s card back to Home when it lands, with no banner (note #726)', async () => {
    let complete = false;
    const state = () => emptyState({
      org: {
        orgId: 'o-new', name: 'New Company', role: 'admin', members: 1,
        seats: complete ? 1 : 0, seatProviders: complete ? ['claude'] : [],
      },
      organizations: [{ orgId: 'o-new', name: 'New Company', role: 'admin', active: true, members: 1, agents: 0 }],
      canCreateOrg: true,
    });
    const { api } = scriptedApi({
      ...workspaceScript(state),
      'GET api/org/seats': () => ({ seats: [], available: [] }),
      'GET api/org/signin': () => {
        complete = true;
        return { signin: { provider: 'claude', startedAt: 't', state: { phase: 'done', seatId: 's1', label: 'Claude' } } };
      },
    });
    const Where = () => { const here = useLocation(); return <div data-testid="where">{here.pathname}</div>; };
    // The provider's own page resumes the sign-in the server holds — here,
    // one that has just finished — opened the way the card opens it.
    render(
      <MemoryRouter initialEntries={[{ pathname: '/seats/sign-in/claude', search: '?org=o-new', state: { afterSignIn: '/' } }]}>
        <App api={api} />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    // The chat's own row says it; no banner over the log, and no Seats
    // screen on the way.
    expect(document.getElementById('homeBanner')).toBeNull();
    expect(screen.queryByText(/signed in/i)).toBeNull();
    expect(document.getElementById('screenSeats')).toBeNull();
  });

  it('holds the Workspace behind the deletion lock, with the account’s own places reachable (2026-09-22)', async () => {
    const deletion = { requestedAt: new Date().toISOString(), purgeAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), requestedByName: 'Saddam', canKeep: true };
    const state = () => emptyState({
      org: { orgId: 'o1', name: 'Nomad Trading', role: 'admin', members: 2, seats: 1, seatProviders: ['claude'], deletion },
      organizations: [{ orgId: 'o1', name: 'Nomad Trading', role: 'admin', active: true, members: 2, agents: 0 }],
    });
    const { api } = scriptedApi(workspaceScript(state));
    renderAt('/notes?org=o1', api);

    expect(await screen.findByRole('heading', { name: 'Nomad Trading is being deleted' })).toBeTruthy();
    expect(document.getElementById('workplaceDeleting')).toBeTruthy();
    expect(document.getElementById('screenNotes')).toBeNull();
    expect(document.getElementById('screenHome')).toBeNull();
  });

  it('asks for an optional authenticator after email and accepts its recovery code', async () => {
    const state = sessionScript();
    const { api } = scriptedApi({
      ...state,
      'GET auth/session': state.session,
      'POST auth/email/login': () => ({ authenticated: false, secondFactorRequired: true, secondFactorToken: 'factor-1', expiresAt: 't' }),
      'POST auth/email/second-factor': (call) => {
        expect(body(call)).toEqual({ secondFactorToken: 'factor-1', recoveryCode: 'QQQQ-9999' });
        state.signIn();
        return { authenticated: true };
      },
    });
    renderAt('/', api);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'saddam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Extra security check' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'QQQQ-9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await findHome();
  });

  it('an invite link opens on a closed door while invites are switched off (owner, 2026-10-11)', async () => {
    const state = sessionScript();
    let redeemed = 0;
    const { api } = scriptedApi({
      ...state,
      'GET auth/session': state.session,
      'GET auth/invite/tok-1': () => ({ status: 'closed' }),
      'POST auth/email/login': () => { state.signIn(); return { authenticated: true }; },
      'GET api/org/invites/tok-1': () => ({ status: 'closed', orgId: 'o1', name: 'Nomad Trading' }),
      'POST api/org/invites/tok-1/redeem': () => { redeemed += 1; return { ok: true, status: 'pending', requestId: 'jr1', orgId: 'o1', name: 'Nomad Trading' }; },
    });
    renderAt('/invite/tok-1', api);
    // Signed out: told before making an account that nobody gets in this way yet.
    expect(await screen.findByText('Invites are closed for now')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Already have an account? Sign in' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'saddam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    // Signed in: the workplace is named, the door is shut, and there is no button to push.
    await waitFor(() => expect(document.querySelector('#inviteScreen .join-status.quiet')?.textContent).toBe('Not open yet'));
    expect(document.querySelector('#pageId #inviteTitle')!.textContent).toBe('Nomad Trading');
    expect(screen.queryByRole('button', { name: 'Request to join' })).toBeNull();
    expect(redeemed).toBe(0);
  });

  it('signs in, explicitly requests access, waits for approval, then opens the workplace', async () => {
    const state = sessionScript();
    let redeemed = 0;
    let approved = false;
    const { api, calls } = scriptedApi({
      ...state,
      'GET auth/session': state.session,
      'GET auth/invite/tok-1': () => ({ status: 'available' }),
      'POST auth/email/login': () => { state.signIn(); return { authenticated: true }; },
      'GET api/org/invites/tok-1': () => ({ status: 'available', orgId: 'o1', name: 'Nomad Trading' }),
      'POST api/org/invites/tok-1/redeem': () => { redeemed += 1; return { ok: true, status: 'pending', requestId: 'jr1', orgId: 'o1', name: 'Nomad Trading' }; },
      'GET api/org/join-requests/jr1': () => ({ status: approved ? 'member' : 'pending', requestId: 'jr1', orgId: 'o1', name: 'Nomad Trading' }),
      'POST api/org/active': (call) => { expect(body(call)).toEqual({ orgId: 'o1' }); return { ok: true }; },
    });
    renderAt('/invite/tok-1', api);
    expect(await screen.findByText('Your invite link is ready')).toBeTruthy();
    // Someone who already has an account is one tap from the sign-in form.
    fireEvent.click(screen.getByRole('button', { name: 'Already have an account? Sign in' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'saddam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const requestButton = await screen.findByRole('button', { name: 'Request to join' });
    expect(document.querySelector('#pageId #inviteTitle')!.textContent).toBe('Nomad Trading');
    expect(document.querySelector('#pageId #inviteSub')!.textContent).toBe('Join this workplace');
    expect(document.querySelector('#inviteScreen .join-status.open')!.textContent).toBe('Invitation ready');
    expect(document.querySelector('#inviteScreen .join-summary.card')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Joining as' })).toBeTruthy();
    expect(redeemed).toBe(0);
    fireEvent.click(requestButton);
    await screen.findByText('Waiting for approval');
    expect(redeemed).toBe(1);
    // The request's answer IS the page. Taking its address must not re-read
    // it, nor take the workplace out of the header on the way (note #639).
    // The wait is what makes this honest: the address is adopted a tick after
    // the answer lands, and the re-read it used to cause came with it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls.filter((call) => call.path === 'api/org/join-requests/jr1')).toHaveLength(0);
    expect(document.querySelector('#pageId #inviteTitle')!.textContent).toBe('Nomad Trading');
    expect(document.querySelector('#pageId #inviteSub')!.textContent).toBe('Waiting for approval');
    // The workplace is its name here, with no monogram beside it.
    expect(document.querySelector('#pageId .pmark')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open workplace' })).toBeNull();
    // No button to press: the page checks by itself, and at once on return.
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    approved = true;
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open workplace' }));
    await findHome();
    expect(calls.filter((call) => call.path === 'api/state').length).toBeGreaterThanOrEqual(2);
  });

  it('an existing member opens a link without submitting or switching workplaces', async () => {
    const { api, calls } = scriptedApi({
      ...workspaceScript(() => emptyState()),
      'GET api/org/invites/tok-1': () => ({ status: 'member', orgId: 'o1', name: 'Nomad' }),
    });
    renderAt('/invite/tok-1', api);
    expect(await screen.findByText('Access approved')).toBeTruthy();
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Request to join' })).toBeNull();
  });

  // 'used' is the one inactive state left: a link has no expiry, and a
  // revoked one is simply unknown.
  it('does not submit an inactive link', async () => {
    const { api, calls } = scriptedApi({
      ...workspaceScript(() => emptyState()),
      'GET api/org/invites/tok-1': () => ({ status: 'used', orgId: 'o1', name: 'Nomad' }),
    });
    renderAt('/invite/tok-1', api);
    await screen.findByText(/This invite is no longer active/);
    expect(screen.queryByRole('button', { name: 'Request to join' })).toBeNull();
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false);
  });

  // Until the first answer there is no state to name. The card used to stand
  // in for one — an icon, "Checking invite", a sentence — which on any
  // ordinary connection was read only as it left (note #639).
  it('names no state for an invitation it has not read yet', async () => {
    let answer: (value: unknown) => void = () => {};
    const { api } = scriptedApi({
      ...workspaceScript(() => emptyState()),
      'GET api/org/invites/tok-1': () => new Promise((resolve) => { answer = resolve; }),
    });
    renderAt('/invite/tok-1', api);
    await screen.findByText('Opening invitation');
    expect(screen.queryByText('Checking invite')).toBeNull();
    expect(document.querySelector('#inviteState .join-status')).toBeNull();
    expect(document.querySelector('#inviteState .iconbox')).toBeNull();
    // Past the quiet window the card holds its shape, and nothing else.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, WAIT_QUIET_MS + 60)); });
    expect(document.querySelectorAll('#inviteWait .skel')).toHaveLength(3);
    expect(document.querySelector('#inviteWait .iconbox')).toBeNull();
    await act(async () => { answer({ status: 'available', orgId: 'o1', name: 'Nomad' }); });
    expect(await screen.findByRole('button', { name: 'Request to join' })).toBeTruthy();
    expect(document.querySelector('#inviteWait')).toBeNull();
  });

  it('keeps a pending request readable after link revocation and clears it when changing accounts', async () => {
    const state = sessionScript();
    state.signIn();
    const { api, calls } = scriptedApi({
      ...state,
      'GET auth/session': state.session,
      'GET api/org/join-requests/jr1': () => ({ status: 'pending', requestId: 'jr1', orgId: 'o1', name: 'Nomad' }),
      'POST auth/logout': () => { state.signOut(); return { loggedOut: true }; },
      'GET auth/invite/revoked': () => { throw new WorkspaceApiError('Link revoked', 404, {}); },
      'GET api/org/invites/revoked': () => { throw new WorkspaceApiError('Link revoked', 404, {}); },
    });
    renderAt('/invite/revoked?request=jr1', api);
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(calls.some((call) => call.path === 'api/org/invites/revoked')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Use another account' }));
    // Signed out, the link's door is the one everyone gets: sign-up first,
    // with sign-in one tap under it.
    await screen.findByRole('button', { name: 'Already have an account? Sign in' });
    expect(calls.some((call) => call.path === 'auth/logout')).toBe(true);
  });

  it('allows retrying a temporary preview failure without submitting a request', async () => {
    let attempts = 0;
    const { api, calls } = scriptedApi({
      ...workspaceScript(() => emptyState()),
      'GET api/org/invites/tok-1': () => {
        if (++attempts === 1) throw new WorkspaceApiError('Temporarily unavailable', 503, {});
        return { status: 'available', orgId: 'o1', name: 'Nomad' };
      },
    });
    renderAt('/invite/tok-1', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Request to join' });
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false);
  });

  it('signing out closes the door', async () => {
    const state = sessionScript();
    state.signIn();
    const { api, calls } = scriptedApi({
      ...state,
      'GET auth/session': state.session,
      'POST auth/logout': () => { state.signOut(); return { loggedOut: true }; },
    });
    renderAt('/profile', api);
    fireEvent.click(await screen.findByRole('button', { name: /Sign out$/ }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(calls.some((call) => call.path === 'auth/logout')).toBe(true);
    expect(document.body.classList.contains('browser-authenticated')).toBe(false);
  });

  it('names the tab after the workplace, and gives the name back on sign-out', async () => {
    let authenticated = true;
    const { api } = scriptedApi({
      ...workspaceScript(() => emptyState({
        org: { orgId: 'o-north', name: 'Northstar Studio', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
        organizations: [{ orgId: 'o-north', name: 'Northstar Studio', role: 'admin', active: true, members: 1, agents: 0 }],
      })),
      'GET auth/session': () => (authenticated ? signedIn() : signedOut()),
      'POST auth/logout': () => { authenticated = false; return { loggedOut: true }; },
    });
    document.title = 'Your workspace';
    renderAt('/profile?org=o-north', api);
    await waitFor(() => expect(document.title).toBe('Northstar Studio'));
    fireEvent.click(await screen.findByRole('button', { name: /Sign out$/ }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(document.title).toBe('Your workspace');
  });
});

describe('the router', () => {
  const signedInApi = () => scriptedApi(workspaceScript(() => emptyState())).api;

  // Slice 7 was the last screen slice, so nothing in the registry falls
  // through to the hand-off card any more. Checked by DRIVING every registered
  // address rather than by reading the router's own table: the table would
  // only be restating itself, and what matters is that a reader who lands on
  // one of these gets a screen.
  it('has a screen for every registered destination', async () => {
    for (const kind of WORKSPACE_ROUTE_KINDS) {
      const path = workspaceRoutePath({ kind, id: 'x', sha: 'y', orgId: 'o1' } as never);
      if (!path) continue;
      const view = render(
        <MemoryRouter initialEntries={[path.slice('/'.length) || '/']}>
          <App api={signedInApi()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(document.getElementById('content')).toBeTruthy());
      expect(screen.queryByRole('link', { name: 'Open in the classic Workspace' }), kind).toBeNull();
      view.unmount();
    }
  });

  // The rooms list and a room's own screen were destinations of their own
  // until rooms left the product (note #843). Their addresses are retired:
  // a bookmark or an old link lands on Home rather than on nothing.
  it('lands an old rooms address on Home', async () => {
    const Where = () => { const here = useLocation(); return <div data-testid="where">{here.pathname}</div>; };
    for (const path of ['/rooms?org=o1', '/rooms/r1?org=o1']) {
      const view = render(
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <App api={signedInApi()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
      await waitFor(() => expect(document.getElementById('screenHome') ?? document.getElementById('screenOverview')).toBeTruthy());
      expect(document.getElementById('screenRooms')).toBeNull();
      expect(document.getElementById('screenRoomDetail')).toBeNull();
      view.unmount();
    }
  });

  // The owner, 2026-10-11: the visitor's header — the mark, "Open
  // Workspace" — is for a stranger. Someone signed in reads a builder's
  // page inside the Workspace, under its own header with Back.
  const builder = {
    'GET api/public/addresses/adam': () => ({ kind: 'person', person: { handle: 'adam', name: 'Adam B', repos: [] } }),
  };

  it('opens a builder’s page inside the Workspace for someone signed in', async () => {
    renderAt('/adam', scriptedApi({ ...workspaceScript(() => emptyState()), ...builder }).api);
    expect(await screen.findByRole('heading', { name: 'Adam B' })).toBeTruthy();
    expect(document.getElementById('pageBack')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open Workspace/ })).toBeNull();
    expect(document.querySelector('.public-repo-head')).toBeNull();
  });

  it('keeps the visitor’s header on it for a stranger', async () => {
    renderAt('/adam', scriptedApi({ 'GET auth/session': signedOut, ...builder }).api);
    expect(await screen.findByRole('heading', { name: 'Adam B' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy());
    expect(document.getElementById('pageBack')).toBeNull();
  });

  it('opens a repository at its own address rather than handing it away', async () => {
    renderAt('/repositories/infinite-agents?org=o1&room=r1', signedInApi());
    expect(await screen.findByRole('heading', { name: 'infinite-agents' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open in the classic Workspace' })).toBeNull();
  });

  it('keeps a fixed child ahead of its parameterized sibling', async () => {
    renderAt('/seats/sign-in?org=o1', signedInApi());
    expect(await screen.findByRole('heading', { name: 'Sign in a subscription' })).toBeTruthy();
  });

  it('reads a commit route by its sha', async () => {
    renderAt('/repositories/infinite-agents/commits/abc123?org=o1&room=r1', signedInApi());
    // The commit's own screen, which opens on the sha it was asked for and
    // fills in the subject when the read lands.
    expect(await screen.findByRole('heading', { name: 'Commit' })).toBeTruthy();
    expect(document.getElementById('prDiffSub')!.textContent).toContain('abc123');
  });

  it('/signup for someone already signed in is Home', async () => {
    renderAt('/signup', signedInApi());
    await findHome();
    // Home no longer ends on a hand-off card: every one of its sections has
    // moved, so there is nothing left behind that door.
    expect(screen.queryByRole('link', { name: 'Open the classic Workspace' })).toBeNull();
  });

  it('an unknown address says so rather than painting something else', async () => {
    renderAt('/nowhere/at/all', signedInApi());
    expect(await screen.findByRole('heading', { name: 'Nothing at this address' })).toBeTruthy();
  });

  it('shows the loading shell until the session answers', async () => {
    let resolve!: (answer: WorkspaceSessionAnswer) => void;
    const pending = new Promise<WorkspaceSessionAnswer>((r) => { resolve = r; });
    const reads = scriptedApi(workspaceScript(() => emptyState())).api;
    const api: WorkspaceApi = {
      api: reads.api,
      authApi: (() => pending) as WorkspaceApi['authApi'],
      csrfToken: () => '',
    };
    renderAt('/', api);
    expect(screen.getByText('Loading your workspace…')).toBeTruthy();
    const firstPaint = document.getElementById('appLoadingSkeleton')!;
    expect(firstPaint).toBeTruthy();
    // Home's own shape (note #718): the Chief of Staff's conversation — a
    // held header with the face and the name, the pane, and the message box
    // with the door to the agents before it; and no turns, which
    // the read has not said this reader has had.
    expect(firstPaint.querySelector('.chathead .chatface .skel.face')).toBeTruthy();
    expect(firstPaint.querySelector('.chathead .chatwho h1 .skel')).toBeTruthy();
    expect(firstPaint.querySelector('.chatpane')).toBeTruthy();
    expect(firstPaint.querySelector('.chatpane .chatmsg')).toBeNull();
    expect(firstPaint.querySelector('.chatbar .chatagents.chatwaitagents')).toBeTruthy();
    expect(firstPaint.querySelector('.chatbar .chatinput')).toBeTruthy();
    expect(firstPaint.querySelector('.chatbar .skel-send')).toBeTruthy();
    expect(firstPaint.querySelectorAll('.skel').length).toBeGreaterThan(6);
    // The old Workplace page's shelves are not drawn any more.
    expect(firstPaint.querySelector('.recapbrief, .seatstrip, .workplace-loading-nav')).toBeNull();
    // And it stands in the chat's viewport-tall shell, which the real Home
    // then takes over without a jump.
    expect(document.body.classList.contains('agent-chat-open')).toBe(true);
    expect(document.getElementById('loading')).toBeNull();
    await act(async () => { resolve(signedIn()); await pending; });
    await homeShelf();
    expect(document.getElementById('appLoadingSkeleton')).toBeNull();
  });

  it('keeps a skeleton through the workplace read, then replaces it with the real tab', async () => {
    let resolveState!: (answer: WorkspaceStateAnswer) => void;
    const pendingState = new Promise<WorkspaceStateAnswer>((resolve) => { resolveState = resolve; });
    const state = emptyState({
      org: { orgId: 'o1', name: 'Nomad', role: 'admin', members: 1, seats: 0, seatProviders: [] },
    });
    const script = workspaceScript(() => state);
    script['GET api/state'] = () => pendingState;
    const { api } = scriptedApi(script);
    renderAt('/overview', api);

    await waitFor(() => expect(document.getElementById('workplaceLoadingSkeleton')).toBeTruthy());
    const workplaceWait = document.getElementById('workplaceLoadingSkeleton')!;
    // The same shape as the first paint: the conversation's held header,
    // pane and message box.
    expect(workplaceWait.querySelector('.chathead .chatface .skel.face')).toBeTruthy();
    expect(workplaceWait.querySelector('.chatbar .chatagents.chatwaitagents')).toBeTruthy();
    expect(workplaceWait.querySelectorAll('.skel').length).toBeGreaterThan(6);
    expect(screen.getByText('Loading your workplace…')).toBeTruthy();
    expect(document.getElementById('loading')).toBeNull();

    await act(async () => { resolveState(state); await pendingState; });
    // Home, with the Workplace window the overview's old address names.
    await waitFor(() => expect(document.getElementById('homeSheetTitle')?.textContent).toBe('Workplace'));
    expect(document.getElementById('workplaceLoadingSkeleton')).toBeNull();
  });
});
