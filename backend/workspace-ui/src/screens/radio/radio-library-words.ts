import type { RadioLibraryTrack } from '../../../../src/shared/radio.js';

/** What a track was made to, in the order a listener hears it: the style,
 *  the lead, the tempo, the key, then the mood or the energy
 *  ("felt piano · 78 BPM · B-flat major", "boom-bap · brass stabs · 92 BPM · D minor · gritty"). */
export function recipeLine(track: RadioLibraryTrack): string {
  const { style, lead, bpm, key, mood, energy } = track.recipe;
  // Each part keeps its words together, so a narrow row breaks between parts.
  return [style, lead, bpm ? `${bpm} BPM` : '', key, mood ? mood.replace(/-/g, ' ') : '', energy].filter(Boolean)
    .map((part) => part!.replace(/ /g, '\u00a0')).join(' · ') || 'No recipe kept';
}

/** The dead air cut from inside a track, when any was ("1 gap cut, 1.7 s"). */
export function gapsLine(track: RadioLibraryTrack): string {
  const gaps = track.gapsCut ?? [];
  if (!gaps.length) return '';
  const seconds = gaps.reduce((sum, gap) => sum + gap.ms, 0) / 1000;
  return `${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'} cut, ${seconds.toFixed(1)} s`;
}

/** "11 Oct, 09:41" in the reader's own time. */
export function madeAt(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The title's second line: the station on show, how many are on, how many off. */
export function librarySub(station: string, on: number, removed: number): string {
  const tracks = `${station}: ${on} ${on === 1 ? 'track' : 'tracks'}`;
  return removed ? `${tracks} · ${removed} removed` : tracks;
}
