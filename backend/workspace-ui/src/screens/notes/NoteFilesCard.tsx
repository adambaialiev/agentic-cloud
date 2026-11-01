/**
 * The note's files, directly under the words: they are part of what the note
 * SAYS (the menu photo beside the note about the menu), not something done
 * to it, so they stand where the sentence that mentions them ends rather
 * than below the agents and the margin (note #397).
 *
 * One horizontal slide each — tap to open, ✕ to take off. The way to add one
 * is not here: it is a paperclip in the row of tools at the end of the words,
 * beside Copy (note #604), because a full-width "Attach a file" card on a
 * note with nothing attached was a whole card spent on one verb. Hence two
 * pieces out of one hook — the button and the card — drawn in two places by
 * the screen, sharing one picker and one upload. Anyone may attach to any note, agent's or not: attaching is not
 * editing. The edit gate protects an agent's WORDS (rewritten behind its
 * back, it contradicts the note next turn), and a file beside them moves no
 * words.
 *
 * The card stands only when there is something in it — a file, or one on its
 * way. The paperclip stands whenever the backend can hold files and the note
 * is not archived; with no file store at all neither is drawn, since a button
 * that 503s is worse than no button.
 *
 * A tap opens what the Workspace can show, where it shows it: a photograph
 * in the shared picture viewer, a PDF in the document viewer beside it (note
 * #403). A video or a recording needs no tap to be shown: it PLAYS on its
 * slide (the owner, 2026-10-04, after the chat learned to in note #693).
 * Everything else is saved. And whatever the viewer shows carries a
 * Download in its head (note #690): a picture opened full screen is often
 * the one the reader came to keep, and closing it to hunt for a way to save
 * it — there was none on the note — is a trip nobody should have to make.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { WorkspaceNoteAttachment, WorkspaceNoteRecord } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { bytes, fileIcon, isAudio, isInlineHtml, isInlineImage, isInlinePdf, isVideo, safeFileName } from '../../ui/file-kind.js';
import { uploadPercent } from '../../ui/parted-upload.js';
import { Icon, Svg, TypeIcon } from '../../ui/icons.js';
import { AskToConfirm } from '../../ui/Ask.js';
import { saveFile } from '../../ui/save-file.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { usePdfViewer } from '../../ui/usePdfViewer.js';
import { usePlayer, videoSrc } from '../../ui/usePlayer.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { PressableRow } from '../home/PressableRow.js';
import { deleteNoteFile, noteFileAccess, putNoteFile } from './note-files.js';
import { noteFileRefusal } from './note-words.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Who put it there, said the way the row says everything else. */
function addedBy(file: WorkspaceNoteAttachment): string {
  if (file.byUser) return ' · you attached this';
  if (file.byMember) return ' · another member attached this';
  return '';
}

/** The ✕ on a file, whatever shape the file is drawn in. Absent on an
 *  archived note: it is read-only, the backend would refuse this anyway, and
 *  an × that only ever errors is worse than no ×. */
function RemoveFile({ file, onRemove }: { file: WorkspaceNoteAttachment; onRemove: () => void }) {
  return (
    <button
      className="chev"
      type="button"
      aria-label={`Remove ${file.fileName}`}
      onClick={(event) => {
        // Whatever surrounds this button opens the file; a remove that also
        // opened it would be a mean trick.
        event.stopPropagation();
        onRemove();
      }}
    >
      <Icon name="x" size={16} />
    </button>
  );
}

