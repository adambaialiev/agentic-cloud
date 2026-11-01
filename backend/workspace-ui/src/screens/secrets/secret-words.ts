import type { WorkspaceOrgSummary, WorkspaceSecretRow } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { personName } from '../../ui/chief-of-staff.js';

/** Home collapses the list into one door at this many. */
export const SECRETS_LIST_AT = 6;

export function secretQuery(secret: Pick<WorkspaceSecretRow, 'scope' | 'agentId'>): string {
  return secret.scope === 'agent' ? `?agent=${encodeURIComponent(secret.agentId ?? '')}` : '';
}

export function secretKeyOf(secret: Pick<WorkspaceSecretRow, 'scope' | 'agentId' | 'name'>): string {
  return `${secret.scope === 'agent' ? secret.agentId ?? '' : ''}/${secret.name}`;
}

export function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function canAddSharedSecrets(org: WorkspaceOrgSummary | null): boolean {
  return !org || org.role === 'admin';
}

/** Whose agents a shared row reaches, in words (note #655). */
export function audienceWords(secret: Pick<WorkspaceSecretRow, 'scope' | 'audience' | 'agentName'>): string {
  if (secret.scope === 'agent') return `Private to ${secret.agentName ? personName(secret.agentName) : 'one agent'}`;
  return secret.audience === 'everyone' ? 'Every agent in the workplace' : 'Admins’ agents only';
}

/** "Reaches Otis and Leo" / "Reaches no agent yet". */
export function reachesWords(secret: Pick<WorkspaceSecretRow, 'scope' | 'reaches' | 'agentName'>): string {
  if (secret.scope === 'agent') return `Reaches ${secret.agentName ? personName(secret.agentName) : 'that agent'} only`;
  const names = secret.reaches ?? [];
  return names.length ? `Reaches ${joinNames(names)}` : 'Reaches no agent yet';
}

// "Every room" / "Only in Platform" (note #783) said which rooms a shared
// key was limited to, until rooms left the product (note #843): a key
// reaches the whole workplace, or its admins' agents, or one agent.

export function canManageSecret(secret: Pick<WorkspaceSecretRow, 'scope'>, org: WorkspaceOrgSummary | null): boolean {
  return secret.scope === 'agent' || canAddSharedSecrets(org);
}

export function secretsOf(state: { secrets?: unknown[] | null } | null): WorkspaceSecretRow[] | null {
  return state && Array.isArray(state.secrets) ? (state.secrets as WorkspaceSecretRow[]) : null;
}

/** A secret's own address: workplace-scoped (note #783), no room. */
export function secretTo(secret: Pick<WorkspaceSecretRow, 'name' | 'scope' | 'agentId'>, orgId: string | undefined): string {
  return toFor({ kind: 'secret', id: secret.name, orgId, ...(secret.scope === 'agent' ? { agentId: secret.agentId } : {}) })!;
}
