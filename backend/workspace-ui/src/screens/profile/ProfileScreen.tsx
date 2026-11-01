/**
 * Settings (`/profile`): the name and picture teammates see beside your
 * agents' work, the X profile your builder page links to, browser login and
 * its sessions, and the sign-out for this browser. The address stays stable for copied links; the screen's name now
 * covers every account control it carries (note #450).
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  WorkspaceBrowserSessionRow,
  WorkspaceBrowserSessionsListAnswer,
  WorkspaceEmailLinkAnswer,
  WorkspaceRecoveryEmailAnswer,
  WorkspaceEnrollmentFinishAnswer,
  WorkspaceEnrollmentStartAnswer,
  WorkspaceSessionsRevokedAnswer,
} from '../../../../src/shared/workspace-api.js';
import type {
  WorkspaceMailAddressClaimAnswer,
  WorkspaceMailWakeAnswer,
  WorkspaceMailWakeCandidate,
} from '../../../../src/shared/workspace-mail.js';
import { MAIL_DOMAIN, isMailDomainAddress, normalizeMailLocal } from '../../../../src/shared/workspace-mail.js';
import { jsonBody } from '../../api/client.js';
import { MailAddressField, type MailAddressStatus } from '../../mail/MailAddressField.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { Icon } from '../../ui/icons.js';
import { AuthenticatorSetup } from '../../auth/AuthenticatorSetup.js';
import { PictureFrame } from './PictureFrame.js';
import { XProfileSettings } from './XProfileSettings.js';
import { PRIVATE_COPY } from '../../../../src/shared/private-copy.js';

/** How big a chosen picture may be. What goes up is the square cut under
 *  the circle (note #660), a few hundred KB whatever was picked, so this is
 *  about what a phone can open rather than what the server keeps — 20 MB
 *  lets a straight-from-the-camera photo through, which 5 MB did not. */
const PICTURE_MAX = 20 * 1024 * 1024;

function AccountRow({ title, detail, action, onAction, disabled, className }: {
  title: string; detail?: ReactNode; action?: string | null; onAction?: () => void; disabled?: boolean; className?: string;
}) {
  const main = (
    <div className="main">
      <div className="name plain">{title}</div>
      {detail ? <div className="meta">{detail}</div> : null}
    </div>
  );
  if (!action) return <div className={`row${className ? ` ${className}` : ''}`}>{main}</div>;
  return (
    <button className={`row open${className ? ` ${className}` : ''}`} type="button" disabled={disabled} onClick={onAction}>
      {main}
      <span className="act">{action}</span>
    </button>
  );
}

