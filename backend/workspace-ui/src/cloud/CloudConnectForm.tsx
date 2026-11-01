import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { WorkspaceOrgFlyAnswer, WorkspaceOrgFlyMoveAsked } from '../../../src/shared/workspace-api.js';
import { jsonBody } from '../api/client.js';
import { useSession } from '../session/useSession.js';
import { errorMessage } from '../ui/format.js';

/**
 * The rest of what a move strands, in one sentence, from the workplace's
 * own record (note #372, Oscar's review).
 *
 * Repositories, their backups and the files on notes, pages and chats all
 * live in the account being left — the git host is an app and a volume there,
 * the two buckets are Fly extensions on it — and every one of them is reached
 * through the token and the peer a move re-points. Named separately from the
 * machines because they are the half nobody has on screen to count.
 */
function strandedWords(move: WorkspaceOrgFlyMoveAsked['move']): string {
  const parts: string[] = [];
  if (move.leaves.gitHost) {
    parts.push(move.leaves.gitBackup ? 'your repositories and their backups' : 'your repositories');
  }
  if (move.leaves.media) parts.push('every file on a note, page or chat');
  if (parts.length === 0) return '';
  // A comma before the second `and`: the first part already carries one
  // ("repositories and their backups"), and three ands in a row is a sentence
  // nobody parses on a phone.
  const said = parts.length === 1 ? parts[0]! : `${parts[0]!}, and ${parts[1]!}`;
  return ` That includes ${said}, which live in ${move.fromSlug} too.`;
}

/** The token stays in this form until it is sent directly to encrypted org storage. */
/**
 * Two facts a founder reading fast assumes wrong (note #153): whose card it
 * is, and why the organization should be the agents' own. Said under every
 * intro — the first connect's steps and a replacement's question alike.
 */
export function CloudBillNote() {
  return <p className="cloudbill">
    The payment method is Fly's, on your own bill: we never see it and never charge you.
    A separate organization keeps our token on your agents' ground only; everything else you run on Fly stays untouched.
  </p>;
}

