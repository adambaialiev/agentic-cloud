/**
 * A repository's anonymous read boundary.
 *
 * Publishing is a human admin action (hidden 2026-09-29, back on
 * 2026-11-01 for note #936, when the owner open-sourced the platform's own
 * source). Agents prepare the code and its licence; this screen is where a
 * person sees the consequence and confirms it. There is no directory of
 * public repositories: a public one is reached by its address. Public means
 * browser + clone READS only — every write surface remains behind the
 * ordinary workplace credentials.
 */

import { useState } from 'react';
import type { WorkspaceRepoPublicAccessAnswer } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useSession } from '../../session/useSession.js';
import { copyFromTap, errorMessage } from '../../ui/format.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

export function RepoPublicAccess({ repoName }: { repoName: string }) {
  const { state, reload } = useWorkspace();
  const { api } = useSession();
  const banner = useBanner();
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const repo = (state?.repos ?? []).find((entry) => entry.name === repoName) ?? null;
  if (!repo) return <div id="repoPublicAccess" hidden />;
  const publicUrl = repo.publicUrl;
  const published = Boolean(publicUrl);

  const canManage = !state?.org || state.org.role === 'admin';

  const change = async (makePublic: boolean) => {
    const confirmed = await ask(makePublic
      ? {
        title: `Make ${repoName} public?`,
        message: 'Anyone with its address will be able to browse the default branch and clone the full history, including every branch, without an account. It must have a non-empty LICENSE file at its root. Copies people make cannot be recalled.',
        verb: 'Make public',
      }
      : {
        title: `Make ${repoName} private again?`,
        message: 'The public page and anonymous cloning will stop. Copies already made remain with the people who made them.',
        verb: 'Make private',
      });
    if (!confirmed) return;
    setBusy(true);
    try {
      const answer = await api.api<WorkspaceRepoPublicAccessAnswer>(
        `api/repos/${encodeURIComponent(repoName)}/public-access`,
        jsonBody({ public: makePublic }),
      );
      banner.show(answer.public ? `${repoName} is now public.` : `${repoName} is private again.`, true);
      await reload();
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = () => {
    if (!publicUrl) return;
    void copyFromTap(async () => publicUrl)
      .then(() => banner.show('Public link copied.', true))
      .catch(() => banner.show('Could not reach the clipboard — open the link and copy it there.'));
  };

  return (
    <>
      <h2 id="repoPublicHead">Public access</h2>
      <div className="card" id="repoPublicAccess">
        <div className="crow repo-public-state">
          <TypeIcon glyph={published ? 'globe' : 'lock'} tint={published ? 'ok' : 'mut'} />
          <div className="main">
            <div className="name">{published ? 'Public' : 'Private'}</div>
            <div className="cline">
              <span className="ctext">
                {published
                  ? 'Anyone with the link can browse and clone. Only the workplace can write.'
                  : 'Only people and agents in this workplace can read or write.'}
              </span>
            </div>
          </div>
        </div>
        {publicUrl ? (
          <div className="repo-public-link">
            <a href={publicUrl} target="_blank" rel="noreferrer">Open public page</a>
            <button type="button" className="act" onClick={copyLink} aria-label="Copy public link">
              <Icon name="copy" size={15} /><span>Copy link</span>
            </button>
          </div>
        ) : null}
      </div>
      {canManage ? (
        <div className="repo-public-actions">
          <button
            className={published ? 'btn ghost bare' : 'btn primary bare'}
            type="button"
            disabled={busy}
            onClick={() => { void change(!published); }}
          >
            {busy ? 'Changing…' : published ? 'Make private' : 'Make public'}
          </button>
        </div>
      ) : (
        <div className="hintblock repo-public-hint">Only a workplace admin can change public access.</div>
      )}
      {!published && canManage ? (
        <div className="hintblock repo-public-hint">
          Add a non-empty LICENSE file at the repository root before making it public.
        </div>
      ) : null}
    </>
  );
}
