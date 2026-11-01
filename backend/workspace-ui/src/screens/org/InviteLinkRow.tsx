import { useEffect, useRef, useState } from 'react';
import type { WorkspaceOrgInvite } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { AskToConfirm } from '../../ui/Ask.js';
import { absolute, copyFromTap, errorMessage } from '../../ui/format.js';
import { Svg, TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useOrgApi } from './useOrgApi.js';

/** One standing invite link. It has no expiry — revoking is what ends it. */
export function InviteLinkRow({ invite, orgId, onChanged }: {
  invite: WorkspaceOrgInvite; orgId: string; onChanged: () => Promise<unknown>;
}) {
  const api = useOrgApi();
  const banner = useBanner();
  const field = useRef<HTMLInputElement>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    setCopying(true);
    setCopyError('');
    try {
      await copyFromTap(() => Promise.resolve(invite.link ?? ''));
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError('Select the link to copy it manually.');
      field.current?.focus();
      field.current?.select();
    } finally { setCopying(false); }
  };

  const revoke = async () => {
    setAsking(false);
    setBusy(true);
    try {
      await api.api(`api/org/invites/${encodeURIComponent(invite.token)}`, { method: 'DELETE' }, { org: orgId });
      banner.show('Invite link revoked.', true);
      await onChanged();
    } catch (error) { banner.show(errorMessage(error)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="orgjoin-link" aria-busy={busy}>
        <div className="crow">
          <TypeIcon glyph="link" />
          <div className="main">
            <div className="name plain">Invite link</div>
            <div className="cline"><span className="ctext">Works until you revoke it · Created <time dateTime={invite.createdAt} title={absolute(invite.createdAt)}>{relative(invite.createdAt) || 'just now'}</time></span></div>
          </div>
          {/* Revoking is rare and asks before it acts: a quiet glyph, not a
              red sentence under every link. */}
          <button className="orgjoin-revoke" type="button" disabled={busy} aria-label={busy ? 'Revoking…' : 'Revoke link'} title="Revoke link" onClick={() => setAsking(true)}>
            {busy ? <span className="spinner" /> : <Svg name="trash" size={14} />}
          </button>
        </div>
        <div className="orgjoin-link-tools">
          <div className="orgjoin-copyfield">
            <input ref={field} aria-label="Shareable invite link" readOnly value={invite.link ?? ''} onFocus={(event) => event.currentTarget.select()} />
            <button className="orgjoin-copy" type="button" disabled={copying || !invite.link} onClick={() => void copy()} aria-label={copied ? 'Invite link copied' : 'Copy link'}>
              <Svg name={copied ? 'tick' : 'copy'} size={17} /><span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
        {copied && !copyError ? <span className="join-sr-only" role="status">Invite link copied to clipboard.</span> : null}
        {copyError ? <p className="formfail orgjoin-inline-error" role="alert">{copyError}</p> : null}
      </div>
      {asking ? <AskToConfirm title="Revoke this invite link?" message="The link stops working at once and people will need a new one. Requests already submitted will still need an admin’s decision."
        verb="Revoke" danger onAnswer={(confirmed) => { if (confirmed) void revoke(); else setAsking(false); }} /> : null}
    </>
  );
}
