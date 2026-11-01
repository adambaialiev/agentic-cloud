import { useParams } from 'react-router-dom';
import type { WorkspaceManagedJob, WorkspaceManagedJobOutcome, WorkspaceSettledJob } from '../../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { elapsed, useNow } from '../../ui/time.js';
import { useWait } from '../../ui/wait.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { useManagedJobs } from './useManagedJobs.js';

function startedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).format(date);
}

/** How a job ended, in a person's words rather than the CLI's identifiers. */
const OUTCOME: Record<WorkspaceManagedJobOutcome, string> = {
  succeeded: 'Finished',
  failed: 'Failed',
  timed_out: 'Timed out',
  stopped: 'Stopped by the agent',
  interrupted: 'Interrupted by a restart',
};

export function BackgroundJobsScreen() {
  const { id = '' } = useParams();
  const { agents } = useWorkspace();
  const agent = (agents ?? []).find((row) => row.id === id) ?? null;
  const { jobs, recent, answered, failed, refresh } = useManagedJobs({
    agentId: id,
    active: Boolean(agent),
    working: Boolean(agent?.working),
  });
  const waiting = useWait(Boolean(agent) && !answered && !jobs.length && !recent.length);
  const now = useNow(jobs.length > 0);

  if (!agents) {
    return <div className="screen" id="screenAgentJobs" aria-busy="true"><div id="loading"><span className="sr-only">Loading…</span></div></div>;
  }
  if (!agent) {
    return (
      <div className="screen" id="screenAgentJobs">
        <ScreenTitle title="Background jobs" />
        <div className="card authpanel" role="alert">
          <h2>That agent is not here</h2>
          <div className="authsub">It may have been deleted, or it belongs to another workspace.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen" id="screenAgentJobs">
      <ScreenTitle title="Background jobs" sub={agent.name} />
      {waiting === 'drawn' ? <div id="loading"><span className="sr-only">Loading background jobs…</span></div> : null}
      {!jobs.length && !recent.length && answered && failed
        ? (
          <div className="card authpanel" role="alert" id="agentJobsFailed">
            <h2>Background jobs could not be loaded</h2>
            <div className="authsub">{failed}</div>
            <button className="btn primary" type="button" onClick={() => { void refresh(); }}>Try again</button>
          </div>
        )
        : null}
      {!jobs.length && answered && !failed
        ? (
          <div className="empty" id="agentJobsEmpty">
            <div className="emptytitle">No background jobs are running</div>
            <div className="emptytext">
              {recent.length
                ? 'The most recent ones are below, with how each ended.'
                : 'A job that ends stays here for a day, with how it ended.'}
            </div>
          </div>
        )
        : null}
      <JobCards jobs={jobs} recent={recent} now={now} />
    </div>
  );
}

/**
 * The cards themselves — the running jobs, then the finished ones — apart
 * from the screen that reads them, so the public documentation can draw
 * them with fixture rows (src/components/LiveJobs.tsx) exactly as the
 * screen draws them.
 */
export function JobCards({ jobs, recent, now }: { jobs: WorkspaceManagedJob[]; recent: WorkspaceSettledJob[]; now: number }) {
  return (
    <>
      {jobs.length ? (
        <div className="jobdetails" id="agentJobsList" aria-live="polite">
          {jobs.map((job) => (
            <section className="card jobdetail" key={job.id} data-job-id={job.id}>
              <code className="jobcommand">{job.label}</code>
              <dl className="jobmeta">
                <div><dt>Status</dt><dd><span className="jobstatus running">Running</span></dd></div>
                <div><dt>Running for</dt><dd className="jobelapsed">{elapsed(job.startedAt, now)}</dd></div>
                <div><dt>Started</dt><dd><time dateTime={job.startedAt}>{startedAt(job.startedAt)}</time></dd></div>
                <div><dt>Job ID</dt><dd><code>{job.id}</code></dd></div>
              </dl>
            </section>
          ))}
        </div>
      ) : null}
      {recent.length ? (
        <>
          <h2 id="agentJobsRecentHead">Recently finished</h2>
          <div className="jobdetails" id="agentJobsRecent">
            {recent.map((job) => (
              <section className="card jobdetail" key={job.id} data-job-id={job.id}>
                <code className="jobcommand">{job.label}</code>
                <dl className="jobmeta">
                  <div><dt>Status</dt><dd><span className={`jobstatus ${job.status}`}>{OUTCOME[job.status]}</span></dd></div>
                  <div><dt>Ran for</dt><dd>{elapsed(job.startedAt, Date.parse(job.finishedAt))}</dd></div>
                  <div><dt>Started</dt><dd><time dateTime={job.startedAt}>{startedAt(job.startedAt)}</time></dd></div>
                  <div><dt>Ended</dt><dd><time dateTime={job.finishedAt}>{startedAt(job.finishedAt)}</time></dd></div>
                  <div><dt>Job ID</dt><dd><code>{job.id}</code></dd></div>
                </dl>
              </section>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
