/**
 * The Chief of Staff's recap, read aloud (note #1146). Adam, 11 Nov 2026:
 * "chief of staff recap I want them be text to voice. In header there should
 * be button to toggles between voice output mode on/off."
 *
 * The rules this file keeps, apart from the screen that draws them so they
 * can be tested on their own:
 *
 * - ON OR OFF IS THIS DEVICE'S. A phone that reads aloud and a desk that
 *   stays quiet is the ordinary case, so the setting lives in this browser's
 *   storage, not on the account.
 * - ONLY A NEW RECAP PLAYS BY ITSELF, once: one that arrives while the screen
 *   is open and showing. The recap already standing when the screen opens,
 *   one that landed while the tab was hidden, and one from a turn that ended
 *   long ago are history, and history is never replayed by itself — the
 *   recap's play button is for that.
 * - ONE PLAYER FOR THE PAGE, unlocked by a tap. iPhone Safari plays audio
 *   only from an element that has already played inside a tap, so the
 *   toggle's tap (and the play button's) plays a breath of silence on the
 *   one shared element; a recap arriving minutes later then plays on it.
 */

import type { WorkspaceTurnRecap } from '../../../../src/shared/turn-recap.js';

export const RECAP_VOICE_KEY = 'acc.recapVoice';
/** A recap whose turn ended longer ago than this is history, not news. */
export const RECAP_AUTOPLAY_FRESH_MS = 5 * 60_000;

export function recapVoiceRemembered(): boolean {
  try { return globalThis.localStorage?.getItem(RECAP_VOICE_KEY) === 'on'; } catch { return false; }
}

export function rememberRecapVoice(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(RECAP_VOICE_KEY, 'on');
    else globalThis.localStorage?.removeItem(RECAP_VOICE_KEY);
  } catch { /* private mode: the setting lasts while the page does */ }
}

/** What the screen remembers between answers about which recap was heard. */
export interface RecapHeard {
  /** The first answer has been seen: what stood then is history. */
  primed: boolean;
  /** The turn (its end) whose recap was already played or passed over. */
  turn: string | null;
}

export const RECAP_NOT_PRIMED: RecapHeard = { primed: false, turn: null };

/**
 * One step of the autoplay rule, for each answer the screen draws. Returns
 * whether to play the recap now, and what to remember. A recap counts once
 * per TURN: a later summary rewriting the same turn's words changes the line
 * in place and is not read out a second time.
 */
export function recapAutoplay(
  heard: RecapHeard,
  now: { turn: WorkspaceTurnRecap | undefined; shown: boolean; on: boolean; visible: boolean; at?: number },
): { play: boolean; heard: RecapHeard } {
  const turn = now.turn;
  if (!heard.primed) return { play: false, heard: { primed: true, turn: turn?.recap ? turn.endedAt : null } };
  if (!turn?.recap || !now.shown || turn.endedAt === heard.turn) return { play: false, heard };
  const ended = Date.parse(turn.endedAt);
  const fresh = Number.isFinite(ended) && (now.at ?? Date.now()) - ended < RECAP_AUTOPLAY_FRESH_MS;
  return { play: now.on && now.visible && fresh, heard: { primed: true, turn: turn.endedAt } };
}

/** A tenth of a second of silence, as a WAV: what the unlocking tap plays. */
function silence(): string {
  const samples = 800, rate = 8000, bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, words: string) => { for (let i = 0; i < words.length; i++) bytes[at + i] = words.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let player: HTMLAudioElement | null = null;
let silent = '';

/** The page's one audio element. */
export function recapPlayer(): HTMLAudioElement {
  if (!player) {
    player = new Audio();
    player.preload = 'auto';
    player.setAttribute('playsinline', '');
  }
  return player;
}

/** Inside a tap: play silence on the shared element, so a later recap may
 *  play on it without one (iPhone Safari). Never throws. */
export function unlockRecapAudio(): void {
  try {
    const element = recapPlayer();
    if (!element.paused && element.src && !element.src.startsWith('data:')) return;
    silent ||= silence();
    element.src = silent;
    const started = element.play();
    if (started && typeof started.catch === 'function') started.catch(() => undefined);
  } catch { /* nothing to unlock with */ }
}

/** The element if anything has made it yet: a screen that never spoke has none. */
export function existingRecapPlayer(): HTMLAudioElement | null { return player; }

/** Test seam: forget the shared element. */
export function forgetRecapPlayer(): void { player = null; }

/** The answer's base64 audio as a URL the player can take. */
export function audioUrl(base64: string, contentType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: contentType || 'audio/mpeg' }));
}
