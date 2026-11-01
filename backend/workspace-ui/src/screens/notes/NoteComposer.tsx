/**
 * Writing one, and rewriting one of your own.
 *
 * ONE field and no name to invent: a note's title is its own first line,
 * which is the rule the agents write to as well. What the user types is PLAIN
 * TEXT — the markup is the server's job — so the box asks for nothing a
 * person would have to know, and an edit hands back the text they typed
 * rather than the HTML it was stored as.
 *
 * Transient, with no address of its own (knowledge page "miniapp-navigation"):
 * it keeps the list's address underneath it, so Back closes the box rather
 * than spending a history entry, and a save lands the reader on the note
 * itself — with Home or the notes list still underneath, one Back away.
 *
 * Both moods share the screen because they are the same act; only two lines
 * and the button's word differ.
 */

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  WorkspaceNoteRecord,
  WorkspaceNoteWriteAnswer,
  WorkspaceNoteWriteRequest,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useBanner } from '../../chrome/useBanner.js';
import { toFor, workspaceScope } from '../../routes.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { useSession } from '../../session/useSession.js';
import { bytes, draftChipMeta, isInlineImage, safeFileName } from '../../ui/file-kind.js';
import { Icon, Svg, TypeIcon } from '../../ui/icons.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { DraftChip } from '../../ui/DraftChip.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { PressableRow } from '../home/PressableRow.js';
import type { NoteDraftFile } from './draft-context.js';
import { NOTE_MAX_FILES, NOTE_MAX_TEXT, noteFileRefusal } from './note-words.js';
import { putNoteFile } from './note-files.js';
import { uploadPercent } from '../../ui/parted-upload.js';
import { useNoteDraft } from './useNoteDraft.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Taking one back off the draft. No confirmation, unlike the same button on
 *  a saved note: nothing has left the phone yet, no agent has seen it, and
 *  picking it again is the whole of the undo. */
function RemoveDraftFile({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      className="chev"
      type="button"
      aria-label={`Remove ${name}`}
      onClick={(event) => {
        // The row around this one opens the file; a remove that also opened
        // it would be a mean trick — the saved note's ✕ stops the same tap.
        event.stopPropagation();
        onRemove();
      }}
    >
      <Icon name="x" size={16} />
    </button>
  );
}

/** Everything that is not a photograph, and any photograph that would not
 *  decode. A door, like the same row on the saved note: the bytes are on the
 *  phone already, so the browser can open them now rather than after a save. */
function DraftFileRow({ name, size, onOpen, onRemove }: {
  name: string;
  size: number;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <PressableRow className="crow open" onPress={onOpen}>
      <TypeIcon glyph="file" />
      <div className="main">
        <div className="name">{name}</div>
        <div className="cline"><span className="ctext">{bytes(size)} · goes up when you save</span></div>
      </div>
      <RemoveDraftFile name={name} onRemove={onRemove} />
    </PressableRow>
  );
}

/**
 * A picked photo, shown AS the photo — the same block the note screen draws,
 * because the picture is why it was picked and "1.jpeg, 859 KB" shows the
 * person none of it. A BUTTON, exactly like the saved note's: the draft
 * minted this picture's object URL when it was picked, so there was something
 * to open here all along — and a picture that goes full screen everywhere
 * else in the Workspace and nowhere here reads as broken (note #318).
 */
