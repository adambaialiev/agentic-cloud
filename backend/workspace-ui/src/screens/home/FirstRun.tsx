/**
 * The first run, as the Chief of Staff's chat draws it (note #726, Rosa's
 * design): the pane's empty state while nothing is said (note #967), the
 * sign-in card under its ask, and the team's progress card while the
 * agents it brought in are being built.
 *
 * The words of the greeting and the ask are rows the server wrote (kinds
 * `greeting` and `signin-ask`, `shared/first-run.ts`); what stands here is
 * only what has no row: taps, a door to the sign-in pages, and live state.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CHIEF_OF_STAFF_EMPTY, FIRST_RUN_SIGNIN_WHERE } from '../../../../src/shared/first-run.js';
import { toFor } from '../../routes.js';
import { arrivingAgents, arrivingLine } from '../../onboarding/arriving.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { signInSlug } from '../../ui/seat-words.js';
import type { HomeAgent } from '../../workspace/live.js';

/**
 * The conversation before anything is said in it (note #967; Adam,
 * 2026-11-03: "no starters as real buttons … it should be enough just to
 * understand what is it"): its face, small, over one line that says what the
 * Chief of Staff is, in the middle of the pane. Not a message — no day, no
 * time, no bubble — and no taps: the person types their own first ask.
 */
export function ChiefOfStaffEmpty({ avatarUrl }: { avatarUrl?: string }) {
  return (
    <div className="chatempty cosempty" id="chiefOfStaffEmpty">
      <span className="cosemptyface" aria-hidden="true"><AgentFace agent={{ avatarUrl }} /></span>
      <p className="cosemptyline">{CHIEF_OF_STAFF_EMPTY}</p>
    </div>
  );
}

/**
 * Where the sign-in happens, as the location state the provider's page
 * reads: back to Home when it lands, with no banner — the chat says it.
 */
export const AFTER_SIGN_IN_HOME = { afterSignIn: '/' } as const;

/** The picker card under the ask: the two existing rows, each opening its own sign-in page, and the line under them. */
export function FirstRunSignIn({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  return (
    <div className="firstrunsignin" id="firstRunSignIn">
      <div className="card">
        {[['claude', 'Claude', 'Claude Pro or Max subscription'], ['codex', 'Codex', 'ChatGPT Plus or Pro subscription']].map(([choice, name, detail]) => (
          <button className="crow open" type="button" key={choice} data-provider={choice}
            onClick={() => navigate(toFor({ kind: 'seatSignInProvider', id: signInSlug(choice!), orgId })!, { state: AFTER_SIGN_IN_HOME })}>
            <TypeIcon glyph="card" />
            <div className="main"><div className="name plain">{name}</div><div className="cline"><span className="ctext">{detail}</span></div></div>
            <Icon name="chev" size={17} className="icon chev" />
          </button>
        ))}
      </div>
      <div className="formhint" id="firstRunSignInWhere">{FIRST_RUN_SIGNIN_WHERE}</div>
    </div>
  );
}

/**
 * The team arriving, in the chat: each agent's name and the same words the
 * arriving screen used to say — "Starting…", "Computer being built…",
 * "Ready". Drawn at the foot of the log while any of them is still being
 * built, and gone once all are ready: the agents' own rows in the roster
 * take over.
 *
 * One card under one heading. It was a card per ROOM under the room's name
 * until rooms left the product (note #843); the agents it has shown arriving
 * are remembered here, so one that turns Ready keeps its row beside the ones
 * still on their way.
 */
export function TeamArrivingCard({ agents }: { agents: HomeAgent[] }) {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const members = arrivingAgents(agents, shown);
  // Remembered as they are drawn — React's "adjust state while rendering":
  // the next render already holds them, so it settles at once.
  const fresh = members.filter((agent) => !shown.has(agent.id));
  if (fresh.length) setShown(new Set([...shown, ...fresh.map((agent) => agent.id)]));
  if (!members.length) return null;
  return (
    <div className="firstrunteam" id="firstRunTeam" aria-live="polite">
      <section className="arrivingroom">
        <h2 className="arrivinghead">Arriving</h2>
        <div className="card">
          {members.map((agent) => (
            <div className={`crow arriving-${agent.status}`} data-agent={agent.id} key={agent.id}>
              <AgentFace agent={agent} />
              <div className="main">
                <div className="name plain">{agent.name}</div>
                <div className="cline"><span className="ctext">{arrivingLine(agent)}</span></div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
