import {
  modelCatalogForCli,
  type TelegramHarnessEffortOption,
} from '../shared/model-catalog.js';
import { HARNESS_CLIS, type HarnessCli } from '../shared/harness-clis.js';

// The catalogs themselves live in `shared/model-catalog.ts` since note #718
// (the Workspace draws its pickers from them); every name is still reachable
// from here.
export {
  TELEGRAM_CLAUDE_MODEL_CATALOG,
  TELEGRAM_CODEX_MODEL_CATALOG,
  TELEGRAM_OPENCODE_MODEL_CATALOG,
  modelCatalogForCli,
  opencodeModelRef,
  type TelegramHarnessEffortOption,
  type TelegramHarnessModelCatalogEntry,
  type TelegramHarnessModelOption,
} from '../shared/model-catalog.js';

/**
 * Models WITHDRAWN from a catalog, still stored on agents that picked them
 * before the withdrawal. These resolve to the CLI default instead of being
 * trusted as-is: an unoffered model would otherwise keep running forever on
 * those agents, with no ● anywhere in the picker to explain why. Deliberately
 * an explicit list rather than "anything outside the catalog".
 */
const RETIRED_MODELS: Readonly<Record<HarnessCli, ReadonlySet<string>>> = {
  // `sonnet` was here until it came back to the catalog on 2026-09-29: an
  // agent still stored on it runs Sonnet again, the model its owner chose.
  claude: new Set(),
  codex: new Set(),
  opencode: new Set(),
};

/**
 * The effort levels for a CONCRETE model choice, or an empty list when the
 * model is absent/unknown.
 */
export function effortsForModel(
  cli: HarnessCli,
  model: string | undefined,
): readonly TelegramHarnessEffortOption[] {
  if (!model) return [];
  return modelCatalogForCli(cli).find((entry) => entry.value === model)?.efforts ?? [];
}

/**
 * "Default" is not a thing users see: every agent always has a CONCRETE
 * model + effort, and these are what an agent runs with (and shows in its
 * message header) until the user picks otherwise.
 */
export function defaultModelForCli(cli: HarnessCli): string {
  if (cli === 'claude') return 'opus';
  // GLM-5.3 (note #780): Go's flagship coding model, and one that offers
  // `high` — so a new OpenCode agent starts on the same rung as the others.
  if (cli === 'opencode') return 'glm-5.3';
  // gpt-6.1-sol since 2026-10-11 (the owner: "new room agents should also
  // start on gpt 6.1 sol high"); it was gpt-6-sol from 2026-09-23 and
  // gpt-5.6-sol before that. Still one rung below the flagship, on purpose —
  // see agent-crown.ts.
  return 'gpt-6.1-sol';
}

/**
 * The stored override when set, otherwise the CLI's default model. A retired
 * model resolves to the default too — the product no longer offers it.
 */
export function resolveEffectiveModel(cli: HarnessCli, model: string | undefined): string {
  const stored = model?.trim();
  if (!stored || RETIRED_MODELS[cli].has(stored)) return defaultModelForCli(cli);
  return stored;
}

/**
 * The effective reasoning effort for an agent: the stored override when the
 * effective model supports it, otherwise the model-aware default — `high`,
 * then `medium`, then the model's first level as available.
 *
 * `high` for BOTH CLIs since 2026-09-11 (it was `max` for Codex and `xhigh`
 * for Claude): a brand-new agent nobody had configured started life inside the
 * heavy band flagged by note #482, quietly spending the subscription's usage
 * window at its fastest rate before its owner had chosen anything. `high` is
 * the one rung every CLI has always had, and it is now the one answer for an
 * unconfigured agent whichever harness it runs — the heavy levels stay one tap
 * away in the picker, and a stored choice is still obeyed exactly as it was.
 *
 * The fall-through bit gpt-5.6-luna while its list skipped `high` (it landed
 * on `medium` rather than climbing back into the heavy band); every model in
 * the catalog offers `high` today, but the ladder still walks DOWN on purpose
 * — a default that overshoots costs the user's window, one that undershoots
 * costs a tap.
 *
 * A stored level BELOW everything the model now offers — `low`, withdrawn
 * from Claude's picker on 2026-09-29 and from Codex's on 2026-10-12 — runs
 * on the model's lowest level
 * rather than on the default: its owner chose the cheap end, and `high`
 * would spend their window faster than anything they picked.
 *
 * For a model outside the catalog (legacy override), the stored effort is
 * trusted as-is, falling back to `high` too — the safe answer for a model
 * whose levels we cannot look up.
 */
const EFFORT_ORDER: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function resolveEffectiveEffort(
  cli: HarnessCli,
  model: string | undefined,
  effort: string | undefined,
): string {
  const effectiveModel = resolveEffectiveModel(cli, model);
  const efforts = effortsForModel(cli, effectiveModel);
  const stored = effort?.trim() || undefined;
  // A catalog model with no effort setting (OpenCode's Kimi K3 and MiMo,
  // note #780) runs with none: the empty answer, which every caller treats
  // as "no level to pass or to show". Only a model OUTSIDE the catalog
  // falls through to the trusted/`high` answer below.
  if (efforts.length === 0 && modelCatalogForCli(cli).some((entry) => entry.value === effectiveModel)) return '';
  if (efforts.length === 0) return stored ?? 'high';
  if (stored && efforts.some((option) => option.value === stored)) return stored;
  const storedRank = stored ? EFFORT_ORDER.indexOf(stored) : -1;
  if (storedRank >= 0 && storedRank < EFFORT_ORDER.indexOf(efforts[0].value)) return efforts[0].value;
  // One ladder, not one per CLI: the answer to "nobody has chosen" is the
  // same rung whichever harness asks.
  const defaultCandidates: readonly string[] = ['high', 'medium'];
  for (const candidate of defaultCandidates) {
    if (efforts.some((option) => option.value === candidate)) return candidate;
  }
  return efforts[0].value;
}

