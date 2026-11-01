/**
 * Setting email up, after the install (note #946): an admin's screen in a
 * private copy, reached from the Mail section and from the workplace page.
 *
 * Three things, in the order they have to happen, and the same screen shows
 * where it stands afterwards:
 *
 *   1. How mail goes out: a Resend key, or any provider over SMTP. Checked
 *      before it is kept (a wrong key is a sentence here, not mail that never
 *      leaves), kept encrypted, never shown again.
 *   2. The mail receiver: the Workspace makes it in the company's own Fly
 *      organization, with the dedicated address mail needs. Its price is said
 *      on the button's line before anything is made.
 *   3. The records: exactly what to add at the domain's DNS provider, each
 *      marked as the domain's own name servers answer it. The Workspace
 *      checks every minute by itself and turns mail on when they are right;
 *      Check now asks at once.
 *
 * A member who lands here is told who can do it.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  WorkspaceCopyMailProviderInput, WorkspaceCopyMailRecord, WorkspaceCopyMailStatus,
} from '../../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { useOrgApi } from '../org/useOrgApi.js';

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** One record as a DNS provider's form asks for it. */
function RecordRow({ record }: { record: WorkspaceCopyMailRecord }) {
  const mark = record.ok === true ? 'In' : record.ok === false ? 'Not yet' : 'Not checked here';
  const tone = record.ok === true ? 'ok' : record.ok === false ? 'wait' : 'none';
  return <div className="crow mailrecord" data-ok={tone}>
    <div className="main">
      <div className="cline wrapline mailrecord-head">
        <span className="name plain mailrecord-name">{record.name}</span>
        <span className="mailrecord-type">{record.type}</span>
        <span className={`mailrecord-mark ${tone}`}>{mark}</span>
      </div>
      <div className="cline wrapline"><code className="mailrecord-value">{record.priority !== undefined ? `${record.priority} ${record.value}` : record.value}</code></div>
      <div className="cline wrapline"><span className="ctext">{record.why}</span></div>
    </div>
  </div>;
}

function stateLine(status: WorkspaceCopyMailStatus): string {
  if (status.state === 'on') {
    const certificate = status.certificate === 'issued' ? 'Mail in is encrypted.' : 'The mail receiver\'s certificate is still coming: until it does, mail arrives unencrypted.';
    return `Email is on${status.fromInstall ? ' (set up by the installer)' : ''}. ${certificate}`;
  }
  if (status.state === 'records') {
    const missing = status.records.filter((record) => record.ok === false).length;
    if (!status.checkedAt) return 'Add the records below. Email turns on by itself once they are in.';
    if (missing) return `Waiting for ${missing} of ${status.records.filter((record) => record.ok !== null).length} records. Email turns on by itself once they are in.`;
    if (status.provider?.kind === 'resend' && status.providerVerified !== true) return 'Every record is in. Waiting for Resend to verify the domain.';
    return 'Every record is in. Turning email on…';
  }
  if (status.state === 'provider') return 'The provider is saved. Next, the mail receiver.';
  return 'Email is not set up yet.';
}

