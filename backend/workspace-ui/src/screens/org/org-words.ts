import type { WorkspaceOrganizationRow } from '../../../../src/shared/workspace-api.js';

/**
 * Whether a workplace can have a team, and so whether the Workspace shows
 * its people, their roles and what their agents are doing (Adam, 28 Oct
 * 2026: "let's bring back the team UI"). Note #205 hid all of it whenever
 * inviting was switched off, because a workplace was then one person's.
 * Since then invites are open again in workplaces the platform marks (note
 * #805) and in every private copy (note #808), so the rule is the team
 * itself: invites open, OR more than one person already in it. A workplace
 * of one that nobody can join stays as #205 left it — a People view there
 * could only ever say "just you".
 */
export function workplaceHasTeam(
  organization: { members: number; invitesClosed?: boolean } | null | undefined,
  invitesClosed = organization?.invitesClosed,
): boolean {
  if (!organization) return false;
  return !invitesClosed || organization.members > 1;
}

/**
 * The quiet line under a workplace's name: how many people, then how many
 * agents. `people: false` leaves the head count out — in a workplace of one
 * that nobody can join (`workplaceHasTeam`), "just you" says nothing but
 * that a team feature is missing.
 */
export function organizationFacts(
  organization: Pick<WorkspaceOrganizationRow, 'members' | 'agents'>,
  { people = true }: { people?: boolean } = {},
): string {
  const parts: string[] = [];
  if (people && organization.members > 0) parts.push(organization.members === 1 ? 'just you' : `${organization.members} people`);
  if (typeof organization.agents === 'number') {
    parts.push(organization.agents === 0 ? 'no agents yet' : organization.agents === 1 ? '1 agent' : `${organization.agents} agents`);
  }
  return parts.join(' · ');
}
