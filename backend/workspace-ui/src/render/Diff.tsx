/**
 * Unified diff → one collapsible card per changed file, closed to start with.
 *
 * What a reader wants first is WHICH files changed and by how much; a
 * twenty-file proposal that opens every line at once buries exactly that, and
 * on a phone it buries the decision buttons too. So each card opens on a tap,
 * and its header carries the file's own two numbers whether it is open or not.
 *
 * `open` overrides that for the one caller where the diff is not a summary to
 * drill into but the CONTENT of the screen: a knowledge change is one page,
 * and asking for a tap to see the only thing on offer is a tap for nothing.
 *
 * SAFETY: every byte of the patch is a React text child, never markup, so
 * nothing an agent commits can become live DOM here.
 */

import { useState } from 'react';
import { DIFF_LINE_CAP, parseDiff, type DiffFile } from './diff.js';
import { Icon } from '../ui/icons.js';

function DiffFileCard({ file, open }: { file: DiffFile; open: boolean }) {
  const [shown, setShown] = useState(open);
  return (
    <div className={shown ? 'difffile' : 'difffile closed'}>
      <button className="diffhead" type="button" aria-expanded={shown} onClick={() => setShown(!shown)}>
        <Icon name="chev" size={17} className="icon chev" />
        <div className="diffpath">{file.path}</div>
        <span className="stat">
          <span className="plus">+{file.added}</span>
          <span className="minus">−{file.removed}</span>
        </span>
      </button>
      <div className="difflines">
        {file.lines.map((line, at) => <div className={line.kind} key={at}>{line.text}</div>)}
      </div>
    </div>
  );
}

export function Diff({ patch, open = false }: { patch: string; open?: boolean }) {
  const parsed = parseDiff(patch);
  return (
    <div>
      {parsed.files.map((file, at) => <DiffFileCard file={file} key={at} open={open} />)}
      {parsed.capped ? (
        <div className="empty">
          {`This diff is longer than what fits here — showing the first ${DIFF_LINE_CAP} lines.`
            + ' `agentbuilt pr diff` has all of it.'}
        </div>
      ) : null}
    </div>
  );
}
