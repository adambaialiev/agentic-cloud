/**
 * One picked file, drawn small: a thumbnail, its name, and the ✕ that takes
 * it back off.
 *
 * The shape chat has always used for a draft's attachments, lifted out of the
 * composer so the full-screen voice review can show the same thing over a
 * NOTE (note #387). The review used to draw a note's picks the way the note
 * screen does — one 380px slide per file, the picture shown whole — which is
 * right on a page you are reading and wrong inside an editor, where the words
 * are the point and the pictures are what you brought along. Two hand-copied
 * blocks of identical markup would have drifted; one chip cannot.
 *
 * The picture is CROPPED to its little square rather than fitted into it,
 * which is the trade this size makes on purpose: at 38px a portrait
 * screenshot letterboxed to fit is two grey bars and a smear. The name is
 * beside it and a tap opens the original full screen, so nothing here is the
 * only way to know what a file is.
 */

import { fileIcon, safeFileName } from './file-kind.js';
import { Icon, TypeIcon } from './icons.js';

export function DraftChip({ name, url, picture, meta, onOpen, onRemove, onBroken, exactName = false }: {
  /** The file's name, already through `safeFileName` or not — it is run
   *  through it here either way, because this is what the reader is shown. */
  name: string;
  /** The object URL its bytes were minted at, where there is one. */
  url: string;
  /** Whether it is drawn AS a picture. The caller's answer, not this row's:
   *  the same answer builds the gallery a tap opens. */
  picture: boolean;
  /** Under the name — what is about to happen to this file, in the words of
   *  the screen that is holding it. */
  meta: string;
  onOpen: () => void;
  onRemove: () => void;
  /** Bytes that will not decode, so the caller can stop counting this one as
   *  a picture and take it out of the gallery rather than leaving a hole. */
  onBroken?: () => void;
  /** Show the name as it is: a direct message keeps its file's real name
   *  (note #1125), where an agent's machine renames it for its disk. */
  exactName?: boolean;
}) {
  const shown = exactName ? name : safeFileName(name);
  const kind = fileIcon(shown);
  return (
    <div className="chatdraftitem">
      <button
        className="chatdraftopen"
        type="button"
        aria-label={picture ? `Preview ${shown} full screen` : `Preview ${shown}`}
        onClick={onOpen}
      >
        {picture && url
          ? <img className="preview" src={url} alt="" onError={onBroken} />
          : <span className="preview"><TypeIcon glyph={kind.glyph} tint={kind.tint} /></span>}
        <div className="main">
          <div className="name">{shown}</div>
          <div className="meta">{meta}</div>
        </div>
      </button>
      <button className="remove" type="button" aria-label={`Remove ${shown}`} onClick={onRemove}>
        <Icon name="x" size={17} />
      </button>
    </div>
  );
}
