/**
 * The Workspace door. Email and password are the primary identity; an
 * authenticator code follows only when that account opted into it.
 *
 * The legacy username/TOTP panels remain only so existing accounts can enter
 * and attach email from Settings. New accounts never have to choose a
 * username, install an app or save recovery codes. Since note #562 the door
 * does not offer that login at all: it is reached by asking for it, at
 * `/login#authenticator`.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  WorkspacePasswordForgotAnswer,
  WorkspacePasswordResetAnswer,
  WorkspaceRecoveryEmailConfirmAnswer,
  WorkspaceEmailLoginAnswer,
  WorkspaceEmailRegisterAnswer,
  WorkspaceEmailVerificationFinishAnswer,
  WorkspaceEmailVerificationResendAnswer,
  WorkspaceInviteStatusAnswer,
  WorkspaceLoginAnswer,
  WorkspaceRecoveryAnswer,
  WorkspaceSecondFactorAnswer,
} from '../../../src/shared/workspace-api.js';
import { WORKSPACE_USERNAME_PATTERN_SOURCE } from '../../../src/shared/workspace-api.js';
import { MAIL_DOMAIN, MAIL_LOCAL_MAX, normalizeMailLocal } from '../../../src/shared/workspace-mail.js';
import { readFirstVisit } from '../../../src/shared/first-visit.js';
import { FIRST_ACCOUNT_FRAGMENT, PRIVATE_COPY, SIGNUP_CLOSED } from '../../../src/shared/private-copy.js';
import { MailAddressField, type MailAddressStatus } from '../mail/MailAddressField.js';
import { SetupHead } from '../onboarding/SetupHead.js';
import { jsonBody, WorkspaceApiError, type WorkspaceApi } from '../api/client.js';
import { useSession } from '../session/useSession.js';

export type AuthPanel =
  | 'email'
  | 'forgot'
  | 'check-email'
  | 'second-factor'
  | 'second-factor-recovery'
  | 'legacy'
  | 'legacy-recovery';

export interface AuthGateProps {
  initialPanel: 'login' | 'register';
  inviteToken?: string;
}
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const canonicalUsername = (value: string): string => value.trim().toLowerCase();

export function AuthGate({ initialPanel, inviteToken }: AuthGateProps) {
  const { api, refresh } = useSession();
  // Note #562 took the authenticator login off the door: nothing links to it
  // any more. The panel itself stays for the accounts that predate email
  // sign-in — they are asked to ask for it, `/login#authenticator` — and
  // the fragment is dropped from history at once, as every other fragment
  // here is, so Back to email sign-in is not undone by a reload.
  const [panel, setPanel] = useState<AuthPanel>(() => {
    if (window.location.hash !== '#authenticator') return 'email';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return 'legacy';
  });
  // A private copy takes no open sign-up (note #808): an account comes
  // through an invite link, or is the copy's first, which the installer
  // makes from `/signup#first-account=<code>`. The code is held here and
  // dropped from the address bar at once, like every fragment on this door.
  const [firstAccountCode] = useState(() => {
    const prefix = `#${FIRST_ACCOUNT_FRAGMENT}=`;
    const { hash } = window.location;
    if (!PRIVATE_COPY || !hash.startsWith(prefix)) return '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    try { return decodeURIComponent(hash.slice(prefix.length)); } catch { return ''; }
  });
  // A join link opens on the sign-up form: the person it was sent to is, far
  // more often than not, new here. Someone with an account is one tap away.
  const [creating, setCreating] = useState(initialPanel === 'register' || Boolean(inviteToken));
  const [email, setEmail] = useState('');
  const [verificationWaitSeconds, setVerificationWaitSeconds] = useState(0);
  const [secondFactorToken, setSecondFactorToken] = useState('');
  const [username, setUsername] = useState('');
  // Walking up to a copy's sign-up door with neither: the door says how
  // accounts are made here instead of drawing a form that would be refused.
  const inviteOnly = PRIVATE_COPY && creating && !inviteToken && !firstAccountCode;
  // Our own platform with new sign-ups closed (note #823): the door says
  // the platform is offered as a private copy, and where to read about it.
  // An invite link into an open workplace still opens the form.
  const signupClosed = SIGNUP_CLOSED && creating && !inviteToken;

  return (
    <AuthShell title={panel === 'check-email' ? 'Check your email.' : panel === 'forgot' ? 'Reset your password.' : inviteToken ? 'Join your team’s Workspace.' : inviteOnly && panel === 'email' ? 'Accounts here come with an invite.' : signupClosed && panel === 'email' ? 'Run it in your own cloud.' : creating && panel === 'email' ? 'Create your Workspace.' : 'Your Workspace, anywhere.'}>
      {inviteToken ? <InvitePreview api={api} token={inviteToken} creating={creating && panel === 'email'} /> : null}
      {panel === 'email' && inviteOnly ? <InviteOnly onMode={() => setCreating(false)} /> : null}
      {panel === 'email' && signupClosed ? <SignupClosed onMode={() => setCreating(false)} /> : null}
      {panel === 'email' && !inviteOnly && !signupClosed ? (
        <EmailPanel
          api={api}
          email={email}
          creating={creating}
          onEmail={setEmail}
          onSignedIn={refresh}
          onVerificationRequired={(freshlySent) => {
            setVerificationWaitSeconds(freshlySent ? 60 : 0);
            setPanel('check-email');
          }}
          onSecondFactor={(token) => { setSecondFactorToken(token); setPanel('second-factor'); }}
          onMode={() => setCreating((value) => !value)}
          onForgot={() => setPanel('forgot')}
          invited={Boolean(inviteToken)}
          {...((PRIVATE_COPY || SIGNUP_CLOSED) && inviteToken ? { inviteToken } : {})}
          {...(firstAccountCode ? { firstAccountCode } : {})}
        />
      ) : null}
      {panel === 'forgot' ? (
        <ForgotPasswordPanel api={api} name={email} onName={setEmail} />
      ) : null}
      {panel === 'check-email' ? (
        <EmailVerificationPending api={api} email={email} inviteToken={inviteToken} initialWaitSeconds={verificationWaitSeconds} onBack={() => { setCreating(false); setPanel('email'); }} />
      ) : null}
      {panel === 'second-factor' || panel === 'second-factor-recovery' ? (
        <SecondFactorPanel
          api={api}
          token={secondFactorToken}
          recovery={panel === 'second-factor-recovery'}
          onRecovery={() => setPanel(panel === 'second-factor' ? 'second-factor-recovery' : 'second-factor')}
          onSignedIn={refresh}
          onRestart={() => setPanel('email')}
        />
      ) : null}
      {panel === 'legacy' ? (
        <LegacyLoginPanel
          api={api}
          username={username}
          onUsername={setUsername}
          onSignedIn={refresh}
          onBack={() => setPanel('email')}
          onRecovery={() => setPanel('legacy-recovery')}
        />
      ) : null}
      {panel === 'legacy-recovery' ? (
        <LegacyRecoveryPanel
          api={api}
          username={username}
          onUsername={setUsername}
          onSignedIn={refresh}
          onBack={() => setPanel('legacy')}
        />
      ) : null}
    </AuthShell>
  );
}

/**
 * Every account screen wears the setup gate's shape (the owner, 2026-09-18):
 * the mark in a quiet head, the title, then the fields as plates with no card
 * around them. Each form's action follows its fields in the same column.
 * The mark leads home to the landing page (the owner, 2026-09-29).
 */
