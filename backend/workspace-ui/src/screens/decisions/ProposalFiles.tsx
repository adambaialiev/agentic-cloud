/**
 * What the proposing agent attached, ABOVE the diff: it is the half of the
 * argument a phone can actually read, and a picture of the screen that changed
 * is worth more here than the first ten lines of a patch (notes #10/#18).
 *
 * A photo is shown AS a photo — the picture is the whole reason it was
 * attached, and "before-after.png · 1.2 MB" shows the reader none of it.
 * Everything else stays a row, SVG included: a drawing of unknown dimensions
 * crops badly.
 *
 * Nothing is attached FROM this screen: a file here is the agent's evidence
 * and the reader is the one being shown it. So a proposal with no files draws
 * no card at all, unlike a note's, where the card is where "Attach a file"
 * lives.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type {
  WorkspaceFileAccessAnswer,
  WorkspaceProposalAttachment,
} from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';
import { fileIcon, isInlineHtml, isInlinePdf } from '../../ui/file-kind.js';
import { TypeIcon } from '../../ui/icons.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { usePdfViewer } from '../../ui/usePdfViewer.js';
import { PressableRow } from '../home/PressableRow.js';
import { bytes } from './proposal-words.js';
import {
  heldProposalPreviewUrl, holdProposalPreview, previewStillGood, proposalPreviewKey, proposalPreviewUrl,
  rememberMediaOrigin,
} from './proposal-previews.js';

const filePath = (proposalId: string, fileId: string, preview = false) => (
  `api/prs/${encodeURIComponent(proposalId)}/files/${encodeURIComponent(fileId)}${preview ? '?preview=1' : ''}`
);

/** Out to the file itself. The URL is minted at tap time — one minted when the
 *  screen opened could be dead by the time of the tap. */
