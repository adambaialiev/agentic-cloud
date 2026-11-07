/**
 * "What we tell Agentic Cloud" (note #1057), on a private copy's Organization
 * screen, for its admins, under "This copy".
 *
 * The copy sends Agentic Cloud one short signed report a day, at every start,
 * and when the contact changes: counts only, plus the contact person, who is
 * the one piece of personal data in it and is there on purpose. This section
 * says so in plain words, lets an admin change the contact and turn the
 * report off (one last report says so), and shows the last report exactly as
 * it was sent, and when.
 */
import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceCopyPulse } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';
import { useOrgApi } from './useOrgApi.js';

const REASON_WORDS: Record<NonNullable<WorkspaceCopyPulse['lastPulse']>['reason'], string> = {
  daily: 'the daily report',
  boot: 'at start',
  'contact-changed': 'after a change here',
};

/** The body as sent, laid out to be read: the same fields and values. */
export function pulseBodyText(body: string | null): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function lastPulseWords(pulse: WorkspaceCopyPulse): string {
  const last = pulse.lastPulse;
  if (!last) return 'Nothing sent yet: the first report goes two minutes after the copy starts.';
  const when = `Last sent ${relative(last.sentAt)}, ${REASON_WORDS[last.reason]}`;
  return last.delivered ? `${when}. Delivered.` : `${when}. Not delivered: ${last.error ?? 'no answer'}. It tries again at the next start or the next day; nothing here depends on it.`;
}

export function switchWords(pulse: WorkspaceCopyPulse): string {
  if (pulse.licenceKeepsOn) return 'Your licence includes the daily report, so it stays on.';
  if (pulse.pulseEnabled) return 'On: once a day, at every start, and when the contact changes.';
  return 'Off. One last report told Agentic Cloud so; nothing more is sent.';
}

export function CopyPulseSection() {
  const api = useOrgApi();
  const banner = useBanner();
  const [pulse, setPulse] = useState<WorkspaceCopyPulse | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  const load = useCallback(async () => {
    try {
      setPulse(await api.api<WorkspaceCopyPulse>('api/copy/pulse'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const post = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    try {
      setPulse(await api.api<WorkspaceCopyPulse>(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      banner.show(done, true);
      return true;
    } catch (err) {
      banner.show(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    setName(pulse?.contactName ?? '');
    setEmail(pulse?.contactEmail ?? '');
    setEditing(true);
  };
  const saveContact = async () => {
    if (await post('api/copy/pulse/contact', { name, email }, 'Contact saved, and Agentic Cloud told.')) setEditing(false);
  };
  const toggle = () => {
    if (!pulse || pulse.licenceKeepsOn) return;
    const on = !pulse.pulseEnabled;
    void post('api/copy/pulse/enabled', { on }, on ? 'The daily report is on again.' : 'The daily report is off. One last report said so.');
  };

  return (
    <section id="orgCopyPulse" aria-labelledby="orgCopyPulseTitle">
      <h2 id="orgCopyPulseTitle">What we tell Agentic Cloud</h2>
      <p className="formhint" id="orgCopyPulseAbout">
        Once a day, at every start, and when the contact changes, this copy sends Agentic Cloud a short signed report:
        how many people, agents and sites, how much the agents worked in the last day, the release it runs, and whether
        it is healthy. Counts only: no messages, code, files, mail, keys or names, except the contact person below.
        Their name and email are in it on purpose, so Agentic Cloud knows who to write to.
      </p>
      <div className="card" id="orgCopyPulseCard">
        {!pulse
          ? <div className="empty">{error || 'Reading…'}</div>
          : (
            <>
              {editing
                ? (
                  <div id="orgCopyPulseContactForm">
                    <label className="drow frow">
                      <span className="k">Name</span>
                      <input id="orgCopyPulseName" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label className="drow frow">
                      <span className="k">Email</span>
                      <input id="orgCopyPulseEmail" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                    </label>
                    <div className="actions">
                      <button className="btn primary" id="orgCopyPulseSave" type="button" disabled={busy || !email.trim()} onClick={() => { void saveContact(); }}>Save</button>
                      <button className="btn ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
                    </div>
                  </div>
                )
                : (
                  <button className="row open" id="orgCopyPulseContact" type="button" onClick={startEdit}>
                    <div className="main">
                      <div className="name plain">Contact person</div>
                      <div className="meta">
                        {pulse.contactEmail
                          ? `${pulse.contactName && pulse.contactName !== pulse.contactEmail ? `${pulse.contactName} · ` : ''}${pulse.contactEmail}`
                          : 'Nobody yet: add who Agentic Cloud should write to'}
                      </div>
                    </div>
                  </button>
                )}
              <button
                className="row open" id="orgCopyPulseSwitch" type="button" role="switch"
                aria-checked={pulse.licenceKeepsOn || pulse.pulseEnabled} disabled={busy || pulse.licenceKeepsOn} onClick={toggle}
              >
                <div className="main">
                  <div className="name plain">Daily report</div>
                  <div className="meta">{switchWords(pulse)}</div>
                </div>
                <span className={`lbswitch${pulse.licenceKeepsOn || pulse.pulseEnabled ? ' on' : ''}`} aria-hidden="true"><span /></span>
              </button>
              <div className="crow" id="orgCopyPulseLast" data-delivered={pulse.lastPulse ? String(pulse.lastPulse.delivered) : 'none'}>
                <div className="main">
                  <div className="name plain">Last report</div>
                  <div className="cline wrap"><span className="ctext">{lastPulseWords(pulse)}</span></div>
                  {pulse.lastPulse?.body
                    ? <button className="linkword" id="orgCopyPulseShow" type="button" onClick={() => setShown(!shown)}>{shown ? 'Hide what was sent' : 'Show exactly what was sent'}</button>
                    : null}
                </div>
              </div>
              {shown && pulse.lastPulse?.body ? <pre className="logtail" id="orgCopyPulseBody">{pulseBodyText(pulse.lastPulse.body)}</pre> : null}
            </>
          )}
      </div>
    </section>
  );
}
