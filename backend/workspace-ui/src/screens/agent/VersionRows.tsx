/**
 * The version card's rows, shared by a room agent's screen and the Workspace
 * Agent's (the owner, 2026-09-21: "I want to see what version it's running
 * on like I can see in room agent details page"). One drawing, so the two
 * screens cannot say the same fact two ways.
 */

import { TypeIcon } from '../../ui/icons.js';

/** A fact row in the version card — what it runs is a thing, not an action,
 *  so it wears the flat glyph the lists use. */
export function CardRow({ glyph, title, meta }: { glyph: 'terminal' | 'drive' | 'filetext'; title: string; meta?: string }) {
  return (
    <div className="crow">
      <TypeIcon glyph={glyph} />
      <div className="main">
        <div className="name plain">{title}</div>
        {/* Wrapping, not ellipsising: this line is the whole of what the row
            has to say, and there is no deeper screen to finish it on. */}
        {meta ? <div className="cline wrap"><span className="ctext">{meta}</span></div> : null}
      </div>
    </div>
  );
}

/**
 * An update button. No mark and no room for one: it belongs to the row
 * directly above it and acts on that row. Locked while a turn runs, free the
 * moment it ends — and left strictly alone while its OWN update is running,
 * because unlocking it from there would offer a second tap on work already
 * under way.
 */
export function BusyLockButton({ label, busy, running, onPress }: {
  label: string;
  busy: boolean;
  running: boolean;
  onPress: () => void;
}) {
  const locked = busy || running;
  return (
    <button
      className="addrow busylock"
      type="button"
      disabled={locked}
      style={locked ? { opacity: '.55' } : undefined}
      data-running={running ? '1' : undefined}
      onClick={onPress}
    >
      {running ? 'Updating… this takes a few minutes' : label}
    </button>
  );
}