export function AuthShell({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section id="authGate" className="authplates" aria-labelledby="authTitle">
      <SetupHead home />
      <div className="authhero"><h1 id="authTitle">{title}</h1></div>
      {children}
    </section>
  );
}

/**
 * A private copy's sign-up door, reached with no invite (note #808): the
 * copy is one company's, and an account here comes through the invite link
 * an admin of its workplace hands out. Signing in stays one tap away.
 */
function InviteOnly({ onMode }: { onMode: () => void }) {
  return (
    <div className="authpanel" id="authInviteOnly">
      <h2>Ask for an invite link</h2>
      <p className="authsub">This Workspace belongs to one company. Ask an admin of your workplace for its invite link, then open it here to create your account.</p>
      <div className="authlinks">
        <button className="authlink" id="authModeLink" type="button" onClick={onMode}>Already have an account? Sign in</button>
      </div>
    </div>
  );
}

/**
 * Our own sign-up door while new sign-ups are closed (note #823, the owner,
 * 2026-10-28: only the private copy is offered). Not a refusal to read
 * twice: what the platform is offered as, the page that says how, and the
 * address to write to. Signing in stays one tap away.
 */
function SignupClosed({ onMode }: { onMode: () => void }) {
  return (
    <div className="authpanel" id="authSignupClosed">
      <h2>New accounts are closed here</h2>
      <p className="authsub">New accounts on our cloud are closed. Instead, build your own Agentic Cloud: the whole platform in your company’s own cloud account, on your own domain, with everything of yours on your side.</p>
      <div className="authlinks">
        <a className="authlink" id="authPrivateCopyLink" href="https://agenticcloudcomputer.com/own-cloud">See how to build your own Agentic Cloud</a>
        <a className="authlink" id="authContactLink" href="mailto:adam@agenticcloudcomputer.com">Write to adam@agenticcloudcomputer.com</a>
        <button className="authlink" id="authModeLink" type="button" onClick={onMode}>Already have an account? Sign in</button>
      </div>
    </div>
  );
}

