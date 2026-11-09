/**
 * Outreach (note #1089): every target company from note #799, one row each,
 * with where it stands and what is next. The owner's alone — the account menu
 * offers it only to him, and the server refuses anyone else who finds the
 * address. A tap opens the company's profile, its timeline and its Send.
 *
 * Nothing on this screen sends. It reads, and it brings the list in from the
 * seed file on a note.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { OUTREACH_STATES, type OutreachImportAnswer, type OutreachListAnswer, type OutreachRow, type OutreachState } from '../../../../src/shared/outreach.js';
import { jsonBody } from '../../api/client.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { TypeIcon } from '../../ui/icons.js';
import { absolute } from '../../ui/format.js';
import { useNow } from '../../ui/time.js';
import { listSub, localTimeWords, nextWords, plural, stateWords } from './outreach-words.js';

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

/** The seed Rowan attached for this screen (note #1089); the owner may name another. */
const SEED_NOTE = '1089';
const SEED_FILE = 'outreach-targets.json';

export function OutreachRowButton({ row, now, onOpen }: { row: OutreachRow; now: number; onOpen: () => void }) {
  const next = nextWords(row.next);
  return (
    <button className="crow open outreachrow" type="button" data-target={row.id} data-state={row.state} onClick={onOpen}>
      <TypeIcon glyph={row.fit === 'fit' ? 'globe' : 'archive'} />
      <div className="main">
        <div className="name plain">
          {row.firstBatchOrder !== null ? <span className="outreachorder">{row.firstBatchOrder}</span> : null}
          {row.company}
          {row.fit === 'fit' ? <span className={`outreachbadge ${row.state}`}>{stateWords(row.state)}</span> : <span className="outreachbadge notafit">Not a fit</span>}
        </div>
        {row.fit === 'fit'
          ? (
            <>
              <div className="cline wrap"><span className="ctext">{row.email ?? <span className="outreachgap">No address on note #799</span>}{row.person ? ` · ${row.person}` : ''}</span></div>
              <div className="cline wrap">
                <span className="ctext">
                  {localTimeWords(row.city, now)}
                  {next ? <> · <span className={row.next?.due ? 'outreachdue' : undefined}>{next}</span></> : null}
                </span>
              </div>
            </>
          )
          : null}
      </div>
    </button>
  );
}

function ImportCard({ first, onDone }: { first: boolean; onDone: (answer: OutreachImportAnswer) => void }) {
  const { api } = useSession();
  const [note, setNote] = useState(SEED_NOTE);
  const [file, setFile] = useState(SEED_FILE);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const run = async () => {
    setBusy(true);
    setFailed('');
    try {
      onDone(await api.api<OutreachImportAnswer>('api/outreach/import', jsonBody({ note, file })));
    } catch (error) {
      setFailed(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card outreachimport" id="outreachImport">
      <p className="hintblock">
        {first
          ? 'Bring the companies in from the seed file made from note #799. Nothing is sent by importing.'
          : 'Import again when the words on note #799 change: the companies and drafts update, and your edits, states and timeline stay.'}
      </p>
      <label className="drow frow">
        <div className="head"><div className="k">Note</div></div>
        <input id="outreachImportNote" type="text" inputMode="numeric" value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <label className="drow frow">
        <div className="head"><div className="k">File on it</div></div>
        <input id="outreachImportFile" type="text" spellCheck={false} value={file} onChange={(event) => setFile(event.target.value)} />
      </label>
      {failed ? <div className="autherror" role="alert" id="outreachImportError">{failed}</div> : null}
      <div className="authactions">
        <button className="formcommit" id="outreachImportGo" type="button" disabled={busy || !note.trim() || !file.trim()} onClick={() => { void run(); }}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

type Filter = 'all' | OutreachState | 'due';

export function OutreachScreen() {
  const { api } = useSession();
  const navigate = useNavigate();
  const [answer, setAnswer] = useState<OutreachListAnswer | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState('');

  const [version, setVersion] = useState(0);
  const load = () => setVersion((value) => value + 1);
  useEffect(() => {
    let live = true;
    api.api<OutreachListAnswer>('api/outreach')
      .then((read) => { if (live) { setAnswer(read); setError(''); } })
      .catch((failure: unknown) => { if (live) setError(messageOf(failure)); });
    return () => { live = false; };
  }, [api, version]);

  const now = useNow(true);
  const rows = useMemo(() => answer?.rows ?? [], [answer]);
  const due = rows.filter((row) => row.next?.due && row.next.step !== 'first').length;
  const shown = useMemo(() => rows.filter((row) => (filter === 'all' ? true
    : filter === 'due' ? Boolean(row.next?.due && row.next.step !== 'first')
      : row.fit === 'fit' && row.state === filter)), [rows, filter]);
  const groups = useMemo(() => {
    if (filter !== 'all') return [{ key: 'shown', title: '', rows: shown }];
    const fit = shown.filter((row) => row.fit === 'fit');
    const out = [{ key: 'batch', title: 'First batch', rows: fit.filter((row) => row.firstBatchOrder !== null) }];
    const rest = fit.filter((row) => row.firstBatchOrder === null);
    for (const group of [...new Set(rest.map((row) => row.group ?? ''))]) {
      out.push({ key: `group-${group || 'none'}`, title: group ? `Group ${group}` : 'No group', rows: rest.filter((row) => (row.group ?? '') === group) });
    }
    out.push({ key: 'notafit', title: 'Not a fit', rows: shown.filter((row) => row.fit !== 'fit') });
    return out.filter((group) => group.rows.length);
  }, [shown, filter]);
  const open = (id: string) => navigate(toFor({ kind: 'outreachTarget', id })!);
  const chip = (key: Filter, label: string) => (
    <button key={key} type="button" className={`chip${filter === key ? ' here' : ''}`} data-filter={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
  );

  return (
    <div className="screen" id="screenOutreach" aria-busy={answer || error ? undefined : true}>
      <ScreenTitle title="Outreach" sub={answer?.imported ? listSub(rows) : 'Your target companies'} subId="outreachSub" />
      {error && !answer ? <div className="card"><div className="empty" id="outreachError">{error}</div></div> : null}
      {!answer && !error ? <div className="card"><div className="empty">Loading…</div></div> : null}
      {answer && !answer.imported
        ? <ImportCard first onDone={(done) => { setImported(`${plural(done.added, 'company', 'companies')} brought in.`); load(); }} />
        : null}
      {answer?.imported
        ? (
          <>
            <p className="hintblock" id="outreachAbout">
              Every letter goes from your address, only when you press Send. Follow-ups come due on day 4 and day 11; nothing sends on a timer.
            </p>
            {answer.firstSends >= answer.reviewAfter
              ? (
                <p className="hintblock mailwarn" id="outreachReview">
                  {plural(answer.firstSends, 'first letter has', 'first letters have')} gone. Note #799: after a fair try, about {answer.reviewAfter} sends, look at what is not working and change it rather than send more (note #788).
                </p>
              )
              : null}
            {imported ? <p className="hintblock" id="outreachImported" role="status">{imported}</p> : null}
            <div className="chiprow" id="outreachFilter" role="group" aria-label="Show companies by state">
              {chip('all', 'All')}
              {due ? chip('due', `Due (${due})`) : null}
              {OUTREACH_STATES.map((state) => chip(state, stateWords(state)))}
            </div>
            {groups.length
              ? groups.map((group) => (
                <section key={group.key} id={`outreach-${group.key}`}>
                  {group.title ? <h2>{group.title}</h2> : null}
                  <div className="card outreachlist">
                    {group.rows.map((row) => <OutreachRowButton key={row.id} row={row} now={now} onOpen={() => open(row.id)} />)}
                  </div>
                </section>
              ))
              : <div className="card"><div className="empty" id="outreachNone">No company is {filter === 'due' ? 'due' : stateWords(filter as OutreachState).toLowerCase()} right now.</div></div>}
            <p className="hintblock" id="outreachSource">
              From {answer.imported.source}{answer.imported.generatedBy ? `, made by ${answer.imported.generatedBy}` : ''}. Imported {absolute(answer.imported.at)}.{' '}
              <button type="button" className="outreachlink" id="outreachImportAgain" onClick={() => setImporting((value) => !value)}>{importing ? 'Close' : 'Import again'}</button>
            </p>
            {importing
              ? <ImportCard first={false} onDone={(done) => { setImporting(false); setImported(`${plural(done.added, 'company', 'companies')} added, ${plural(done.updated, 'company', 'companies')} updated.`); load(); }} />
              : null}
          </>
        )
        : null}
    </div>
  );
}
