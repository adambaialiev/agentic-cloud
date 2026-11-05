/**
 * What's new (note #1006): in a company's own Agentic Cloud, for its admins,
 * every release newer than the one running, newest first, each with its
 * notes as the update service serves them; then the running release itself,
 * "what this release brought". Reached from the health page's Workspace line.
 *
 * The notes are a release's own words for an admin (infra/copy-release/
 * notes/<version>.md): a title, then What's new, Fixed and Needs you. They
 * are rendered by the same safe Markdown reader every write-up uses.
 */
import { useEffect, useState } from 'react';
import type { WorkspaceCopyRelease, WorkspaceCopyReleases } from '../../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { Markdown } from '../../render/Markdown.js';
import { errorMessage } from '../../ui/format.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { UpgradeHint } from './CopyHealthSection.js';
import { useOrgApi } from './useOrgApi.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2026-11-03 → 3 November 2026 */
export function releaseDay(date: string | null): string | null {
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}` : null;
}

/** The notes below their title: the title is the card's own heading, and
 *  the three sections sit one level under it. */
export function notesBody(notes: string): { title: string | null; body: string } {
  const lines = notes.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((line) => line.trim());
  const title = at >= 0 && /^# /.test(lines[at]!) ? lines[at]!.slice(2).trim() : null;
  const rest = title ? lines.slice(at + 1) : lines;
  return { title, body: rest.join('\n').replace(/^## /gm, '### ').trim() };
}

function ReleaseCard({ release }: { release: WorkspaceCopyRelease }) {
  const parsed = release.notes ? notesBody(release.notes) : null;
  const title = parsed?.title ?? release.summary;
  const day = releaseDay(release.date);
  return (
    <section className="copyrelease" data-version={release.version} aria-labelledby={`copyRelease-${release.version}`}>
      <h2 id={`copyRelease-${release.version}`}>
        {release.running ? 'What this release brought · ' : ''}{release.version}{day ? ` · ${day}` : ''}
      </h2>
      <div className="card copyreleasecard">
        {title ? <div className="copyreleasetitle">{title}</div> : null}
        {parsed?.body
          ? <Markdown source={parsed.body} className="copyreleasenotes" />
          : <div className="empty">{release.notes === null ? 'The notes for this release could not be read from the update service.' : 'This release has no notes.'}</div>}
      </div>
    </section>
  );
}

export function CopyReleasesScreen() {
  const api = useOrgApi();
  const { state } = useWorkspace();
  const [answer, setAnswer] = useState<WorkspaceCopyReleases | null>(null);
  const [failed, setFailed] = useState('');
  const admin = state?.org?.role === 'admin';

  useEffect(() => {
    if (!admin) return;
    let live = true;
    api.api<WorkspaceCopyReleases>('api/copy/releases')
      .then((read) => { if (live) { setAnswer(read); setFailed(''); } })
      .catch((err: unknown) => { if (live) setFailed(errorMessage(err)); });
    return () => { live = false; };
  }, [api, admin]);

  if (state && !admin) {
    return <div className="screen" id="screenCopyReleases">
      <ScreenTitle title="What's new" />
      <div className="card"><div className="empty">Only an admin of this workplace sees what each release brings.</div></div>
    </div>;
  }

  const updates = answer?.updates;
  const newer = answer?.releases.filter((release) => !release.running).length ?? 0;
  const sub = updates
    ? [updates.running ? `You run ${updates.running}` : 'Your release is not known', updates.latest ? `latest ${updates.latest}` : null].filter(Boolean).join(' · ')
    : undefined;

  return <div className="screen" id="screenCopyReleases">
    <ScreenTitle title="What's new" sub={sub} subId="copyReleasesSub" />
    {failed ? <div className="hintblock mailwarn" role="alert" id="copyReleasesFailed">{failed}</div> : null}
    {!answer && !failed ? <div className="card"><div className="empty">Reading…</div></div> : null}
    {answer ? <>
      <p className="formhint" id="copyReleasesLead">
        {updates?.state === 'behind'
          ? `${newer === 1 ? 'One release is' : `${newer} releases are`} newer than the one you run, newest first.`
          : updates?.state === 'current'
            ? 'You run the latest release.'
            : updates?.state === 'off'
              ? 'Update checks are off here, so newer releases are not shown.'
              : 'The update service has not been reached lately, so newer releases may be missing.'}
      </p>
      {updates?.state === 'behind' && updates.howToUpgrade ? <div className="card copyupgradecard"><div className="crow"><div className="main"><UpgradeHint text={updates.howToUpgrade} /></div></div></div> : null}
      {answer.releases.map((release) => <ReleaseCard key={release.version} release={release} />)}
    </> : null}
  </div>;
}