function InvitePreview({ api, token, creating }: { api: WorkspaceApi; token: string; creating: boolean }) {
  const [status, setStatus] = useState<'loading' | 'available' | 'used' | 'closed' | 'invalid' | 'error'>('loading');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.authApi<WorkspaceInviteStatusAnswer>(`auth/invite/${encodeURIComponent(token)}`)
      .then((answer) => { if (!cancelled) { setStatus(answer.status); setError(''); } })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus(err instanceof WorkspaceApiError && err.status === 404 ? 'invalid' : 'error');
          setError(errorMessage(err));
        }
      });
    return () => { cancelled = true; };
  }, [api, token]);
  const available = status === 'available';
  const title = available ? 'Your invite link is ready' : status === 'loading' ? 'Checking your invite link…' : status === 'error' ? 'We couldn’t check this link' : status === 'closed' ? 'Invites are closed for now' : 'This link is no longer active';
  // In a private copy the request is sent WITH a new account (note #808).
  const detail = available ? (creating && (PRIVATE_COPY || SIGNUP_CLOSED)
    ? 'Create your account below and your request to join goes with it. Access starts after admin approval.'
    : `${creating ? 'Create your account' : 'Sign in'} below, then send your request. Access starts after admin approval.`)
    : status === 'loading' ? 'Checking whether this link can accept requests.'
      : status === 'error' ? 'You can sign in and try again.'
        : status === 'closed' ? 'Workplaces are for one person at the moment, and teams are coming. You can still create a Workspace of your own below.'
          : 'Ask an admin for a new link. You can still sign in to your own Workspace.';
  return (
    <div id="authInvite" className={`authinvite join-invite${available ? '' : ' muted'}`} aria-live="polite">
      <strong>{title}</strong><p>{detail}</p>
      {error && status === 'error' ? <span className="join-invite-error">{error}</span> : null}
    </div>
  );
}

function AuthError({ id, message }: { id: string; message: string }) {
  return message ? <div className="autherror" id={id} role="alert">{message}</div> : null;
}

/**
 * The one field a person signs in with: the name of their address here, with
 * the domain beside it so nobody types it. An account made before addresses
 * existed still signs in with the outside email it was created with — the
 * field takes a whole address too, and the domain steps aside once an `@`
 * is typed. type=text, not email: the browser would refuse `adam` before the
 * form was ever sent.
 *
 * Note #562: it is labelled Email — the domain beside it already says what
 * to type, so there is no example name in the box.
 */
