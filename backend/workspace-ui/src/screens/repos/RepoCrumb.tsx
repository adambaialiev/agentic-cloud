/**
 * The path crumb the tree, the file view, the history and the contributors
 * screens all wear: the repository's name and every folder above the reader,
 * each a jump straight to that folder.
 *
 * A jump is a real navigation, so it writes the folder's own address. The
 * legacy page replays browser Back when the target is the ONE proven parent
 * entry and walks forward otherwise; here every jump is a forward door,
 * because the persistent header's Back already owns the one-hop return and a
 * crumb that sometimes went back and sometimes forward was the subtler of the
 * two behaviours to keep honest.
 */

import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { useOrgScope } from '../../workspace/useWorkspace.js';
import { crumbParts } from './repo-nav.js';

export function RepoCrumb({ id, repoName, path, leaf, tail }: {
  id: string;
  repoName: string;
  path: string;
  /** What the reader is looking at: a file's name, "History", or null for
   *  "the last folder in the path". */
  leaf: string | null;
  /** Appended after the leaf — a file's size, once it is known. */
  tail?: string;
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const { parts, here } = crumbParts(repoName, path, leaf);
  return (
    <div className="sub crumb" id={id}>
      {parts.map((part) => {
        const to = toFor({ kind: 'repo', id: repoName, ...scope, ...(part.target ? { path: part.target } : {}) });
        return (
          <span key={`${part.target}:${part.label}`}>
            <button className="seg" type="button" onClick={() => { if (to) navigate(to); }}>{part.label}</button>
            <span className="sep">/</span>
          </span>
        );
      })}
      <span className="here">{here}</span>
      {tail ? <span>{tail}</span> : null}
    </div>
  );
}
