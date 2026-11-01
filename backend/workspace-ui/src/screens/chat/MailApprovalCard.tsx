import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceMailApproval, WorkspaceMailApprovalAnswer } from '../../../../src/shared/workspace-mail.js';
import { jsonBody } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { bytes } from '../../ui/file-kind.js';

const POLL_MS = 5000;

function party(value: { address: string; name?: string }): string {
  return value.name ? `${value.name} <${value.address}>` : value.address;
}

/**
 * The entire decision, inline in either chat. There is no door on this card:
 * the exact recipient, subject and body are already here, beside the two
 * answers that may release or discard them. No icon either (note #530): the
 * EMAIL eyebrow already says what this is, and the words are the point. The
 * letter itself sits in its own box, so the body reads as the thing being
 * sent rather than as more of the card's prose.
 */
export function MailApprovalCard({ id, approval: initial, at, fallback }: {
  id: string;
  approval?: WorkspaceMailApproval;
  at?: string;
  fallback: string;
}) {
  const { api } = useSession();
  const [approval, setApproval] = useState<WorkspaceMailApproval | null>(initial ?? null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [said, setSaid] = useState('');

  useEffect(() => { if (initial) setApproval(initial); }, [initial]);

  const read = useCallback(async () => {
    const answer = await api.api<WorkspaceMailApprovalAnswer>(
      `api/mail/approvals/${encodeURIComponent(id)}`,
    );
    setApproval(answer.approval);
  }, [api, id]);

  useEffect(() => {
    if (approval) return;
    void read().catch((error) => setSaid(errorMessage(error)));
  }, [approval, read]);

  // Another tab may answer this card. Chat's incremental cursor deliberately
  // does not resend old rows, so the decision itself follows its own tiny
  // record until it settles.
  useEffect(() => {
    if (!approval || (approval.status !== 'pending' && approval.status !== 'sending')) return;
    const timer = window.setInterval(() => { void read().catch(() => {}); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [approval?.status, read]);

  const decide = async (decision: 'approve' | 'reject') => {
    if (!approval) return;
    if (busy || approval.status !== 'pending') return;
    setBusy(decision); setSaid('');
    if (decision === 'approve') setApproval({ ...approval, status: 'sending' });
    try {
      const answer = await api.api<WorkspaceMailApprovalAnswer>(
        `api/mail/approvals/${encodeURIComponent(id)}/decision`,
        jsonBody({ decision }),
      );
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
      <div className="chatmsg platform mailapproval loading" data-mail-approval={id}>
        <div className="chatnotice">
          <div className="chatnoticebody">
            <div className="chatnoticehead"><span className="chatnoticelabel">Email</span></div>
            <div className="chatnoticetitle">{fallback}</div>
            <div className="mailapprovalanswer">{said || 'Loading the message to review…'}</div>
            {said ? <button className="btn ghost" type="button" onClick={() => { setSaid(''); void read().catch((error) => setSaid(errorMessage(error))); }}>Try again</button> : null}
          </div>
        </div>
      </div>
    );
  }

  const pending = approval.status === 'pending';
  const sending = approval.status === 'sending';
  const state = approval.status === 'sent' ? 'Sent'
    : approval.status === 'rejected' ? 'Not sent'
      : sending ? 'Sending…' : 'Your decision';
  const tone = approval.status === 'sent' ? 'ok'
    : approval.status === 'rejected' ? 'danger' : 'act';
  const clock = at ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

  return (
    <div className={`chatmsg platform mailapproval ${approval.status}`} data-mail-approval={approval.id}>
      <div className="chatnotice">
        <div className="chatnoticebody">
          <div className="chatnoticehead">
            <span className="chatnoticelabel">Email</span>
            <span className={`chatnoticestatus ${tone}`}>{state}</span>
            {clock ? <span className="chatnoticetime">{clock}</span> : null}
          </div>
          <div className="chatnoticetitle">
            {approval.requestedBy} wants to {approval.kind === 'reply' ? 'send this reply'
              : approval.kind === 'forward' ? 'forward this letter' : 'send this message'}
          </div>
          <dl className="mailapprovalfacts">
            <div><dt>From</dt><dd>{approval.from.address}</dd></div>
            <div><dt>To</dt><dd>{party(approval.to)}</dd></div>
            {/* Everybody it reaches, and everything that leaves with it
                (slice 12): a Cc and a file are the two parts of a letter
                nobody can read off its words. */}
            {approval.cc?.length ? <div><dt>Cc</dt><dd>{approval.cc.map(party).join(', ')}</dd></div> : null}
            <div><dt>Subject</dt><dd>{approval.subject || '(no subject)'}</dd></div>
            {approval.attachments?.length ? <div><dt>Files</dt><dd>
              <ul className="mailapprovalfiles">
                {approval.attachments.map((file, at) => <li key={`${at}-${file.fileName}`}>
                  <span className="file">{file.fileName}</span> <span className="size">{bytes(file.size)}</span>
                </li>)}
              </ul>
            </dd></div> : null}
          </dl>
          <div className="mailapprovaltext">{approval.text}</div>
          {pending ? (
            <div className="mailapprovalactions">
              <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={() => { void decide('approve'); }}>
                {busy === 'approve' ? 'Sending…' : 'Send email'}
              </button>
              <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={() => { void decide('reject'); }}>
                Don’t send
              </button>
            </div>
          ) : null}
          {approval.error || said ? <div className="mailapprovalerror" role="alert">{said || approval.error}</div> : null}
          {approval.status === 'sent' ? <div className="mailapprovalanswer" role="status">
            Sent to {[approval.to, ...(approval.cc ?? [])].map((one) => one.address).join(', ')}.
          </div> : null}
          {approval.status === 'rejected' ? <div className="mailapprovalanswer" role="status">Nothing was sent.</div> : null}
        </div>
      </div>
    </div>
  );
}
