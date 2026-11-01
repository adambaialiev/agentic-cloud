/**
 * What an agent's newest message CARRIES, on its plate (note #553).
 *
 * The fleet's recap line says an agent "delivered 30 screenshots"; this is
 * the screenshots. Every file on the newest message of its chat — the owner's
 * or the agent's own, whichever was said last — stands in a strip under the
 * recap: a picture as a thumbnail at its own proportions, anything else as
 * the typed glyph and its name. The strip scrolls sideways when it is wider
 * than a half-plate, which is what a carousel is at this size.
 *
 * A tap on a picture opens the shared full-screen viewer with the strip's
 * OTHER pictures as its gallery, so the second and third screenshots are one
 * step away rather than a trip back to the list. A PDF opens in the document
 * viewer beside it, and so does a Markdown file, as a page (note #677);
 * everything else is saved, the way the chat saves it
 * (note #552). None of those taps opens the agent's screen: the plate is the
 * door, and a control on it has to swallow its own press or every tap on a
 * thumbnail would leave the list.
 *
 * Pictures are minted the way the notes list mints its glimpse (note #198):
 * lazily, when the STRIP scrolls into view, and held for the session so a
 * poll rebuilding the row puts the picture straight back rather than asking
 * — and downloading — again. The strip is what is watched, not each
 * thumbnail: a thumbnail past the strip's right edge never intersects the
 * viewport, and a picture minted only once scrolled to is a picture the
 * viewer's carousel would be missing when the first one is tapped.
 */

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { WorkspaceChatFile, WorkspaceChatFileAccessAnswer } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { fileIcon, isInlineHtml, isInlineImage, isInlinePdf, isMarkdown } from '../../ui/file-kind.js';
import { TypeIcon } from '../../ui/icons.js';
import { heldPreview, mintPreview, type HeldPreview } from '../../ui/preview-urls.js';
import { saveFile } from '../../ui/save-file.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { usePdfViewer } from '../../ui/usePdfViewer.js';
import type { WorkspaceApi } from '../../api/client.js';
import { readChatFileText } from '../chat/chat-file-text.js';

/** What identifies the picture: the file, on the chat it was said in. */
const agentFileKey = (agentId: string, file: { id: string }) => `agent-chat/${agentId}/${file.id}`;

const fileRead = (agentId: string, file: { id: string }, preview: boolean) =>
  `api/agents/${encodeURIComponent(agentId)}/chat/files/${encodeURIComponent(file.id)}${preview ? '?preview=1' : ''}`;

const previewOf = (api: WorkspaceApi, agentId: string, file: WorkspaceChatFile) => mintPreview(
  agentFileKey(agentId, file),
  () => api.api<WorkspaceChatFileAccessAnswer>(fileRead(agentId, file, true)),
);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A thumbnail's proportions, when anything knows them: the row's recorded
 *  size first, else what the preview read measured. Square until then. */
const ratioStyle = (file: WorkspaceChatFile, held: HeldPreview | null): CSSProperties | undefined => {
  const width = file.width || held?.width;
  const height = file.height || held?.height;
  return width && height ? { '--thumb-ratio': `${width} / ${height}` } as CSSProperties : undefined;
};

function FileMark({ agentId, file, near, onPress, onShown }: {
  agentId: string;
  file: WorkspaceChatFile;
  /** Whether the strip is on screen, or near enough to mint for. */
  near: boolean;
  onPress: (file: WorkspaceChatFile) => void;
  /** The URL of a picture that is now PAINTED, and '' for one that turned
   *  out not to be — so the viewer opens on exactly what the reader sees. */
  onShown: (id: string, url: string) => void;
}) {
  const { api } = useSession();
  const picture = isInlineImage(file.contentType);
  const [held, setHeld] = useState<HeldPreview | null>(() => (picture ? heldPreview(agentFileKey(agentId, file)) : null));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!picture || held || !near) return;
    let alive = true;
    previewOf(api, agentId, file)
      // A row can be rebuilt while its mint is out; that copy is detached,
      // and an <img> in it would decode bytes for nobody.
      .then((minted) => { if (alive && minted) setHeld(minted); })
      // The typed glyph is already the truthful fallback. A list should not
      // grow an error banner because one glimpse failed.
      .catch(() => {});
    return () => { alive = false; };
  }, [api, agentId, file, picture, held, near]);

  const kind = fileIcon(file.fileName);
  const painted = picture && loaded && Boolean(held);
  // A press is this control's, not the plate's: the plate is a door, and a
  // thumbnail that also walked through it would leave the list on every tap.
  const press = (event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onPress(file); };
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); };
  const label = painted
    ? `Open ${file.fileName} full screen`
    : isInlinePdf(file.contentType, file.fileName) || isInlineHtml(file.contentType, file.fileName)
      || isMarkdown(file.contentType, file.fileName)
      ? `Open ${file.fileName}`
      : `Download ${file.fileName}`;
  if (picture) {
    return (
      <button
        className={`cfile pic${painted ? ' painted' : ''}`}
        type="button"
        style={ratioStyle(file, held)}
        title={file.fileName}
        aria-label={label}
        onClick={press}
        onKeyDown={keys}
      >
        {painted ? null : <TypeIcon glyph={kind.glyph} tint={kind.tint} />}
        {held
          ? (
            <img
              alt=""
              decoding="async"
              src={held.url}
              onLoad={() => { setLoaded(true); onShown(file.id, held.url); }}
              onError={() => { setHeld(null); setLoaded(false); onShown(file.id, ''); }}
            />
          )
          : null}
      </button>
    );
  }
  return (
    <button
      className="cfile doc"
      type="button"
      title={file.fileName}
      aria-label={label}
      onClick={press}
      onKeyDown={keys}
    >
      <TypeIcon glyph={kind.glyph} tint={kind.tint} />
      <span className="cfilename">{file.fileName}</span>
    </button>
  );
}

