/**
 * Where an approved change to this repository goes on its own
 * (`agentbuilt repo publish`).
 *
 * Shown only while a link stands: a repository published by hand has nothing
 * to say here. Since note #739 the link is applied the moment an admin's agent
 * asks for it, so nothing here is decided — this is the owner's view of what
 * approving now means. No button on it — any agent turns it off
 * (`agentbuilt repo publish <name> --off`), and the line says so, the same
 * way the CI-secrets grant above it is handed back.
 */

import { TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

export function RepoPublishing({ repoName }: { repoName: string }) {
  const { state } = useWorkspace();
  const repo = (state?.repos ?? []).find((entry) => entry.name === repoName) ?? null;
  const site = repo?.publishesTo;
  if (!site) return <div id="repoPublishing" hidden />;
  return (
    <>
      <h2 id="repoPublishingHead">Publishing</h2>
      <div className="card" id="repoPublishing">
        <div className="crow">
          <TypeIcon glyph="globe" tint="ok" />
          <div className="main">
            <div className="name plain">{`Publishes ${site}`}</div>
            <div className="cline"><span className="ctext">On approval, once its checks pass</span></div>
          </div>
        </div>
      </div>
      {/* The whole meaning, unclipped: a one-line row truncates, and the half
          that says how to take it back is the half that would be cut. */}
      <div className="hintblock repo-public-hint">
        Every change you approve goes live there on its own. Ask any agent to go back to publishing by hand.
      </div>
    </>
  );
}
