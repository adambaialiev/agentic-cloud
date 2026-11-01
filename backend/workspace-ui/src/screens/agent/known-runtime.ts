/**
 * What a model & effort picker can draw BEFORE its read has answered
 * (note #718): the choices.
 *
 * The owner, 2026-10-11: "the model and effort choices should appear at once
 * when a picker opens, even before the server has answered". The list of
 * models and the levels each offers is a fact of the product, not of the
 * account — the same `shared/model-catalog.ts` the backend answers from —
 * so a picker that opens on "Loading choices…" is waiting for words it
 * already has. What the read still owes is which entry is CURRENT, and for
 * the private runtimes which entries the account may use; both land over
 * this first frame when the read answers, and a tap before then goes to the
 * server exactly as a tap after it would, where the same catalog judges it.
 *
 * A room agent's picker starts from the agent's own row: the fleet read has
 * already said its harness and the pair it runs on, so its first frame is
 * complete — the whole catalog of its harness, with the current pair marked.
 * The Chief of Staff's and the briefing's pickers start from the catalog of
 * every harness the workplace can reach — its seats and its agents' own
 * harnesses, the same two sources the server reads — with no current pair
 * until the opener or the read supplies one.
 */

import type { WorkspaceAgentRow, WorkspaceAgentRuntimeAnswer, WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import type { WorkspaceRecapModel, WorkspaceRecapSettingsAnswer } from '../../../../src/shared/workspace-recap.js';
import { modelCatalogForCli } from '../../../../src/shared/model-catalog.js';

type Cli = 'claude' | 'codex' | 'opencode';
const supported = (cli: string): cli is Cli => cli === 'claude' || cli === 'codex' || cli === 'opencode';

/** The catalog as the wire carries it: a fresh copy, `heavy` only when set. */
function catalog(cli: Cli) {
  return modelCatalogForCli(cli).map((option) => ({
    value: option.value,
    label: option.label,
    efforts: option.efforts.map((effort) => ({
      value: effort.value, label: effort.label, ...(effort.heavy ? { heavy: true } : {}),
    })),
  }));
}

/**
 * A room agent's picker, complete from its row — or nothing for a harness
 * without a picker, which the read then says in its own words.
 */
export function knownAgentRuntime(agent: Pick<WorkspaceAgentRow, 'cli' | 'model' | 'effort'>): WorkspaceAgentRuntimeAnswer | null {
  if (!supported(agent.cli)) return null;
  return { cli: agent.cli, model: agent.model ?? '', effort: agent.effort ?? '', models: catalog(agent.cli) };
}

/**
 * The private runtimes' choices: every model of every harness the workplace
 * can reach, in the server's own order (Codex first). A harness nobody here
 * runs is left out, as the server leaves it out; the one exception is the
 * current pair's own model, which stays so the reader can see what is set.
 * Before anything is connected nothing is left out and nothing is pickable:
 * every model is shown, read-only until a sign-in, as the server shows it
 * (note #747).
 */
export function knownPrivateRuntime(
  orgId: string,
  state: Pick<WorkspaceStateAnswer, 'org' | 'agents'> | null,
  settings: WorkspaceRecapSettingsAnswer['settings'] = null,
): WorkspaceRecapSettingsAnswer {
  const reach = new Set<string>([
    ...(state?.org?.seatProviders ?? []),
    ...(state?.agents ?? []).map((agent) => agent.cli),
  ]);
  const models: WorkspaceRecapModel[] = (['codex', 'claude'] as const)
    .flatMap((cli) => catalog(cli).map((model) => ({ cli, ...model, available: reach.has(cli) })))
    .filter((model) => model.available || !reach.size || (model.cli === settings?.cli && model.value === settings.model));
  return { orgId, settings, models };
}
