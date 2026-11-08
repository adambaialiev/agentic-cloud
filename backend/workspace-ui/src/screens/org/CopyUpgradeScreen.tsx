/**
 * Upgrade, in a company's own Agentic Cloud (note #1008, the mock-ups on note
 * #1007): the confirmation, and one run's progress, then how it ended. The
 * upgrade itself runs on the upgrader machine, outside this Workspace, and
 * keeps its record in the backup bucket; this screen asks the Workspace for
 * that record every 2 s. While the Workspace restarts onto the new release
 * it does not answer: the screen keeps the last steps it saw, says so, and
 * picks up again by itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  WorkspaceCopyReleases, WorkspaceCopyUpgradeRun, WorkspaceCopyUpgradeState, WorkspaceCopyUpgradeStep,
} from '../../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBanner } from '../../chrome/useBanner.js';
import { Markdown } from '../../render/Markdown.js';
import { toFor } from '../../routes.js';
import { Scrim } from '../../ui/Ask.js';
import { errorMessage } from '../../ui/format.js';
import { stopwatch, useNow } from '../../ui/time.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { notesBody } from './CopyReleasesScreen.js';
import { useOrgApi } from './useOrgApi.js';

const POLL_MS = 2_000;
/** After this long with no answer, the screen says the Workspace is away for longer than a restart. */
const AWAY_LONG_MS = 5 * 60_000;

const hhmm = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(11, 16) : null);
const lasted = (from: string | null, to: string | null) => {
  if (!from || !to) return null;
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
/** A step's duration as the right-hand column reads it: "9 s", "6:38", "1:02:05". */
const clock = (seconds: number | null) => (seconds === null ? '' : seconds < 60 ? `${Math.max(0, Math.floor(seconds))} s` : stopwatch(seconds));

/** The four lines the admin reads before saying yes (note #1007, picture B). */
export function CopyUpgradeConfirm({ from, to, agentsWorking, onAnswer }: {
  from: string; to: string; agentsWorking: number; onAnswer: (yes: boolean) => void;
}) {
  return (
    <Scrim onDismiss={() => onAnswer(false)}>
      <div id="copyUpgradeConfirm">
        <h3>Upgrade to {to}?</h3>
        <p>From {from}. It takes about 3 minutes.</p>
        <ul className="upconfirm">
          <li><span className="k" aria-hidden="true">↻</span><span>The Workspace restarts once and is away for about a minute. <span className="d">Everyone sees “reconnecting”; nobody signs in again.</span></span></li>
          <li><span className="k" aria-hidden="true">◉</span><span>{agentsWorking === 0 ? 'No agent is working right now.' : agentsWorking === 1 ? '1 agent is working.' : `${agentsWorking} agents are working.`} <span className="d">{agentsWorking ? 'Their turns pause during the restart and carry on after it.' : 'Any that start will pause during the restart and carry on after it.'}</span></span></li>
          <li><span className="k" aria-hidden="true">▤</span><span>Your database is backed up first, <span className="d">and both disks are snapshotted.</span></span></li>
          <li><span className="k" aria-hidden="true">↩</span><span>If any step fails, {from} is put back by itself, <span className="d">with the database as it was when the upgrade began. Anything written in those minutes is lost.</span></span></li>
        </ul>
        <div className="btns">
          <button className="btn ghost" type="button" onClick={() => onAnswer(false)}>Cancel</button>
          <button className="btn fill" id="copyUpgradeGo" type="button" onClick={() => onAnswer(true)}>Upgrade now</button>
        </div>
      </div>
    </Scrim>
  );
}

/**
 * How long a step has taken: its reported duration once done, and while it
 * runs a time that ticks every second, counted from the step's recorded start
 * (note #1076) — so a reload, or a second admin's screen, shows the same
 * number rather than restarting at zero.
 */
function stepTime(step: Pick<WorkspaceCopyUpgradeStep, 'state' | 'seconds' | 'startedAt'>, now: number): string {
  if (step.state === 'now') {
    const started = step.startedAt ? new Date(step.startedAt).getTime() : NaN;
    return Number.isFinite(started) ? clock(Math.max(0, (now - started) / 1000)) : '';
  }
  return clock(step.seconds);
}

function StepRow({ step, running }: { step: WorkspaceCopyUpgradeStep; running: boolean }) {
  const now = useNow(running && step.state === 'now');
  // A run nobody hears from any more has no clock worth showing on its open step.
  const time = step.state === 'now' && !running ? '' : stepTime(step, now);
  return (
    <li data-state={step.state}>
      <span className={`updot ${step.state}${step.back && step.state === 'done' ? ' wayback' : ''}`} aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'fail' ? '✕' : ''}</span>
      <span className="s">{step.label}{step.state === 'now' && step.detail ? <span className="d">{step.detail}</span> : null}</span>
      <span className="t">{step.state === 'now' && time ? <span className="upelapsed" role="timer" aria-label={`Running for ${time}`}>{time}</span> : time}</span>
    </li>
  );
}

