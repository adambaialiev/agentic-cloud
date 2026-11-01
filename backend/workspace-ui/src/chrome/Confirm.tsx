/**
 * The app's own yes/no, for the questions that used to be `window.confirm`.
 *
 * Ten of them were still the BROWSER's dialog: removing somebody from the
 * workplace, changing a role, leaving, growing the code storage, deleting a
 * secret, the three subscription answers, signing every browser out and
 * dropping the recovery email. Several of those are heavier than the ones
 * that already got the app's card, and the system box could not be styled,
 * could not carry the red the act deserved, and looked like a different
 * product each time — one window on a phone, another on a laptop.
 *
 * It is a provider rather than state on each screen because the old call
 * shape is what keeps those screens readable: `if (!(await ask(…))) return;`
 * in the middle of the handler that does the work, exactly where
 * `confirmDialog` stood. `AskToConfirm` answers through a promise here so
 * every caller keeps that line and none of them grows a second state machine.
 * The dialog itself is the same one `AskByTyping` and the delete cards use —
 * one card, one backdrop-is-no rule, one place to change how a question
 * looks (note #624).
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ConfirmContext, type Confirmation } from './confirm-context.js';
import { AskToConfirm } from '../ui/Ask.js';

interface Pending { question: Confirmation; answer: (confirmed: boolean) => void }

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // The promise's resolver, kept out of state as well: answering reads it
  // during an event, where the state this render closed over may already be
  // a version behind.
  const open = useRef<Pending | null>(null);

  const ask = useCallback((question: Confirmation) => new Promise<boolean>((resolve) => {
    // A second question while one is still up answers the first NO. Its
    // caller is waiting on a promise nobody can say yes to any more, and a
    // promise that never settles leaves that handler suspended for good.
    open.current?.answer(false);
    const next: Pending = { question, answer: resolve };
    open.current = next;
    setPending(next);
  }), []);

  const answer = useCallback((confirmed: boolean) => {
    const waiting = open.current;
    open.current = null;
    setPending(null);
    waiting?.answer(confirmed);
  }, []);

  return (
    <ConfirmContext value={ask}>
      {children}
      {pending ? <AskToConfirm {...pending.question} onAnswer={answer} /> : null}
    </ConfirmContext>
  );
}