function SignInNameField({ id, value, onChange, autoFocus }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const wholeAddress = value.includes('@');
  return (
    <div className="authfield mailfield">
      <label className="mailfieldlabel" htmlFor={id}>Email</label>
      <div className="mailinput">
        <input
          id={id}
          name="email"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={wholeAddress ? 254 : MAIL_LOCAL_MAX}
          required
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {wholeAddress ? null : <span className="maildomain" id={`${id}Domain`} aria-hidden="true">@{MAIL_DOMAIN}</span>}
      </div>
    </div>
  );
}

export function EmailPanel({ api, email, creating, onEmail, onSignedIn, onVerificationRequired, onSecondFactor, onMode, onForgot, invited, inviteToken, firstAccountCode }: {
  api: WorkspaceApi;
  email: string;
  creating: boolean;
  onEmail: (value: string) => void;
  onSignedIn: () => Promise<void>;
  onVerificationRequired: (freshlySent: boolean) => void;
  onSecondFactor: (token: string) => void;
  onMode: () => void;
  onForgot: () => void;
  invited: boolean;
  /** A private copy's admission (note #808), sent with a new account: the
   *  invite link it came through, or the installer's first-account code. */
  inviteToken?: string;
  firstAccountCode?: string;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  // The name for their own address here (note #509) — the whole of what a new
  // account is. There is no outside email to prove, so creating one signs
  // them straight in.
  const [mailbox, setMailbox] = useState('');
  const [mailboxStatus, setMailboxStatus] = useState<MailAddressStatus>('empty');
  // Their own name, asked here with the address (note #144): it is what the
  // Workspace Agent calls them a minute from now and what teammates see.
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (creating && password !== confirm) throw new Error('Those passwords do not match.');
      if (creating) {
        // Where this browser first came from rides along (shared/first-visit.ts),
        // so Growth can tell which places bring people. Nothing is asked of them.
        const firstVisit = readFirstVisit(window);
        await api.authApi<WorkspaceEmailRegisterAnswer>('auth/email/register', jsonBody({
          mailbox: normalizeMailLocal(mailbox), password, firstName: firstName.trim(), lastName: lastName.trim(),
          ...(firstVisit ? { firstVisit } : {}),
          ...(inviteToken ? { inviteToken } : {}),
          ...(firstAccountCode ? { firstAccountCode } : {}),
        }));
        await onSignedIn();
        return;
      }
      // In a private copy the link's token rides the sign-in too: an account
      // that is in no workplace is let back in only through it (note #814).
      const answer = await api.authApi<WorkspaceEmailLoginAnswer>('auth/email/login', jsonBody({
        email: email.trim().toLowerCase(), password, ...(inviteToken ? { inviteToken } : {}),
      }));
      if (!answer.authenticated && 'verificationRequired' in answer) { onVerificationRequired(false); return; }
      if (!answer.authenticated) { onSecondFactor(answer.secondFactorToken); return; }
      await onSignedIn();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <>
      <div className="authpanel" id="authEmailPanel">
        <h2>{creating ? 'Create your account' : 'Sign in'}</h2>
        <form id="authEmailForm" autoComplete="on" onSubmit={(event) => { void submit(event); }}>
          {creating ? (
            <div className="authnames">
              <label className="authfield">
                <span>First name</span>
                <input id="authFirstName" name="given-name" autoComplete="given-name" autoCapitalize="words" maxLength={64} required autoFocus value={firstName} onChange={(event) => setFirstName(event.target.value)} />
              </label>
              <label className="authfield">
                <span>Last name</span>
                <input id="authLastName" name="family-name" autoComplete="family-name" autoCapitalize="words" maxLength={64} required value={lastName} onChange={(event) => setLastName(event.target.value)} />
              </label>
            </div>
          ) : null}
          {creating ? (
            <MailAddressField
              api={api}
              id="authMailbox"
              value={mailbox}
              onChange={setMailbox}
              onStatus={setMailboxStatus}
            />
          ) : (
            <SignInNameField id="authEmail" value={email} onChange={onEmail} autoFocus />
          )}
          <label className="authfield">
            <span>Password</span>
            <input id="authPassword" name="password" type="password" autoComplete={creating ? 'new-password' : 'current-password'} minLength={10} maxLength={256} required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {creating ? (
            <label className="authfield">
              <span>Confirm password</span>
              <input id="authPasswordConfirm" name="password-confirm" type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </label>
          ) : null}
          {/* Note #605: the rescue sits on the commit's own row, at the
              column's leading edge, rather than on a line of its own below. */}
          <div className="authsubmit">
            {!creating ? <button className="authlink" id="authForgotLink" type="button" onClick={onForgot}>Forgot your password?</button> : null}
            <button className="formcommit" id="authEmailButton" type="submit" disabled={busy || (creating && mailboxStatus !== 'free')}>{busy ? (creating ? 'Creating your account…' : 'Signing in…') : creating ? 'Create account' : 'Sign in'}</button>
          </div>
        </form>
        {/* Note #562: the ordinary door is a sign-in and nothing else — the
            landing page carries the way to a new account, and the
            authenticator login is no longer offered here. An invite is the
            one exception: the person it names may have no account at all,
            and this is their only way to one from the screen it opens. */}
        {invited ? (
          <div className="authlinks">
            <button className="authlink" id="authModeLink" type="button" onClick={onMode}>{creating ? 'Already have an account? Sign in' : 'Create an account'}</button>
          </div>
        ) : null}
        <AuthError id="authEmailError" message={error} />
      </div>
      {/* A joiner walks into a workplace that is already set up. */}
      {creating && !invited ? (
        <aside className="authneeds" id="authNeeds">
          <div className="authneedstitle">After you create your account</div>
          {/* Connecting Fly.io was the first row until note #664: agents'
              computers run on the cloud now, free, with nothing to connect. */}
          <div className="authneedsrow">
            <strong>Sign in Codex or Claude</strong>
            <span>Codex uses your ChatGPT subscription; Claude uses Claude Pro or Max.</span>
          </div>
          {/* In a company's own Agentic Cloud (PRIVATE_COPY, note #828) the
              computers run in the company's own cloud account, which pays
              for them and which the installer already connected: "free" and
              "no cloud account" are our hosted platform's promise, not its. */}
          <div className="authneedsrow">
            <strong>Nothing else</strong>
            <span>{PRIVATE_COPY
              ? 'Your agents’ computers run in your company’s own cloud account, which pays for them. It was connected when your Agentic Cloud was installed.'
              : 'Your agents’ computers run on the cloud, free — there is no cloud account to connect.'}</span>
          </div>
        </aside>
      ) : null}
    </>
  );
}

