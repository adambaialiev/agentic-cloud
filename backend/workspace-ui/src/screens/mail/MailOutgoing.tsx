/**
 * What every way of writing mail now shares (note #509, slice 12): the Cc
 * line, the files that go with a letter, and the one request that carries
 * both.
 *
 * THE Cc LINE IS ONE BOX PER ADDRESS, and there are at most three of them.
 * A single field that took `a@b, c@d` would make "four people at most" a
 * matter of parsing; a box that holds one address, with the comma refused by
 * the server, makes it a matter of counting. No Bcc, anywhere: everybody a
 * letter reaches can see everybody else it reached.
 *
 * FILES ARE CHECKED HERE ONLY SO THE PERSON HEARS THE LIMIT FIRST. The
 * numbers are the server's (`mailOutFilesRefusal`, shared), and the server
 * checks them again — this just says "too big" at the moment of picking,
 * rather than after the words were written and Send was pressed.
 */

import { useRef, useState } from 'react';
import {
  MAIL_MAX_CC,
  MAIL_OUT_MAX_FILES,
  mailOutFileRefusal,
  mailOutFilesRefusal,
  type WorkspaceMailFile,
} from '../../../../src/shared/workspace-mail.js';
import { bytes, fileIcon, safeFileName } from '../../ui/file-kind.js';
import { Icon, Svg, TypeIcon } from '../../ui/icons.js';
import { mailCcAddresses, type MailPick } from './mail-outgoing.js';

/** Keys for picked files, unique for the life of the tab. */
let picks = 0;

/**
 * The Cc line. Nothing is drawn until somebody asks for a box, because most
 * letters go to one person and an empty field on every one of them would say
 * otherwise. `offer` is Reply to all's prefill, when the letter being
 * answered went to anybody else.
 */
export function MailCcField({ cc, onChange, offer, offerLeftOut = 0 }: {
  cc: string[];
  onChange: (next: string[]) => void;
  offer?: string[];
  offerLeftOut?: number;
}) {
  const filled = mailCcAddresses(cc);
  const offered = offer?.length && !offer.every((address) => filled.some((one) => one.toLowerCase() === address.toLowerCase()));
  return <>
    {cc.map((box, at) => <div className="drow frow mailccrow" key={at}>
      <label className="head" htmlFor={`mailCcField-${at}`}><div className="k">Cc</div></label>
      <div className="mailccbox">
        <input
          id={`mailCcField-${at}`}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="name@example.com"
          value={box}
          onChange={(event) => onChange(cc.map((one, where) => (where === at ? event.target.value : one)))}
        />
        <button className="remove" type="button" aria-label={`Remove this Cc${box.trim() ? `, ${box.trim()}` : ''}`}
          onClick={() => onChange(cc.filter((_, where) => where !== at))}>
          <Icon name="x" size={17} />
        </button>
      </div>
    </div>)}
    <div className="mailccdoors">
      {offered ? <button className="btn bare" id="mailReplyAll" type="button"
        onClick={() => onChange(offer.slice(0, MAIL_MAX_CC))}>
        {`Reply to all — also ${offer.join(', ')}${offerLeftOut ? ` (${offerLeftOut} more on that letter cannot be added: four people at most)` : ''}`}
      </button> : null}
      {cc.length < MAIL_MAX_CC ? <button className="btn bare" id="mailAddCc" type="button"
        onClick={() => onChange([...cc, ''])}>{cc.length ? 'Add another Cc' : 'Add Cc'}</button> : null}
    </div>
  </>;
}

/**
 * The files that go with the letter, and the door to add more. A forward
 * brings the letter's own files as `carried`, each ticked until somebody
 * unticks it — and a kind of file the provider refuses to carry is drawn
 * unticked and cannot be ticked, with the reason beside it.
 */
export function MailFilesField({ picked, onPicked, carried = [], carry, onCarry }: {
  picked: MailPick[];
  onPicked: (next: MailPick[]) => void;
  carried?: WorkspaceMailFile[];
  carry?: string[];
  onCarry?: (next: string[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [refused, setRefused] = useState('');
  const going = carried.filter((file) => carry?.includes(file.id));
  const count = going.length + picked.length;

  const add = (chosen: FileList | null) => {
    const files = Array.from(chosen ?? []);
    if (!files.length) return;
    const refusal = mailOutFilesRefusal([
      ...going.map((file) => ({ fileName: file.fileName, size: file.size })),
      ...picked.map(({ file }) => ({ fileName: safeFileName(file.name), size: file.size })),
      ...files.map((file) => ({ fileName: safeFileName(file.name), size: file.size })),
    ]);
    setRefused(refusal ?? '');
    if (refusal) return;
    onPicked([...picked, ...files.map((file) => ({ key: `pick-${picks += 1}`, file }))]);
  };

  return <div className="mailoutfiles" id="mailOutFiles">
    {carried.length || picked.length ? <div className="card mailfiles">
      {carried.map((file) => {
        const cannot = mailOutFileRefusal({ fileName: file.fileName, size: file.size });
        const ticked = !cannot && Boolean(carry?.includes(file.id));
        return <label className="crow mailcarried" key={file.id}>
          <input type="checkbox" checked={ticked} disabled={Boolean(cannot)}
            aria-label={`Send ${file.fileName} with it`}
            onChange={(event) => onCarry?.(event.target.checked
              ? [...(carry ?? []), file.id]
              : (carry ?? []).filter((id) => id !== file.id))} />
          <TypeIcon {...fileIcon(file.fileName)} />
          <div className="main">
            <div className="name plain">{file.fileName}</div>
            <div className="cline">{cannot ?? `${bytes(file.size)} · ${ticked ? 'goes with it' : 'left off'}`}</div>
          </div>
        </label>;
      })}
      {picked.map(({ key, file }) => <div className="crow" key={key}>
        <TypeIcon {...fileIcon(safeFileName(file.name))} />
        <div className="main">
          <div className="name plain">{safeFileName(file.name)}</div>
          <div className="cline">{bytes(file.size)}</div>
        </div>
        <button className="remove" type="button" aria-label={`Remove ${safeFileName(file.name)}`}
          onClick={() => { setRefused(''); onPicked(picked.filter((one) => one.key !== key)); }}>
          <Icon name="x" size={17} />
        </button>
      </div>)}
    </div> : null}
    {refused ? <div className="autherror" id="mailFilesRefused" role="alert">{refused}</div> : null}
    {count < MAIL_OUT_MAX_FILES ? <button className="btn bare mailattach" id="mailAttach" type="button"
      onClick={() => input.current?.click()}>
      <Svg name="attach" size={18} />{count ? 'Attach another file' : 'Attach files'}
    </button> : null}
    <input type="file" id="mailFileInput" ref={input} multiple hidden
      onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
  </div>;
}
