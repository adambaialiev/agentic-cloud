/**
 * Your subscriptions (`/seats?org=`): the private subscription sign-ins assigned to
 * this workplace, the ones you hold elsewhere that could be, and the
 * door to signing in a new one. Reads the seats cache; the cache is dropped
 * by every mutation before the list is shown again.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceSeatRecord, WorkspaceSeatWindow } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useSession } from '../../session/useSession.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { errorMessage, openExternal } from '../../ui/format.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { seatHasCurrentUsage, seatNeedsPayment, seatShowsPrimary, seatsEmptyState, seatStatusWords } from '../../ui/seat-words.js';
import { SeatUseDot } from '../../ui/SeatUse.js';
import { UsageMeter, UsagePill } from '../../ui/Usage.js';
import { useFocusRefresh } from '../../ui/useFocusRefresh.js';
import { toFor } from '../../routes.js';
import { seatRecordIsBehind, useSeatCopiesInStep } from '../../workspace/seat-copies.js';
import { useSeats } from '../../workspace/useSeats.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { providerLabel } from '../home/agent-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { TokenUsage } from './TokenUsage.js';

export function SeatStatusPill({ seat }: { seat: Pick<WorkspaceSeatRecord, 'status' | 'attention'> }) {
  const { tone, text } = seatStatusWords(seat);
  return <span className={`pill ${tone}`}>{text}</span>;
}

/** What a row reads: the full record, or — before this screen's own read
 *  lands — the state read's row for the same subscription, the one Home's
 *  plate was drawn from, which carries everything a row shows (note #625). */
type SeatRowSource = Pick<WorkspaceSeatRecord, 'seatId' | 'label' | 'provider' | 'planText' | 'status' | 'attention' | 'selected'>
  & { windows?: Array<Pick<WorkspaceSeatWindow, 'usedPercent' | 'percentText' | 'trackText' | 'spend'>> };

function SeatRow({ seat, seats, onOpen }: {
  seat: SeatRowSource;
  seats: SeatRowSource[];
  onOpen: () => void;
}) {
  const { agents, state } = useWorkspace();
  const gating = (seatHasCurrentUsage(seat) ? (seat.windows ?? []) : []).filter((w) => !w.spend);
  const worst = gating.length ? gating.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : null;
  return (
    <button className="crow open" type="button" onClick={onOpen}>
      <TypeIcon glyph="card" />
      <div className="main">
        <div className="name plain">{seat.label}<SeatUseDot seat={seat} agents={agents} seats={seats} activeSeatIds={state?.org?.activeSeatIds} /></div>
        <div className="cline seatline">
          <span className="ctext">{providerLabel(seat.provider)}{seat.planText ? ` · ${seat.planText}` : ''}</span>
          {/* Grey, not the accent (the owner, note #773): in accent the word
              read as a button. It is a fact about the row, like "Admin". */}
          {seatShowsPrimary(seat, seats) ? <span className="badge mut">Primary</span> : null}
          {seatNeedsPayment(seat) ? <SeatStatusPill seat={seat} /> : null}
          {gating.map((w, index) => <UsagePill key={index} window={w} />)}
        </div>
        {worst ? <UsageMeter usedPercent={worst.usedPercent} /> : null}
      </div>
      {!seatNeedsPayment(seat) ? <div className="cside"><SeatStatusPill seat={seat} /></div> : null}
      <Icon name="chev" size={17} className="icon chev" />
    </button>
  );
}

function AvailableSeatRow({ seat, orgName, onChanged }: { seat: WorkspaceSeatRecord; orgName: string; onChanged: () => Promise<void> }) {
  const { api } = useSession();
  const banner = useBanner();
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const paymentRequired = seatNeedsPayment(seat);
  const reusable = !paymentRequired && (seat.status === 'active' || seat.status === 'cooldown');
  const state = paymentRequired ? 'subscription needs attention · restore it in Claude'
    : seat.status === 'active' ? 'ready to reuse'
      : seat.status === 'cooldown' ? 'resting · still reusable'
        : seat.status === 'dead' ? 'needs sign-in · delete removes it everywhere'
          : 'off · delete removes it everywhere';
  return (
    <div className="crow">
      <TypeIcon glyph="card" />
      <div className="main">
        <div className="name plain">{seat.label}</div>
        <div className="cline"><span className="ctext">{providerLabel(seat.provider)} · {state}</span></div>
      </div>
      <button
        className={reusable || paymentRequired ? 'btn ghost' : 'btn danger'}
        type="button"
        disabled={busy}
        onClick={async () => {
          if (paymentRequired) { openExternal('https://claude.ai/settings/billing'); return; }
          if (!reusable && !(await ask({
            title: `Delete “${seat.label}” everywhere?`,
            message: 'Every workplace using this underlying sign-in loses it.',
            verb: 'Delete',
            danger: true,
          }))) return;
          setBusy(true);
          try {
            if (reusable) {
              await api.api(`api/org/seats/${encodeURIComponent(seat.seatId)}/assign`, { method: 'POST' });
              banner.show(`Assigned “${seat.label}” to ${orgName}.`, true);
            } else {
              await api.api(`api/seats/${encodeURIComponent(seat.seatId)}`, { method: 'DELETE' });
              banner.show(`Deleted “${seat.label}” from every workplace.`, true);
            }
            await onChanged();
          } catch (error) { banner.show(errorMessage(error)); setBusy(false); }
        }}
      >
        {reusable ? 'Use here' : paymentRequired ? 'Open provider settings' : 'Delete'}
      </button>
    </div>
  );
}

