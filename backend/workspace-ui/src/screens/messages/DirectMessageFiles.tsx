/** The files under a direct message's words (note #1125) — see dm-files.ts for where their bytes live. */
import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { DirectMessageFile } from '../../../../src/shared/direct-messages.js';
import { bytes, fileIcon } from '../../ui/file-kind.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { directMessageFileUrl, directMessagePictureSource } from './dm-files.js';

/**
 * The frame a picture stands in before its bytes land, so the conversation
 * does not jump. Only when its shape is sure: a small copy's (made upright),
 * or a picture that is not a JPEG — a JPEG's header size may be the camera's
 * sideways one, which a frame would squash.
 */
const frame = (file: DirectMessageFile): CSSProperties | null => (file.width && file.height && (file.thumb || file.type !== 'image/jpeg')
  ? ({ '--picture-ratio': `${file.width} / ${file.height}`, '--picture-width': `${file.width}px` } as CSSProperties)
  : null);

function DirectMessageFileItem({ file, orgId, peerId, onOpenPicture, onPictureLoaded }: {
  file: DirectMessageFile;
  orgId: string | null | undefined;
  peerId: string;
  onOpenPicture: (file: DirectMessageFile) => void;
  onPictureLoaded?: () => void;
}) {
  // The real name: React writes it as text, and a message keeps it as sent.
  const name = file.name;
  const kind = fileIcon(name.toLowerCase());
  const source = directMessagePictureSource(file);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const picture = source !== null && !broken;
  const download = directMessageFileUrl(orgId, peerId, file.id, 'download');
  if (picture) {
    const framed = frame(file);
    const img = <img className={framed ? 'chatpicturebytes' : undefined} src={directMessageFileUrl(orgId, peerId, file.id, source)} alt={name}
      decoding="async" onLoad={() => { setLoaded(true); if (!framed) onPictureLoaded?.(); }} onError={() => setBroken(true)} />;
    return (
      <button className={`chatfileitem haspicture dmfile${loaded ? '' : ' loading'}`} type="button"
        aria-label={`Open ${name} full screen`} data-file-id={file.id} onClick={() => onOpenPicture(file)}>
        {framed ? <span className="chatpicture" style={framed}>{img}</span> : img}
      </button>
    );
  }
  return (
    <a className="chatfileitem dmfile" href={download} download={name} data-file-id={file.id} aria-label={`Download ${name}`}>
      <span className="chatfileline">
        <TypeIcon glyph={kind.glyph} tint={kind.tint} />
        <span>{name} · {bytes(file.size)}</span>
        <Icon name="arrowdown" size={16} className="icon chatsave" />
      </span>
    </a>
  );
}

/** A message's files, under its words, in the agent chat's own file rows. */
export function DirectMessageFiles({ files, orgId, peerId, onOpenPicture, onPictureLoaded }: {
  files: DirectMessageFile[];
  orgId: string | null | undefined;
  peerId: string;
  onOpenPicture: (file: DirectMessageFile) => void;
  /** An unframed picture grew the conversation: a reader following the end is carried with it. */
  onPictureLoaded?: () => void;
}) {
  return <>{files.map(file => <DirectMessageFileItem key={file.id} file={file} orgId={orgId} peerId={peerId}
    onOpenPicture={onOpenPicture} onPictureLoaded={onPictureLoaded} />)}</>;
}
