/**
 * The curated model catalogs, with the reasoning-effort levels each model
 * offers. SHARED between the backend and the Workspace (note #718): the
 * backend validates picks against it and answers the runtime reads from it;
 * the Workspace draws a model & effort picker from it the moment it opens,
 * before the read has answered — the list is a fact of the product, not of
 * the account, and only which entries the account may USE (`available`) and
 * which is current have to come from the server. Nothing here may import
 * from outside `shared/`.
 */

export interface TelegramHarnessModelOption {
  value: string;
  label: string;
}

/**
 * One reasoning-effort level a model offers.
 *
 * `heavy` is carried by the level itself, all the way to the picker that
 * offers it (note #482): every level from `xhigh` up thinks for far longer
 * before it answers and spends the subscription's usage window much faster,
 * and a reader choosing one is entitled to know that BEFORE the tap rather
 * than from a drained window later. It is an explicit flag on the level, not
 * a rule the page infers from the name or from a position in the list — a
 * catalog that one day offers a cheap level called `xtra` must not have the
 * warning follow the spelling.
 */
export interface TelegramHarnessEffortOption extends TelegramHarnessModelOption {
  heavy?: boolean;
}

/**
 * One model in a CLI's curated catalog, with the reasoning-effort levels that
 * model actually supports. Effort is PER MODEL, not per CLI: the /agents
 * detail view shows only models; tapping a model pushes an effort view built
 * from that model's own list.
 */
export interface TelegramHarnessModelCatalogEntry extends TelegramHarnessModelOption {
  efforts: readonly TelegramHarnessEffortOption[];
  /**
   * The model's context window, for a harness whose stream never states one
   * (OpenCode). Codex states its own and Claude's resolve by model id, so
   * neither catalog carries it.
   */
  contextWindow?: number;
  /**
   * The model's own name where its id does not spell it (`glm-5.3` is
   * "GLM-5.3", `mimo-v2.6-pro` is "MiMo V2.6 Pro"). Absent where the id reads
   * well once capitalised, as every Claude and Codex entry does.
   */
  name?: string;
}

const EFFORT_MEDIUM: TelegramHarnessEffortOption = { value: 'medium', label: 'medium' };
const EFFORT_HIGH: TelegramHarnessEffortOption = { value: 'high', label: 'high' };
const EFFORT_XHIGH: TelegramHarnessEffortOption = { value: 'xhigh', label: 'xhigh', heavy: true };
const EFFORT_MAX: TelegramHarnessEffortOption = { value: 'max', label: 'max', heavy: true };
const EFFORT_ULTRA: TelegramHarnessEffortOption = { value: 'ultra', label: 'ultra', heavy: true };

/**
 * Claude: family aliases follow the user's account as Anthropic updates
 * versions and workplace policy; `--model <alias>` + `--effort <level>`.
 * Haiku is intentionally not offered. Sonnet was withdrawn and came back on
 * 2026-09-29 (the owner): Fable, Opus and Sonnet, deepest first.
 * Every Claude model shares the same effort levels, medium|high|xhigh|max.
 * The CLI also takes `low`, but since 2026-09-29 (the owner) the picker does
 * not offer it; an agent stored on it runs on `medium` (see
 * resolveEffectiveEffort). ultracode exists but is intentionally NOT exposed
 * (verified against claude 2.1.207).
 */
const CLAUDE_EFFORTS: readonly TelegramHarnessEffortOption[] = [
  EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX,
];
export const TELEGRAM_CLAUDE_MODEL_CATALOG: readonly TelegramHarnessModelCatalogEntry[] = [
  { value: 'fable', label: 'fable', efforts: CLAUDE_EFFORTS },
  { value: 'opus', label: 'opus', efforts: CLAUDE_EFFORTS },
  { value: 'sonnet', label: 'sonnet', efforts: CLAUDE_EFFORTS },
];

/**
 * Codex: a deliberately CURATED, static catalog — this replaced live
 * `codex debug models` discovery (per-machine SSH + parsing) on purpose: the
 * product offers exactly these models, and effort levels differ per model
 * (`-m <slug>` + `-c model_reasoning_effort=<level>`).
 */
