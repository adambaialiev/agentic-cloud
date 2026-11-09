import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DirectMessageApproval, DirectMessageApprovalAnswer } from '../../../../src/shared/direct-messages.js';
import { jsonBody } from '../../api/client.js';
import { Markdown } from '../../render/Markdown.js';
import { toFor } from '../../routes.js';
import { errorMessage } from '../../ui/format.js';
import { useOrgApi, useOrgId } from '../org/useOrgApi.js';

const POLL_MS = 5000;

/**
 * Note #1090: the Chief of Staff's draft of a direct message to a teammate,
 * decided here — the mail card's shape, with the DIRECT MESSAGE eyebrow. The
 * teammate and the exact words stand beside the two answers; only Send
 * message sends, as the person, into the teammate's Direct messages. Once it
 * is decided the platform keeps no words of it, so a decided card says what
 * happened and opens the conversation, where the message itself lives.
 */
export function MessageApprovalCard({ id, approval: initial, at, fallback }: {
  id: string;
  approval?: DirectMessageApproval;
  at?: string;
  fallback: string;
}) {
  const api = useOrgApi(), orgId = useOrgId();
  const [approval, setApproval] = useState<DirectMessageApproval | null>(initial ?? null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [said, setSaid] = useState('');

  useEffect(() => { if (initial) setApproval(initial); }, [initial]);

  const read = useCallback(async () => {
    const answer = await api.api<DirectMessageApprovalAnswer>(`api/message-approvals/${encodeURIComponent(id)}`);
    setApproval(answer.approval);
  }, [api, id]);

  useEffect(() => {
    if (approval) return;
    void read().catch((error) => setSaid(errorMessage(error)));
  }, [approval, read]);

  // Another tab may answer it; follow its own small record until it settles.
  useEffect(() => {
    if (!approval || (approval.status !== 'pending' && approval.status !== 'sending')) return;
    const timer = window.setInterval(() => { void read().catch(() => {}); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [approval?.status, read]);

  const decide = async (decision: 'approve' | 'reject') => {
    if (!approval || busy || approval.status !== 'pending') return;
    setBusy(decision); setSaid('');
    if (decision === 'approve') setApproval({ ...approval, status: 'sending' });
    try {
      const answer = await api.api<DirectMessageApprovalAnswer>(
        `api/message-approvals/${encodeURIComponent(id)}/decision`, jsonBody({ decision }));
      setApproval(answer.approval);
    } catch (error) {
      setSaid(errorMessage(error));
      await read().catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  if (!approval) {
    return (
      <div className="chatmsg platform mailapproval messageapproval loading" data-message-approval={id}>
        <div className="chatnotice"><div className="chatnoticebody">
          <div className="chatnoticehead"><span className="chatnoticelabel">Direct message</span></div>
          <div className="chatnoticetitle">{fallback}</div>
          <div className="mailapprovalanswer">{said || 'Loading the message to review…'}</div>
          {said ? <button className="btn ghost" type="button" onClick={() => { setSaid(''); void read().catch((error) => setSaid(errorMessage(error))); }}>Try again</button> : null}
        </div></div>
      </div>
    );
  }

  const { status } = approval;
  const pending = status === 'pending';
  const state = status === 'sent' ? 'Sent' : status === 'rejected' ? 'Not sent'
    : status === 'expired' ? 'Expired' : status === 'sending' ? 'Sending…' : 'Your decision';
  const tone = status === 'sent' ? 'ok' : status === 'rejected' || status === 'expired' ? 'danger' : 'act';
  const clock = at ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  const conversation = toFor({ kind: 'directMessage', id: approval.to.userId, orgId: orgId ?? undefined });
  const error = said || approval.error;

  return (
    <div className={`chatmsg platform mailapproval messageapproval ${status}`} data-message-approval={approval.id}>
      <div className="chatnotice"><div className="chatnoticebody">
        <div className="chatnoticehead">
          <span className="chatnoticelabel">Direct message</span>
          <span className={`chatnoticestatus ${tone}`}>{state}</span>
          {clock ? <span className="chatnoticetime">{clock}</span> : null}
        </div>
        <div className="chatnoticetitle">Chief of Staff wants to send this to {approval.to.name}</div>
        <dl className="mailapprovalfacts">
          <div><dt>To</dt><dd>{approval.to.name}</dd></div>
          <div><dt>From</dt><dd>You, marked “via your Chief of Staff”</dd></div>
        </dl>
        {/* Drawn exactly as the teammate will read it (Adam, 13:25 UTC):
            the agent's paragraphs, line breaks and lists, never raw markup. */}
        {approval.text ? <div className="mailapprovaltext dmformatted"><Markdown source={approval.text} className="chatmarkdown" /></div> : null}
        {pending ? (
          <div className="mailapprovalactions">
            <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={() => { void decide('approve'); }}>
              {busy === 'approve' ? 'Sending…' : 'Send message'}
            </button>
            <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={() => { void decide('reject'); }}>
              Don’t send
            </button>
          </div>
        ) : null}
        {error && status !== 'sent' ? <div className="mailapprovalerror" role="alert">{error}</div> : null}
        {status === 'sent' ? <div className="mailapprovalanswer" role="status">
          Sent to {approval.to.name}.{conversation ? <> <Link to={conversation}>Open the conversation</Link></> : null}
        </div> : null}
        {status === 'rejected' && !approval.error ? <div className="mailapprovalanswer" role="status">Nothing was sent.</div> : null}
        {status === 'expired' ? <div className="mailapprovalanswer" role="status">Nobody answered it within a day, so nothing was sent.</div> : null}
      </div></div>
    </div>
  );
}