/** A real zero state rather than one grey line: the typed mark, the title
 *  and the words a first-time reader needs before the door beneath the card
 *  means anything (note #491). The block is the shared one every empty shelf
 *  in the Workspace draws; only the words are this screen's own. */
function SeatsEmpty({ orgName, available }: { orgName: string; available: number }) {
  const words = seatsEmptyState(orgName, available);
  return <EmptyState glyph="card" tint="act" title={words.title} body={words.body} />;
}

export function SeatsScreen() {
  const { state, reload } = useWorkspace();
  const seats = useSeats();
  const { fetch: fetchSeats } = seats;
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const orgId = state?.org?.orgId ?? '';
  const orgName = state?.org?.name ?? 'this workplace';
  const known = seats.seats !== null;

  // Before this screen's own read goes out, so a record found behind Home's
  // row is asked for by that one read rather than by a second (note #697).
  useSeatCopiesInStep();

  // Every arrival and browser focus asks again. The server answers from its
  // cache unless the provider reading is older than the probe cadence.
  const refresh = useCallback(async () => {
    try { await fetchSeats({ force: true }); setError(''); }
    catch (err) { setError(errorMessage(err)); }
  }, [fetchSeats]);
  useEffect(() => {
    let cancelled = false;
    fetchSeats({ force: true }).then(
      () => { if (!cancelled) setError(''); },
      (err: unknown) => { if (!cancelled) setError(errorMessage(err)); },
    );
    return () => { cancelled = true; };
  }, [fetchSeats]);
  useFocusRefresh(refresh);

  const list = seats.seats ?? [];
  const held = state?.org?.seatUsage ?? [];
  // Until this screen's own read lands, the rows are the ones the state read
  // already holds — the plates Home drew, which carry every word and meter a
  // row shows — so the list opens whole instead of on "Loading…" (note #625).
  // A held record older than Home's row for the same subscription gives way
  // to that row too: one copy, the newer (note #697). That row leaves
  // `status` out for a seat that is simply active.
  const asRow = (row: (typeof held)[number]): SeatRowSource => ({ ...row, status: row.status ?? 'active' });
  const rows: SeatRowSource[] = known
    ? list.map((record) => {
      const row = held.find((entry) => entry.seatId === record.seatId);
      return row && seatRecordIsBehind(record, row) ? asRow(row) : record;
    })
    : held.map(asRow);
  const changed = async () => {
    seats.invalidate();
    await Promise.all([reload(), fetchSeats({ force: true })]);
  };

  return (
    <div className="screen" id="screenSeats">
      <ScreenTitle title="Your subscriptions" />
      <div className="sub" id="seatsSub">
        {!known && !state?.org ? '' : rows.length === 0 ? `The private subscriptions ${orgName} may use.` : rows.length === 1 ? `One private sign-in assigned to ${orgName}.` : `${rows.length} private sign-ins assigned to ${orgName}.`}
      </div>
      <div className="card">
        <div id="seatsList" aria-busy={!known && !error ? 'true' : undefined}>
          {/* An empty shelf waits for the read, because what it says depends
              on the sign-ins this member holds ELSEWHERE, which only the read
              knows. */}
          {rows.length
            ? rows.map((seat) => <SeatRow key={seat.seatId} seat={seat} seats={rows} onOpen={() => navigate(toFor({ kind: 'seat', id: seat.seatId, orgId })!)} />)
            : error && !known
              ? <div className="empty">{error}</div>
              : known ? <SeatsEmpty orgName={orgName} available={seats.available.length} /> : null}
        </div>
        {/* The way to add one, at the foot of the card it adds to — the
            app's own idiom for a founding action ("Write a note", "New
            room"). It had a card of its own until note #491: a second grey
            box holding one line of accent text, which on an empty screen
            read as a list of its own rather than as this list's door. */}
        <button className="addrow" type="button" id="seatSignInOpen" onClick={() => navigate(toFor({ kind: 'seatSignIn', orgId })!)}>Sign in a subscription</button>
      </div>
      <div className="formhint" id="seatsHint">{known ? `Your current subscription access follows you the first time you enter a workplace. Changes here affect ${orgName} only; teammates and admins never see your credentials or usage.` : 'Your subscriptions stay private to you, even when they work across workplaces. Teammates and admins never see their credentials or usage.'}</div>
      {seats.available.length
        ? (
          <div id="availableSeats">
            <h2>Your other sign-ins</h2>
            <div className="card" id="availableSeatsList">
              {seats.available.map((seat) => <AvailableSeatRow key={seat.seatId} seat={seat} orgName={orgName} onChanged={changed} />)}
            </div>
            <div className="formhint">Ready sign-ins can work here and elsewhere at the same time. A sign-in that needs attention cannot be assigned; deleting it removes the one underlying credential everywhere.</div>
          </div>
        )
        : null}
      <TokenUsage />
    </div>
  );
}
