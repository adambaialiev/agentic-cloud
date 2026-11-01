import { createContext } from 'react';

/**
 * One yes/no question, in the three parts the app's own dialog draws: what is
 * being asked, what it costs, and the word on the button that says yes.
 *
 * `danger` paints that word red, and it is spent narrowly — on the answers
 * that destroy something or take access away account-wide, never on the ones
 * a reader can simply do again.
 */
export interface Confirmation {
  title: string;
  message: string;
  verb: string;
  danger?: boolean;
}

/** Resolves true only if the reader answered with the verb. */
export type AskToConfirm = (question: Confirmation) => Promise<boolean>;

export const ConfirmContext = createContext<AskToConfirm | null>(null);