function EmailVerificationPending({ api, email, inviteToken, initialWaitSeconds, onBack }: {
  api: WorkspaceApi;
  email: string;
  inviteToken?: string;
  initialWaitSeconds: number;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [waitSeconds, setWaitSeconds] = useState(initialWaitSeconds);
  useEffect(() => {
    if (waitSeconds <= 0) return;
    const timer = window.setTimeout(() => setWaitSeconds((seconds) => Math.max(0, seconds - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [waitSeconds]);
  const resendLabel = busy
    ? 'Sending…'
    : waitSeconds > 0
      ? `Send again in ${Math.floor(waitSeconds / 60)}:${String(waitSeconds % 60).padStart(2, '0')}`
      : 'Send again';
  return (
    <div className="authpanel" id="authEmailPending">
      <h2 className="sr-only">Check your email</h2>
      <div className="authpendingaddress">
        <span>Sent to</span>
        <strong>{email}</strong>
      </div>
      <p className="authpendinginstruction">Open the link to finish creating your account. It expires in 30 minutes. You’ll be signed in automatically.</p>
      <p className="authpendinghelp">Didn’t receive it? Check spam or junk.</p>
      <div className="authactions"><button className="btn ghost" type="button" disabled={busy || waitSeconds > 0} onClick={async () => {
        setBusy(true); setMessage('');
        try {
          await api.authApi<WorkspaceEmailVerificationResendAnswer>('auth/email/resend', jsonBody({
            email, ...(inviteToken ? { inviteToken } : {}),
          }));
          setMessage('If this address is awaiting confirmation, a new link has been sent.');
          setWaitSeconds(60);
        } catch (error) { setMessage(errorMessage(error)); }
        setBusy(false);
      }}>{resendLabel}</button>
      <button className="btn bare" type="button" onClick={onBack}>Change email address</button></div>
      {message ? <div className="authnote" role="status">{message}</div> : null}
    </div>
  );
}

/**
 * "Forgot your password?" The answer is the same whatever the name: the
 * server never says whether an account exists or whether it has a recovery
 * address, so neither does this screen.
 */
function ForgotPasswordPanel({ api, name, onName }: {
  api: WorkspaceApi;
  name: string;
  onName: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [sent, setSent] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api.authApi<WorkspacePasswordForgotAnswer>('auth/email/forgot', jsonBody({ name: name.trim().toLowerCase() }));
      setSent(true);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };
  return (
    <div className="authpanel" id="authForgotPanel">
      <h2>Reset your password</h2>
      {sent ? (
        <>
          <div className="authsub" id="authForgotSent">If that account has a confirmed recovery email, a link to choose a new password is on its way there. It works once, for 30 minutes.</div>
          <div className="authnote">No recovery email on the account? A password here cannot be recovered any other way — add one in Settings while you are signed in.</div>
        </>
      ) : (
        <>
          <div className="authsub">We will send a link to the recovery email on your account.</div>
          <form id="authForgotForm" onSubmit={(event) => { void submit(event); }}>
            <SignInNameField id="authForgotName" value={name} onChange={onName} autoFocus />
            <button className="formcommit" id="authForgotButton" type="submit" disabled={busy || !name.trim()}>Send the link</button>
          </form>
        </>
      )}
      <AuthError id="authForgotError" message={error} />
    </div>
  );
}

/**
 * The landing for a reset link. The token rides in the fragment, as the
 * confirmation link's does, and is taken out of history before the one POST
 * that spends it. A reset opens no session: the person signs in with the
 * new password, through their authenticator when they have one.
 */
export function PasswordResetScreen() {
  const { api } = useSession();
  const [token] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return value;
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (password !== confirm) throw new Error('Those passwords do not match.');
      await api.authApi<WorkspacePasswordResetAnswer>('auth/email/reset', jsonBody({ token, password }));
      setDone(true);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };
  return (
    <AuthShell title="Choose a new password.">
      <div className="authpanel" id="authResetPanel" aria-live="polite">
        {done ? (
          <>
            <h2>Password changed</h2>
            <div className="authsub" id="authResetDone">Every browser that was signed in has been signed out. Sign in with your new password.</div>
            <a className="formcommit authcontinue" id="authResetContinue" href="/">Sign in</a>
          </>
        ) : !token ? (
          <>
            <h2>This link did not work</h2>
            <div className="autherror">The link is missing its key. Open it from the email again, or request a new one.</div>
            <a className="formcommit authcontinue" href="/">Back to sign in</a>
          </>
        ) : (
          <>
            <h2>New password</h2>
            <div className="authsub">At least 10 characters. Your authenticator, if you use one, stays as it is.</div>
            <form id="authResetForm" onSubmit={(event) => { void submit(event); }}>
              <label className="authfield">
                <span>New password</span>
                <input id="authResetPassword" name="password" type="password" autoComplete="new-password" minLength={10} maxLength={256} required autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <label className="authfield">
                <span>Confirm new password</span>
                <input id="authResetConfirm" name="password-confirm" type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
              </label>
              <button className="formcommit" id="authResetButton" type="submit" disabled={busy}>Change password</button>
            </form>
            <AuthError id="authResetError" message={error} />
          </>
        )}
      </div>
    </AuthShell>
  );
}

/** The landing for a recovery-email confirmation link. */
export function RecoveryEmailConfirmScreen() {
  const { api } = useSession();
  const [state, setState] = useState<'working' | 'confirmed' | 'error'>('working');
  const [message, setMessage] = useState('Confirming your recovery email…');
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    let cancelled = false;
    api.authApi<WorkspaceRecoveryEmailConfirmAnswer>('auth/email/recovery/confirm', jsonBody({ token }))
      .then((answer) => { if (!cancelled) { setState('confirmed'); setMessage(`${answer.email} can now reset your password if you forget it.`); } })
      .catch((error: unknown) => { if (!cancelled) { setState('error'); setMessage(errorMessage(error)); } });
    return () => { cancelled = true; };
  }, [api]);
  return (
    <AuthShell title="Recovery email">
      <div className="authpanel" id="authRecoveryConfirm" aria-live="polite">
        <h2>{state === 'working' ? 'One moment' : state === 'confirmed' ? 'Recovery email confirmed' : 'This link did not work'}</h2>
        <div className={state === 'error' ? 'autherror' : 'authsub'}>{message}</div>
        {state !== 'working' ? <a className="formcommit authcontinue" href="/">Continue to Workspace</a> : null}
      </div>
    </AuthShell>
  );
}

/** The bearer rides in the URL fragment so neither the HTTP request nor asset
 * referrers disclose it. Remove it before making the one state-changing POST. */
export function EmailVerificationScreen() {
  const { api } = useSession();
  const [state, setState] = useState<'working' | 'verified' | 'error'>('working');
  const [authenticated, setAuthenticated] = useState(false);
  const [message, setMessage] = useState('Confirming your email…');
  const [continueTo] = useState(() => {
    const requested = new URLSearchParams(window.location.hash.slice(1)).get('continue') ?? '';
    return /^\/invite\/[A-Za-z0-9_-]{20,64}$/.test(requested) ? requested : '/';
  });
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('token') ?? '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    let cancelled = false;
    api.authApi<WorkspaceEmailVerificationFinishAnswer>('auth/email/verify', jsonBody({ token }))
      .then((answer) => {
        if (!cancelled) {
          setAuthenticated(answer.authenticated);
          setState('verified');
          setMessage(answer.authenticated
            ? 'Your email is confirmed and you’re signed in.'
            : 'Your email is confirmed. Sign in to complete your security check.');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) { setState('error'); setMessage(errorMessage(error)); }
      });
    return () => { cancelled = true; };
  }, [api]);
  return (
    <AuthShell title="Email confirmation">
      <div className="authpanel" id="authEmailVerification" aria-live="polite">
        <h2>{state === 'working' ? 'One moment' : state === 'verified' ? 'Email confirmed' : 'This link did not work'}</h2>
        <div className={state === 'error' ? 'autherror' : 'authsub'}>{message}</div>
        {state !== 'working' ? <a className="formcommit authcontinue" href={continueTo}>{state === 'verified' ? authenticated ? 'Continue to Workspace' : 'Continue to sign in' : 'Request another link'}</a> : null}
      </div>
    </AuthShell>
  );
}

