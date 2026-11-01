/**
 * What approved checks in this repository may use (`agentbuilt repo
 * ci-secrets`), by name. Since note #739 a grant is applied the moment an
 * admin's agent makes it — nothing on this screen is decided — so this is the
 * owner's standing view of it: which names, whose room's they are, and where
 * they reach. Shown only while a grant stands. No button on it: any agent
 * takes a name back (`agentbuilt repo ci-secrets <name> NAME --remove`), and
 * the line says so, the same way the publishing link beneath it is handed
 * back.
 */

import { TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

export function RepoCiSecrets({ repoName }: { repoName: string }) {
  const { state } = useWorkspace();
  const repo = (state?.repos ?? []).find((entry) => entry.name === repoName) ?? null;
  const grant = repo?.ciSecrets;
  if (!grant || grant.names.length === 0) return <div id="repoCiSecrets" hidden />;
  return (
    <>
      <h2 id="repoCiSecretsHead">Keys for checks</h2>
      <div className="card" id="repoCiSecrets">
        <div className="crow">
          <TypeIcon glyph="key" tint="ok" />
          <div className="main">
            {/* It said whose room's keys, while there were rooms (note #843). */}
            <div className="name plain">{`Approved checks use ${grant.names.join(', ')}`}</div>
            <div className="cline"><span className="ctext">On the protected branch only</span></div>
          </div>
        </div>
      </div>
      {/* The whole meaning, unclipped — as the publishing hint below it. */}
      <div className="hintblock repo-public-hint">
        Only checks on the protected branch receive them, and their values are masked out of every log.
        Ask any agent to take a name back.
      </div>
    </>
  );
}
