import { modelCatalogForCli } from '../agent/harness-models.js';
import type { AgentRecord } from '../types/user.js';
import type { WorkspaceRecapModel, WorkspaceRecapSettings } from '../shared/workspace-recap.js';

/** The agent-work catalog, Sonnet included since 2026-09-29 — it no longer
 *  has to be added here for the recap's own Sonnet default. */
export function recapModelCatalog(): WorkspaceRecapModel[] {
  return (['codex', 'claude'] as const).flatMap((cli) => modelCatalogForCli(cli)
    .map((model) => ({ cli, ...model, available: true, efforts: [...model.efforts] })));
}
export function validRecapSettings(value: unknown): value is WorkspaceRecapSettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as WorkspaceRecapSettings;
  return recapModelCatalog().some((m) => m.cli === v.cli && m.value === v.model && m.efforts.some((e) => e.value === v.effort));
}
export function recapSettingsKey(settings?: WorkspaceRecapSettings | null): string {
  return settings ? `${settings.cli}/${settings.model}/${settings.effort}` : 'automatic';
}
export function recapCandidates(agents: AgentRecord[]): AgentRecord[] {
  return agents.filter((a) => (a.cli === 'codex' || a.cli === 'claude') && a.connectedAt && a.serverId)
    .sort((a, b) => (b.recap?.at ?? '').localeCompare(a.recap?.at ?? '') || a.id.localeCompare(b.id));
}
/** The harnesses this person can run a private runtime on: their own
 *  subscriptions in this workplace and their connected agents' harnesses. */
function recapReach(agents: AgentRecord[], providers: string[]): Set<string> {
  return new Set([...recapCandidates(agents).map((a) => a.cli), ...providers]);
}
/**
 * What the Chief of Staff thinks with before anyone has chosen: Claude Opus
 * at high (the owner, 2026-10-12: "By default model should be opus with
 * 'high' effort", "even if subscription is not yet connected" — note #747),
 * and GPT-6.1 Sol at high only when a ChatGPT plan is all this person can
 * reach (the owner, 2026-10-11). It was Sonnet on a Claude plan, and nothing
 * at all before a sign-in, which left the header blank and the picker empty.
 */
export function resolveRecapSettings(agents: AgentRecord[], stored?: WorkspaceRecapSettings, providers: string[] = []): WorkspaceRecapSettings {
  if (validRecapSettings(stored)) return stored;
  const reach = recapReach(agents, providers);
  return reach.has('codex') && !reach.has('claude')
    ? { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' }
    : { cli: 'claude', model: 'opus', effort: 'high' };
}
/**
 * The picker's models: the harnesses this person reaches, plus the current
 * pick's own model so the reader can see what is set. Before anything is
 * connected that is the whole catalog, none of it pickable yet — the page
 * shows what there is and the default, and is read-only until a sign-in
 * (the owner, 2026-10-12, note #747).
 */
export function availableRecapModels(agents: AgentRecord[], settings: WorkspaceRecapSettings | null, seats: string[] = []): WorkspaceRecapModel[] {
  const reach = recapReach(agents, seats);
  return recapModelCatalog().map((m) => ({ ...m, available: reach.has(m.cli) }))
    .filter((m) => m.available || !reach.size || (m.cli === settings?.cli && m.value === settings.model));
}
