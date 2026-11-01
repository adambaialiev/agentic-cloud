/**
 * The two questions this shell asks over a screen, ported from the legacy
 * page's `askToChoose` and `askByTyping`.
 *
 * Both keep the legacy class vocabulary (`.scrim`, `.ask`, `.choices`,
 * `.choice`, `.btns`) so the shared stylesheet draws them, and both keep the
 * rules those functions encode:
 *
 *  - a tap on the BACKDROP — not on the card standing in it — is the gesture
 *    everyone knows for "no", and no is the safe direction;
 *  - Escape is the same answer;
 *  - the CARD takes focus, not the first option, so nothing here can be
 *    chosen by one reflex press of Enter;
 *  - a delete is confirmed by typing the name, trimmed and only trimmed: a
 *    phone's keyboard hands out a trailing space for free, and a name never
 *    contains one. Case and near misses are not forgiven.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The backdrop and the card, rendered ON `document.body` rather than where
 * the asking component stands (note #347).
 *
 * `.scrim` is `position: fixed; inset: 0`, and on paper that puts it over the
 * viewport wherever it is in the tree. iPhone Safari does not read it that
 * way when the tree passes through a SCROLLER: a fixed descendant of an
 * `overflow: auto` box is composited inside that box and clipped to it. The
 * Create agent plate lives in the sideways row of agent cards under a note,
 * so its harness question came up as a pale sliver at the top of that row —
 * the bottom edge of the card, cut off by the row — and every tap on the
 * dim strip was the backdrop saying no. Chrome and desktop WebKit draw the
 * same markup correctly, which is why the harnesses never saw it.
 *
 * A portal takes every question this shell asks out of whatever scroller
 * its button happened to be in, so a dialog is never again at the mercy of
 * the section that opened it. React events still bubble through the
 * component tree, exactly as they did when the card sat in place.
 */
export function Scrim({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  // The input inside a typing confirmation owns focus after a reader taps it.
  // Its state changes every keystroke, so keep the Escape answer fresh without
  // putting the focus effect behind the changing callback.
  const dismiss = useRef(onDismiss);

  useEffect(() => { dismiss.current = onDismiss; });

  useEffect(() => {
    card.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div
      className="scrim"
      onClick={(event) => { if (event.target === event.currentTarget) onDismiss(); }}
      role="presentation"
    >
      <div className="ask" role="dialog" aria-modal="true" ref={card} tabIndex={-1}>{children}</div>
    </div>,
    document.body,
  );
}

export interface AskChoice { id: string; label: string; hint?: string }

/** One question with named answers — the New agent harness pick. */
export function AskToChoose({ title, message, options, onAnswer }: {
  title: string;
  message?: string;
  options: readonly AskChoice[];
  onAnswer: (id: string | null) => void;
}) {
  return (
    <Scrim onDismiss={() => onAnswer(null)}>
      <h3>{title}</h3>
      {message ? <p>{message}</p> : null}
      <div className="choices">
        {options.map((option) => (
          // The name and what it runs on are one label, so a screen reader
          // announces the whole option rather than a bare product name.
          <button className="choice" key={option.id} type="button" onClick={() => onAnswer(option.id)}>
            <span className="n">{option.label}</span>
            {option.hint ? <span className="d">{option.hint}</span> : null}
          </button>
        ))}
      </div>
      <div className="btns">
        <button className="btn ghost" type="button" onClick={() => onAnswer(null)}>Cancel</button>
      </div>
    </Scrim>
  );
}

/** The confirm that cannot be tapped through: type the name. */
export function AskByTyping({ name, lines, verb, onAnswer }: {
  name: string;
  lines: readonly string[];
  verb: string;
  onAnswer: (confirmed: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === name;
  return (
    <Scrim onDismiss={() => onAnswer(false)}>
      <h3>{verb} <span className="name">{name}</span>?</h3>
      {lines.map((line) => <p key={line}>{line}</p>)}
      <label>
        <span className="k">Type the name to confirm</span>
        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          // Every one of these is a phone doing something helpful to a string
          // that must arrive EXACTLY as it left: a capital first letter, a
          // "corrected" hyphen, a remembered value. The name is not prose.
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={`Type ${name} to confirm`}
          onKeyDown={(event) => {
            // Enter is the hardware-keyboard way to say the same thing — and
            // it goes through the same gate the button does.
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (matches) onAnswer(true);
          }}
        />
      </label>
      <div className="btns">
        <button className="btn ghost" type="button" onClick={() => onAnswer(false)}>Cancel</button>
        <button className="btn danger" type="button" disabled={!matches} onClick={() => { if (matches) onAnswer(true); }}>
          {verb}
        </button>
      </div>
    </Scrim>
  );
}

/**
 * The plain yes/no — over an action that restarts something, over taking a
 * file off a note, and over every question that used to reach the reader as
 * a browser dialog. `window.confirm` is gone from this app entirely: the
 * last ten calls (a member removed, a role changed, a workplace left, the
 * code storage grown, a secret deleted, the three subscription answers, every
 * browser signed out, the recovery email dropped) come through
 * `ConfirmProvider` and land here. Same words, same two answers, and the same
 * backdrop-is-no rule as every other question this shell asks — and, unlike
 * the system box, a card that can say in red what the act costs.
 *
 * `danger` paints the answer red where the act really cannot be undone. It is
 * the only warning such a button carries, which is why it is not also filled.
 */
export function AskToConfirm({ title, message, verb, danger, onAnswer }: {
  title: string;
  message: string;
  verb: string;
  danger?: boolean;
  onAnswer: (confirmed: boolean) => void;
}) {
  return (
    <Scrim onDismiss={() => onAnswer(false)}>
      <h3>{title}</h3>
      <p>{message}</p>
      <div className="btns">
        <button className="btn ghost" type="button" onClick={() => onAnswer(false)}>Cancel</button>
        <button className={danger ? 'btn danger' : 'btn primary'} type="button" onClick={() => onAnswer(true)}>
          {verb}
        </button>
      </div>
    </Scrim>
  );
}