export function EmailVerificationPrompt({ email, status }: {
  email: string;
  status: 'pending' | 'legacy';
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <aside className="emailverificationprompt" id="emailVerificationPrompt" aria-label="Email confirmation">
      <div>
        <strong>Confirm your email</strong>
        <span>{status === 'legacy'
          ? 'Your access stays unchanged. Confirm when convenient so this address is known to be yours.'
          : 'Your current session stays open; confirm the address to finish switching your sign-in.'}</span>
      </div>
      <button className="btn ghost" type="button" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await api.authApi<WorkspaceEmailVerificationResendAnswer>('auth/email/resend', jsonBody({ email }));
          setSent(true);
        } catch { setSent(false); }
        setBusy(false);
      }}>{sent ? 'Link requested' : 'Send link'}</button>
    </aside>
  );
}

function SecondFactorPanel({ api, token, recovery, onRecovery, onSignedIn, onRestart }: {
  api: WorkspaceApi;
  token: string;
  recovery: boolean;
  onRecovery: () => void;
  onSignedIn: () => Promise<void>;
  onRestart: () => void;
}) {
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api.authApi<WorkspaceSecondFactorAnswer>('auth/email/second-factor', jsonBody({ secondFactorToken: token, [recovery ? 'recoveryCode' : 'code']: value }));
      await onSignedIn();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <div className="authpanel" id="authSecondFactorPanel">
      <h2>{recovery ? 'Use a recovery code' : 'Extra security check'}</h2>
      <div className="authsub">{recovery ? 'Enter one of the recovery codes you saved when you enabled authenticator security.' : 'This account has authenticator security enabled. Enter the current code from your app.'}</div>
      <form id="authSecondFactorForm" onSubmit={(event) => { void submit(event); }}>
        <label className="authfield"><span>{recovery ? 'Recovery code' : 'Authenticator code'}</span><input className={recovery ? '' : 'authotp'} id="authSecondFactorCode" autoComplete={recovery ? 'off' : 'one-time-code'} inputMode={recovery ? 'text' : 'numeric'} required autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label>
        <button className="formcommit" id="authSecondFactorButton" type="submit" disabled={busy}>Sign in</button>
      </form>
      <div className="authlinks">
        <button className="authlink" type="button" onClick={onRecovery}>{recovery ? 'Use authenticator code' : 'Use a recovery code'}</button>
        <button className="authlink" type="button" onClick={onRestart}>Start sign-in again</button>
      </div>
      <AuthError id="authSecondFactorError" message={error} />
    </div>
  );
}