function Steps({ steps, running }: { steps: WorkspaceCopyUpgradeStep[]; running: boolean }) {
  return (
    <div className="card" id="copyUpgradeSteps">
      <ul className="upsteps">
        {steps.map((step) => <StepRow key={step.key} step={step} running={running} />)}
      </ul>
    </div>
  );
}

/** What the run is, in one heading and one line under it. */
export function runTitle(run: WorkspaceCopyUpgradeRun): { title: string; sub: string } {
  const by = run.requestedBy ? ` by ${run.requestedBy}` : '';
  const started = hhmm(run.startedAt);
  switch (run.phase) {
    case 'done': return { title: `Upgraded to ${run.to}`, sub: `Finished ${hhmm(run.finishedAt)} UTC · started${by}` };
    case 'put-back': return { title: 'The upgrade did not go through', sub: `${run.from} is back · ${started}–${hhmm(run.finishedAt)} UTC · started${by}` };
    case 'drill-done': return { title: `Drill done: ${run.from} is back`, sub: `${run.drill === 'backend' ? 'The new Workspace was made not to start' : `${run.to} came up and was made to fail`} · ${started}–${hhmm(run.finishedAt)} UTC` };
    case 'unchanged': return { title: `Already on ${run.to}`, sub: 'Nothing to do' };
    case 'failed': return { title: 'The upgrade could not run', sub: `Nothing was changed · ${started} UTC · started${by}` };
    case 'stopped': return { title: 'The upgrade stopped part-way', sub: `To ${run.to} · started ${started} UTC${by}` };
    case 'putting-back': return { title: `Putting ${run.from} back`, sub: `The upgrade to ${run.to} stopped at a step that failed` };
    default: return { title: `Upgrading to ${run.to}`, sub: `${run.from ? `From ${run.from} · ` : ''}started ${started} UTC${by}` };
  }
}