function useOpenFile(proposalId: string, onError: (message: string) => void) {
  const { api } = useSession();
  return (file: WorkspaceProposalAttachment) => {
    void (async () => {
      try {
        const access = await api.api<WorkspaceFileAccessAnswer>(filePath(proposalId, file.id), undefined);
        window.open(access.url, '_blank', 'noopener');
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    })();
  };
}

function FileRow({ file, glyph, onOpen }: {
  file: WorkspaceProposalAttachment;
  /** `image` for a photograph that would not draw; otherwise the mark the
   *  file's own name earns it, so a PDF reads as a document. */
  glyph?: 'image';
  onOpen: () => void;
}) {
  const kind = fileIcon(file.fileName);
  return (
    <PressableRow className="crow open" onPress={onOpen}>
      <TypeIcon glyph={glyph ?? kind.glyph} tint={glyph ? '' : kind.tint} />
      <div className="main">
        <div className="name">{file.fileName}</div>
        <div className="cline"><span className="ctext">{bytes(file.sizeBytes)}</span></div>
      </div>
    </PressableRow>
  );
}

/**
 * The photo itself, at the sheet's width and its own proportions.
 *
 * Note #825 is why it is shaped like this. On a phone, the sheet's pictures
 * waited for the words, then one more round trip each to mint a URL, and
 * drew as flat grey blocks of one fixed height that grew when the bytes
 * landed — the reader saw file names over grey and the sheet jumped under
 * their thumb. Now the proposal's answer carries each picture's pixel size
 * and a signed URL: the frame is laid out at the picture's real proportions
 * before a byte arrives (`--picture-ratio`, capped at the same height the
 * loaded picture obeys, so nothing moves when it lands), a quiet ring turns
 * in it meanwhile, and the picture is asked for in the FIRST render. The
 * first picture is fetched eagerly, at high priority; the rest as they
 * scroll into view. A URL the answer did not carry — an older backend, a
 * mint that failed — is minted the old way, and either way the URL is held
 * for the session so a rebuilt sheet puts the picture straight back.
 *
 * A URL that will not load leaves the reader a row they can still tap
 * rather than a grey box, and the caption under it goes with the block it
 * described.
 */
function ProposalPhoto({ proposalId, file, index, onOpen, onResolved }: {
  proposalId: string;
  file: WorkspaceProposalAttachment;
  /** Its place among the sheet's pictures: the first is above the fold
   *  more often than not, and is the one fetched eagerly. */
  index: number;
  onOpen: () => void;
  /** The signed URL, once it exists, so the screen above can build the
   *  gallery out of the pictures it is actually showing. */
  onResolved: (id: string, url: string) => void;
}) {
  const { api } = useSession();
  const key = proposalPreviewKey(proposalId, file);
  const carried = file.preview && previewStillGood(file.preview.expiresAt) ? file.preview : null;
  // Read synchronously, so the <img> exists in the first render and the
  // browser starts on it before React has finished mounting the sheet.
  const [url, setUrl] = useState(() => carried?.url ?? heldProposalPreviewUrl(key) ?? '');
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (carried) holdProposalPreview(key, carried);
    if (url) { rememberMediaOrigin(url); onResolved(file.id, url); return undefined; }
    let alive = true;
    void proposalPreviewUrl(api, proposalId, file).then((minted) => {
      if (!alive) return;
      if (minted) { setUrl(minted); onResolved(file.id, minted); }
      else setBroken(true);
    });
    return () => { alive = false; };
  }, [api, proposalId, file, key, carried, url, onResolved]);
  if (broken) return <FileRow file={file} glyph="image" onOpen={onOpen} />;
  const shaped = Boolean(file.width && file.height);
  return (
    <>
      <button
        className={['notephoto', shaped ? 'framed' : '', loaded ? '' : 'loading'].filter(Boolean).join(' ')}
        type="button"
        aria-label={loaded ? `Open ${file.fileName}` : `Loading ${file.fileName}`}
        style={shaped ? ({ '--picture-ratio': `${file.width} / ${file.height}` } as CSSProperties) : undefined}
        onClick={onOpen}
      >
        {loaded ? null : <span className="spinner" aria-hidden="true" />}
        {url ? (
          <img
            src={url}
            alt={file.fileName}
            loading={index === 0 ? 'eager' : 'lazy'}
            decoding="async"
            fetchPriority={index === 0 ? 'high' : 'auto'}
            onLoad={() => setLoaded(true)}
            onError={() => setBroken(true)}
          />
        ) : null}
      </button>
      <div className="crow caprow">
        <div className="main">
          <div className="cline">
            <span className="ctext">{file.fileName} · {bytes(file.sizeBytes)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

const isPhoto = (file: WorkspaceProposalAttachment) => {
  const type = file.contentType || '';
  return type.indexOf('image/') === 0 && type !== 'image/svg+xml';
};

export function ProposalFiles({ proposalId, files, onError }: {
  proposalId: string;
  files: readonly WorkspaceProposalAttachment[];
  onError: (message: string) => void;
}) {
  const { api } = useSession();
  const openOut = useOpenFile(proposalId, onError);
  const viewer = useImageViewer();
  const documents = usePdfViewer();
  // The gallery is built from the pictures the screen is ALREADY showing:
  // each photo hands its signed URL up as it resolves, so stepping between
  // three screenshots costs no further requests and cannot mint a URL for a
  // picture nobody looked at.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const onResolved = useCallback((id: string, url: string) => {
    setUrls((was) => (was[id] === url ? was : { ...was, [id]: url }));
  }, []);
  if (files.length === 0) return null;
  const photos = files.filter(isPhoto).filter((file) => urls[file.id]);
  const openPhoto = (file: WorkspaceProposalAttachment) => {
    const gallery = photos.map((photo) => ({ url: urls[photo.id]!, name: photo.fileName }));
    const at = photos.findIndex((photo) => photo.id === file.id);
    if (!gallery.length || at < 0) { openOut(file); return; }
    viewer(gallery, at);
  };
  // A PDF is evidence a phone can actually read, so it opens IN the
  // Workspace, over the decision (note #403), rather than downloading and
  // taking the reader away from the screen they are deciding on — and so
  // does an HTML page, sandboxed, with the save path as its Download (note
  // #557). Minted at the tap like every other read here, and asked for as a
  // preview: a link signed to be saved is downloaded rather than drawn.
  const openDocument = (file: WorkspaceProposalAttachment, kind: 'pdf' | 'html') => {
    void (async () => {
      try {
        const access = await api.api<WorkspaceFileAccessAnswer>(
          filePath(proposalId, file.id, true),
        );
        documents(kind === 'html'
          ? { url: access.url, name: file.fileName, kind, save: () => openOut(file) }
          : { url: access.url, name: file.fileName });
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    })();
  };
  return (
    <div className="card" id="prFiles">
      {files.map((file, at) => (isPhoto(file)
        ? (
          <ProposalPhoto
            proposalId={proposalId}
            file={file}
            index={files.slice(0, at).filter(isPhoto).length}
            key={file.id}
            onOpen={() => openPhoto(file)}
            onResolved={onResolved}
          />
        )
        : isInlinePdf(file.contentType, file.fileName)
          ? <FileRow file={file} key={file.id} onOpen={() => openDocument(file, 'pdf')} />
          : isInlineHtml(file.contentType, file.fileName)
            ? <FileRow file={file} key={file.id} onOpen={() => openDocument(file, 'html')} />
          // Everything else — an archive, a log, a zip — still leaves for the
          // browser's own handler: the Workspace has nothing to show it in.
          : <FileRow file={file} key={file.id} onOpen={() => openOut(file)} />))}
    </div>
  );
}