export function CloudConnectForm({
  orgId, onConnected, continueLabel = 'Connect cloud', idPrefix = 'orgCloud', leavesBehind, onCancel,
  intro, hideHint = false, lead,
}: {
  orgId: string;
  idPrefix?: string;
  /** The guided setup keeps the form terse; details screens retain the help. */
  hideHint?: boolean;
  onConnected?: (answer: WorkspaceOrgFlyAnswer) => void;
  continueLabel?: string;
  /** A button on the commit's row, before it (note #653: the setup gate's
   *  way out to the person's other workplaces). Given with no `onCancel`. */
  lead?: ReactNode;
  /**
   * The way out, when this form is the whole of a sheet (note #372).
   *
   * Given, it becomes the form's OWN first button in both states — so the
   * question below reads as one row of two answers, "keep what I have" beside
   * "move", rather than a pair of answers with a third Cancel underneath
   * meaning the same as the first. The first-connect callers give none: their
   * form stands in a card on a screen, with nothing to back out of.
   */
  onCancel?: () => void;
  /**
   * What a MOVE would leave behind, in the caller's own words (note #372).
   *
   * The Cloud details screen is holding the account's machine list and can
   * count them; Home cannot, and a form that guessed would be worse than one
   * that says only what it knows. Shown UNDER the question, never instead of
   * it — the consequence is the same either way, and the count is detail.
   */
  leavesBehind?: string;
  /**
   * What stands above the box, for a caller whose cloud already works.
   *
   * The default is a first connect's words and its three steps, and every one
   * of them is wrong for a REPLACEMENT: the reader has a Fly organization and
   * a card on it, and what they need said is which of the two things a paste
   * will turn out to be. Given, it takes the place of both.
   */
  intro?: ReactNode;
}) {
  const { api } = useSession();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * The move this token turned out to be, put back as a question (note #372).
   *
   * The backend cannot know a paste is a move until it has asked Fly whose
   * token it is, so the question can only be asked here, after the first
   * send. The token stays in this form's own state across it — the same paste
   * is what goes back with the answer, and it still reaches nothing but
   * encrypted org storage.
   */
  const [asked, setAsked] = useState<WorkspaceOrgFlyMoveAsked['move'] | null>(null);
  const active = useRef(true);
  const sending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const send = async (replace: string) => {
    if (!token.trim() || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const answer = await api.api<WorkspaceOrgFlyAnswer | WorkspaceOrgFlyMoveAsked>(
        'api/org/fly',
        // The agreed slug rather than a bare yes: this send answers a question
        // that named an org, and the server refuses if the token has stopped
        // resolving to it.
        jsonBody({ token: token.trim(), ...(replace ? { replace } : {}) }),
        { org: orgId },
      );
      if (!active.current) return;
      if (!answer.ok) {
        // Nothing was written. Ask, holding the paste for the answer.
        setAsked(answer.move);
        return;
      }
      setToken('');
      setAsked(null);
      window.dispatchEvent(new CustomEvent('workspace-cloud-connected', { detail: orgId }));
      onConnected?.(answer);
    } catch (err) {
      if (active.current) setError(errorMessage(err));
    } finally {
      sending.current = false;
      if (active.current) setBusy(false);
    }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    void send('');
  };
  if (asked) {
    return <div className="cloudsetup" id={`${idPrefix}Move`}>
      <p>
        That token is for <strong>{asked.toSlug}</strong>, not <strong>{asked.fromSlug}</strong>.
        Using it moves your cloud: every agent, machine and site made from now on is created
        in {asked.toSlug}, on that account’s bill.
      </p>
      {/* What stays behind, and it is not only the machines. The org's own
          record says whether its repositories, their backups and its files
          are in that account too — all three are reached through the token
          and the tunnel this move re-points, so all three go out of reach
          with it, and a warning that named only machines would be read as a
          promise about the rest. */}
      <p>
        Everything already in {asked.fromSlug} stays there and keeps billing there — this
        platform simply stops being able to reach it.
        {leavesBehind ? ` ${leavesBehind}` : ''}
        {strandedWords(asked)}
      </p>
      {/* Said separately because it is the part that surprises: the agents do
          not politely stop. Which of the two happens depends on how Fly
          answers for an app the new token cannot see, and that is not a
          promise this sentence should pick a side of. */}
      <p>
        An agent whose computer stayed behind cannot be reached from here. Its next turn either
        fails or builds it a fresh, empty computer in {asked.toSlug} — and either way the machine
        left behind keeps billing in {asked.fromSlug} until you remove it in Fly.
      </p>
      {error ? <p className="cloud-error" role="alert">{error}</p> : null}
      <div className="btns">
        <button
          className="btn ghost"
          id={`${idPrefix}Keep`}
          type="button"
          disabled={busy}
          onClick={() => { if (onCancel) onCancel(); else { setAsked(null); setToken(''); setError(''); } }}
        >
          Keep {asked.fromSlug}
        </button>
        <button
          className="btn danger"
          id={`${idPrefix}MoveGo`}
          type="button"
          disabled={busy}
          onClick={() => { void send(asked.toSlug); }}
        >
          {busy ? 'Moving…' : `Move to ${asked.toSlug}`}
        </button>
      </div>
    </div>;
  }
  return <div className="cloudsetup">
    {intro ?? <>
      <p>Your agents need a computer to work on. Fly.io runs those computers in your own cloud account, on your Fly bill.</p>
      <ol className="cloudsteps">
        <li><a href="https://fly.io/organizations/new" target="_blank" rel="noopener noreferrer">Create a Fly organization</a> for your team and add a payment method.</li>
        <li>In your <a href="https://fly.io/dashboard" target="_blank" rel="noopener noreferrer">Fly dashboard</a>, choose that organization, open <strong>Tokens</strong> and create an <strong>Org deploy token</strong>.</li>
        <li>Copy the token and paste it below.</li>
      </ol>
    </>}
    <CloudBillNote />
    <form id={`${idPrefix}Form`} autoComplete="off" onSubmit={connect}>
      <div className="card">
        <label className="drow frow">
          <div className="k">Org deploy token</div>
          <input id={`${idPrefix}Token`} type="password" placeholder="Paste the org deploy token" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} />
        </label>
      </div>
      {error ? <p className="cloud-error" role="alert">{error}</p> : null}
      {onCancel || lead
        ? <div className="btns">
          {onCancel ? <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>Cancel</button> : lead}
          <button className="formcommit" id={`${idPrefix}Connect`} type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking with Fly…' : continueLabel}</button>
        </div>
        : <button className="formcommit" id={`${idPrefix}Connect`} type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking with Fly…' : continueLabel}</button>}
    </form>
    {hideHint ? null : <div className="formhint">Checked with Fly before saving. Stored encrypted and never shared in agent chats. <a href="https://fly.io/docs/security/tokens/" target="_blank" rel="noopener noreferrer">Token help</a></div>}
  </div>;
}
