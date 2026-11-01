/**
 * What a runtime choice COSTS, in words (note #482).
 *
 * Every effort level from `xhigh` up is marked `heavy` by the catalog that
 * offers it, and the picker says so twice: a short line on the row itself, so
 * the mark is where the thumb is, and one sentence under the card that
 * explains what "heavy" spends. The levels are NAMED from the data rather
 * than described as "xhigh and above", because a model offers its own list —
 * gpt-5.5 stops at xhigh and would otherwise be warned about levels it cannot
 * run.
 *
 * No multiplier is quoted. The honest thing we know is the direction and its
 * consequence — much longer thinking, a subscription window that empties much
 * faster — and a made-up "3×" on a screen is the kind of number that outlives
 * the person who guessed it.
 */

import { catalogModelName } from '../../../src/shared/model-catalog.js';

/** The mark on a heavy row. Short: the sentence under the card carries the why. */
export const HEAVY_EFFORT_MARK = 'Much more compute';

/** "xhigh, max and ultra", "xhigh and max", "xhigh". */
export function effortList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The caution under the effort card, or null when the model on offer has no
 * heavy level at all — a card with nothing to warn about carries no warning.
 */
export function heavyEffortNote(labels: string[]): string | null {
  if (labels.length === 0) return null;
  const many = labels.length > 1;
  return `${effortList(labels)} ${many ? 'think' : 'thinks'} for much longer before answering,`
    + ` and ${many ? 'spend' : 'spends'} the subscription’s usage much faster — a few long turns`
    + ' can drain a window. Worth it on a hard problem, expensive as an everyday setting.';
}

/**
 * A model and an effort level as a person reads them (the owner, 2026-09-29):
 * the catalog's labels are the CLI's own words — `opus`, `gpt-6-astra`,
 * `xhigh` — and the picker set them in the terminal face, so the screen read
 * as a command line. The value on the wire is untouched; only the words
 * change. No version is added to a family alias: `opus` follows the account
 * as the provider updates it, so "Opus 5.5" would go stale on its own.
 */
const EFFORT_NAMES: Record<string, string> = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
};

const capital = (word: string) => (word ? word[0]!.toUpperCase() + word.slice(1) : word);

/** "opus" -> "Opus", "gpt-6-astra" -> "GPT-6 Astra", "gpt-5.5" -> "GPT-5.5",
 *  and a model whose catalog entry names it by its own name: "glm-5.3" -> "GLM-5.3". */
export function modelName(label: string): string {
  const own = catalogModelName(label);
  if (own) return own;
  const gpt = /^gpt-([^-]+)(?:-(.+))?$/i.exec(label);
  if (gpt) return [`GPT-${gpt[1]}`, ...(gpt[2] ?? '').split('-').filter(Boolean).map(capital)].join(' ');
  return label.split('-').filter(Boolean).map(capital).join(' ');
}

/** "xhigh" -> "Extra high"; a level this file has never met keeps its word, capitalised. */
export function effortName(label: string): string {
  return EFFORT_NAMES[label.toLowerCase()] ?? capital(label);
}

const EFFORT_LINES: Record<string, string> = {
  none: 'Answers without stopping to think.',
  minimal: 'Answers almost at once, with barely any thinking.',
  low: 'Answers quickly, with the least thinking.',
  medium: 'Thinks a little before answering.',
  high: 'Thinks carefully before answering.',
};

/**
 * The one line under the effort scale, about the step that is chosen. A
 * heavy step says what it costs in the mark's words; a level with no line
 * of its own says nothing rather than something invented.
 */
export function effortLine(option: { value: string; heavy?: boolean }): string {
  if (option.heavy) return `${HEAVY_EFFORT_MARK} — thinks far longer before answering.`;
  return EFFORT_LINES[option.value.toLowerCase()] ?? '';
}
