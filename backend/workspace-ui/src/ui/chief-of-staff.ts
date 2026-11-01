/**
 * What a person calls the Workspace Agent (note #715, the owner): the Chief
 * of Staff. One per member, the agent that runs their fleet.
 *
 * Only the WORDS a person reads changed. The agent is still addressed as
 * "Workspace Agent" by every other agent and by the platform's own rows —
 * `agentbuilt agent message "Workspace Agent" …`, the [Platform] block's
 * Sender line the room agents' rule keys on (note #555), a stopped turn's
 * stored sentence — so a row that names it by that name is put into the
 * person's words where it is drawn (`personName`), never rewritten where it
 * is stored.
 */

export const CHIEF_OF_STAFF = 'Chief of Staff';

/** The name the platform and the agents use. */
const AGENT_FACING = 'workspace agent';

/** A sender's name as a person reads it: the Chief of Staff for the
 *  Workspace Agent, every other name exactly as it came. */
export function personName(name: string): string {
  return name.trim().toLowerCase() === AGENT_FACING ? CHIEF_OF_STAFF : name;
}