function DraftAttachment({ picked, photo, compact, onOpen, onBroken, onRemove }: {
  picked: NoteDraftFile;
  /** Whether this pick is drawn as a picture at all. The composer's call, not
   *  this row's, because the same answer builds the gallery the tap opens. */
  photo: boolean;
  /** Small, in the shape chat's draft uses. The card below the box shows a
   *  pick the way the saved note will — the picture is why it was attached —
   *  but inside the full-screen recorder the words are the screen and the
   *  files sit under them (note #387), so there the same pick is one chip. */
  compact?: boolean;
  onOpen: () => void;
  /** Bytes that will not decode: the composer stops counting this one as a
   *  picture, which turns it into the plain row below AND takes it out of the
   *  gallery, rather than leaving a hole for the reader to swipe into. */
  onBroken: () => void;
  onRemove: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const name = safeFileName(picked.file.name);
  if (compact) {
    return (
      <DraftChip
        name={name}
        url={picked.url ?? ''}
        picture={photo}
        meta={draftChipMeta(picked.file.size, 'goes up when you save')}
        onOpen={onOpen}
        onRemove={onRemove}
        onBroken={onBroken}
      />
    );
  }
  if (!photo) {
    return (
      <div className="noteattachment">
        <DraftFileRow name={name} size={picked.file.size} onOpen={onOpen} onRemove={onRemove} />
      </div>
    );
  }
  return (
    <div className="noteattachment">
      <button
        className={loaded ? 'notephoto' : 'notephoto loading'}
        type="button"
        aria-label={`Preview ${name} full screen`}
        onClick={onOpen}
      >
        <img src={picked.url ?? ''} alt={name} onLoad={() => setLoaded(true)} onError={onBroken} />
      </button>
      {/* What a photo block cannot say for itself: which file, how big, and
          the way to take it back off. */}
      <div className="crow caprow">
        <div className="main">
          <div className="cline">
            <span className="ctext">{name} · {bytes(picked.file.size)} · goes up when you save</span>
          </div>
        </div>
        <RemoveDraftFile name={name} onRemove={onRemove} />
      </div>
    </div>
  );
}

export function NoteComposer({ editing, onClose, onSaved }: {
  /** The note being rewritten, or absent when the box is a new one. Only ever
   *  the reader's OWN — no other kind offers Edit. */
  editing?: WorkspaceNoteRecord;
  onClose: () => void;
  /** An edit has a screen to go back to that must re-read itself. */
  onSaved?: () => void;
}) {
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  // A note is written into the workplace's one list (note #843): it went
  // into the room the address or the viewed room named, while there were
  // rooms, so no request names one now.
  const banner = useBanner();
  const navigate = useNavigate();
  const draft = useNoteDraft();
  const viewer = useImageViewer();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  // An edit is about the note in front of the reader, not the half-written
  // one underneath: it never touches the draft.
  const [edited, setEdited] = useState(editing?.text ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<[number, number, string?] | null>(null);
  // Picks whose bytes would not decode, kept HERE rather than in the row that
  // found out: what is drawn as a picture and what the gallery holds have to
  // be the same list, or a tap opens the viewer on a hole.
  const [broken, setBroken] = useState<readonly File[]>([]);
  // Object URLs minted at a tap on something that is not a picture (see
  // `openPicked`), held so they can be given back when the screen goes: the
  // new tab is still reading one the moment it opens, so none can be revoked
  // where it is made.
  const lent = useRef<string[]>([]);
  useBackClaim(onClose);
  useEffect(() => () => { for (const url of lent.current) URL.revokeObjectURL(url); }, []);

  const text = editing ? edited : draft.text;
  const setText = editing ? setEdited : draft.setText;
  const files = editing ? [] : draft.files;
  const shownAsPhoto = (held: NoteDraftFile) =>
    Boolean(held.url) && isInlineImage(held.file.type) && !broken.includes(held.file);

  // A note is a page of prose, not a message line. Grow the field after
  // every value change — including a transcript committed by VoiceField and
  // a long saved note opened for editing — until the stylesheet's phone-safe
  // cap. Only text beyond that cap becomes an inner scroll (note #454).
  useLayoutEffect(() => {
    const box = field.current;
    if (!box) return;
    box.style.height = 'auto';
    const border = box.offsetHeight - box.clientHeight;
    if (box.scrollHeight) box.style.height = `${box.scrollHeight + border}px`;
  }, [text]);

  useEffect(() => {
    // Straight into the box: this screen exists to be typed in, and one tap
    // should not need a second one to start writing. The caret goes to the
    // END, or returning to a draft would type into the middle of it.
    const box = field.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  const pick = (chosen: File | null | undefined) => {
    if (!chosen) return;
    const refusal = noteFileRefusal(chosen, files.map((held) => safeFileName(held.file.name)));
    if (refusal) { banner.show(refusal); return; }
    // Nothing is uploaded here — the note has no number yet. It waits.
    draft.addFile(chosen);
  };

  /**
   * A whole FileList at once, which is what the full-screen recorder's picker
   * hands over (note #365). Refused as a SET, like chat's: everything is
   * checked before anything is added, so a pick that breaks a rule halfway
   * does not leave half of itself attached and a refusal on screen.
   *
   * The name list grows as it goes — two copies of the same photograph in one
   * pick are the same clash as picking it twice.
   */
  const attachMany = (chosen: FileList | null): string | null => {
    const selected = Array.from(chosen ?? []);
    if (!selected.length) return null;
    const taken = files.map((held) => safeFileName(held.file.name));
    for (const file of selected) {
      const refusal = noteFileRefusal(file, taken);
      if (refusal) return refusal;
      taken.push(safeFileName(file.name));
    }
    for (const file of selected) draft.addFile(file);
    return null;
  };

  const remove = (file: File) => {
    draft.removeFile(file);
    setBroken((was) => (was.includes(file) ? was.filter((held) => held !== file) : was));
  };

  /**
   * A tap on a pick, answered before the note exists (note #318).
   *
   * A picture goes full screen in the shared viewer, and the draft's OTHER
   * pictures are its gallery — the same swipe the saved note offers, off the
   * object URLs already minted, so it costs no request and no save. Anything
   * else leaves for the browser, exactly as the saved note's row does.
   *
   * That one's URL is minted at the TAP: the draft mints only for what it can
   * show as a picture, because it outlives this screen and pinning every
   * picked file's bytes for the life of it is a cost only the photos earn.
   */
  const openPicked = (held: NoteDraftFile) => {
    const photos = files.filter(shownAsPhoto);
    const at = photos.indexOf(held);
    if (at < 0) {
      // A photograph that would not decode still has the URL it was picked
      // with, and it is as good for the browser as a fresh one.
      const url = held.url ?? URL.createObjectURL(held.file);
      if (!held.url) lent.current.push(url);
      window.open(url, '_blank', 'noopener');
      return;
    }
    // Inside the full-screen recorder the viewer has to be portalled INTO the
    // dialog: it is in the browser's top layer, and an overlay on the body
    // would open behind it, invisible (note #365).
    const review = document.querySelector<HTMLElement>('.voicereview[open]');
    viewer(
      photos.map((photo) => ({ url: photo.url!, name: safeFileName(photo.file.name) })),
      at,
      review ?? undefined,
    );
  };

  /** Answers whether the note is saved — the full-screen voice review closes
   *  on true and keeps the reader's words in the box on false. */
  const save = async (): Promise<boolean> => {
    const said = text.trim();
    if (!said || saving) return false;
    // Typing is over: the save is what the keyboard was in the way of, and
    // the progress it reports is underneath it.
    field.current?.blur();
    // Taken before the await: the list is the composer's live state and the
    // save empties it, so this must hold its own copy.
    const picked = files.map((held) => held.file);
    setSaving(true);
    let answer: WorkspaceNoteWriteAnswer;
    try {
      answer = await api.api<WorkspaceNoteWriteAnswer>(
        editing ? `api/notes/${encodeURIComponent(editing.number)}` : 'api/notes',
        jsonBody({ text: said } satisfies WorkspaceNoteWriteRequest, editing ? 'PUT' : 'POST'),
      );
    } catch (error) {
      // The text stays in the box on a failure: it is the reader's own words,
      // and a form that empties itself when the save fails has thrown them
      // away. So do the files — they are part of the same unsaved note.
      banner.show(errorMessage(error));
      setSaving(false);
      return false;
    }
    if (editing) {
      banner.show('Saved your changes.', true);
      setSaving(false);
      void reload().catch(() => { /* the note re-reads itself behind this */ });
      onSaved?.();
      onClose();
      return true;
    }
    // The note exists now, so its files can finally go somewhere. One at a
    // time, and a failure does NOT throw: the note is already saved, and
    // unwinding would report the whole save as failed over one photo. What
    // did not make it is named instead — a file silently missing from a note
    // the reader watched themselves attach is the worst of the three
    // outcomes.
    const missed: string[] = [];
    for (let at = 0; at < picked.length; at += 1) {
      setUploading([at + 1, picked.length]);
      try {
        await putNoteFile(api, answer.note.number, picked[at]!,
          (bytesSent, total) => setUploading([at + 1, picked.length, uploadPercent(bytesSent, total)]));
      } catch {
        missed.push(safeFileName(picked[at]!.name));
      }
    }
    setUploading(null);
    draft.clear();
    setSaving(false);
    banner.show(
      missed.length
        ? `Saved “${answer.title}” — but ${missed.join(', ')} did not attach. Try again from this note.`
        : `Saved — “${answer.title}” is in your notes.`,
      missed.length === 0,
    );
    void reload().catch(() => { /* the list catches up on the next read */ });
    // Creation ends on the thing just created, exactly as an edit returns to
    // the thing just changed. The list this box opened over is still the
    // entry underneath, so Back returns to Home or the notes screen.
    navigate(toFor({
      kind: 'note', id: String(answer.note.number), ...workspaceScope(state?.org?.orgId),
    })!);
    return true;
  };

  /**
   * A tap on the composer that landed on NOTHING — the card, a heading, the
   * page behind them — takes the focus off the box, and the keyboard with it.
   *
   * The tap outside has to reach the field for the field to lose focus, and
   * on iOS a tap on inert space does not: none of it can take focus, so the
   * textarea keeps it and the keyboard stands over the bottom of the screen
   * with no way down (note #20).
   *
   * Only for taps that land on nothing. A button, a link, a label or another
   * field is left entirely alone: blurring on the way INTO a control would
   * collapse the keyboard and slide that control out from under the finger
   * mid-tap, and the LABEL is the box's own — a tap on it hands focus
   * straight back to the box it labels.
   */
  const blurOnInertTap = (event: MouseEvent<HTMLDivElement>) => {
    const box = field.current;
    if (!box || document.activeElement !== box) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, button, a, label, [contenteditable]')) return;
    box.blur();
  };

  const saveLabel = uploading ? `Attaching ${uploading[0]} of ${uploading[1]}…${uploading[2] ? ` ${uploading[2]}` : ''}` : 'Saving…';
  const canAttach = Boolean(state?.noteFiles) && !editing;
  /** The picks — one description of a row, two places that show it, in the
   *  two sizes those places want. */
  const draftRows = (compact = false) => files.map((picked) => (
    <DraftAttachment
      picked={picked}
      key={`${picked.file.name}:${picked.file.size}:${picked.file.lastModified}`}
      photo={shownAsPhoto(picked)}
      compact={compact}
      onOpen={() => openPicked(picked)}
      onBroken={() => setBroken((was) => (was.includes(picked.file) ? was : [...was, picked.file]))}
      onRemove={() => remove(picked.file)}
    />
  ));
  const saveButton = (
    <button className="formcommit" id="saveNoteBtn" type="submit" disabled={saving}>
      {saving
        ? <><span className="spinner" /><span>{saveLabel}</span></>
        : <span>{editing ? 'Save changes' : 'Save'}</span>}
    </button>
  );
  return (
    <div className="screen" id="screenNoteNew" onClick={blurOnInertTap} role="presentation">
      <ScreenTitle titleId="noteFormTitle" title={editing ? 'Edit note' : 'Write a note'} />
      <div className="sub" id="noteFormSub">
        {editing ? 'Your own note, in your own words.' : 'A jotting your agents can read too.'}
      </div>
      <form id="noteForm" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="card">
          <label className="drow frow">
            <div className="head">
              <div className="k">Note</div>
              <div className="count" id="noteCount">
                {text.length ? `${text.length} character${text.length === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            {/* A note is dictated the way a chat message is (note #365): the
                mic opens the full-screen recorder, and the words land in an
                editor big enough to read before they are saved. The inline
                mic on its own put a wave the size of a thumbnail under a
                keyboard covering half the phone. It carries the note's FILES
                as well: dictating a note and then having to back out to add
                the photograph it is ABOUT is the friction this dialog exists
                to remove. An edit takes no files — the saved note's own screen
                owns those — so there the dialog offers none either. */}
            <VoiceField
              onTranscript={setText}
              review={{
                value: text,
                onChange: setText,
                autoGrow: true,
                maxLength: NOTE_MAX_TEXT,
                sending: saving,
                onSend: save,
                ...(canAttach
                  ? {
                    attachmentCount: files.length,
                    // Small, and in chat's own strip: inside the recorder a
                    // note's picks are drawn exactly as a message's are.
                    attachments: draftRows(true),
                    onAttach: attachMany,
                  }
                  : {}),
                words: {
                  review: editing ? 'Review your changes' : 'Review note',
                  record: 'Voice note',
                  back: editing ? 'Back to the note' : 'Back to writing',
                  field: 'Your note',
                  placeholder: 'The wifi code is 4417',
                  hint: 'Make any changes before you save.',
                  commit: editing ? 'Save changes' : 'Save note',
                  committing: 'Saving…',
                  // No paper plane: a note is saved where it stands, not sent
                  // anywhere, and the glyph is the part a reader believes.
                  icon: 'tick',
                  failed: 'The note could not be saved. Your words are still here. Try again.',
                },
              }}
            >
              <textarea
                id="noteText"
                className="prose"
                ref={field}
                placeholder="The wifi code is 4417"
                rows={5}
                maxLength={NOTE_MAX_TEXT}
                required
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </VoiceField>
          </label>
        </div>
        {/* Files, chosen BEFORE the note exists. There is no note yet to hang
            bytes on, so what the phone hands over waits here and goes up the
            moment the note has a number — which is why these rows carry no
            size-on-server and no open-this link. Only once something is
            picked: the way to pick is the paperclip beside Save. Absent while
            REWRITING one: an edit is about the words, and the note's own
            screen already keeps its files one tap away. */}
        {canAttach && files.length ? (
          <div className="card" id="noteDraftFilesCard">
            <div id="noteDraftFiles" data-gallery="note-draft-files">{draftRows()}</div>
          </div>
        ) : null}
        {/* The paperclip on Save's own row (note #604): a full-width "Attach
            a file" card between the words and Save was a whole card spent
            on one verb, and the two finishing moves — add a file, keep the
            note — belong side by side where the thumb already is. */}
        <div className="noteformfoot">
          {canAttach ? (
            <>
              <button
                className="noteattach"
                id="noteDraftAttachBtn"
                type="button"
                aria-label="Attach a file"
                title="Attach a file"
                // Full, or mid-save, and the button would take a pick it
                // cannot honour.
                disabled={saving || files.length >= NOTE_MAX_FILES}
                onClick={() => {
                  // The picker is about to take the whole screen; the keyboard
                  // goes first, or it is still standing there when the photo
                  // comes back (note #20).
                  field.current?.blur();
                  filePicker.current?.click();
                }}
              >
                <Svg name="attach" size={20} />
              </button>
              <input
                type="file"
                id="noteDraftFileInput"
                ref={filePicker}
                hidden
                onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }}
              />
            </>
          ) : null}
          {saveButton}
        </div>
      </form>
    </div>
  );
}
