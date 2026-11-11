import type { WorkspaceRepoTreeEntry } from '../../backend/src/shared/workspace-api';
import { RepoCrumb } from '../../backend/workspace-ui/src/screens/repos/RepoCrumb';
import { entrySide, orderedEntries } from '../../backend/workspace-ui/src/screens/repos/repo-nav';
import { bytes, fileIcon } from '../../backend/workspace-ui/src/ui/file-kind';
import { Icon, TypeIcon } from '../../backend/workspace-ui/src/ui/icons';
import { CheckRow } from '../../backend/workspace-ui/src/screens/decisions/Checks';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { PanelTitle } from './live/PanelTitle';

/**
 * A repository's files, live: the repository screen's Content tab — its two
 * tabs, the crumb, the branch bar and the Files card — over the fixture's
 * northstar-routing tree. The tab strip, the bar and the tree row are the
 * screen's own markup in its own classes, with its own icon rule
 * (`fileIcon`) and size words (`entrySide`); the crumb is the real
 * component. The screen itself reads the tree through the API on a route
 * of its own, which is why the rows are composed here.
 */

const REPO = 'northstar-routing';
const TREE: WorkspaceRepoTreeEntry[] = orderedEntries([
  { name: 'src', type: 'dir' },
  { name: 'bench', type: 'dir' },
  { name: '.agentbuilt', type: 'dir' },
  { name: 'Cargo.toml', type: 'file', sizeBytes: 1_284 },
  { name: 'README.md', type: 'file', sizeBytes: 4_096 },
  { name: 'run.sh', type: 'file', sizeBytes: 118 },
]);

function TreeRow({ entry }: { entry: WorkspaceRepoTreeEntry }) {
  const isDir = entry.type === 'dir';
  const kind = isDir ? { glyph: 'folder' as const, tint: 'dir' as const } : fileIcon(entry.name);
  const side = entrySide(entry, bytes);
  return (
    <div className="trow open" role="button" tabIndex={-1}>
      <TypeIcon glyph={kind.glyph} tint={kind.tint} />
      <div className="tname">{entry.name}{isDir ? '/' : ''}</div>
      {side ? <div className="tsize">{side}</div> : null}
    </div>
  );
}

/** The repository's Actions: the checks `.agentbuilt/ci.sh` ran on the last
 *  push, green, and the deploy that push started, still running (the owner,
 *  2026-09-12). `side` is the relative time the screen puts at the row's
 *  edge, fixed words here so the build's HTML and the client's first paint
 *  agree. */
const RUNS = [
  { context: 'checks', state: 'success', description: 'Tests, clippy and build · 4m 02s', startedAt: '2026-09-11T14:02:00.000Z', side: '3m ago' },
  { context: 'deploy', state: 'pending', description: 'Publishing routing · running', startedAt: '2026-09-11T14:05:00.000Z', side: 'just now' },
] as const;

export default function LiveRepoFiles({ className = '' }: { className?: string }) {
  return (
    <LivePanel size="tile" className={`landing-files ${className}`} says="The northstar-routing repository’s files on its main branch: the src, bench and .agentbuilt folders, Cargo.toml, README.md and run.sh, each with its size.">
      <LiveWorkspace>
        <div className="screen" id="screenRepo">
          <div className="phead">
            <div className="pname"><PanelTitle id="repoTitle">{REPO}</PanelTitle></div>
          </div>
          <div className="segtabs" id="repoTabs" role="tablist" aria-label="Repository view">
            <button className="segtab" type="button" role="tab" aria-selected={false} tabIndex={-1}>Overview</button>
            <button className="segtab" type="button" role="tab" aria-selected tabIndex={0}>Content</button>
          </div>
          <div id="repoContent" role="tabpanel">
            <RepoCrumb id="repoCrumb" repoName={REPO} path="" leaf={null} />
            <div className="filebar" id="repoBar">
              <div className="kind branch" id="repoBranch"><Icon name="git" size={13} /><span>main</span></div>
            </div>
            <h2 id="repoFilesHead">Files</h2>
            <div className="card" id="repoTree">
              {TREE.map((entry) => <TreeRow entry={entry} key={`${entry.type}:${entry.name}`} />)}
            </div>
            {/* The Overview tab's Actions card, under the files (the owner,
                2026-09-12): the repository's own checks, one row per run, the
                app's CheckRow — the tile is the repository, not one tab of it. */}
            <h2 id="repoChecksHead">Actions</h2>
            <div className="card" id="repoChecks">
              {RUNS.map((run) => <CheckRow check={run} side={run.side} startClosed key={run.startedAt} />)}
            </div>
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