export const TELEGRAM_CODEX_MODEL_CATALOG: readonly TelegramHarnessModelCatalogEntry[] = [
  // Every list below is what `codex debug models` reports for the slug, re-read
  // against codex-cli 0.156.1 on 2026-09-23 (the bump that brought gpt-6-sol and
  // gpt-6-luna) and 0.161.0 on 2026-10-11 (gpt-6.1-sol), and unchanged on
  // 0.166.0 on 2026-10-31 (which brought gpt-6.1-terra, offered since note
  // #930), less `low`: the CLI still takes it, but since 2026-10-12 (the owner: "let's
  // remove 'low' effort from chatgpt models") no picker offers it, as Claude's
  // went on 2026-09-29; an agent stored on it runs on `medium` (see
  // resolveEffectiveEffort). Astra's `ultra` is a Codex CLI level; the public
  // API model page documents low through max.
  {
    value: 'gpt-6-astra',
    label: 'gpt-6-astra',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX, EFFORT_ULTRA],
  },
  // GPT-6.1 Sol, listed by codex-cli 0.161.0 (the platform's pin, read on
  // 2026-10-11) between Astra and Sol, with Sol's full ladder. The owner's
  // pick for the Chief of Staff on a ChatGPT plan (workspace-recap-settings).
  {
    value: 'gpt-6.1-sol',
    label: 'gpt-6.1-sol',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX, EFFORT_ULTRA],
  },
  // GPT-6.1 Terra (note #930, the owner: "yes add gpt-6.1 terra"), new in
  // codex-cli 0.165.0 and listed by the pin, 0.166.0, right after 6.1 Sol,
  // with the same low → ultra ladder and a 500,000-token default window
  // (Codex states it in its own stream, so nothing here carries it).
  {
    value: 'gpt-6.1-terra',
    label: 'gpt-6.1-terra',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX, EFFORT_ULTRA],
  },
  // The GPT-6 pair beneath the flagship: sol is Codex's own "workhorse for
  // coding and everyday work" and the default an unconfigured agent runs on;
  // luna is the fast, affordable rung and has no `ultra`.
  {
    value: 'gpt-6-sol',
    label: 'gpt-6-sol',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX, EFFORT_ULTRA],
  },
  {
    value: 'gpt-6-luna',
    label: 'gpt-6-luna',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX],
  },
  // The 5.6 family stays offered (Codex lists it as "older", not gone) so an
  // agent already on one keeps running exactly as it was.
  {
    value: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX, EFFORT_ULTRA],
  },
  {
    value: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX, EFFORT_ULTRA],
  },
  {
    // Luna once had no `high` rung (which is why the effort ladder below
    // walks DOWN); Codex lists one for it now, on 0.155.0 and 0.156.1 alike.
    value: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX],
  },
  {
    value: 'gpt-5.5',
    label: 'gpt-5.5',
    efforts: [EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH],
  },
];

/**
 * OpenCode on the member's own OpenCode Go subscription (note #780): the
 * open-weight models Go covers, addressed `opencode-go/<id>` on the command
 * line. The value is the bare id — what OpenCode's own model list calls it,
 * and what the agent rows print — and the harness adds the provider
 * (`opencodeModelRef`). Effort is OpenCode's `--variant`; every list below is
 * what `opencode models opencode-go --verbose` reports for the model,
 * read against opencode 1.19.3 on 2026-10-20 and unchanged on 1.19.5 on
 * 2026-10-31, less the levels no picker offers
 * (`low`, `none`, `minimal`), as with the other two harnesses.
 *
 * Kimi K3 and MiMo V2.6 Pro have no effort setting here: MiMo lists no
 * variant at all, and Kimi K3's only one is `max` — so it runs on its own
 * default rather than on a heavy level nobody chose. Each window is the
 * model's own, from the same list.
 */
export const TELEGRAM_OPENCODE_MODEL_CATALOG: readonly TelegramHarnessModelCatalogEntry[] = [
  { value: 'glm-5.3', label: 'glm-5.3', name: 'GLM-5.3', efforts: [EFFORT_HIGH, EFFORT_MAX], contextWindow: 1_000_000 },
  { value: 'kimi-k3', label: 'kimi-k3', name: 'Kimi K3', efforts: [], contextWindow: 1_048_576 },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', efforts: [EFFORT_HIGH, EFFORT_MAX], contextWindow: 1_000_000 },
  { value: 'qwen3.8-max', label: 'qwen3.8-max', name: 'Qwen3.8 Max', efforts: [EFFORT_MEDIUM, EFFORT_XHIGH], contextWindow: 1_000_000 },
  { value: 'mimo-v2.6-pro', label: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', efforts: [], contextWindow: 1_048_576 },
  // The fast, cheap rungs: Go allows each several times the monthly usage
  // of the flagships above.
  { value: 'glm-5.3-flash', label: 'glm-5.3-flash', name: 'GLM-5.3 Flash', efforts: [EFFORT_HIGH, EFFORT_MAX], contextWindow: 1_000_000 },
  { value: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', efforts: [EFFORT_HIGH, EFFORT_MAX], contextWindow: 1_000_000 },
];

/** A catalog model's own name when its entry carries one — any harness, any value. */
export function catalogModelName(value: string): string | undefined {
  return TELEGRAM_OPENCODE_MODEL_CATALOG.find((entry) => entry.value === value || entry.label === value)?.name;
}

/** The provider an OpenCode catalog value runs on: the member's Go subscription. */
export const OPENCODE_GO_PROVIDER = 'opencode-go';

/** `glm-5.3` → `opencode-go/glm-5.3`, the `--model` OpenCode takes. A value that already names its provider is left alone. */
export function opencodeModelRef(model: string): string {
  return model.includes('/') ? model : `${OPENCODE_GO_PROVIDER}/${model}`;
}

/** The curated model catalog for a CLI. */
export function modelCatalogForCli(cli: 'claude' | 'codex' | 'opencode'): readonly TelegramHarnessModelCatalogEntry[] {
  if (cli === 'opencode') return TELEGRAM_OPENCODE_MODEL_CATALOG;
  return cli === 'claude' ? TELEGRAM_CLAUDE_MODEL_CATALOG : TELEGRAM_CODEX_MODEL_CATALOG;
}
