import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * The forty pre-generated agent avatars, one per name in
 * TELEGRAM_AGENT_NAME_POOL. See backend/assets/agent-avatars/README.md for how
 * they are made and scripts/agent-avatar-prompts.mjs for why they look the way
 * they do.
 *
 * The directory sits beside dist/ in a release, and beside src/ in the repo, so
 * one relative path resolves in both. It has to be added to the release
 * artifact by hand (.github/workflows/backend-deploy.yml) — nothing here copies
 * it, and a missing directory degrades silently to the grey default.
 */
const AVATAR_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../assets/agent-avatars',
);

/**
 * The file for an agent name, or undefined when there is nothing to upload:
 * a renamed agent, a numbered fallback name past the pool ("Kai 41" reuses
 * Kai's dog), or a release that shipped without the assets. Every caller treats
 * that as "no avatar", never as an error.
 */
export function readTelegramAgentAvatar(agentName: string): Buffer | undefined {
  const slug = telegramAgentAvatarSlug(agentName);
  if (!slug) {
    return undefined;
  }

  try {
    return fs.readFileSync(path.join(AVATAR_DIRECTORY, `${slug}.jpg`));
  } catch {
    return undefined;
  }
}

/**
 * The slug whose avatar file actually exists for this name, or undefined.
 * The Workspace Mini App uses this to hand out an image URL only when there
 * is an image behind it — a renamed agent has no dog, and a broken <img> is
 * worse than the generic icon it would replace.
 */
export function telegramAgentAvatarSlug(agentName: string): string | undefined {
  const slug = agentName
    .trim()
    .toLowerCase()
    // Past forty agents the pool wraps and names come back numbered; those
    // deliberately reuse the base name's dog.
    .replace(/\s+\d+$/, '');
  if (!/^[a-z]+$/.test(slug)) {
    return undefined;
  }
  return fs.existsSync(path.join(AVATAR_DIRECTORY, `${slug}.jpg`)) ? slug : undefined;
}

/**
 * The Workspace Agent's own face (note #434): one reserved file,
 * `workspace-agent.jpg`, beside the pool. A room agent can never wear it —
 * the slug carries a hyphen, and `telegramAgentAvatarSlug` admits letters
 * only, so no name anyone types or the pool hands out resolves here. That
 * regex is the whole reservation; keep it.
 *
 * Absent from the release it degrades exactly as a pool dog does: the plate
 * keeps its bot glyph.
 */
export const WORKSPACE_AGENT_AVATAR_SLUG = 'workspace-agent';

/**
 * The dogs a newly created workplace may give its Workspace Agent (note
 * #582). The selection is deliberately narrower than the room-agent litter:
 * shepherds and sheepdogs (Alex, Felix, Oscar, Otis, Willow), or visibly big,
 * strong working dogs (Stella, Gus, Marcus, Greta and the reserved Bernese).
 *
 * Store the chosen slug on the workplace. Randomness is only for birth; a
 * face that changes on each read is decoration rather than identity.
 */
export const WORKSPACE_AGENT_AVATAR_SLUGS = [
  'alex',
  'felix',
  'oscar',
  'otis',
  'willow',
  'stella',
  'gus',
  'marcus',
  'greta',
  WORKSPACE_AGENT_AVATAR_SLUG,
] as const;

export type WorkspaceAgentAvatarSlug = (typeof WORKSPACE_AGENT_AVATAR_SLUGS)[number];

export function isWorkspaceAgentAvatarSlug(value: string | undefined): value is WorkspaceAgentAvatarSlug {
  return WORKSPACE_AGENT_AVATAR_SLUGS.some((slug) => slug === value);
}

/** Choose once when the workplace record is born. */
export function pickWorkspaceAgentAvatarSlug(
  pickIndex: (maxExclusive: number) => number = (maxExclusive) => randomInt(maxExclusive),
): WorkspaceAgentAvatarSlug {
  return WORKSPACE_AGENT_AVATAR_SLUGS[pickIndex(WORKSPACE_AGENT_AVATAR_SLUGS.length)]!;
}

export function readWorkspaceAgentAvatar(): Buffer | undefined {
  try {
    return fs.readFileSync(path.join(AVATAR_DIRECTORY, `${WORKSPACE_AGENT_AVATAR_SLUG}.jpg`));
  } catch {
    return undefined;
  }
}

/**
 * The workplace's selected slug when its file is really there. An older
 * workplace has no saved selection and keeps the original reserved Bernese;
 * an unrecognised stored value falls back the same way instead of exposing an
 * arbitrary public avatar through a corrupt record.
 */
export function workspaceAgentAvatarSlug(selected?: string): WorkspaceAgentAvatarSlug | undefined {
  const slug = isWorkspaceAgentAvatarSlug(selected) ? selected : WORKSPACE_AGENT_AVATAR_SLUG;
  return fs.existsSync(path.join(AVATAR_DIRECTORY, `${slug}.jpg`))
    ? slug
    : undefined;
}
