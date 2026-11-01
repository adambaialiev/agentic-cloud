/**
 * What this folder is FOR, under the listing — the same place GitHub puts it.
 *
 * Read AFTER the files are on screen, so the listing never waits on it, and a
 * README that fails, or is too big, or turns out to be bytes rather than
 * text, says nothing at all: the file is still one tap away in the listing
 * above, and a folder listing is not the place to explain a fetch that did
 * not work.
 */

import { useEffect, useState } from 'react';
import type {
  WorkspaceRepoFileAnswer,
  WorkspaceRepoTreeEntry,
} from '../../../../src/shared/workspace-api.js';
import { Markdown } from '../../render/Markdown.js';
import { useSession } from '../../session/useSession.js';
import { fileExt } from '../../ui/file-kind.js';
import { CodeView } from './CodeView.js';
import { MD_EXT } from './repo-nav.js';

export function RepoReadme({ repoName, path, entry }: {
  repoName: string;
  path: string;
  entry: WorkspaceRepoTreeEntry;
}) {
  const { api } = useSession();
  const [content, setContent] = useState<string | null>(null);

  const filePath = path ? `${path}/${entry.name}` : entry.name;
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const answer = await api.api<WorkspaceRepoFileAnswer>(
          `api/repos/${encodeURIComponent(repoName)}/file?path=${encodeURIComponent(filePath)}`,
          undefined,
        );
        // Bytes, a blob too large for a phone, or an empty file: all three are
        // "nothing to say here", which is what this draws.
        if (current) setContent(answer.tooLarge || answer.binary || answer.image ? null : (answer.content ?? null));
      } catch {
        if (current) setContent(null);
      }
    })();
    return () => { current = false; };
  }, [api, repoName, filePath]);

  if (!content) return null;
  return MD_EXT.has(fileExt(entry.name))
    ? <div className="card readme"><Markdown source={content} /></div>
    : <div className="card readme"><CodeView content={content} ext={fileExt(entry.name)} /></div>;
}
