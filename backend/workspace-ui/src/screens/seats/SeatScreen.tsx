/**
 * One seat (`/seats/:id`): its status and plan, what this workplace does
 * with it, the recovery card when the provider paused it or the sign-in
 * died, its usage windows, and the actions — primary, fallback order,
 * unassign, delete everywhere. Every mutation drops the seats cache and
 * hands the reader back the place they came FROM: it SPENDS the browser
 * entry underneath when there is one of ours, and only replaces this address
 * with the list for a pasted or reloaded one that has nothing beneath it
 * (knowledge page "miniapp-navigation"; the same shape the direct-message
 * screen's own Back keeps).
 *
 * It must not replace unconditionally (note #400). The list is usually the
 * entry directly underneath, so replacing stacked a SECOND identical list
 * entry on top of the first: the reader was returned to the list, pressed
 * Back, and spent that duplicate repainting the very same screen at the very
 * same address. Nothing moved, and the way out cost two taps instead of one
 * — which from the outside is a Back button that has stopped working.
 * Spending the entry cannot reopen a seat the server would now refuse
 * either, which is what the replace was there for: the seat's own entry is
 * the one being left, and a seat a mutation ended draws its honest "no
 * longer assigned here" card.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkspaceSeatCheckAnswer, WorkspaceSeatRecord, WorkspaceSeatUsage, WorkspaceSeatWindow } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useReturnToParent } from '../../chrome/history.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage, openExternal } from '../../ui/format.js';
import { seatHasCurrentUsage, seatNeedsPayment, signInSlug, subscriptionName } from '../../ui/seat-words.js';
import { UsageWindowRow } from '../../ui/Usage.js';
import { useFocusRefresh } from '../../ui/useFocusRefresh.js';
import { relative, useNow } from '../../ui/time.js';
import { useWait } from '../../ui/wait.js';
import { toFor } from '../../routes.js';
import { seatRecordIsBehind, useSeatCopiesInStep } from '../../workspace/seat-copies.js';
import { useSeats } from '../../workspace/useSeats.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { providerLabel } from '../home/agent-words.js';
import { SeatStatusPill } from './SeatsScreen.js';
import { SeatBar, SeatUsageWait } from './SeatWait.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

/** What the facts card reads: the full record, or the state read's row for
 *  the same subscription, which knows all of it but when it was added. */
type SeatFactsSource = Pick<WorkspaceSeatRecord, 'status' | 'attention' | 'planText' | 'selected' | 'cooldownUntil'>
  & { createdAt?: string };

/** The state read's row as the facts card reads it. That row leaves `status`
 *  out for a seat that is simply active (`workspace-seat-usage.ts`). */
function heldFacts(row: WorkspaceSeatUsage): SeatFactsSource {
  return { status: row.status ?? 'active', attention: row.attention, planText: row.planText, selected: row.selected };
}

/**
 * The state read's row as the usage card's own rows — the reading Home's
 * plate is showing, drawn in full (note #697) — when it carries every word
 * one says: a live subscription with readings, each named in full. Null for
 * anything else: a paused or signed-out subscription's last reading, which
 * that row leaves out, or a row from a server that did not name them.
 */
function heldReading(row: WorkspaceSeatUsage | null): WorkspaceSeatWindow[] | null {
  if (!row || !seatHasCurrentUsage(row) || !row.windows.length) return null;
  if (!row.windows.every((window) => window.label)) return null;
  return row.windows.map((window) => ({ ...window, label: window.label! }));
}

/** The usage card: a row per window and when the reading was taken — for the
 *  record, and for the state read's row while the record is out or behind. */
function SeatUsageCard({ windows, refreshedAt, refreshedNote = '', empty }: {
  windows: WorkspaceSeatWindow[];
  refreshedAt?: string;
  refreshedNote?: string;
  empty: string;
}) {
  return (
    <div className="card" id="seatUsageCard">
      {windows.length
        ? (
          <>
            {windows.map((w, index) => <UsageWindowRow key={index} window={w} />)}
            {refreshedAt
              ? <div className="usage-foot">Checked {relative(refreshedAt) || 'just now'}{refreshedNote}</div>
              : null}
          </>
        )
        : <div className="empty">{empty}</div>}
    </div>
  );
}

