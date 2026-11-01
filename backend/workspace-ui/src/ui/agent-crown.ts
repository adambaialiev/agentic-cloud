/** The models whose agents wear the crown: the FLAGSHIP of each CLI's curated
 * catalog — `fable` for Claude Code (note #296) and `gpt-6-astra` for Codex
 * (note #324). Both are the first entry of their catalog in
 * `src/agent/harness-models.ts`, which is where that order is decided.
 *
 * Written out here rather than read from those catalogs, because the crown
 * is an editorial claim — "this is the best thing its CLI can run" — and not
 * a mechanical fact about list order. A model added at the top of a catalog
 * should not inherit a crown nobody chose to give it. What keeps the two
 * honest is a test that fails when a catalog's first entry stops matching
 * this set, so the next flagship is a decision somebody makes rather than
 * one that happens quietly.
 *
 * This is NOT the CLI's default model: `defaultModelForCli` answers `opus`
 * and `gpt-6.1-sol`, each a rung below its flagship on purpose. So an agent
 * that never picked a model is uncrowned, which is the common case.
 *
 * The rows carry the EFFECTIVE model the agent will actually run with — the
 * server resolves an absent or a retired override, and sends the catalog's
 * label, before it serializes — so this reads the same fact the runtime line
 * under the name reads, and never a stale override. */
const CROWNED_MODELS: ReadonlySet<string> = new Set(['fable', 'gpt-6-astra']);

export function agentWearsCrown(model: string | undefined): boolean {
  return CROWNED_MODELS.has((model ?? '').trim().toLowerCase());
}
