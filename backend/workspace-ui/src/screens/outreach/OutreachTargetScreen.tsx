/**
 * One company in Outreach (note #1089): its profile as note #799 has it,
 * each fact with where it was read; the owner's own fields (person, address,
 * city); the Send box with the next letter prefilled from the note's words;
 * and every touch, newest first.
 *
 * The Send button is the ONLY way a letter leaves from here, and it sends
 * exactly what is in the box. A template placeholder left in the box keeps
 * the button off; a follow-up shows its day until the day comes.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  OUTREACH_KNOWN_PLACES, OUTREACH_MAX_WORDS, OUTREACH_STATES, outreachPlaceholders, outreachWordCount,
  type OutreachSendAnswer, type OutreachState, type OutreachTargetAnswer, type OutreachTouch,
} from '../../../../src/shared/outreach.js';
import { jsonBody } from '../../api/client.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { absolute } from '../../ui/format.js';
import { useNow } from '../../ui/time.js';
import { localTimeWords, nextWords, stateWords, stepWords, touchWords } from './outreach-words.js';

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

function Fact({ id, k, children, source }: { id: string; k: string; children: React.ReactNode; source?: string | null }) {
  return (
    <div className="drow outreachfact" id={id}>
      <div className="k">{k}</div>
      <div className="v">
        {children}
        {source !== undefined
          ? <div className="outreachsource">{source ? `Source: ${source}` : <span className="outreachgap">No separate source on note #799</span>}</div>
          : null}
      </div>
    </div>
  );
}

const orGap = (value: string | null | undefined, gap = 'Not on note #799') => value || <span className="outreachgap">{gap}</span>;

/** The owner's three fields, edited in place. */
function OwnFields({ answer, onSaved }: { answer: OutreachTargetAnswer; onSaved: (next: OutreachTargetAnswer) => void }) {
  const { api } = useSession();
  const { row, seed } = answer;
  const [editing, setEditing] = useState(false);
  const [person, setPerson] = useState(row.person ?? '');
  const [email, setEmail] = useState(row.email ?? '');
  const [city, setCity] = useState(row.city ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const wrote = answer.touches.some((touch) => touch.kind === 'sent');
  const now = useNow(true);
  const start = () => { setPerson(row.person ?? ''); setEmail(row.email ?? ''); setCity(row.city ?? ''); setFailed(''); setEditing(true); };
  const save = async () => {
    setBusy(true);
    setFailed('');
    try {
      const next = await api.api<OutreachTargetAnswer>(`api/outreach/targets/${encodeURIComponent(row.id)}`, jsonBody({ person, email, city }, 'PATCH'));
      onSaved(next);
      setEditing(false);
    } catch (error) {
      setFailed(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  if (editing) {
    return (
      <div className="card" id="outreachOwnEdit">
        <label className="drow frow"><div className="head"><div className="k">Person</div></div>
          <input id="outreachPersonField" type="text" value={person} onChange={(event) => setPerson(event.target.value)} /></label>
        <label className="drow frow"><div className="head"><div className="k">Address</div></div>
          <input id="outreachEmailField" type="email" spellCheck={false} autoCapitalize="none" value={email} disabled={wrote} onChange={(event) => setEmail(event.target.value)} /></label>
        {wrote ? <p className="hintblock">A letter already went to {row.email}. One address per company.</p> : null}
        <label className="drow frow"><div className="head"><div className="k">City</div></div>
          <input id="outreachCityField" type="text" list="outreachPlaces" value={city} onChange={(event) => setCity(event.target.value)} /></label>
        <datalist id="outreachPlaces">{OUTREACH_KNOWN_PLACES.map((place) => <option key={place} value={place} />)}</datalist>
        {failed ? <div className="autherror" role="alert">{failed}</div> : null}
        <div className="authactions">
          <button className="formcommit" id="outreachOwnSave" type="button" disabled={busy} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="btn ghost" id="outreachOwnCancel" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="card" id="outreachOwn">
      <Fact id="outreachPerson" k="Person">{orGap(row.person)}{'person' in answer.edits ? <div className="outreachsource">Set by you</div> : null}</Fact>
      <Fact id="outreachEmail" k="Address">
        {orGap(row.email, 'No address on note #799')}
        {'email' in answer.edits
          ? <div className="outreachsource">Set by you{seed.email ? ` (note #799 has ${seed.email})` : ''}</div>
          : seed.emailWherePrinted ? <div className="outreachsource">Printed: {seed.emailWherePrinted}{seed.emailWhose ? ` · whose: ${seed.emailWhose}` : ''}</div> : null}
        {seed.notThisAddress ? <div className="outreachwarn" id="outreachNotThis">{seed.notThisAddress}</div> : null}
      </Fact>
      <Fact id="outreachCity" k="City">
        <span id="outreachLocal">{localTimeWords(row.city, now)}</span>
        {'city' in answer.edits ? <div className="outreachsource">Set by you</div> : !row.city ? <div className="outreachsource">Set the city to see their time.</div> : null}
      </Fact>
      <button className="addrow" id="outreachOwnEditOpen" type="button" onClick={start}>Edit person, address or city</button>
    </div>
  );
}

/** The Send box: the next letter, prefilled, editable, counted. */
function SendBox({ answer, onSent }: { answer: OutreachTargetAnswer; onSent: () => void }) {
  const { api } = useSession();
  const draft = answer.draft!;
  const [subject, setSubject] = useState(draft.subject);
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const next = answer.row.next!;
  const first = draft.step === 'first';
  const words = outreachWordCount(first ? subject : '', text);
  const left = outreachPlaceholders(`${subject}\n${text}`);
  const over = first && words > OUTREACH_MAX_WORDS;
  // The whole letter in view, signature included: the box grows to its words.
  const box = useRef<HTMLTextAreaElement | null>(null);
  const grow = useCallback((node: HTMLTextAreaElement | null) => { box.current = node; }, []);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight + 2}px`;
  }, [text]);
  const send = async () => {
    setBusy(true);
    setFailed('');
    try {
      await api.api<OutreachSendAnswer>(`api/outreach/targets/${encodeURIComponent(answer.row.id)}/send`, jsonBody({ step: draft.step, subject, text }));
      onSent();
    } catch (error) {
      setFailed(messageOf(error));
      setBusy(false);
    }
  };
  if (!next.due) {
    return (
      <div className="card" id="outreachSend">
        <p className="hintblock" id="outreachNotYet">{nextWords(next)}. It shows here, ready to send, from that day. Nothing sends by itself.</p>
      </div>
    );
  }
  return (
    <div className="card outreachsend" id="outreachSend" data-step={draft.step}>
      <div className="drow"><div className="k">{stepWords(draft.step)}</div>
        <div className="v" id="outreachSendTo">To {draft.to}{first ? '' : ', in the same thread'}</div></div>
      <div className="drow"><div className="k">Words from</div>
        <div className="v" id="outreachSendFrom">{draft.from === 'written' ? 'Note #799, the email written for them' : draft.from === 'template' ? 'Note #799, the template: fill in the brackets' : `Note #799, the ${stepWords(draft.step).toLowerCase()}`}</div></div>
      <label className="drow frow">
        <div className="head"><div className="k">Subject</div></div>
        <input id="outreachSubjectField" className="prose" type="text" maxLength={200} value={subject} disabled={!first} onChange={(event) => setSubject(event.target.value)} />
      </label>
      <label className="drow frow">
        <div className="head">
          <div className="k">Letter</div>
          <div className={`count${over ? ' outreachover' : ''}`} id="outreachWordCount">
            {`${words} words${draft.noteWordCount !== null ? ` · note #799: ${draft.noteWordCount}` : ''}${first ? ` · max ${OUTREACH_MAX_WORDS}, subject in` : ''}`}
          </div>
        </div>
        <textarea ref={grow} id="outreachTextField" className="prose" rows={8} maxLength={20_000} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      {left.length ? <p className="hintblock mailwarn" id="outreachPlaceholders">Fill in {left.join(' and ')} before sending.</p> : null}
      {failed ? <div className="autherror" role="alert" id="outreachSendError">{failed}</div> : null}
      <div className="authactions">
        <button className="formcommit" id="outreachSendGo" type="button" disabled={busy || left.length > 0 || !text.trim() || !subject.trim()} onClick={() => { void send(); }}>
          {busy ? 'Sending…' : `Send to ${draft.to}`}
        </button>
      </div>
      <p className="hintblock">It goes from your address as a plain letter: no tracking, no rewritten links. It appears in Sent and below.</p>
    </div>
  );
}

function TouchRow({ touch }: { touch: OutreachTouch }) {
  return (
    <div className={`outreachtouch ${touch.kind}`} data-kind={touch.kind} data-touch={touch.id}>
      <div className="outreachtouchhead">
        <span className="outreachtouchwhat">{touchWords(touch)}</span>
        <time dateTime={touch.at}>{absolute(touch.at)}</time>
      </div>
      {touch.kind === 'sent'
        ? (
          <details className="outreachletter">
            <summary>{touch.subject}</summary>
            <pre className="outreachtext">{touch.text}</pre>
            <Link to={toFor({ kind: 'mailMessage', id: touch.mailId })!}>Open in mail</Link>
          </details>
        )
        : null}
      {touch.kind === 'reply'
        ? <div className="outreachtouchbody">{touch.subject} · <Link to={toFor({ kind: 'mailMessage', id: touch.mailId })!} id={`outreachReply-${touch.mailId}`}>Read and answer in mail</Link></div>
        : null}
      {touch.kind === 'note' ? <div className="outreachtouchbody outreachnote">{touch.text}</div> : null}
    </div>
  );
}

export function OutreachTargetScreen() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const [answer, setAnswer] = useState<OutreachTargetAnswer | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState('');
  const [sentKey, setSentKey] = useState(0);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    api.api<OutreachTargetAnswer>(`api/outreach/targets/${encodeURIComponent(id)}`)
      .then((read) => { if (live) { setAnswer(read); setError(''); } })
      .catch((failure: unknown) => { if (live) setError(messageOf(failure)); });
    return () => { live = false; };
  }, [api, id, version]);

  const act = async (what: string, path: string, body: Record<string, unknown>) => {
    setBusy(what);
    setFailed('');
    try {
      setAnswer(await api.api<OutreachTargetAnswer>(`api/outreach/targets/${encodeURIComponent(id)}/${path}`, jsonBody(body)));
      if (what === 'note') setNote('');
    } catch (failure) {
      setFailed(messageOf(failure));
    } finally {
      setBusy('');
    }
  };

  const row = answer?.row;
  const seed = answer?.seed;
  const wrote = answer?.touches.some((touch) => touch.kind === 'sent') ?? false;
  const allowed = (state: OutreachState) => state !== row?.state && !(state === 'not-contacted' && wrote) && !(state === 'sent' && !wrote);

  return (
    <div className="screen" id="screenOutreachTarget" aria-busy={answer || error ? undefined : true}>
      <ScreenTitle title={row?.company ?? 'Company'} sub={row ? (row.fit === 'fit' ? stateWords(row.state) : 'Not a fit') : undefined} subId="outreachTargetSub" />
      {error && !answer ? <div className="card"><div className="empty" id="outreachTargetError">{error}</div></div> : null}
      {!answer && !error ? <div className="card"><div className="empty">Loading…</div></div> : null}
      {answer && row && seed
        ? (
          <>
            {!row.inLatestImport ? <p className="hintblock mailwarn">The latest import no longer has this company. It is kept with its timeline.</p> : null}
            <h2>Send</h2>
            {answer.draft
              ? <SendBox key={`${sentKey}-${answer.draft.step}`} answer={answer} onSent={() => { setSentKey((value) => value + 1); setVersion((value) => value + 1); }} />
              : <div className="card" id="outreachSend"><p className="hintblock" id="outreachNoSend">{answer.noSend}</p></div>}

            <h2>Person and address</h2>
            <OwnFields key={`${row.person}|${row.email}|${row.city}`} answer={answer} onSaved={setAnswer} />

            <h2>From note #799</h2>
            <div className="card" id="outreachProfile">
              {seed.firstBatchOrder !== null ? <Fact id="outreachBatch" k="First batch">{`Number ${seed.firstBatchOrder} of the first ten`}</Fact> : null}
              <Fact id="outreachGroup" k="Group">{seed.group ? `Group ${seed.group}${seed.number !== null ? ` · row ${seed.number}` : ''}${seed.newOn2Nov ? ' · new on 2 Nov' : ''}` : 'None'}</Fact>
              <Fact id="outreachSize" k="Size">{orGap(seed.size)}</Fact>
              {seed.fit !== 'fit' ? <Fact id="outreachDropped" k="Not a fit">{orGap(seed.notAFitReason)}</Fact> : null}
              <Fact id="outreachWhy" k="Why their own (our reading)">{orGap(seed.whyOwnCloud)}</Fact>
              <Fact id="outreachSignal" k="Their agent signal" source={seed.agentSignal ? seed.agentSignalSource : undefined}>{orGap(seed.agentSignal)}</Fact>
              <Fact id="outreachVerification" k="Checked">{`${seed.verification ?? 'Not said'}${seed.checkedOn ? ` · ${seed.checkedOn}` : ''}`}</Fact>
              {seed.firstEmail?.wherePrinted ? <Fact id="outreachLetterWhere" k="Ready letter's address">{seed.firstEmail.wherePrinted}{seed.firstEmail.note ? <div className="outreachsource">{seed.firstEmail.note}</div> : null}</Fact> : null}
            </div>

            {row.fit === 'fit'
              ? (
                <>
                  <h2>State</h2>
                  <div className="card" id="outreachState">
                    <div className="chiprow" role="group" aria-label="Set the state">
                      {OUTREACH_STATES.map((state) => (
                        <button key={state} type="button" className={`chip${row.state === state ? ' here' : ''}`} data-state={state}
                          aria-pressed={row.state === state} disabled={Boolean(busy) || !allowed(state) && row.state !== state}
                          onClick={() => { if (allowed(state)) void act('state', 'state', { state }); }}>{stateWords(state)}</button>
                      ))}
                    </div>
                    <p className="hintblock">Sent, Replied and Installed follow what happens. Set Not now when they say so: it ends the sequence.</p>
                  </div>
                </>
              )
              : null}

            <h2>Timeline</h2>
            <div className="card" id="outreachTimeline">
              <label className="drow frow">
                <div className="head"><div className="k">Add a note</div></div>
                <textarea id="outreachNoteField" className="prose" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
              </label>
              <div className="authactions">
                <button className="formcommit" id="outreachNoteSave" type="button" disabled={Boolean(busy) || !note.trim()} onClick={() => { void act('note', 'notes', { text: note }); }}>
                  {busy === 'note' ? 'Saving…' : 'Save note'}
                </button>
              </div>
              {failed ? <div className="autherror" role="alert" id="outreachActError">{failed}</div> : null}
              {answer.touches.length
                ? <div className="outreachtouches" id="outreachTouches">{answer.touches.map((touch) => <TouchRow key={touch.id} touch={touch} />)}</div>
                : <div className="empty" id="outreachNoTouches">Nothing yet.</div>}
            </div>
          </>
        )
        : null}
    </div>
  );
}