export function MailSetupScreen() {
  const api = useOrgApi();
  const { state } = useWorkspace();
  const [status, setStatus] = useState<WorkspaceCopyMailStatus | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState('');
  const [kind, setKind] = useState<'resend' | 'smtp'>('smtp');
  const [apiKey, setApiKey] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.api<WorkspaceCopyMailStatus>('api/copy/mail'));
    } catch (error) {
      setFailed(errorMessage(error));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  // While it waits on DNS, the screen keeps up with the server's own checks.
  useEffect(() => {
    if (status?.state !== 'records' && !(status?.state === 'on' && status.certificate !== 'issued')) return undefined;
    const timer = setInterval(() => { void load(); }, 20_000);
    return () => clearInterval(timer);
  }, [load, status?.state, status?.certificate]);

  const run = async (what: string, path: string, init: RequestInit) => {
    setBusy(what);
    setFailed('');
    try {
      const answer = await api.api<WorkspaceCopyMailStatus>(path, init);
      setStatus(answer);
      return answer;
    } catch (error) {
      setFailed(errorMessage(error));
      return null;
    } finally {
      setBusy('');
    }
  };

  const saveProvider = async () => {
    const input: WorkspaceCopyMailProviderInput = kind === 'resend'
      ? { kind: 'resend', apiKey: apiKey.trim() }
      : { kind: 'smtp', host: host.trim(), port: Number(port), ...(user.trim() ? { user: user.trim(), password } : {}) };
    const saved = await run('provider', 'api/copy/mail/provider', json(input));
    if (!saved) return;
    setApiKey('');
    setPassword('');
    setChanging(false);
    // A first setup goes straight on to the receiver: one tap, as promised.
    if (!saved.receiver && !saved.fromInstall) await run('receiver', 'api/copy/mail/receiver', { method: 'POST' });
  };

  if (state && state.mailSetup && !state.mailSetup.canSetUp) {
    return <div className="screen" id="screenMailSetup">
      <ScreenTitle title="Set up email" />
      <div className="card"><div className="empty">Only an admin of this workplace sets up email.</div></div>
    </div>;
  }

  const showForm = status && !status.fromInstall && (!status.provider || changing);
  const ready = kind === 'resend' ? apiKey.trim().length > 8 : host.trim().length > 3 && (!user.trim() || password.length > 0);

  return <div className="screen" id="screenMailSetup">
    <ScreenTitle title="Set up email" sub={status ? `Addresses on ${status.domain}` : undefined} />
    {failed ? <div className="hintblock mailwarn" role="alert" id="mailSetupFailed">{failed}</div> : null}
    {!status ? <div className="card"><div className="empty">{failed ? 'Could not read the email setup.' : 'Reading…'}</div></div> : null}
    {status ? <div className="card" id="mailSetupState">
      <div className="crow">
        <div className="main">
          <div className="name plain" id="mailSetupLine">{stateLine(status)}</div>
          {status.checkedAt ? <div className="cline wrapline"><span className="ctext">Checked {relative(status.checkedAt)}</span></div> : null}
        </div>
      </div>
    </div> : null}
    {status?.unavailable ? <div className="hintblock mailwarn" role="alert" id="mailSetupUnavailable">{status.unavailable}</div> : null}

    {status && !status.unavailable ? <>
      <h2>1. How mail goes out</h2>
      <div className="card" id="mailSetupProvider">
        {status.provider && !changing
          ? <div className="crow">
            <div className="main">
              <div className="name plain">{status.provider.kind === 'resend' ? 'Resend' : 'SMTP'}</div>
              <div className="cline wrapline"><span className="ctext">{status.provider.line}</span></div>
            </div>
          </div>
          : null}
        {status.provider && !changing && !status.fromInstall
          ? <button className="addrow" type="button" id="mailProviderChange" onClick={() => setChanging(true)}>Change the provider</button>
          : null}
        {showForm ? <div className="mailsetupform">
          <div className="segtabs" role="tablist" aria-label="Mail provider">
            <button className="segtab" type="button" role="tab" id="mailProviderSmtp" aria-selected={kind === 'smtp'} onClick={() => setKind('smtp')}>Any provider (SMTP)</button>
            <button className="segtab" type="button" role="tab" id="mailProviderResend" aria-selected={kind === 'resend'} onClick={() => setKind('resend')}>Resend</button>
          </div>
          {kind === 'resend'
            ? <label className="drow frow">
              <div className="head"><div className="k">Resend key</div></div>
              <input id="mailResendKey" type="password" autoComplete="off" spellCheck={false} placeholder="re_…" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </label>
            : <>
              <label className="drow frow">
                <div className="head"><div className="k">Host</div></div>
                <input id="mailSmtpHost" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="smtp.postmarkapp.com" value={host} onChange={(event) => setHost(event.target.value)} />
              </label>
              <div className="drow frow">
                <div className="head"><div className="k">Port</div></div>
                <div className="segtabs" role="tablist" aria-label="SMTP port" id="mailSmtpPort">
                  {['587', '465'].map((value) => <button
                    key={value} className="segtab" type="button" role="tab" data-port={value}
                    aria-selected={port === value} onClick={() => setPort(value)}
                  >{value === '587' ? '587 (STARTTLS)' : '465 (TLS)'}</button>)}
                </div>
              </div>
              <label className="drow frow">
                <div className="head"><div className="k">User</div></div>
                <input id="mailSmtpUser" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={user} onChange={(event) => setUser(event.target.value)} />
              </label>
              <label className="drow frow">
                <div className="head"><div className="k">Password</div></div>
                <input id="mailSmtpPassword" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
            </>}
          <button className="addrow" type="button" id="mailProviderSave" disabled={!ready || Boolean(busy)} onClick={() => { void saveProvider(); }}>
            {busy ? <span className="spinner" /> : null}
            {busy === 'receiver' ? 'Making the mail receiver…' : busy === 'provider' ? 'Checking…' : status.receiver ? 'Save' : 'Save and make the mail receiver'}
          </button>
          {changing ? <button className="addrow" type="button" disabled={Boolean(busy)} onClick={() => setChanging(false)}>Cancel</button> : null}
        </div> : null}
      </div>
      {showForm ? <p className="formhint">
        {kind === 'resend'
          ? `A Resend key with full access: the Workspace registers ${status.domain} there and shows you its records.`
          : 'The Workspace signs in to check it before it keeps anything.'}
        {' '}The key is kept encrypted and never shown again.
        {!status.receiver ? ` Saving also makes the mail receiver in your Fly organization: about $${status.monthlyUsd.toFixed(2)} a month at Fly's list prices, billed by Fly.` : ''}
      </p> : null}

      <h2>2. The mail receiver</h2>
      <div className="card" id="mailSetupReceiver">
        {status.receiver
          ? <div className="crow">
            <div className="main">
              <div className="name plain">{status.receiver.app}</div>
              <div className="cline wrapline"><span className="ctext">
                At {status.receiver.ipv4}, in your Fly organization{status.receiver.adopted ? ' (made by the installer, kept as it is)' : ''}.
                {' '}{status.certificate === 'issued' ? 'Its certificate is in.' : 'Its certificate comes by itself once its records are in.'}
              </span></div>
            </div>
          </div>
          : status.fromInstall
            ? <div className="empty">Made by the installer.</div>
            : <>
              <div className="empty">Not made yet. It receives mail for {status.domain}, on an address of its own (about ${status.monthlyUsd.toFixed(2)} a month at Fly&apos;s list prices).</div>
              {status.provider
                ? <button className="addrow" type="button" id="mailReceiverMake" disabled={Boolean(busy)} onClick={() => { void run('receiver', 'api/copy/mail/receiver', { method: 'POST' }); }}>
                  {busy === 'receiver' ? 'Making the mail receiver…' : 'Make the mail receiver'}
                </button>
                : null}
            </>}
      </div>

      {status.records.length ? <>
        <h2>3. The records</h2>
        <p className="formhint">Add these at {status.domain}&apos;s DNS provider, all DNS only (not proxied). They are checked on the domain&apos;s own name servers every minute.</p>
        <div className="card" id="mailSetupRecords">
          {status.records.map((record) => <RecordRow key={`${record.type} ${record.name} ${record.value}`} record={record} />)}
          <button className="addrow" type="button" id="mailRecordsCheck" disabled={Boolean(busy)} onClick={() => { void run('check', 'api/copy/mail/check', { method: 'POST' }); }}>
            {busy === 'check' ? 'Checking…' : 'Check now'}
          </button>
        </div>
        {status.providerRecordsNote ? <p className="formhint" id="mailProviderRecordsNote">{status.providerRecordsNote}</p> : null}
      </> : null}
    </> : null}
  </div>;
}
