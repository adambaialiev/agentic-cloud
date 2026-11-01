/**
 * The model and effort each private runtime — the Chief of Staff's and the
 * recap's — was last seen on, kept across visits (note #735).
 *
 * The tab's own copies (`recap-chat-cache.ts`, `agent-cache.ts`) die with
 * the page, and a phone opens the Workspace afresh far more often than it
 * comes Back to it: from the home screen, after a reload, after Safari has
 * dropped a page it was not showing. Every such open drew the header's line
 * as "Model & effort" until the settings read answered — a placeholder over
 * a choice the reader made and has seen there a hundred times. So the PAIR
 * is kept in the browser's own storage and drawn in the first frame; the
 * read replaces it quietly, and a read that says nothing is chosen drops it,
 * because only then is the placeholder the truth.
 *
 * Just the pair, never the catalog: three short words per workplace, so
 * nothing here ever needs evicting for size, and the choices themselves come
 * from the catalog the picker already knows (`known-runtime.ts`). Forgotten
 * on sign-out, because the next reader of this browser is someone else.
 */

import type { WorkspaceRecapSettings } from '../../../../src/shared/workspace-recap.js';
import type { PrivateRuntime } from './agent-cache.js';

const KEY = 'agentbuilt.privateRuntimes';

type Kept = Record<string, WorkspaceRecapSettings>;

const shelf = (): Storage | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

const isPair = (value: unknown): value is WorkspaceRecapSettings => {
  const pair = value as Partial<WorkspaceRecapSettings> | null;
  return Boolean(pair) && (pair!.cli === 'claude' || pair!.cli === 'codex')
    && typeof pair!.model === 'string' && Boolean(pair!.model) && typeof pair!.effort === 'string' && Boolean(pair!.effort);
};

function read(): Kept {
  try {
    const kept: unknown = JSON.parse(shelf()?.getItem(KEY) ?? '{}');
    return kept && typeof kept === 'object' ? kept as Kept : {};
  } catch { return {}; }
}

function write(kept: Kept): void {
  try {
    if (Object.keys(kept).length) shelf()?.setItem(KEY, JSON.stringify(kept));
    else shelf()?.removeItem(KEY);
  } catch { /* storage full or refused: the read still answers, a little later */ }
}

/** What this runtime was last seen on in this browser, or null when it never was. */
export function recalledRuntime(orgId: string, target: PrivateRuntime): WorkspaceRecapSettings | null {
  const pair = read()[`${target}:${orgId}`];
  return isPair(pair) ? pair : null;
}

/** Keep what a read or a pick just said — or, when it said nothing is chosen, forget the old pair. */
export function rememberRuntime(orgId: string, target: PrivateRuntime, settings: WorkspaceRecapSettings | null | undefined): void {
  const kept = read();
  const key = `${target}:${orgId}`;
  if (isPair(settings)) kept[key] = { cli: settings.cli, model: settings.model, effort: settings.effort };
  else delete kept[key];
  write(kept);
}

/** One workplace's pairs, gone: the reader lost it. */
export function forgetRuntimesOf(orgId: string): void {
  const kept = read();
  for (const key of Object.keys(kept)) if (key.endsWith(`:${orgId}`)) delete kept[key];
  write(kept);
}

/** Every pair, gone. Sign-out, and every test. */
export function forgetRememberedRuntimes(): void {
  write({});
}
