import { useCallback, useEffect, useState } from 'react';
import type {
  PublicGuideQuestionRecord,
  PublicGuideVisitRecord,
  WorkspacePublicGuideVisitAnswer,
  WorkspacePublicGuideVisitsAnswer,
} from '../../../../src/shared/public-guide.js';
import { useSession } from '../../session/useSession.js';
import { Markdown } from '../../render/Markdown.js';
import { relative } from '../../ui/time.js';

const STATE_WORDS: Partial<Record<PublicGuideQuestionRecord['state'], string>> = {
  declined: 'Declined',
  failed: 'Failed on our side, not counted',
  resting: 'Asked while resting, not answered',
  queued: 'Waiting',
  waking: 'Waking the machine',
  reading: 'Reading the code',
};

function questionMeta(question: PublicGuideQuestionRecord, now: number): string {
  const parts = [relative(question.askedAt, now) || 'just now'];
  if (question.seconds !== undefined) parts.push(`${question.seconds} s`);
  if (question.costUsd !== undefined) parts.push(`$${question.costUsd.toFixed(2)} at API prices`);
  const state = STATE_WORDS[question.state];
  if (state) parts.push(state);
  return parts.join(' · ');
}

/**
 * The Visits list on a sealed public guide's screen (note #1010): every
 * visitor's conversation from the home page, newest first, kept 90 days.
 * Tapping a visit opens it here, read-only. A visit flagged by the outgoing
 * check says so — that answer was held back from the visitor and is shown
 * only here.
 */
export function VisitsCard({ agentId, now }: { agentId: string; now: number }) {
  const { api } = useSession();
  const [list, setList] = useState<WorkspacePublicGuideVisitsAnswer | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The opened visit, keyed by its id: a different row opened reads as not yet loaded.
  const [opened, setOpened] = useState<{ visitId: string; visit: PublicGuideVisitRecord } | null>(null);
  const visit = opened && opened.visitId === open ? opened.visit : null;

  const read = useCallback(async () => {
    try {
      setList(await api.api<WorkspacePublicGuideVisitsAnswer>(`api/agents/${encodeURIComponent(agentId)}/visits`));
    } catch {
      /* no list beats a wrong one */
    }
  }, [api, agentId]);

  useEffect(() => {
    const first = setTimeout(() => { void read(); }, 0);
    const timer = setInterval(() => { void read(); }, 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [read]);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void api.api<WorkspacePublicGuideVisitAnswer>(`api/agents/${encodeURIComponent(agentId)}/visits/${encodeURIComponent(open)}`)
      .then((answer) => { if (live) setOpened({ visitId: open, visit: answer.visit }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [api, agentId, open]);

  if (!list) return null;
  return (
    <div className="card" id="agentVisits">
      <div className="drow">
        <div className="k">Visits</div>
        <div className="v dim">{`Every conversation on the home page, newest first. Kept ${list.keptDays} days; nothing about a visitor beyond what they typed.`}</div>
      </div>
      {list.visits.length === 0
        ? <div className="empty" id="agentVisitsEmpty">Nobody has asked anything yet.</div>
        : list.visits.map((row) => (
          <div className="visit" key={row.visitId} data-open={open === row.visitId ? '1' : undefined}>
            <button
              className="drow visitrow"
              type="button"
              aria-expanded={open === row.visitId}
              onClick={() => setOpen(open === row.visitId ? null : row.visitId)}
            >
              <div className="v visitfirst">{row.firstQuestion}</div>
              <div className="v dim">
                {[relative(row.startedAt, now) || 'just now', `${row.questions} question${row.questions === 1 ? '' : 's'}`, ...(row.flagged ? ['Flagged'] : [])].join(' · ')}
              </div>
            </button>
            {open === row.visitId
              ? (
                <div className="visitthread">
                  {!visit
                    ? <div className="empty">Opening…</div>
                    : visit.questions.map((question) => (
                      <div className="visitturn" key={question.questionId} data-state={question.state}>
                        <div className="visitq">{question.question}</div>
                        <div className="v dim">{questionMeta(question, now)}</div>
                        {question.flag ? <div className="hintblock visitflag">{question.flag}</div> : null}
                        {question.answer ? <Markdown className="visita" source={question.answer} /> : null}
                        {question.files?.length
                          ? <div className="v dim visitfiles">{`It read ${question.files.join(', ')}`}</div>
                          : null}
                      </div>
                    ))}
                </div>
              )
              : null}
          </div>
        ))}
    </div>
  );
}