async function downloadDiagnostics(api: ReturnType<typeof useOrgApi>) {
  const bundle = await api.api<{ generatedAt: string }>('api/copy/diagnostics');
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `copy-diagnostics-${bundle.generatedAt.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function CopyUpgradeScreen() {
  const api = useOrgApi();
  const navigate = useNavigate();
  const banner = useBanner();
  const { state } = useWorkspace();
  const admin = state?.org?.role === 'admin';
  const [upgrade, setUpgrade] = useState<WorkspaceCopyUpgradeState | null>(null);
  const [heardAt, setHeardAt] = useState<number | null>(null);
  // Polls in a row the Workspace did not answer: a restart is a few, an outage many.
  const [awayPolls, setAwayPolls] = useState(0);
  const [notes, setNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finishedFor = useRef<string | null>(null);

  const read = useCallback(async () => {
    try {
      const answer = await api.api<WorkspaceCopyUpgradeState>('api/copy/upgrade');
      setUpgrade(answer);
      setHeardAt(Date.now());
      setAwayPolls(0);
    } catch {
      // The Workspace restarting onto the new release, or being put back.
      setAwayPolls((n) => n + 1);
    }
  }, [api]);

  const run = upgrade?.run ?? null;
  const ended = Boolean(run && ['done', 'put-back', 'drill-done', 'unchanged', 'failed'].includes(run.phase));
  useEffect(() => {
    if (!admin) return;
    void read();
    if (ended) return;
    const timer = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [admin, read, ended]);

  // The new release's notes, once it runs (note #1006's screen reads them).
  useEffect(() => {
    if (!run || run.phase !== 'done' || finishedFor.current === run.id) return;
    finishedFor.current = run.id;
    api.api<WorkspaceCopyReleases>('api/copy/releases')
      .then((answer) => setNotes(answer.releases.find((release) => release.version === run.to)?.notes ?? null))
      .catch(() => setNotes(null));
  }, [api, run]);

  if (state && !admin) {
    return <div className="screen" id="screenCopyUpgrade">
      <ScreenTitle title="Upgrade" />
      <div className="card"><div className="empty">Only an admin of this workplace can upgrade it.</div></div>
    </div>;
  }
  if (!run) {
    return <div className="screen" id="screenCopyUpgrade">
      <ScreenTitle title="Upgrade" />
      <div className="card"><div className="empty">{upgrade ? 'No upgrade has run here yet.' : awayPolls ? 'Reconnecting…' : 'Reading…'}</div></div>
    </div>;
  }

  const { title, sub } = runTitle(run);
  const away = awayPolls > 0;
  const awayMs = awayPolls * POLL_MS;
  const awayLong = awayMs >= AWAY_LONG_MS;
  const failedStep = run.steps.find((step) => step.state === 'fail');
  const parsed = notes ? notesBody(notes) : null;
  const back = () => navigate(toFor({ kind: 'organization' })!);
  const carryOn = async () => {
    setBusy(true);
    try {
      await api.api('api/copy/upgrade/carry-on', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await read();
    } catch (err) {
      banner.show(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const diagnostics = async () => {
    try { await downloadDiagnostics(api); } catch (err) { banner.show(errorMessage(err)); }
  };

  return <div className="screen" id="screenCopyUpgrade" data-phase={run.phase}>
    <ScreenTitle title={title} sub={sub} subId="copyUpgradeSub" />
    {run.phase === 'done'
      ? <div className="upnotice good" id="copyUpgradeDone"><span aria-hidden="true">✓</span><span>Your Agentic Cloud runs <b>{run.to}</b>. It took {lasted(run.startedAt, run.finishedAt)}, and every part answered the final check.</span></div>
      : null}
    {run.phase === 'put-back' || run.phase === 'drill-done'
      ? <div className={`upnotice ${run.phase === 'put-back' ? 'bad' : 'warn'}`} id="copyUpgradePutBack"><span aria-hidden="true">↩</span><span>
        <b>{run.from} was put back, and every part answers.</b>{' '}
        {run.snapshotAt || run.startedAt ? `Your data is as it was at ${hhmm(run.snapshotAt ?? run.startedAt)} UTC; anything written between then and ${hhmm(run.finishedAt)} is lost.` : ''}
        {run.phase === 'drill-done' ? ' This was a drill: it was made to fail on purpose.' : ''}
      </span></div>
      : null}
    {run.phase === 'putting-back'
      ? <div className="upnotice warn" id="copyUpgradePuttingBack"><span aria-hidden="true">↩</span><span><b>Nothing for you to do.</b> {run.from} is being put back by itself, with the database as it was{run.snapshotAt ? ` at ${hhmm(run.snapshotAt)} UTC` : ''}.</span></div>
      : null}
    {run.phase === 'stopped'
      ? <div className="upnotice bad" id="copyUpgradeStopped"><span aria-hidden="true">!</span><span><b>The upgrader has not been heard from{run.heardSecondsAgo !== null ? ` for ${Math.round(run.heardSecondsAgo / 60)} min` : ''}.</b> Carry on starts a new one, which picks the upgrade up where it stopped, or puts the old release back if it must.</span></div>
      : null}

    {run.phase === 'done' && parsed
      ? <section aria-labelledby="copyUpgradeNotesTitle">
        <h2 id="copyUpgradeNotesTitle">What&apos;s new in {run.to}</h2>
        <div className="card copyreleasecard">
          {parsed.title ? <div className="copyreleasetitle">{parsed.title}</div> : null}
          <Markdown source={parsed.body} className="copyreleasenotes" />
        </div>
      </section>
      : null}

    {(run.phase === 'put-back' || run.phase === 'failed') && (failedStep || run.message)
      ? <section aria-labelledby="copyUpgradeFailedTitle">
        <h2 id="copyUpgradeFailedTitle">What failed</h2>
        <div className="card"><div className="crow"><div className="main">
          <div className="name plain">{failedStep?.label ?? 'The upgrade'}</div>
          <div className="cline"><span className="ctext">{run.message ?? 'see the steps below'}</span><span className="badge warn">Failed</span></div>
        </div></div></div>
      </section>
      : null}

    <h2>Steps</h2>
    <Steps steps={run.steps} running={!ended && run.phase !== 'stopped'} />

    {away && !ended
      ? <div className="upnotice" id="copyUpgradeAway" role="status"><span aria-hidden="true">↻</span><span>
        {awayLong
          ? <><b>The Workspace has not answered for {Math.floor(awayMs / 60_000)} minutes.</b> The upgrade carries on outside it and puts the old release back if it must. If it stays away, your engineer can run <code>node install.mjs status</code>.</>
          : <><b>The Workspace is restarting itself.</b> This page reconnects by itself. You can also close it: the upgrade runs outside the Workspace and finishes either way.</>}
      </span></div>
      : null}
    {!ended && !away && heardAt
      ? <p className="formhint" id="copyUpgradeHeard">{run.heardSecondsAgo !== null ? `Last heard from ${run.heardSecondsAgo} s ago. ` : ''}Any admin can follow this from Workplace › This copy.</p>
      : null}

    <div className="uprow">
      {run.phase === 'stopped' ? <button className="btn fill" id="copyUpgradeCarryOn" type="button" disabled={busy} onClick={() => { void carryOn(); }}>Carry on</button> : null}
      {run.phase === 'put-back' || run.phase === 'drill-done' || run.phase === 'failed' || run.phase === 'stopped'
        ? <button className={run.phase === 'stopped' ? 'btn primary' : 'btn fill'} id="copyUpgradeDiagnostics" type="button" onClick={() => { void diagnostics(); }}>Download diagnostics</button>
        : null}
      {run.phase === 'put-back' || run.phase === 'failed' ? <button className="btn primary" id="copyUpgradeTryAgain" type="button" onClick={back}>Try again</button> : null}
      {run.phase === 'done' || run.phase === 'drill-done' || run.phase === 'unchanged' ? <button className="btn primary" id="copyUpgradeBack" type="button" onClick={back}>Done</button> : null}
    </div>
    {run.phase === 'done' ? <p className="formhint">The database as it was before is kept on the Workspace&apos;s disk until the next upgrade.</p> : null}
    {run.phase === 'put-back' || run.phase === 'drill-done' || run.phase === 'failed'
      ? <p className="formhint">The diagnostics file carries this upgrade&apos;s steps and holds no messages, code, files, keys or names. Send it to support if you would like us to look.</p>
      : null}
  </div>;
}
