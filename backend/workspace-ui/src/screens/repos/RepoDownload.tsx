/**
 * Download: the whole repository as one .zip, for a person who wants to take
 * their code somewhere else (note #1199 — Adam, 20 Nov 2026: "user should be
 * able to download repository if user wants to walk away and move to another
 * git hosting. history should be preserved").
 *
 * The zip is the default branch's files plus the full `.git` — every branch,
 * every tag, every commit — so unzipped it is an ordinary git repository, and
 * one `git push --mirror` moves all of it to the new host. The line under the
 * button says exactly that, because the button alone does not tell a person
 * how to finish leaving.
 *
 * The size is said BEFORE the tap: a 300 MB file on a phone's data plan is a
 * decision, not a surprise. It is the host's upper bound (history on disk
 * plus the files uncompressed), so "about" is honest and the file is never
 * bigger than promised.
 *
 * A plain link, not a fetch: the browser streams the file to disk itself, on
 * the session cookie, and a phone hands it to Files like any download. Any
 * member may take it — the same people who can already read every byte here.
 */

import { useEffect, useState } from 'react';
import type { WorkspaceRepoDownloadInfo } from '../../../../src/shared/workspace-api.js';
import { WORKSPACE_API_BASE } from '../../../../src/shared/workspace-routes.js';
import { useSession } from '../../session/useSession.js';
import { bytes } from '../../ui/file-kind.js';
import { TypeIcon } from '../../ui/icons.js';
import { useOrgScope } from '../../workspace/useWorkspace.js';

/** Our own address for the zip, read with the reader's session. */
export function repoDownloadUrl(repoName: string, orgId?: string): string {
  const query = orgId ? `?${new URLSearchParams({ org: orgId })}` : '';
  return `${WORKSPACE_API_BASE}/api/repos/${encodeURIComponent(repoName)}/download${query}`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "about 253 MB · 4,843 commits · 8 branches · 2 tags" — tags only when
 *  there are some, since "0 tags" reads like something is missing. */
export function downloadSummary(info: WorkspaceRepoDownloadInfo): string {
  const parts = [`about ${bytes(info.estimateBytes)}`];
  if (info.commits === 0) parts.push('no commits yet');
  else {
    parts.push(count(info.commits, 'commit', 'commits'));
    parts.push(count(info.branches, 'branch', 'branches'));
    if (info.tags > 0) parts.push(count(info.tags, 'tag', 'tags'));
  }
  return parts.join(' · ');
}

export function RepoDownload({ repoName }: { repoName: string }) {
  const { api } = useSession();
  const { orgId } = useOrgScope();
  const [info, setInfo] = useState<WorkspaceRepoDownloadInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setInfo(null);
    setFailed(false);
    void (async () => {
      try {
        const read = await api.api<WorkspaceRepoDownloadInfo>(`api/repos/${encodeURIComponent(repoName)}/download-info`, undefined);
        if (current) setInfo(read);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => { current = false; };
  }, [api, repoName]);

  // A host that cannot make downloads says nothing rather than offering a
  // button that fails.
  if (failed) return <div id="repoDownload" hidden />;
  const fileName = info?.fileName ?? `${repoName}.zip`;
  const branch = info?.defaultBranch;
  return (
    <>
      <h2 id="repoDownloadHead">Download</h2>
      <div className="card" id="repoDownload" aria-busy={!info || undefined}>
        <div className="crow repo-download-file">
          <TypeIcon glyph="archive" tint="mut" />
          <div className="main">
            <div className="name">{fileName}</div>
            <div className="cline">
              <span className="ctext" id="repoDownloadSize">
                {info ? downloadSummary(info) : 'Working out the size…'}
              </span>
            </div>
          </div>
        </div>
      </div>
      {info?.tooLarge ? (
        <div className="hintblock repo-download-hint">
          Too big for one zip. Clone it with git instead — the full history comes with it.
        </div>
      ) : (
        <>
          <div className="repo-download-actions">
            <a className="btn primary bare" id="repoDownloadLink" href={repoDownloadUrl(repoName, orgId)} download={fileName}>
              Download
            </a>
          </div>
          <div className="hintblock repo-download-hint" id="repoDownloadHint">
            {`Every branch, tag and commit, with the files of ${branch ?? 'the default branch'} beside them — unzip it and it is an ordinary git repository. `}
            To move to another git host, create an empty repository there, then run{' '}
            <code>git push --mirror &lt;its address&gt;</code> inside the unzipped folder.
          </div>
        </>
      )}
    </>
  );
}