function FileRow({ file, glyph, canRemove, onOpen, onRemove }: {
  file: WorkspaceNoteAttachment;
  /** `image` for a photograph that would not draw; otherwise the mark the
   *  file's own name earns it, so a PDF reads as a document. */
  glyph?: 'image';
  canRemove: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const kind = fileIcon(file.fileName);
  return (
    <PressableRow className="crow open" onPress={onOpen}>
      <TypeIcon glyph={glyph ?? kind.glyph} tint={glyph ? '' : kind.tint} />
      <div className="main">
        <div className="name">{file.fileName}</div>
        <div className="cline"><span className="ctext">{bytes(file.sizeBytes)}{addedBy(file)}</span></div>
      </div>
      {canRemove ? <RemoveFile file={file} onRemove={onRemove} /> : null}
    </PressableRow>
  );
}

/**
 * The photo itself, as a button that opens the original — with the frame held
 * at a plausible height first, so pixels arriving do not shove the caption
 * around. A mint or a load that fails downgrades to the plain file row: a
 * broken image frame says "bug", a row with the file's name says what is
 * actually still true — the file exists and a tap fetches it.
 */
function NotePhoto({ number, file, canRemove, onOpen, onRemove, onResolved }: {
  number: number;
  file: WorkspaceNoteAttachment;
  canRemove: boolean;
  onOpen: () => void;
  onRemove: () => void;
  /** The signed URL, once it exists, so the card above can build the gallery
   *  out of the pictures it is actually showing. */
  onResolved: (id: string, url: string) => void;
}) {
  const { api } = useSession();
  const [url, setUrl] = useState('');
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void noteFileAccess(api, number, file.id, true)
      .then((access) => {
        if (!alive) return;
        setUrl(access.url);
        onResolved(file.id, access.url);
      })
      .catch(() => { if (alive) setBroken(true); });
    return () => { alive = false; };
  }, [api, number, file.id, onResolved]);
  if (broken) {
    return <FileRow file={file} glyph="image" canRemove={canRemove} onOpen={onOpen} onRemove={onRemove} />;
  }
  return (
    <>
      <button
        className={loaded ? 'notephoto' : 'notephoto loading'}
        type="button"
        aria-label={loaded ? `Open ${file.fileName}` : `Loading ${file.fileName}`}
        onClick={onOpen}
      >
        {url ? <img src={url} alt={file.fileName} onLoad={() => setLoaded(true)} onError={() => setBroken(true)} /> : null}
      </button>
      {/* Under each photo, the row of facts the plain file row carries. */}
      <div className="crow caprow">
        <div className="main">
          <div className="cline">
            <span className="ctext">{file.fileName} · {bytes(file.sizeBytes)}{addedBy(file)}</span>
          </div>
        </div>
        {canRemove ? <RemoveFile file={file} onRemove={onRemove} /> : null}
      </div>
    </>
  );
}

/**
 * A video or a recording, PLAYED on its slide — the walkthrough beside the
 * note about the walkthrough is there to be watched, and until now watching
 * it meant downloading it first. The browser's own player stands where a
 * photo would, a video at its own shape once the player has read it (16:9
 * until then) and never taller than a photo is allowed to be; a recording
 * is a play bar. Under it the facts row a photo has, with a Download beside
 * the ✕: nothing on a player saves the file, and the facts row is not a
 * button. A clip this browser will not play goes back to the plain file
 * row, whose tap saves it. The link's lifetime is `usePlayer`'s business.
 */
function NoteMedia({ number, file, canRemove, onSave, onRemove }: {
  number: number;
  file: WorkspaceNoteAttachment;
  canRemove: boolean;
  onSave: () => void;
  onRemove: () => void;
}) {
  const { api } = useSession();
  const video = isVideo(file.contentType, file.fileName);
  const mint = useCallback(() => noteFileAccess(api, number, file.id, true), [api, number, file.id]);
  const { link, broken, shape, events } = usePlayer(file.id, mint);
  if (broken) return <FileRow file={file} canRemove={canRemove} onOpen={onSave} onRemove={onRemove} />;
  return (
    <>
      {video
        ? (
          <div className="notevideo" style={{ '--video-shape': shape ?? '16 / 9' } as CSSProperties}>
            <video src={link ? videoSrc(link.url) : undefined} controls playsInline preload="metadata" aria-label={file.fileName} {...events} />
          </div>
        )
        : <div className="noteaudio"><audio src={link?.url} controls preload="metadata" aria-label={file.fileName} {...events} /></div>}
      <div className="crow caprow">
        <div className="main">
          <div className="cline">
            <span className="ctext">{file.fileName} · {bytes(file.sizeBytes)}{addedBy(file)}</span>
          </div>
        </div>
        <button className="chev" type="button" aria-label={`Download ${file.fileName}`} onClick={onSave}>
          <Icon name="arrowdown" size={16} />
        </button>
        {canRemove ? <RemoveFile file={file} onRemove={onRemove} /> : null}
      </div>
    </>
  );
}

/** A row for a file that has not landed yet — the same shape as a landed one
 *  so nothing jumps when it does, with a spinner where the type icon goes and
 *  no remove button, because there is not yet anything to take off. */
