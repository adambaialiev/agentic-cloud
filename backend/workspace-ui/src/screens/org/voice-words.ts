/**
 * The words around a workplace's voice-to-text (note #1026), kept apart from
 * the screens so they can be tested without a browser.
 */
import type { VoiceMonthUsage } from '../../../../src/shared/voice.js';

/** Who can fix it, by name: "Dana Rivera", "Dana Rivera or Sam Lee",
 *  "Dana Rivera, Sam Lee or another admin", or "An admin". */
export function voiceAdminsWords(admins: readonly string[]): string {
  if (admins.length === 0) return 'An admin';
  if (admins.length === 1) return admins[0]!;
  if (admins.length === 2) return `${admins[0]} or ${admins[1]}`;
  return `${admins[0]}, ${admins[1]} or another admin`;
}

/** "$11.62", "$0.38", "under 1¢", "$0.00". */
export function voiceUsdWords(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return 'under 1¢';
  return `$${usd.toFixed(2)}`;
}

function speechWords(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under a minute of speech';
  if (minutes < 60) return `${minutes} min of speech`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min of speech`;
}

/** "This month: 412 recordings, 2 h 05 min of speech, $0.38". */
export function voiceMonthWords(month: VoiceMonthUsage): string {
  if (month.recordings === 0) return 'No recordings yet this month.';
  const parts = [`${month.recordings} recording${month.recordings === 1 ? '' : 's'}`];
  if (month.seconds > 0) parts.push(speechWords(month.seconds));
  parts.push(voiceUsdWords(month.costUsd));
  return `This month: ${parts.join(', ')}`;
}