/**
 * The facts card: its status, when a resting one is back, its plan, what this
 * workplace does with it, and when it was added. ONE component for the page
 * and for its wait (note #625), so the rows the wait holds are the rows the
 * answer draws and nothing below them moves when it lands. While the read is
 * out, what the state read does not know — the day it was added, the minute a
 * resting one comes back — stands as a bar in its own line.
 */
function SeatFacts({ seat, held = false }: { seat: SeatFactsSource; held?: boolean }) {
  const paymentRequired = seatNeedsPayment(seat);
  return (
    <div className="card" id={held ? 'seatCardWait' : 'seatCard'}>
      <div className="drow"><div className="k">Status</div><div className="v"><SeatStatusPill seat={seat} /></div></div>
      {seat.status === 'cooldown' && seat.cooldownUntil
        ? <div className="drow"><div className="k">Back</div><div className="v">around {new Date(seat.cooldownUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, when its limit resets</div></div>
        : seat.status === 'cooldown' && held
          ? <div className="drow"><div className="k">Back</div><div className="v"><SeatBar width="68%" /></div></div>
          : null}
      {seat.planText ? <div className="drow"><div className="k">Plan</div><div className="v">{seat.planText}</div></div> : null}
      <div className="drow"><div className="k">This workplace</div><div className="v">{paymentRequired ? (seat.selected ? 'Primary when access is restored' : 'Fallback when access is restored') : (seat.selected ? 'Uses this subscription first' : 'Keeps it as a fallback')}</div></div>
      <div className="drow"><div className="k">Added</div><div className="v">{seat.createdAt ? (relative(seat.createdAt) || 'just now') : <SeatBar width="64px" />}</div></div>
    </div>
  );
}

export function SeatScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const seats = useSeats();
  const { fetch: fetchSeats } = seats;
  const banner = useBanner();
  const ask = useConfirm();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Whether this page's own read has answered since it opened: until then a
  // held list without this subscription may simply be older than it.
  const [answered, setAnswered] = useState(false);
  const now = useNow(false);
  const orgId = state?.org?.orgId ?? '';
  const returnToSeats = useReturnToParent(toFor({ kind: 'seats', orgId })!);
  const orgName = state?.org?.name ?? 'this workplace';
  const seat = seats.seats?.find((entry) => entry.seatId === id) ?? null;
  // The same subscription as the state read already has it — the row Home's
  // plate was drawn from — so a page opened before its own read lands still
  // says WHICH subscription it is (note #625).
  const held = state?.org?.seatUsage?.find((entry) => entry.seatId === id) ?? null;
  const known = seats.seats !== null;
  // ONE copy of the subscription (note #697). A record the seats cache has
  // held since an earlier visit painted that visit's percentages under the
  // newer ones Home had just shown, until this page's own read replaced them.
  // While the record is older than the plate the reader tapped, its usage
  // and facts give way to Home's, and the record is asked for again; with no
  // record yet, Home's reading is drawn in full while the read is out.
  const behind = seatRecordIsBehind(seat, held);
  const reading = !seat || behind ? heldReading(held) : null;
  // A failure, or an answer that has no such subscription. A held list
  // without it while Home's row has it is older than the subscription, and
  // waits for this page's own answer.
  const missing = !seat && Boolean(error || (known && (answered || !held)));
  // Nothing is drawn for a read that answers quickly, and nothing already
  // drawn is snatched away inside its hold (`ui/wait.ts`). Home's reading is
  // no wait: it is the page itself, so it is drawn at once.
  const wait = useWait(!seat && !reading && !missing);
  // Before this page's own read goes out, so a record found behind is asked
  // for by that one read rather than by a second behind it.
  useSeatCopiesInStep();

  // Paint the warm cache immediately, then replace it on every arrival and
  // browser focus. The server probes providers only when that cache is stale.
  const refresh = useCallback(async () => {
    try { await fetchSeats({ force: true }); setError(''); }
    catch (err) { setError(errorMessage(err)); }
  }, [fetchSeats]);
  useEffect(() => {
    let cancelled = false;
    fetchSeats({ force: true }).then(
      () => { if (!cancelled) { setError(''); setAnswered(true); } },
      (err: unknown) => { if (!cancelled) setError(errorMessage(err)); },
    );
    return () => { cancelled = true; };
  }, [fetchSeats]);
  useFocusRefresh(refresh);

  const afterMutation = async (refreshWorkspace: boolean) => {
    seats.invalidate();
    // SPEND our own entry when the browser has one of ours underneath — the
    // same move the header's Back makes from this screen — and only fall
    // back to the list for an address that was pasted or reloaded and has
    // nothing of ours beneath it.
    returnToSeats();
    if (refreshWorkspace) await reload();
  };

  // The name the page can honestly give at any moment: the record, else the
  // state read's row for it, else the product's own word — never "Seat", the
  // bare placeholder this page used to open under (note #625).
  const named = seat ?? held;
  const title = named?.label ?? 'Subscription';
  const sub = named ? <>{providerLabel(named.provider)} subscription</> : undefined;

  // A failure, or an answer that has no such subscription, replaces the wait
  // at once: a reader should never watch bars breathe over something that is
  // not coming.
  if (missing) {
    return (
      <div className="screen" id="screenSeat">
        <ScreenTitle titleId="seatTitle" title={title} subId="seatSub" sub={sub} />
        <div className="card" id="seatCard"><div className="empty">{error || 'This subscription is no longer assigned here.'}</div></div>
      </div>
    );
  }
  // Still out — or in hand but inside the hold of a wait already drawn, which
  // keeps this branch so the bars are not snatched away a frame after they
  // appeared (note #287). The facts the state read knows are drawn as
  // themselves, and so is its reading when it carries every word of one
  // (note #697); what it does not know — the day it was added, a reading it
  // leaves out — is held in its own box; the actions wait for the record
  // they act on.
  if (!seat || wait === 'drawn') {
    const drawn = wait === 'drawn';
    const facts = seat ?? (held ? heldFacts(held) : null);
    const historical = facts ? seatNeedsPayment(facts) || facts.status === 'dead' : false;
    return (
      <div className="screen" id="screenSeat" aria-busy="true">
        <ScreenTitle titleId="seatTitle" title={title} subId="seatSub" sub={sub} />
        {drawn || reading
          ? (
            <>
              <span className="sr-only" role="status">Loading this subscription…</span>
              {facts ? <SeatFacts seat={facts} held /> : null}
              <h2 id="seatUsageTitle">{historical ? 'Last known usage' : 'Usage'}</h2>
              {reading
                ? <SeatUsageCard windows={reading} refreshedAt={held?.usageRefreshedAt} empty="" />
                : <SeatUsageWait seat={held} />}
            </>
          )
          : null}
      </div>
    );
  }

  const paymentRequired = seatNeedsPayment(seat);
  const needsSignIn = seat.status === 'dead';
  const usageIsHistorical = paymentRequired || needsSignIn;
  const sameProvider = (seats.seats ?? []).filter((entry) => entry.provider === seat.provider);
  const fallbackIndex = sameProvider.findIndex((entry) => entry.seatId === seat.seatId);
  const alternatives = sameProvider.filter((entry) => entry.seatId !== seat.seatId);
  const readyFallback = alternatives.find((entry) => !seatNeedsPayment(entry)
    && (entry.status === 'active' || (entry.status === 'cooldown' && (!entry.cooldownUntil || Date.parse(entry.cooldownUntil) <= now))));
  const restingFallback = alternatives.find((entry) => entry.status === 'cooldown' && entry.cooldownUntil && Date.parse(entry.cooldownUntil) > now);
  const fallbackCopy = readyFallback
    ? `This subscription is skipped while it is paused. Agents will try “${readyFallback.label}”.`
    : restingFallback
      ? `“${restingFallback.label}” is temporarily resting. Agents can resume there when its limit resets, even while this Claude subscription needs attention.`
      : alternatives.length
        ? 'No other Claude subscription is ready here. Restore this one or another to resume agents.'
        : 'No other Claude subscription is assigned here, so Claude agents cannot start new turns until a Claude subscription is active again.';

  const move = async (delta: number) => {
    const next = [...sameProvider];
    const target = fallbackIndex + delta;
    if (target < 0 || target >= next.length) return;
    [next[fallbackIndex], next[target]] = [next[target]!, next[fallbackIndex]!];
    setBusy('order');
    try {
      await api.api('api/org/seats/order', jsonBody({ provider: seat.provider, seatIds: next.map((entry) => entry.seatId) }));
      banner.show('Fallback order updated.', true);
      await afterMutation(false);
    } catch (err) { banner.show(errorMessage(err)); setBusy(null); }
  };

  const checkAgain = async () => {
    setBusy('check');
    try {
      const payload = await api.api<WorkspaceSeatCheckAnswer>(`api/org/seats/${encodeURIComponent(seat.seatId)}/check`, { method: 'POST' });
      const fresh: WorkspaceSeatRecord | undefined = payload.seat;
      if (!fresh) { banner.show('This subscription is no longer assigned here.'); await afterMutation(true); return; }
      seats.replace(fresh);
      if (payload.check === 'ready' && seatHasCurrentUsage(fresh)) banner.show('Claude is ready again.', true);
      else if (seatNeedsPayment(fresh) && fresh.subscriptionStatus === 'past_due') banner.show('The Claude subscription still needs attention.');
      else if (seatNeedsPayment(fresh)) banner.show('Claude is still restoring access. Try again shortly.');
      else banner.show('Claude now needs your attention.');
      setBusy(null);
    } catch (err) { banner.show(errorMessage(err)); setBusy(null); }
  };

  return (
    <div className="screen" id="screenSeat">
      <ScreenTitle
        titleId="seatTitle"
        title={seat.label}
        subId="seatSub"
        sub={<>{providerLabel(seat.provider)} subscription</>}
      />
      <SeatFacts seat={behind && held ? { ...seat, ...heldFacts(held) } : seat} />
      {paymentRequired
        ? (
          <div className="card seatrecovery" id="seatRecoveryCard" role="region" aria-labelledby="seatRecoveryTitle">
            <h3 className="recovery-title" id="seatRecoveryTitle">Claude paused this subscription</h3>
            <div className="recovery-copy">{seat.subscriptionStatus === 'past_due' ? 'Claude marked this subscription past due. Open Claude billing to restore access.' : 'Claude needs attention before this subscription can run agents again.'}</div>
            {seat.subscriptionCheckedAt ? <div className="recovery-check">Access checked {relative(seat.subscriptionCheckedAt) || 'just now'}</div> : null}
            <div className="actions">
              <button className="btn primary" type="button" disabled={busy === 'check'} onClick={() => openExternal('https://claude.ai/settings/billing')}>Open Claude billing</button>
              <button className="btn ghost" type="button" disabled={busy === 'check'} onClick={() => { void checkAgain(); }}>{busy === 'check' ? 'Checking…' : 'Check again'}</button>
            </div>
            <div className="hintblock">{fallbackCopy}</div>
          </div>
        )
        : needsSignIn
          ? (
            <div className="card seatrecovery" id="seatRecoveryCard" role="region" aria-labelledby="seatRecoveryTitle">
              {/* An OpenCode subscription is a key, not a sign-in (note
                  #780): what is dead is the key, and the way back is a new
                  one from its console. */}
              <h3 className="recovery-title" id="seatRecoveryTitle">{seat.provider === 'opencode' ? 'Add a new OpenCode key' : `Sign in to ${subscriptionName(seat.provider)} again`}</h3>
              <div className="recovery-copy">{seat.provider === 'opencode'
                ? 'OpenCode no longer accepts this key. It may have been deleted or replaced in the OpenCode console.'
                : `${subscriptionName(seat.provider)} no longer accepts the saved authorization. It may have expired, been revoked, or failed repeated authentication checks.`}</div>
              <div className="actions">
                <button className="btn primary" type="button" onClick={() => navigate(toFor({ kind: 'seatSignInProvider', id: signInSlug(seat.provider), orgId })!)}>{seat.provider === 'opencode' ? 'Add a new key' : 'Retry sign in'}</button>
              </div>
            </div>
          )
          : null}
      <h2 id="seatUsageTitle">{usageIsHistorical ? 'Last known usage' : 'Usage'}</h2>
      <SeatUsageCard
        // Home's newer reading while the record catches up — with the
        // record's spend cap beneath it, which Home's row leaves out, so the
        // card does not lose a row for the moment that takes.
        windows={reading ? [...reading, ...(seat.windows ?? []).filter((w) => w.spend)] : seat.windows ?? []}
        refreshedAt={reading ? held?.usageRefreshedAt : seat.usageRefreshedAt}
        refreshedNote={paymentRequired ? ' · before access was paused' : needsSignIn ? ' · before access stopped working' : ''}
        empty={paymentRequired ? 'No usage reading was saved before access was paused.' : needsSignIn ? 'No usage reading was saved before access stopped working.' : (seat.usageNotice || 'No reading yet.')}
      />
      <div className="actions" id="seatActions">
        {!paymentRequired && !seat.selected
          ? (
            <button className="btn primary" type="button" disabled={busy !== null} onClick={async () => {
              setBusy('select');
              try {
                await api.api(`api/org/seats/${encodeURIComponent(seat.seatId)}/select`, { method: 'POST' });
                banner.show(`“${seat.label}” is primary in ${orgName}.`, true);
                await afterMutation(false);
              } catch (err) { banner.show(errorMessage(err)); setBusy(null); }
            }}>
              Make primary here
            </button>
          )
          : null}
        {!paymentRequired && sameProvider.length > 1 && fallbackIndex > 0
          ? <button className="btn ghost" type="button" disabled={busy !== null} onClick={() => { void move(-1); }}>Earlier fallback</button>
          : null}
        {!paymentRequired && sameProvider.length > 1 && fallbackIndex < sameProvider.length - 1
          ? <button className="btn ghost" type="button" disabled={busy !== null} onClick={() => { void move(1); }}>Later fallback</button>
          : null}
        <button className="btn ghost" type="button" disabled={busy !== null} onClick={async () => {
          if (!(await ask({
            title: `Unassign “${seat.label}” from ${orgName}?`,
            message: 'It stays signed in and keeps working in every other workplace where you assigned it.',
            verb: 'Unassign',
          }))) return;
          setBusy('unassign');
          try {
            await api.api(`api/org/seats/${encodeURIComponent(seat.seatId)}`, { method: 'DELETE' });
            banner.show(`Unassigned “${seat.label}” here. The subscription is still yours.`, true);
            await afterMutation(true);
          } catch (err) { banner.show(errorMessage(err)); setBusy(null); }
        }}>
          Unassign from this workplace
        </button>
        <button className="btn danger" type="button" disabled={busy !== null} onClick={async () => {
          if (!(await ask({
            title: `Remove “${seat.label}” everywhere?`,
            message: 'Every workplace using it loses access to the subscription. You would have to sign in again to restore it.',
            verb: 'Remove',
            danger: true,
          }))) return;
          setBusy('delete');
          try {
            await api.api(`api/seats/${encodeURIComponent(seat.seatId)}`, { method: 'DELETE' });
            banner.show(`Removed “${seat.label}” from every workplace.`, true);
            await afterMutation(true);
          } catch (err) { banner.show(errorMessage(err)); setBusy(null); }
        }}>
          Remove subscription everywhere
        </button>
      </div>
    </div>
  );
}