export function AgentFiles({ agentId, files }: { agentId: string; files: WorkspaceChatFile[] }) {
  const { api } = useSession();
  const banner = useBanner();
  const viewer = useImageViewer();
  const documents = usePdfViewer();
  const [shown, setShown] = useState<Record<string, string>>({});
  const onShown = (id: string, url: string) => setShown((held) => (held[id] === url ? held : { ...held, [id]: url }));
  const strip = useRef<HTMLDivElement | null>(null);
  // Mint once the strip is on screen or a little below it — a fleet of
  // twenty plates should not download twenty sets of thumbnails on open.
  // Where nothing can watch for that, mint at once.
  const [near, setNear] = useState(() => typeof window.IntersectionObserver !== 'function');
  useEffect(() => {
    const node = strip.current;
    if (!node || typeof window.IntersectionObserver !== 'function') return undefined;
    const observer = new window.IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setNear(true);
    }, { rootMargin: '160px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const save = async (file: WorkspaceChatFile) => {
    try {
      // A URL minted at the tap, signed for saving (note #552): one minted at
      // paint could be dead by now, and the preview's inline disposition
      // would open the bytes in the tab rather than put them on the shelf.
      const access = await api.api<WorkspaceChatFileAccessAnswer>(fileRead(agentId, file, false));
      if (access?.url) saveFile(access.url, access.fileName || file.fileName);
    } catch (error) {
      banner.show(errorMessage(error));
    }
  };
  const open = (file: WorkspaceChatFile) => {
    // Only a picture the reader can SEE is one the viewer can show; the
    // strip's other painted pictures are the gallery, in the strip's order.
    const photos = files.filter((entry) => isInlineImage(entry.contentType) && shown[entry.id]);
    const at = photos.findIndex((photo) => photo.id === file.id);
    if (at >= 0) {
      viewer(photos.map((photo) => ({ url: shown[photo.id]!, name: photo.fileName, save: () => { void save(photo); } })), at);
      return;
    }
    if (isInlinePdf(file.contentType, file.fileName)) {
      previewOf(api, agentId, file)
        .then((held) => { if (held) documents({ url: held.url, name: file.fileName }); else void save(file); })
        .catch(() => { void save(file); });
      return;
    }
    // A Markdown file opens as a page of its own words (note #677), as it
    // does in the chat, with the strip's save path as its Download.
    if (isMarkdown(file.contentType, file.fileName)) {
      readChatFileText(api, agentId, file.id)
        .then((read) => {
          if (read.kind === 'markdown') documents({ text: read.content, name: file.fileName, kind: 'markdown', save: () => { void save(file); } });
          else void save(file);
        })
        .catch(() => { void save(file); });
      return;
    }
    // A page opens in the same viewer, sandboxed (note #557), and carries the
    // strip's own save path as its Download.
    if (isInlineHtml(file.contentType, file.fileName)) {
      previewOf(api, agentId, file)
        .then((held) => {
          if (held) documents({ url: held.url, name: file.fileName, kind: 'html', save: () => { void save(file); } });
          else void save(file);
        })
        .catch(() => { void save(file); });
      return;
    }
    void save(file);
  };

  return (
    <div className="cfiles" role="group" aria-label="Files on its last message" ref={strip}>
      {files.map((file) => (
        <FileMark key={file.id} agentId={agentId} file={file} near={near} onPress={open} onShown={onShown} />
      ))}
    </div>
  );
}
