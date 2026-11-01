/**
 * One file of the default branch, on a screen of its own.
 *
 * Four different things can come back and each gets its own answer: text
 * (numbered, or wrapped when it is prose), a markdown file (rendered, with a
 * toggle to the source), an image the host decoded (shown at its real size,
 * and a tap opens it full screen), and everything else — a binary, or a blob
 * too large for a phone — which says so plainly rather than showing a wall of
 * mojibake.
 *
 * Nothing in the file ever becomes markup: the markdown goes through the
 * shell's one renderer, and the raw view is text in a `<pre>`.
 */

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { WorkspaceRepoFileAnswer } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { Markdown } from '../../render/Markdown.js';
import { useSession } from '../../session/useSession.js';
import { bytes, fileExt } from '../../ui/file-kind.js';
import { copyFromTap } from '../../ui/format.js';
import { Icon } from '../../ui/icons.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { CodeView } from './CodeView.js';
import { RepoCrumb } from './RepoCrumb.js';
import { repoReadError } from './repo-words.js';
import { MD_EXT, folderOf, imageDataUrl, leafOf } from './repo-nav.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

/** The wait: a toolbar and a few lines of nothing, the shape of what lands. */
function FileSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="filebar"><span className="skel nm" style={{ width: '64px' }} /></div>
      <div className="card">
        {[72, 54, 63, 41].map((width, at) => (
          <div className="trow" key={at}>
            <div className="skel nm" style={{ width: `${width}%`, animationDelay: `${(at * 0.09).toFixed(2)}s` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function FileImage({ src, name }: { src: string; name: string }) {
  const [size, setSize] = useState('');
  const [broken, setBroken] = useState(false);
  const openImage = useImageViewer();
  const label = fileExt(name).toUpperCase() || 'Image';
  if (broken) {
    return <div className="empty">This image could not be shown here. Clone the repository to open it.</div>;
  }
  return (
    <>
      {/* Its real size, once the browser knows it: the one fact about an
          image that its picture cannot show you, and the one a person asks
          about a screenshot or an icon. */}
      <div className="filebar"><div className="kind">{size ? `${label} · ${size}` : label}</div></div>
      <div className="imgview">
        <img
          alt={name}
          className="openimage"
          src={src}
          role="button"
          tabIndex={0}
          aria-label={`Open ${name} full screen`}
          onLoad={(event) => {
            const img = event.currentTarget;
            setSize(`${img.naturalWidth} × ${img.naturalHeight}`);
          }}
          onError={() => setBroken(true)}
          onClick={() => openImage([{ url: src, name }], 0)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openImage([{ url: src, name }], 0);
          }}
        />
      </div>
    </>
  );
}

function FileText({ content, name }: { content: string; name: string }) {
  const banner = useBanner();
  const ext = fileExt(name);
  const isMd = MD_EXT.has(ext);
  const [raw, setRaw] = useState(false);
  const formatted = isMd && !raw;
  return (
    <>
      <div className="filebar">
        <div className="kind">
          {formatted ? 'Markdown' : isMd ? 'Markdown source' : (ext ? ext.toUpperCase() : 'Text')}
        </div>
        {isMd ? (
          <button className="act" type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
            {formatted ? 'View raw' : 'View formatted'}
          </button>
        ) : null}
        <button
          className="act"
          type="button"
          onClick={() => {
            void copyFromTap(async () => content)
              .then(() => banner.show(`Copied ${name}`, true))
              .catch(() => banner.show('Could not reach the clipboard — try again.'));
          }}
        >
          <Icon name="copy" size={15} /><span>Copy</span>
        </button>
      </div>
      {formatted ? <Markdown source={content} /> : <CodeView content={content} ext={ext} />}
    </>
  );
}

export function RepoFileScreen() {
  const { id: repoName = '' } = useParams();
  const [search] = useSearchParams();
  const filePath = search.get('path') ?? '';
  const { api } = useSession();
  const { state } = useWorkspace();
  const [file, setFile] = useState<WorkspaceRepoFileAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const answer = await api.api<WorkspaceRepoFileAnswer>(
          `api/repos/${encodeURIComponent(repoName)}/file?path=${encodeURIComponent(filePath)}`,
          undefined,
        );
        if (current) setFile(answer);
      } catch (error) {
        if (current) setLoadError(error);
      }
    })();
    return () => { current = false; };
  }, [api, repoName, filePath]);

  const name = leafOf(filePath);
  const image = file?.image ? imageDataUrl(file.image) : '';
  return (
    <div className="screen" id="screenFile">
      <ScreenTitle
        titleId="fileTitle"
        title={name}
        subNode={(
          <RepoCrumb
            id="fileSub"
            repoName={repoName}
            path={folderOf(filePath)}
            leaf={name}
            tail={file ? ` · ${bytes(file.sizeBytes)}` : undefined}
          />
        )}
      />
      <div id="fileBody">
        {loadError ? <div className="empty">{repoReadError(loadError, repoName, state?.org?.name)}</div> : null}
        {!file && !loadError ? <FileSkeleton /> : null}
        {file?.tooLarge
          ? (
            <div className="empty">
              This file is {bytes(file.sizeBytes)} — too large to show here. Clone the repository to open it.
            </div>
          )
          : null}
        {file && !file.tooLarge && file.image
          ? (image
            ? <FileImage src={image} name={name} />
            : <div className="empty">This image could not be shown here. Clone the repository to open it.</div>)
          : null}
        {file && !file.tooLarge && !file.image && file.binary
          ? (
            <div className="empty">
              This looks like a binary file, so there is nothing to show as text. Clone the repository to open it.
            </div>
          )
          : null}
        {file && !file.tooLarge && !file.image && !file.binary && file.content === ''
          ? <div className="empty">This file is empty.</div>
          : null}
        {file && !file.tooLarge && !file.image && !file.binary && file.content
          ? <FileText content={file.content} name={name} />
          : null}
      </div>
    </div>
  );
}
