/**
 * The Workspace Agent's conversation as this tab last read it, per workplace
 * (note #615) — and the runtime line its header wears.
 *
 * The conversation is a route, so every visit rebuilt it from nothing: a
 * reader who tapped a note link in a reply and came Back found an empty pane,
 * then the whole transcript arriving and the pane jumping to the newest
 * message, with their line gone. The room chat has never done that — its
 * rows live one level up (`transcript-context.ts`) — and this is the same
 * idea for the one conversation that is not a room agent's. A visit paints
 * the held answer in its first frame and reads underneath it.
 *
 * Per TAB, and emptied by `SessionProvider` on sign-out and by the test
 * setup between tests; a reader who loses the workplace has the copy dropped
 * by the screen.
 */

import type { WorkspaceRecapSettingsAnswer } from '../../../../src/shared/workspace-recap.js';
import type { RecapChatAnswer } from '../../../../src/shared/workspace-recap-chat.js';
import { forgetRuntimesOf, rememberRuntime } from '../agent/runtime-memory.js';

const answers = new Map<string, RecapChatAnswer>();
const settings = new Map<string, WorkspaceRecapSettingsAnswer>();

export function heldRecapChat(orgId: string): RecapChatAnswer | null {
  return answers.get(orgId) ?? null;
}

export function holdRecapChat(orgId: string, answer: RecapChatAnswer): void {
  answers.set(orgId, answer);
}

export function heldRecapChatSettings(orgId: string): WorkspaceRecapSettingsAnswer | null {
  return settings.get(orgId) ?? null;
}

export function holdRecapChatSettings(orgId: string, answer: WorkspaceRecapSettingsAnswer): void {
  settings.set(orgId, answer);
  // The header's pair outlives the tab (note #735): the next fresh open draws it at once.
  rememberRuntime(orgId, 'agent', answer.settings);
}

/** One workplace's copy, gone: the reader lost it. */
export function forgetRecapChatOf(orgId: string): void {
  answers.delete(orgId);
  settings.delete(orgId);
  forgetRuntimesOf(orgId);
}

/** Every workplace, gone. Sign-out, and every test. */
export function forgetRecapChats(): void {
  answers.clear();
  settings.clear();
}