function UploadingRow({ file, sent }: { file: File; sent: number | null }) {
  return (
    <div className="crow">
      <span className="iconbox"><span className="spinner" /></span>
      <div className="main">
        <div className="name">{safeFileName(file.name)}</div>
        {/* A big file goes in parts (note #784): how far it has got. */}
        <div className="cline"><span className="ctext">{`${bytes(file.size)} · sending…${sent === null ? '' : ` ${uploadPercent(sent, file.size)}`}`}</span></div>
      </div>
    </div>
  );
}

export function useNoteFiles({ note, onChanged }: {
  /** Null while the note is still on its way: the screen's hooks run before
   *  it knows, and there is nothing to attach to yet. */
  note: WorkspaceNoteRecord | null;
  /** The fresh list, after an attach or a remove. */
  onChanged: (attachments: WorkspaceNoteAttachment[]) => void;
}): { attachButton: ReactNode; card: ReactNode } {
  const { api } = useSession();
  const { reload } = useWorkspace();
  const banner = useBanner();
  const [uploading, setUploading] = useState<File | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [asking, setAsking] = useState<WorkspaceNoteAttachment | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const viewer = useImageViewer();
  const documents = usePdfViewer();
  // The gallery is built from the pictures already on screen: each photo
  // hands its signed URL up as it resolves, so stepping between a note's
  // photos costs no further requests.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const onResolved = useCallback((id: string, url: string) => {
    setUrls((was) => (was[id] === url ? was : { ...was, [id]: url }));
  }, []);

  // A new pending file is the answer to "did my pick work?", so bring that
  // last slide into view. Every other repaint keeps the strip where the
  // reader left it — which this shell gets for free, because the container
  // element itself is never rebuilt.
  useEffect(() => {
    if (uploading && strip.current) strip.current.scrollLeft = strip.current.scrollWidth;
  }, [uploading]);

  const files = note?.attachments;
  if (!note || !Array.isArray(files)) return { attachButton: null, card: null };
  const archived = Boolean(note.archivedAt);

  // A file the Workspace does not draw is SAVED, and so is one whose
  // viewer's Download was pressed. The URL is minted at the tap, because one
  // minted at open could be dead by then, and signed for saving — not the
  // preview the viewer is drawing, which is signed inline and would open in
  // the tab. It goes to the browser through an anchor in THIS tab rather
  // than a new window (note #552): by the time the URL exists the tap is
  // over, and Safari refuses a window opened after it in silence.
  const saveOut = (file: WorkspaceNoteAttachment) => {
    void noteFileAccess(api, note.number, file.id)
      .then((access) => { saveFile(access.url, access.fileName || file.fileName); })
      .catch((error) => banner.show(errorMessage(error)));
  };
  // A PDF opens full screen in the Workspace's own document viewer (note
  // #403) rather than leaving for the browser, and so does an HTML page,
  // sandboxed (note #557) — each with the save path above as its Download
  // (note #690: a framed PDF on a phone offers no way to keep it). The URL
  // is minted at the tap like every other, and asked for as a PREVIEW: a
  // link signed to be saved is downloaded by the browser rather than drawn
  // in the frame.
  const openDocument = (file: WorkspaceNoteAttachment, kind: 'pdf' | 'html') => {
    void noteFileAccess(api, note.number, file.id, true)
      .then((access) => {
        documents(kind === 'html'
          ? { url: access.url, name: file.fileName, kind, save: () => saveOut(file) }
          : { url: access.url, name: file.fileName, save: () => saveOut(file) });
      })
      .catch((error) => banner.show(errorMessage(error)));
  };
  // A picture opens in the viewer, and the note's OTHER pictures are its
  // gallery — the same swipe the strip already implies. Each carries its own
  // Download (note #690), so the one on screen is the one saved.
  const open = (file: WorkspaceNoteAttachment) => {
    if (isInlinePdf(file.contentType, file.fileName)) { openDocument(file, 'pdf'); return; }
    if (isInlineHtml(file.contentType, file.fileName)) { openDocument(file, 'html'); return; }
    if (!isInlineImage(file.contentType)) { saveOut(file); return; }
    const photos = files.filter((entry) => isInlineImage(entry.contentType) && urls[entry.id]);
    const at = photos.findIndex((photo) => photo.id === file.id);
    if (at < 0) { saveOut(file); return; }
    viewer(photos.map((photo) => ({
      url: urls[photo.id]!,
      name: photo.fileName,
      save: () => saveOut(photo),
    })), at);
  };

  const remove = async (file: WorkspaceNoteAttachment) => {
    try {
      const answer = await deleteNoteFile(api, note.number, file.id);
      onChanged(answer.attachments);
      // The other half of the same stale row: taking the last file off a note
      // has to clear its badge too, not just leave a smaller number behind.
      await reload().catch(() => { /* the row catches up on the next open */ });
    } catch (error) {
      banner.show(errorMessage(error));
    }
  };

  const attach = async (chosen: File) => {
    const refusal = noteFileRefusal(chosen, files.map((file) => file.fileName));
    if (refusal) { banner.show(refusal); return; }
    setUploading(chosen);
    setSent(null);
    let landed = false;
    try {
      const answer = await putNoteFile(api, note.number, chosen, (bytesSent) => setSent(bytesSent));
      onChanged(answer.attachments);
      landed = true;
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      // Cleared before anything else either way: the row is a promise that
      // something is happening, and it has to go when nothing is.
      setUploading(null);
    }
    // Home is drawn once when the app opens and only re-polls while something
    // is mid-flight, so the row behind this screen still describes a note with
    // no file on it — and would until the next reopen, which is precisely when
    // someone checks whether attaching worked. A refresh that fails must not
    // surface as an attach that failed.
    if (landed) await reload().catch(() => { /* the row catches up on the next open */ });
  };

  // An archived note keeps its files and offers no way to change them — the
  // card is a way to READ them, which is what an archive is for. The
  // paperclip goes rather than greying out: there is nothing to wait for.
  const attachButton = archived ? null : (
    <>
      <button
        type="button"
        id="noteAttachBtn"
        aria-label="Attach a file"
        title="Attach a file"
        // One at a time: the row in the card is the answer to "is it
        // working", and a second pick while the first is still going would
        // replace it with a row for the second and lose that answer.
        disabled={Boolean(uploading)}
        onClick={() => picker.current?.click()}
      >
        <Svg name="attach" size={19} />
      </button>
      <input
        type="file"
        id="noteFileInput"
        ref={picker}
        hidden
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) void attach(chosen);
        }}
      />
    </>
  );
  const ask = asking ? (
    <AskToConfirm
      title={`Take ${asking.fileName} off this note?`}
      message="Your agents lose it too."
      verb="Take it off"
      onAnswer={(confirmed) => {
        const file = asking;
        setAsking(null);
        if (confirmed && file) void remove(file);
      }}
    />
  ) : null;
  if (files.length === 0 && !uploading) return { attachButton, card: ask };
  const card = (
    <div className="card" id="noteFilesCard">
      {/* One attachment is one carousel slide — a photo and the facts/remove
          row under it stay inside the same sliding boundary. A note's photos
          are a set too, and the same swipe carries them. */}
      <div id="noteFiles" ref={strip} data-gallery="note-files" data-note-number={String(note.number)}>
        {files.map((file) => (
          <div className="noteattachment" key={file.id}>
            {/* A photo is shown AS a photo — the picture is why it was
                attached. SVG stays a row: a "photo" that is really a drawing
                of unknown size crops badly. */}
            {isInlineImage(file.contentType)
              ? (
                <NotePhoto
                  number={note.number}
                  file={file}
                  canRemove={!archived}
                  onOpen={() => open(file)}
                  onRemove={() => setAsking(file)}
                  onResolved={onResolved}
                />
              )
              : isVideo(file.contentType, file.fileName) || isAudio(file.contentType, file.fileName)
                ? (
                  <NoteMedia
                    number={note.number}
                    file={file}
                    canRemove={!archived}
                    onSave={() => saveOut(file)}
                    onRemove={() => setAsking(file)}
                  />
                )
                : (
                <FileRow
                  file={file}
                  canRemove={!archived}
                  onOpen={() => open(file)}
                  onRemove={() => setAsking(file)}
                />
              )}
          </div>
        ))}
        {/* What is on its way, after what has landed — where it will itself
            appear. */}
        {uploading ? <div className="noteattachment"><UploadingRow file={uploading} sent={sent} /></div> : null}
      </div>
      {ask}
    </div>
  );
  return { attachButton, card };
}
