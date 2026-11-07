/**
 * Copies (note #1058): every private copy — a company's own Agentic Cloud —
 * that has sent us its daily pulse, one row each, the copy heard from most
 * recently first. A row says who runs it, what it runs, how much it is used
 * and whether it is well; a tap opens its history. Counts only: a pulse
 * carries nothing else but the contact person its admin gave on purpose.
 *
 * The platform operator's alone: the account menu offers it only to them,
 * and the server refuses anyone else who finds the address.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceCopiesAnswer, WorkspaceCopyRow } from '../../../../src/shared/copy-pulse.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { TypeIcon } from '../../ui/icons.js';
import { useNow } from '../../ui/time.js';
import { copiesSub, countsWords, healthWords, releaseWords, seenWords, standingWords } from './copies-words.js';

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

/** One copy: its domain and who runs it, then what it runs, its counts and its health. */
export function CopyRow({ row, now, onOpen }: { row: WorkspaceCopyRow; now: number; onOpen: () => void }) {
  const standing = standingWords(row, now);
  const trouble = row.health.state === 'trouble';
  const behind = (row.releasesBehind ?? 0) >= 2;
  return (
    <button className="crow open copyrow" type="button" data-copy={row.copyId} data-standing={row.standing} onClick={onOpen}>
      <TypeIcon glyph="globe" />
      <div className="main">
        <div className="name plain">
          {row.domain}
          {standing ? <span className={`copybadge ${row.standing}`}>{standing}</span> : null}
        </div>
        <div className="cline wrap"><span className="ctext">{row.contactName} · {row.contactEmail}</span></div>
        <div className="cline wrap"><span className={`ctext${behind ? ' copywarn' : ''}`}>{releaseWords(row)}</span></div>
        <div className="cline wrap"><span className="ctext">{countsWords(row)}</span></div>
        <div className="cline wrap">
          <span className="ctext"><span className={trouble ? 'copywarn' : undefined}>{healthWords(row)}</span> · {seenWords(row, now)}</span>
        </div>
      </div>
    </button>
  );
}

export function CopiesScreen() {
  const { api } = useSession();
  const navigate = useNavigate();
  const [answer, setAnswer] = useState<WorkspaceCopiesAnswer | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.api<WorkspaceCopiesAnswer>('api/copies')
      .then((read) => { if (live) { setAnswer(read); setError(''); } })
      .catch((failure: unknown) => { if (live) setError(messageOf(failure)); });
    return () => { live = false; };
  }, [api]);

  const now = useNow(false);
  return (
    <div className="screen" id="screenCopies" aria-busy={answer || error ? undefined : true}>
      <ScreenTitle title="Copies" sub={answer ? copiesSub(answer.copies) : 'Private copies'} subId="copiesSub" />
      {error && !answer
        ? <div className="card"><div className="empty" id="copiesError">{error}</div></div>
        : (
          <>
            <p className="hintblock" id="copiesAbout">
              Every company that runs its own Agentic Cloud sends a pulse once a day: counts only, and the person to write to.
              {answer?.latestRelease ? ` The latest release is ${answer.latestRelease}.` : ''}
            </p>
            <div className="card" id="copiesList">
              {answer === null
                ? <div className="empty">Loading…</div>
                : answer.copies.length
                  ? answer.copies.map((row) => (
                    <CopyRow key={row.copyId} row={row} now={now} onOpen={() => navigate(toFor({ kind: 'copy', id: row.copyId })!)} />
                  ))
                  : <div className="empty" id="copiesEmpty">No copy has sent a pulse yet. Each one appears here after its first.</div>}
            </div>
          </>
        )}
    </div>
  );
}
