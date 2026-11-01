/**
 * The composer's limits and what they refuse, and what a key press in it
 * means. Pure: the numbers are the ones the routes enforce — the box stops
 * rather than taking a paste it will hand straight back as an error — and the
 * Enter rule is a function of the press and one boolean, so it can be read as
 * a sentence and held to it by a test.
 */

import { UPLOAD_PART_BYTES } from '../../../../src/shared/uploads.js';

/** AGENT_USER_MESSAGE_MAX_LENGTH, the number the route refuses past. */
export const CHAT_MESSAGE_MAX = 10_000;
/** How close to the cap the counter appears. A counter under every two-line
 *  message is bookkeeping nobody asked for. */
export const CHAT_COUNT_FROM = 500;
/**
 * A chat file has no product cap (note #943). Anything past one part goes up
 * in 8 MB parts before its message is sent (`chat-upload.ts`), so neither the
 * edge's 100 MB body limit nor the server's memory bounds it; the one ceiling
 * is the parted protocol's — 10,000 parts of 8 MiB — and the server says the
 * same number (AGENT_CHAT_FILE_MAX_BYTES).
 */
export const CHAT_FILE_MAX_BYTES = UPLOAD_PART_BYTES * 10_000;

/** Why this file cannot go, or null. */
export function chatFileRefusal(file: { size: number }): string | null {
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > CHAT_FILE_MAX_BYTES) {
    const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(0);
    return `A chat file can be up to ${gb(CHAT_FILE_MAX_BYTES)} GB — this one is ${gb(file.size)} GB.`;
  }
  return null;
}

/**
 * What tells a touch keyboard from a real one — the only hard question in
 * note #291.
 *
 * There is no "desktop" in this app to ask: one bundle is both the page in a
 * browser and the Mini App inside Telegram, and `body.web-mode` is on either
 * way. Nor is the size of the screen the question. What the rule needs to know
 * is whether Enter is a key of its own: on a touch keyboard Enter IS the
 * newline key and has no Shift beside it to hold, so sending on it would take
 * the second line away from every phone.
 *
 * The test is deliberately NEGATIVE — a coarse pointer means a finger, and
 * everything else keeps Enter. Asking instead for a fine pointer that hovers
 * reads better and is wrong: a window with no pointing device at all reports
 * `pointer: none`, and that is a keyboard-only desk (and every headless
 * browser, which is how this was caught) — exactly the reader who lives on the
 * keys, quietly refused the key. Coarse is a positive claim a phone makes and
 * a desk never does, so the doubtful cases all fall on the side that keeps
 * Enter working.
 *
 * Read it AT THE PRESS rather than at the render: a keyboard folio can be
 * attached mid-conversation, and nothing stored is nothing to go stale.
 */
export const CHAT_TOUCH_QUERY = '(pointer: coarse)';

/** The keyCode a browser reports while an IME is still choosing the word.
 *  Safari commits a candidate with an Enter whose `isComposing` has already
 *  gone false, and this is all that is left to recognise it by. */
const IME_KEY_CODE = 229;

/** A press in the box, as much of one as the rule below reads. */
export interface ComposerPress {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** The NATIVE event's `isComposing`; React's synthetic one carries none. */
  isComposing: boolean;
  keyCode: number;
}

/**
 * Whether this press means send, rather than a new line (note #291).
 *
 * Plain Enter sends, and only where there is a keyboard to hold Shift on.
 * Everything else keeps the browser's own default: Shift+Enter is the new line
 * the note asks for, Ctrl/Alt/Meta+Enter were not asked for and are left
 * alone, and an Enter mid-composition is not a press at the composer at all —
 * it is the word being finished, and sending on it posts half a sentence in
 * Japanese, Chinese or Korean.
 */
export function chatEnterSends(press: ComposerPress, keyboard: boolean): boolean {
  if (press.key !== 'Enter' || !keyboard) return false;
  if (press.isComposing || press.keyCode === IME_KEY_CODE) return false;
  return !(press.shiftKey || press.altKey || press.ctrlKey || press.metaKey);
}