function BrowserSessions({ onSignedOutEverywhere }: { onSignedOutEverywhere: () => void }) {
  const { api } = useSession();
  const banner = useBanner();
  const ask = useConfirm();
  const [sessions, setSessions] = useState<WorkspaceBrowserSessionRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.authApi<WorkspaceBrowserSessionsListAnswer>('auth/sessions')
      .then((answer) => { if (!cancelled) setSessions(answer.sessions ?? []); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [api, generation]);

  return (
    <div id="profileBrowserSetup">
      <div className="card authpanel">
        <h2>Browser sessions</h2>
        <div className="authsub">You can revoke any browser without changing your email or security settings.</div>
        {!sessions ? <div className="empty">{error || 'Loading…'}</div> : null}
        {sessions && sessions.length === 0 ? <div className="empty">No active browser sessions.</div> : null}
        {sessions?.map((session) => (
          <AccountRow
            key={session.sessionId}
            className="sessionrow"
            title={session.current ? 'This browser' : 'Browser session'}
            detail={`${session.userAgent || 'Unknown browser'} · active ${relative(session.lastSeenAt)}`}
            action={session.current ? null : 'Revoke'}
            disabled={busy === session.sessionId}
            onAction={async () => {
              setBusy(session.sessionId);
              try {
                await api.authApi(`auth/sessions/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' });
                setGeneration((n) => n + 1);
              } catch (err) { banner.show(errorMessage(err)); }
              setBusy(null);
            }}
          />
        ))}
        {sessions && sessions.length > 1
          ? (
            <button className="btn ghost" type="button" disabled={busy === 'others'} onClick={async () => {
              setBusy('others');
              try {
                const result = await api.authApi<WorkspaceSessionsRevokedAnswer>('auth/logout-others', { method: 'POST' });
                banner.show(`Signed out ${result.revoked} other session${result.revoked === 1 ? '' : 's'}.`, true);
                setGeneration((n) => n + 1);
              } catch (err) { banner.show(errorMessage(err)); }
              setBusy(null);
            }}>
              Sign out everywhere else
            </button>
          )
          : null}
        {sessions && sessions.length
          ? (
            <button className="btn ghost" type="button" disabled={busy === 'all'} onClick={async () => {
              if (!(await ask({
                title: 'Sign out every browser session?',
                message: 'Every browser signed in to this account is signed out, this one included — you sign in again here.',
                verb: 'Sign out',
              }))) return;
              setBusy('all');
              try {
                await api.authApi('auth/logout-all', { method: 'POST' });
                onSignedOutEverywhere();
              } catch (err) { banner.show(errorMessage(err)); setBusy(null); }
            }}>
              Sign out every browser
            </button>
          )
          : null}
      </div>
    </div>
  );
}

function EmailLinkSetup({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const { api } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (password !== confirm) throw new Error('Those passwords do not match.');
      await api.authApi<WorkspaceEmailLinkAnswer>('auth/email/link', jsonBody({ email: email.trim().toLowerCase(), password }));
      await onDone();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <form className="card authpanel" id="profileEmailSetup" onSubmit={(event) => { void submit(event); }}>
      <h2>Add email sign-in</h2>
      <div className="authsub">Email and a password of at least 10 characters become your main way into the Workspace. Your authenticator stays enabled as an extra security check.</div>
      <label className="authfield"><span>Email</span><input type="email" autoComplete="email" required autoFocus value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="authfield"><span>Password</span><input type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="authfield"><span>Confirm password</span><input type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      <button className="formcommit" type="submit" disabled={busy}>Add email sign-in</button>
      <button className="btn bare" type="button" onClick={onCancel}>Cancel</button>
      {error ? <div className="autherror" role="alert">{error}</div> : null}
    </form>
  );
}

/**
 * The outside address a forgotten password can be reset through. There is
 * no other way back into an account here, so this is the one place a
 * person can arrange one — and it is theirs only once they open our link.
 */
function RecoveryEmailSetup({ current, onDone, onCancel }: { current?: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const { api } = useSession();
  const banner = useBanner();
  const [email, setEmail] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const answer = await api.authApi<WorkspaceRecoveryEmailAnswer>('auth/email/recovery', jsonBody({ email: email.trim().toLowerCase() }));
      banner.show(`We sent a confirmation link to ${answer.email}.`, true);
      await onDone();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <form className="card authpanel" id="profileRecoverySetup" onSubmit={(event) => { void submit(event); }}>
      <h2>{current ? 'Change recovery email' : 'Add a recovery email'}</h2>
      <div className="authsub">An address outside {MAIL_DOMAIN} that you can read when you cannot sign in here. We send a link there; the address counts once you open it.</div>
      <label className="authfield"><span>Recovery email</span><input id="profileRecoveryEmail" type="email" autoComplete="email" required autoFocus value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <button className="formcommit" id="profileRecoverySend" type="submit" disabled={busy}>Send the confirmation link</button>
      <button className="btn bare" type="button" onClick={onCancel}>Cancel</button>
      {error ? <div className="autherror" role="alert">{error}</div> : null}
    </form>
  );
}

function PasswordChange({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { api } = useSession();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (password !== confirm) throw new Error('Those passwords do not match.');
      await api.authApi('auth/email/password', jsonBody({ currentPassword: current, newPassword: password }));
      onDone();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <form className="card authpanel" id="profilePasswordChange" onSubmit={(event) => { void submit(event); }}>
      <h2>Change password</h2>
      <div className="authsub">Use at least 10 characters. Your other browser sessions will be signed out.</div>
      <label className="authfield"><span>Current password</span><input type="password" autoComplete="current-password" required autoFocus value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
      <label className="authfield"><span>New password</span><input type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="authfield"><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      <button className="formcommit" type="submit" disabled={busy}>Change password</button>
      <button className="btn bare" type="button" onClick={onCancel}>Cancel</button>
      {error ? <div className="autherror" role="alert">{error}</div> : null}
    </form>
  );
}

function TotpSetup({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const { api } = useSession();
  const [enrollment, setEnrollment] = useState<WorkspaceEnrollmentStartAnswer | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.authApi<WorkspaceEnrollmentStartAnswer>('auth/totp/start', { method: 'POST' })
      .then((answer) => { if (!cancelled) setEnrollment(answer); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [api]);

  const finish = async (event: FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    setBusy(true); setError('');
    try {
      const answer = await api.authApi<WorkspaceEnrollmentFinishAnswer>('auth/totp/finish', jsonBody({ enrollmentToken: enrollment.enrollmentToken, code }));
      setCodes(answer.recoveryCodes);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  if (codes) return (
    <div className="card authpanel" id="profileTotpCodes">
      <h2>Save your recovery codes</h2>
      <div className="authsub">Each code replaces the authenticator once. They are shown only here.</div>
      <div className="recoverygrid">{codes.map((item) => <div key={item}>{item}</div>)}</div>
      <button className="btn primary" type="button" onClick={() => { void onDone(); }}>I saved them</button>
    </div>
  );

  return (
    <form className="card authpanel" id="profileTotpSetup" onSubmit={(event) => { void finish(event); }}>
      <h2>Add authenticator security</h2>
      <div className="authsub">After this, sign-in starts with email and then asks for the current code from your authenticator app.</div>
      {!enrollment && !error ? <div className="empty">Preparing…</div> : null}
      {enrollment ? (
        <>
          <img className="authqr" alt="Authenticator setup QR code" src={enrollment.qrDataUrl} />
          <AuthenticatorSetup secret={enrollment.secret} otp={enrollment.otp} />
          <label className="authfield"><span>Current code</span><input className="authotp" autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={(event) => setCode(event.target.value)} /></label>
          <button className="formcommit" type="submit" disabled={busy}>Enable extra security</button>
        </>
      ) : null}
      <button className="btn bare" type="button" onClick={onCancel}>Cancel</button>
      {error ? <div className="autherror" role="alert">{error}</div> : null}
    </form>
  );
}

function TotpDisable({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const { api } = useSession();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api.authApi('auth/totp/disable', jsonBody({ code }));
      await onDone();
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  return (
    <form className="card authpanel" id="profileTotpDisable" onSubmit={(event) => { void submit(event); }}>
      <h2>Turn off authenticator security</h2>
      <div className="authsub">Email and password will remain your sign-in. Enter the current authenticator code to remove the extra check and its recovery codes.</div>
      <label className="authfield"><span>Current code</span><input className="authotp" autoComplete="one-time-code" inputMode="numeric" required autoFocus value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <button className="formcommit" type="submit" disabled={busy}>Turn off extra security</button>
      <button className="btn bare" type="button" onClick={onCancel}>Cancel</button>
      {error ? <div className="autherror" role="alert">{error}</div> : null}
    </form>
  );
}

/**
 * WHO A LETTER WAKES (note #509, slice 11).
 *
 * The one place a person says that an arriving letter may start a turn of
 * one of their agents, and the only place the platform ever asks. NOBODY is
 * the default and stays it: mail is the one thing on this platform a stranger
 * writes, and an agent woken by a stranger's letter is a thing to opt into
 * deliberately rather than something a slice turns on for everybody.
 *
 * ONE agent, not a list. Two agents woken by the same letter is two turns
 * spent on one piece of post, and a person who wants a different one changes
 * their mind here in a tap.
 *
 * The roster is everybody's agents in every room of theirs, because that is
 * already the reach an agent has into their mail (slice 6 keys mail on the
 * person, never on a workplace). The Workspace Agent is not in it: its
 * conversation is started by its person or by its own coordination, exactly
 * as it is for a finished job.
 */
function MailWakeRow() {
  const { api } = useSession();
  const banner = useBanner();
  const [answer, setAnswer] = useState<WorkspaceMailWakeAnswer | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const read = await api.api<WorkspaceMailWakeAnswer>('api/mail/wake');
        if (alive) setAnswer(read);
      } catch { /* The row simply does not offer the choice. */ }
    })();
    return () => { alive = false; };
  }, [api]);

  const choose = async (agent: WorkspaceMailWakeCandidate | null) => {
    setBusy(agent?.id ?? 'nobody'); setError('');
    try {
      const written = await api.api<WorkspaceMailWakeAnswer>(
        'api/mail/wake',
        jsonBody({ agentId: agent?.id ?? null }, 'PUT'),
      );
      setAnswer(written);
      setOpen(false);
      banner.show(written.agent ? `${written.agent.name} is woken when mail arrives.` : 'Nothing is woken when mail arrives.', true);
    } catch (err) { setError(errorMessage(err)); }
    setBusy(null);
  };

  if (!answer) return null;
  const chosen = answer.agent;
  // The row's own line does three different jobs, and which one it is doing
  // is the whole news: a name, the default, or a choice that has fallen away
  // — which nothing else tells them, because the wake itself falls back to
  // nobody in silence.
  // The agent's room rode beside its name while there were rooms (note #843).
  const detail = chosen
    ? chosen.name
    : answer.lapsed
      ? 'Your agent is gone — pick another'
      : 'Nobody';

  if (!open) {
    return (
      <AccountRow
        className="mailwakerow"
        title="When mail arrives, wake"
        detail={detail}
        action={answer.agents.length ? 'Change' : null}
        onAction={() => { setError(''); setOpen(true); }}
      />
    );
  }
  const pick = (id: string | null, name: string, line: string, agent: WorkspaceMailWakeCandidate | null) => (
    <button
      className={`row open mailwakepick${(chosen?.id ?? null) === id ? ' current' : ''}`}
      key={id ?? 'nobody'}
      type="button"
      disabled={busy !== null}
      aria-current={(chosen?.id ?? null) === id || undefined}
      onClick={() => { void choose(agent); }}
    >
      <div className="main">
        <div className="name plain">{name}</div>
        <div className="meta">{line}</div>
      </div>
      {busy === (id ?? 'nobody')
        ? <span className="spinner" />
        : (chosen?.id ?? null) === id ? <Icon name="tick" size={20} className="icon orgtick" /> : null}
    </button>
  );
  return (
    <>
      {/* The question stays on screen while it is being answered: without
          it the card is bare names under an address. */}
      <AccountRow
        className="mailwakerow"
        title="When mail arrives, wake"
        action="Cancel"
        disabled={busy !== null}
        onAction={() => { setError(''); setOpen(false); }}
      />
      {pick(null, 'Nobody', 'Default', null)}
      {answer.agents.map((agent) => pick(
        agent.id,
        agent.name,
        agent.cli || 'Your agent',
        agent,
      ))}
      {error ? <div className="autherror" role="alert">{error}</div> : null}
    </>
  );
}

/**
 * Your own address on the mail domain (note #509). A person who signed up
 * before addresses existed — or who let a signup hold lapse — picks one here,
 * and it is the same field the signup form uses.
 *
 * Under it stands the one choice this address carries — who, if anybody, a
 * letter wakes. The rows carry values, not explanations (note #641).
 */
function MailAddressCard() {
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const mailbox = state?.user?.account.mailbox ?? null;
  const [choosing, setChoosing] = useState(false);
  const [local, setLocal] = useState('');
  const [status, setStatus] = useState<MailAddressStatus>('empty');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const claim = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const answer = await api.api<WorkspaceMailAddressClaimAnswer>('api/mail/address', jsonBody({ local: normalizeMailLocal(local) }));
      banner.show(`${answer.mailbox.address} is yours.`, true);
      setChoosing(false);
      setLocal('');
      await reload();
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  };

  return (
    <>
      <h2>Your address</h2>
      <div className="card" id="profileMailCard">
        {mailbox
          ? (
            <>
              <AccountRow title={mailbox.address} />
              <MailWakeRow />
            </>
          )
          : choosing
            ? (
              <form className="mailclaim" onSubmit={(event) => { void claim(event); }}>
                <MailAddressField api={api} id="profileMailbox" value={local} onChange={setLocal} onStatus={setStatus} autoFocus disabled={busy} />
                <div className="authactions">
                  <button className="btn bare" type="button" onClick={() => { setChoosing(false); setError(''); }}>Cancel</button>
                  <button className="formcommit" id="profileMailClaim" type="submit" disabled={busy || status !== 'free'}>Take this address</button>
                </div>
                {error ? <div className="autherror" role="alert">{error}</div> : null}
              </form>
            )
            : <AccountRow title="Choose your address" detail={`Your name at ${MAIL_DOMAIN} — cannot be changed later`} action="Choose" onAction={() => setChoosing(true)} />}
      </div>
    </>
  );
}

export function ProfileScreen() {
  const { api, refresh, signOut, state: session } = useSession();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const ask = useConfirm();
  const user = state?.user ?? null;
  const profile = user?.profile;
  const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ');
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [emailSetupOpen, setEmailSetupOpen] = useState(false);
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);
  const [totpDisableOpen, setTotpDisableOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const picture = useRef<HTMLInputElement>(null);
  // The picture being framed (note #660), and the object URL the frame
  // draws it from — made here, when it is chosen, and let go on close.
  const [framing, setFraming] = useState<{ file: File; url: string } | null>(null);
  const browser = user?.account.browserLogin ?? { enabled: false as const };
  const identity = browser.enabled
    ? browser.method === 'email' ? browser.email : browser.username
    : session.status === 'signed-in' ? session.session.username : '';
  // Their sign-in name is an address we host, not an outside email they had
  // to prove (note #509).
  const ownAddress = browser.enabled && browser.method === 'email' && isMailDomainAddress(browser.email);
  const openEditor = () => { setFirst(profile?.firstName ?? ''); setLast(profile?.lastName ?? ''); setEditing(true); };

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.api('api/profile', jsonBody({ firstName: first.trim(), lastName: last.trim() }));
      banner.show('Saved.', true);
      setEditing(false);
      await reload();
    } catch (error) { banner.show(errorMessage(error)); }
    setBusy(false);
  };

  const choosePicture = (file: File | undefined) => {
    if (!file) return;
    if (file.size > PICTURE_MAX) { banner.show('A picture here is up to 20 MB.'); return; }
    setFraming({ file, url: URL.createObjectURL(file) });
  };

  const closeFrame = () => {
    if (framing) URL.revokeObjectURL(framing.url);
    setFraming(null);
  };

  /** The framed square goes up. A refusal throws back into the frame, which
   *  stays open with the reason, so the reader can try again. */
  const uploadPicture = async (square: Blob) => {
    await api.api('api/profile/photo', { method: 'POST', headers: { 'Content-Type': square.type || 'image/jpeg' }, body: square });
    closeFrame();
    banner.show('That’s you now.', true);
    await reload();
  };

  return (
    <div className="screen" id="screenProfile">
      <ScreenTitle
        mark={profile?.photoUrl ? <img className="aface" id="profileFace" alt="" src={profile.photoUrl} /> : null}
        title="Settings"
        subId="profileSub"
        sub={profile?.incomplete ? 'Add your name and picture' : user?.name ?? ''}
      />
      {editing
        ? (
          <form id="profileForm" autoComplete="off" onSubmit={(event) => { void saveName(event); }}>
            <div className="card">
              <label className="drow frow">
                <div className="k">First name</div>
                <VoiceField onTranscript={setFirst}>
                  <input id="profileFirst" maxLength={64} required value={first} onChange={(event) => setFirst(event.target.value)} autoFocus />
                </VoiceField>
              </label>
              <label className="drow frow">
                <div className="k">Last name</div>
                <VoiceField onTranscript={setLast}>
                  <input id="profileLast" maxLength={64} required value={last} onChange={(event) => setLast(event.target.value)} />
                </VoiceField>
              </label>
            </div>
            <button className="formcommit" id="profileSave" type="submit" disabled={busy}>Save name</button>
            <button className="btn bare" id="profileNameCancel" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        )
        : (
          <div className="card" id="profileNameCard">
            <AccountRow title="Name" detail={fullName || 'Not set yet'} action={fullName ? 'Edit' : 'Add'} onAction={openEditor} />
          </div>
        )}
      <h2>Picture</h2>
      <div className="card" id="profilePhotoCard">
        <button className="addrow cardtop" type="button" onClick={() => picture.current?.click()}>{profile?.photoUrl ? 'Choose a different picture' : 'Choose a picture'}</button>
        {profile?.photoUrl
          ? (
            <button className="addrow" type="button" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await api.api('api/profile/photo', { method: 'DELETE' });
                banner.show('Picture removed.', true);
                await reload();
              } catch (error) { banner.show(errorMessage(error)); }
              setBusy(false);
            }}>
              Remove the picture
            </button>
          )
          : null}
      </div>
      <input type="file" id="profilePhotoInput" accept="image/jpeg,image/png,image/webp" hidden ref={picture} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; choosePicture(file); }} />
      {framing
        ? (
          <PictureFrame
            file={framing.file}
            url={framing.url}
            onCancel={closeFrame}
            onUse={uploadPicture}
            onBroken={() => { closeFrame(); banner.show('That file would not open as a picture — try a JPEG, PNG or WebP.'); }}
          />
        )
        : null}
      {/* A private copy's pages carry no numbers, so no Follow on X
          either (note #814). */}
      {PRIVATE_COPY ? null : <XProfileSettings />}
      <MailAddressCard />
      <h2>Access</h2>
      <div className="card" id="profileAccessCard">
        {browser.enabled || identity
          ? (
            <>
              <AccountRow
                title={browser.enabled && browser.method === 'email' ? (ownAddress ? 'Sign-in' : 'Email sign-in') : 'Authenticator sign-in'}
                detail={browser.enabled && browser.method === 'email' ? browser.email : `@${identity}`}
                action={browser.enabled && browser.method === 'totp' ? 'Add email' : 'Sessions'}
                onAction={() => { if (browser.enabled && browser.method === 'totp') setEmailSetupOpen(true); else setSessionsOpen(true); }}
              />
              {browser.enabled && browser.method === 'email' ? (
                <>
                  <AccountRow title="Password" action="Change" onAction={() => setPasswordOpen(true)} />
                  {/* The one way back in after a forgotten password. Absent
                      means exactly that, and the row says so rather than
                      letting anyone assume a reset exists. */}
                  <AccountRow
                    title="Recovery email"
                    className="recoveryrow"
                    detail={browser.recoveryEmail
                      ? browser.recoveryEmail.status === 'verified'
                        ? browser.recoveryEmail.email
                        : `${browser.recoveryEmail.email} — not confirmed yet`
                      : 'None'}
                    action={browser.recoveryEmail ? 'Change' : 'Add'}
                    onAction={() => setRecoveryOpen(true)}
                  />
                  {/* An address on our own domain was minted for this account:
                      there is no outside owner to confirm, so the row that
                      reports that confirmation belongs only to the accounts
                      that still sign in with an outside email. */}
                  {ownAddress ? null : (
                    <AccountRow
                      title="Email ownership"
                      detail={browser.verificationStatus === 'verified' ? 'Confirmed' : 'Not confirmed yet'}
                    />
                  )}
                  <AccountRow
                    title="Authenticator security"
                    detail={browser.secondFactorEnabled ? 'On' : 'Off'}
                    action={browser.secondFactorEnabled ? 'Disable' : 'Enable'}
                    onAction={() => { if (browser.secondFactorEnabled) setTotpDisableOpen(true); else setTotpSetupOpen(true); }}
                  />
                </>
              ) : null}
              <AccountRow title="This browser" detail={`Signed in as ${browser.enabled && browser.method === 'email' ? identity : `@${identity}`}`} action="Sign out" onAction={() => { void signOut(); }} />
            </>
          )
          : <AccountRow title="Browser login" detail="Not available for this account" />}
      </div>
      {emailSetupOpen ? <EmailLinkSetup onCancel={() => setEmailSetupOpen(false)} onDone={async () => { setEmailSetupOpen(false); await Promise.all([reload(), refresh()]); }} /> : null}
      {passwordOpen ? <PasswordChange onCancel={() => setPasswordOpen(false)} onDone={() => setPasswordOpen(false)} /> : null}
      {recoveryOpen ? (
        <>
          <RecoveryEmailSetup
            current={browser.enabled && browser.method === 'email' ? browser.recoveryEmail?.email : undefined}
            onCancel={() => setRecoveryOpen(false)}
            onDone={async () => { setRecoveryOpen(false); await reload(); }}
          />
          {browser.enabled && browser.method === 'email' && browser.recoveryEmail ? (
            <button className="btn bare" id="profileRecoveryRemove" type="button" disabled={busy} onClick={async () => {
              if (!(await ask({
                title: 'Remove the recovery email?',
                message: 'A forgotten password could then not be reset.',
                verb: 'Remove',
              }))) return;
              setBusy(true);
              try {
                await api.authApi('auth/email/recovery', { method: 'DELETE' });
                banner.show('Recovery email removed.', true);
                setRecoveryOpen(false);
                await reload();
              } catch (error) { banner.show(errorMessage(error)); }
              setBusy(false);
            }}>
              Remove the recovery email
            </button>
          ) : null}
        </>
      ) : null}
      {totpSetupOpen ? <TotpSetup onCancel={() => setTotpSetupOpen(false)} onDone={async () => { setTotpSetupOpen(false); await reload(); }} /> : null}
      {totpDisableOpen ? <TotpDisable onCancel={() => setTotpDisableOpen(false)} onDone={async () => { setTotpDisableOpen(false); await reload(); }} /> : null}
      {sessionsOpen ? <BrowserSessions onSignedOutEverywhere={() => { void refresh(); }} /> : null}
    </div>
  );
}