interface UsernameProps { username: string; onUsername: (value: string) => void }

function LegacyLoginPanel({ api, username, onUsername, onSignedIn, onBack, onRecovery }: UsernameProps & {
  api: WorkspaceApi; onSignedIn: () => Promise<void>; onBack: () => void; onRecovery: () => void;
}) {
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.authApi<WorkspaceLoginAnswer>('auth/login', jsonBody({ username: canonicalUsername(username), code })); await onSignedIn(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <div className="authpanel" id="authLoginPanel">
      <h2>Existing authenticator login</h2>
      <div className="authsub">Use this only if your account was created before email sign-in. Once inside, add your email in Settings.</div>
      <form id="authLoginForm" autoComplete="on" onSubmit={(event) => { void submit(event); }}>
        <label className="authfield"><span>Username</span><input id="authUsername" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern={WORKSPACE_USERNAME_PATTERN_SOURCE} autoFocus value={username} onChange={(event) => onUsername(event.target.value)} /></label>
        <label className="authfield"><span>Authenticator code</span><input className="authotp" id="authCode" name="one-time-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]{6,11}" maxLength={11} required value={code} onChange={(event) => setCode(event.target.value)} /></label>
        <button className="formcommit" id="authLoginButton" type="submit" disabled={busy}>Sign in</button>
      </form>
      <div className="authlinks">
        <button className="authlink" id="authRecoveryLink" type="button" onClick={onRecovery}>Use a recovery code</button>
        <button className="authlink" type="button" onClick={onBack}>Back to email sign-in</button>
      </div>
      <AuthError id="authLoginError" message={error} />
    </div>
  );
}

function LegacyRecoveryPanel({ api, username, onUsername, onSignedIn, onBack }: UsernameProps & {
  api: WorkspaceApi; onSignedIn: () => Promise<void>; onBack: () => void;
}) {
  const [recoveryCode, setRecoveryCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.authApi<WorkspaceRecoveryAnswer>('auth/recovery', jsonBody({ username: canonicalUsername(username), recoveryCode })); await onSignedIn(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <div className="authpanel" id="authRecoveryPanel">
      <h2>Use a recovery code</h2>
      <form id="authRecoveryForm" onSubmit={(event) => { void submit(event); }}>
        <label className="authfield"><span>Username</span><input id="authRecoveryUsername" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(event) => onUsername(event.target.value)} /></label>
        <label className="authfield"><span>Recovery code</span><input id="authRecoveryCode" autoComplete="off" autoCapitalize="characters" spellCheck={false} required autoFocus value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} /></label>
        <button className="formcommit" id="authRecoveryButton" type="submit" disabled={busy}>Recover access</button>
      </form>
      <div className="authlinks"><button className="authlink" type="button" onClick={onBack}>Back</button></div>
      <AuthError id="authRecoveryError" message={error} />
    </div>
  );
}