/**
 * A model and an effort asked for when an agent is created (note #757): the
 * Chief of Staff's `agentbuilt agent create --model/--effort`, judged against
 * the same catalog the picker offers, so creation can never store a pair the
 * picker would refuse. Either half may be absent, and an absent half is the
 * default exactly as for an agent nobody configured; an effort without a
 * model is judged against the harness's default model. Names are matched
 * case-blind (the catalog is lower case). A refusal carries what IS offered:
 * the harness's models, or the levels of the one model asked about, and for
 * a model of the other harness, which harness that is.
 */
export function checkCreationRuntime(
  cli: HarnessCli,
  model: string | undefined,
  effort: string | undefined,
):
  | { ok: true; model?: string; effort?: string }
  | { ok: false; field: 'model'; allowed: string[]; otherCli?: HarnessCli }
  | { ok: false; field: 'effort'; model: string; allowed: string[] } {
  const askedModel = model?.trim().toLowerCase() || undefined;
  const askedEffort = effort?.trim().toLowerCase() || undefined;
  if (askedModel && !modelCatalogForCli(cli).some((entry) => entry.value === askedModel)) {
    const other = HARNESS_CLIS.find((candidate) => candidate !== cli
      && modelCatalogForCli(candidate).some((entry) => entry.value === askedModel));
    return {
      ok: false,
      field: 'model',
      allowed: modelCatalogForCli(cli).map((entry) => entry.value),
      ...(other ? { otherCli: other } : {}),
    };
  }
  if (askedEffort) {
    const effectiveModel = resolveEffectiveModel(cli, askedModel);
    const efforts = effortsForModel(cli, effectiveModel);
    if (!efforts.some((option) => option.value === askedEffort)) {
      return { ok: false, field: 'effort', model: effectiveModel, allowed: efforts.map((option) => option.value) };
    }
  }
  return { ok: true, ...(askedModel ? { model: askedModel } : {}), ...(askedEffort ? { effort: askedEffort } : {}) };
}

/**
 * A harness's catalog in one line of words, models grouped by the effort
 * levels they share — for an agent's instructions, which then never drift
 * from what the picker offers (note #757).
 */
export function catalogInWords(cli: HarnessCli): string {
  const groups = new Map<string, string[]>();
  for (const entry of modelCatalogForCli(cli)) {
    const levels = entry.efforts.map((option) => option.value).join(', ');
    groups.set(levels, [...(groups.get(levels) ?? []), entry.value]);
  }
  return [...groups].map(([levels, models]) => `${models.join(', ')} (${levels ? `effort ${levels}` : 'no effort setting'})`).join('; ');
}

/**
 * One change to an existing agent's model and effort, by the rule the
 * picker on its screen has always written (note #776 shares it with the
 * Chief of Staff's `agentbuilt agent model`): an effort is judged against
 * the model it will run with — the new one when the model changes too, the
 * current one otherwise; a model change alone keeps the stored effort only
 * when the new model offers it, and otherwise clears it to that model's
 * default. Values are taken as given; a caller that wants names matched
 * case-blind lowers them first. `updates` is what to write on the record.
 */
export function planRuntimeChange(
  cli: HarnessCli,
  current: { model?: string; effort?: string },
  asked: { model?: string; effort?: string },
):
  | { ok: true; updates: { model?: string; effort?: string | null } }
  | { ok: false; field: 'model'; allowed: string[] }
  | { ok: false; field: 'effort'; model: string; allowed: string[] } {
  const catalog = modelCatalogForCli(cli);
  const model = asked.model !== undefined ? asked.model : resolveEffectiveModel(cli, current.model);
  const entry = catalog.find((option) => option.value === model);
  if (!entry) return { ok: false, field: 'model', allowed: catalog.map((option) => option.value) };
  const updates: { model?: string; effort?: string | null } = {};
  if (asked.model !== undefined) updates.model = model;
  if (asked.effort !== undefined) {
    if (!entry.efforts.some((option) => option.value === asked.effort)) {
      return { ok: false, field: 'effort', model, allowed: entry.efforts.map((option) => option.value) };
    }
    updates.effort = asked.effort;
  } else if (asked.model !== undefined) {
    const stored = current.effort?.trim();
    updates.effort = stored && entry.efforts.some((option) => option.value === stored) ? stored : null;
  }
  return { ok: true, updates };
}

/**
 * The line an agent's next turn opens its platform notes with after the
 * Workspace Agent changed what it runs on (note #776) — the pair this very
 * turn runs with, so it can never name a stale one. Null when nothing was
 * changed on the person's behalf since the agent last spoke.
 */
export function buildRuntimeChangeNote(
  change: { by: 'workspace-agent'; at: string } | undefined,
  model: string | undefined,
  effort: string | undefined,
): string | null {
  if (!change || !model) return null;
  return `[Platform] Since your last turn the Workspace Agent changed what you run on, at your user's request: this turn runs on ${model}${effort ? ` at ${effort} effort` : ''}. Nothing else about your work changed.`;
}
