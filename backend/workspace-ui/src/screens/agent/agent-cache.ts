/**
 * What this tab last read about an agent, for the two agent screens and the
 * model & effort pickers (note #630) — in the owner's words: "Agent details
 * page data should be cached and refetched silently. Also model and effort
 * picker page should be cached".
 *
 * Both screens are routes and both pickers are leaves that mount fresh on
 * every open, so each visit used to draw "Checking…" and "Loading choices…"
 * over facts the reader had just seen, and then the machine row and the
 * proposals card popped in a second later. They open on the held copy now and
 * read underneath it, the rule the note, mail, people and Drive caches
 * already keep. A failed refresh leaves the held copy standing.
 *
 * Keys:
 *  - a room agent by its id, which is all its reads are addressed by;
 *  - the Workspace Agent by WORKPLACE, since it is one per workplace and
 *    reader, and its reads are addressed by the workplace alone;
 *  - the private runtimes (the briefing's and the Workspace Agent's) by
 *    workplace AND which of the two, so a pick for one never shows as the
 *    other's.
 *
 * Per TAB, and emptied by `SessionProvider` on sign-out and by the test setup
 * between tests.
 */

import type {
  WorkspaceAgentProposalsAnswer,
  WorkspaceAgentRuntimeAnswer,
  WorkspaceAgentVersionAnswer,
} from '../../../../src/shared/workspace-api.js';
import type { WorkspaceAgentDetailsAnswer, WorkspaceRecapSettingsAnswer } from '../../../../src/shared/workspace-recap.js';
import { rememberRuntime } from './runtime-memory.js';

/** A room agent's screen: the three reads it takes on open. Each is kept
 *  only once it has actually answered — "never read" stays absent. */
export interface HeldAgent {
  version?: WorkspaceAgentVersionAnswer;
  /** Boxed as the screen boxes it: a read that found NO reply is an answer. */
  reply?: { value: { text: string; at?: string } | null };
  proposals?: WorkspaceAgentProposalsAnswer;
}

/** The Workspace Agent's screen: its details read and its version card. */
export interface HeldWorkspaceAgent {
  details?: WorkspaceAgentDetailsAnswer;
  version?: WorkspaceAgentVersionAnswer;
}

export type PrivateRuntime = 'recap' | 'agent';

const agents = new Map<string, HeldAgent>();
const runtimes = new Map<string, WorkspaceAgentRuntimeAnswer>();
const workspaceAgents = new Map<string, HeldWorkspaceAgent>();
const privateRuntimes = new Map<string, WorkspaceRecapSettingsAnswer>();

export function heldAgent(id: string): HeldAgent {
  return agents.get(id) ?? {};
}

export function holdAgent(id: string, part: HeldAgent): void {
  agents.set(id, { ...agents.get(id), ...part });
}

export function heldRuntime(id: string): WorkspaceAgentRuntimeAnswer | null {
  return runtimes.get(id) ?? null;
}

/** Also moves the pair on the held version card, so the agent's screen does
 *  not reopen on the old model after a pick made from its chat header. */
export function holdRuntime(id: string, answer: WorkspaceAgentRuntimeAnswer): void {
  runtimes.set(id, answer);
  const version = agents.get(id)?.version;
  if (version) holdAgent(id, { version: { ...version, model: answer.model, effort: answer.effort } });
}

export function heldWorkspaceAgent(orgId: string): HeldWorkspaceAgent {
  return workspaceAgents.get(orgId) ?? {};
}

export function holdWorkspaceAgent(orgId: string, part: HeldWorkspaceAgent): void {
  workspaceAgents.set(orgId, { ...workspaceAgents.get(orgId), ...part });
}

export function heldPrivateRuntime(orgId: string, target: PrivateRuntime): WorkspaceRecapSettingsAnswer | null {
  return privateRuntimes.get(`${target}:${orgId}`) ?? null;
}

export function holdPrivateRuntime(orgId: string, target: PrivateRuntime, answer: WorkspaceRecapSettingsAnswer): void {
  privateRuntimes.set(`${target}:${orgId}`, answer);
  // And the pair alone, past this page's life (note #735).
  rememberRuntime(orgId, target, answer.settings);
}

/** One room agent, gone: it was deleted. */
export function forgetAgent(id: string): void {
  agents.delete(id);
  runtimes.delete(id);
}

/** Every agent, gone. Sign-out, and every test. */
export function forgetAgents(): void {
  agents.clear();
  runtimes.clear();
  workspaceAgents.clear();
  privateRuntimes.clear();
}
