/**
 * A repository's anonymous read boundary.
 *
 * Opening a repository to the public is HIDDEN (the owner, 2026-09-29: the
 * platform is for closed-source work). A private repository shows nothing
 * here; one an admin opened before then keeps its link and the one way
 * back, Make private. Public means browser + clone READS only — every write
 * surface remains behind the ordinary workplace credentials.
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
  const publicUrl = repo?.publicUrl;
  if (!publicUrl) return <div id="repoPublicAccess" hidden />;

  const canManage = !state?.org || state.org.role === 'admin';

  const makePrivate = async () => {
    const confirmed = await ask({
      title: `Make ${repoName} private again?`,
      message: 'The public page and anonymous cloning will stop, and it cannot be made public again. Copies already made remain with the people who made them.',
      verb: 'Make private',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.api<WorkspaceRepoPublicAccessAnswer>(
        `api/repos/${encodeURIComponent(repoName)}/public-access`,
        jsonBody({ public: false }),
      );
      banner.show(`${repoName} is private again.`, true);
      await reload();
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = () => {
    void copyFromTap(async () => publicUrl)
      .then(() => banner.show('Public link copied.', true))
      .catch(() => banner.show('Could not reach the clipboard — open the link and copy it there.'));
  };

  return (
    <>
      <h2 id="repoPublicHead">Public access</h2>
      <div className="card" id="repoPublicAccess">
        <div className="crow repo-public-state">
          <TypeIcon glyph="globe" tint="ok" />
          <div className="main">
            <div className="name">Public</div>
            <div className="cline">
              <span className="ctext">Anyone with the link can browse and clone. Only the workplace can write.</span>
            </div>
          </div>
        </div>
        <div className="repo-public-link">
          <a href={publicUrl} target="_blank" rel="noreferrer">Open public page</a>
          <button type="button" className="act" onClick={copyLink} aria-label="Copy public link">
            <Icon name="copy" size={15} /><span>Copy link</span>
          </button>
        </div>
      </div>
      {canManage ? (
        <div className="repo-public-actions">
          <button className="btn ghost bare" type="button" disabled={busy} onClick={() => { void makePrivate(); }}>
            {busy ? 'Changing…' : 'Make private'}
          </button>
        </div>
      ) : (
        <div className="hintblock repo-public-hint">Only a workplace admin can make it private.</div>
      )}
    </>
  );
}
