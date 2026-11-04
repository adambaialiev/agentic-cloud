/**
 * The fleet, one tap from the middle of a conversation (notes #581, #713):
 * one button by the message box reaches every agent from every
 * conversation.
 *
 * A stack of agent faces stands to the left of the box, where the reader's
 * thumb already is, and it opens every agent this conversation can be swapped
 * for — the whole workplace's, in one list. "Who else could answer this" is
 * one question with one list.
 *
 * A launcher's layout (note #713, modelled on the macOS Applications
 * launcher): a search field and the agents under it. Each agent is the card
 * the fleet draws everywhere (`AgentRow`, the owner, note #721): the face in
 * its context ring, the model and the machine, the state line, what it is
 * doing now and its latest-work recap. Over them, when something waits on
 * the reader, their unread replies and every decision waiting on them (the
 * owner's follow-up to #721). Under them, the way to make another agent and
 * to give the finished ones a fresh chat (note #707), and the teammates'
 * agents. The sheet keeps the Workspace's flat, light surfaces.
 *
 * It had ROOMS too, until rooms left the product (note #843, the owner:
 * "Let's remove rooms"): a tab row over the cards — All, then every room —
 * where a room's tab was the room's whole view (its messages and decisions,
 * its agents and its notes), a decision dot on a room's tab, and the faces
 * on the button promising "your agents and rooms". All was the view that
 * stayed: one flat list of every agent in the workplace. The notes are the
 * workplace's, in the Workplace window over Home (`HomePanels`).
 *
 * The agent being READ is not in it (the owner, 2026-09-20), and that is one
 * rule rather than two: the sheet lists exactly who the stack on the button
 * promised. A face for the conversation already open leads nowhere.
 *
 * On a phone it rises from the bottom edge the button is on and stops short
 * of the top, so the conversation it came from is still there above it —
 * this is a switch made WHILE reading something, not a page the reader
 * navigated to. At a desk it stands near the top of the screen like the
 * launcher (and Spotlight) does, with the conversation all round it, and is
 * as tall as its cards. It takes no address
 * (knowledge page "miniapp-navigation"), claims Back like every other
 * transient leaf, and leaves the chat mounted with its transcript and its
 * unsent draft intact.
 *
 * Everything else a row in it opens — a proposal, an agent's own screen —
 * opens INSIDE it as a page (note #722; `AgentSwitch` below), with a Back of
 * the sheet's own.
 *
 * Three ways out, all the same answer: Close, the dim around the sheet, and
 * Back (or Escape, at a desk — which first empties the search when there is
 * one; over a page, both close the page instead). Each plays the sheet's way
 * out before it goes, as opening plays its way in. A fourth closes it too —
 * walking through one of the cards into a conversation, which takes the
 * whole screen with it: `ChatRoute` keys the chat by agent id
 * (App.tsx), so a switch rebuilds it and this sheet goes with it. That is also
 * what keeps each conversation's unsent words its own — the composer is
 * rebuilt and reads the draft remembered for the agent being opened, not the
 * one being left.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, TouchEvent as ReactTouchEvent, UIEvent as ReactUIEvent } from 'react';
import type { WorkspaceDecisionsAnswer } from '../../../../src/shared/workspace-api.js';
import { parseWorkspaceRoute, workspaceRoutePath, type WorkspaceRouteKind } from '../../../../src/shared/workspace-routes.js';
import { createPath, useLocation, useNavigate, type Path } from 'react-router-dom';
import { useBackClaim } from '../../chrome/useBack.js';
import { WindowNavigation } from '../../chrome/WindowNavigation.js';
import { pageKey, pathOf, type WindowMoves } from '../../chrome/window-pages.js';
import { WindowPageView } from '../../chrome/WindowPageView.js';
import { useSession } from '../../session/useSession.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Icon, Svg } from '../../ui/icons.js';
import { RoomFaces } from '../../ui/RoomFaces.js';
import { Sheet } from '../../ui/Sheet.js';
import { useNow } from '../../ui/time.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { agentClockMoves } from '../home/agent-words.js';
import { agentDoor } from '../home/agent-door.js';
import { AgentRow, FreshChatsDoor, NewAgentDoor, PendingAgentRow } from '../home/Agents.js';
import { KnowledgeProposalRow, ProposalRow } from '../home/Decisions.js';
import { TeamAgents } from '../home/TeamAgents.js';
import { UnreadMessages } from '../home/UnreadMessages.js';
import { stillWaiting, useDecided } from '../../workspace/decided.js';
import { heldDecisions, holdDecisions } from './decisions-memory.js';
import { readerNeedsAttention, type HomeAgent } from '../../workspace/live.js';
import { useFleet } from '../../workspace/useFleet.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { overviewArrival } from '../home/home-sheet.js';
import {
  currentPickerEntry, pickerEntryOf, pushPickerEntry, writePickerEntry,
  type PickerEntry, type PickerPage,
} from './picker-entry.js';
import { agentSwitchHeld, agentSwitchShown, agentSwitchStack } from './agent-switch.js';

/** Anything but a touch-first screen. Only there does the search take the
 *  focus on open — on a phone that would bring the keyboard up over the
 *  cards. Asked as "not coarse" rather than "fine", so a desk whose browser
 *  reports no pointer at all still counts as one. */
function atDesk(): boolean {
  const media = window.matchMedia;
  return typeof media === 'function' && !media('(pointer: coarse)').matches;
}

/**
 * Every decision waiting on the reader (note #721), over the cards. Read
 * when the sheet stands, and again when what the state knows about the
 * queue moves. A read that fails shows nothing rather than "nothing
 * waiting".
 *
 * The sheet opens on the list this tab last read (note #745) rather than on
 * nothing, and the read replaces it in place when it answers.
 *
 * It was "every ROOM's decisions" while the state read carried only the
 * viewed room's queue; since rooms left the product (note #843) it is the
 * workplace's one queue, read the same way.
 */
function useDecisionQueue(on: boolean): WorkspaceDecisionsAnswer | null {
  const { api } = useSession();
  const { state } = useWorkspace();
  const workplace = state?.org?.orgId ?? '';
  const [answer, setAnswer] = useState<WorkspaceDecisionsAnswer | null>(() => heldDecisions(workplace));
  // A decision taken in this tab moves it too (note #743).
  const decided = useDecided();
  const moved = [
    decided,
    (state?.prs ?? []).map((pr) => pr.id).join(','),
    (state?.knowledgeProposals ?? []).map((proposal) => proposal.id).join(','),
  ].join('|');
  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    void api.api<WorkspaceDecisionsAnswer>('api/decisions')
      .then((next) => {
        // Kept whether or not the sheet is still open: it is the freshest
        // copy there is, and the next opening draws it.
        holdDecisions(workplace, next);
        if (alive) setAnswer(next);
      })
      .catch(() => { /* the state's own queue still lights the button */ });
    return () => { alive = false; };
  }, [api, on, moved, workplace]);
  // And the read in hand — remembered or fresh — leaves out what was decided
  // here at once, rather than after the next one answers (`useDecided` draws
  // this again).
  if (!on || !answer) return null;
  return {
    ...answer,
    prs: stillWaiting('pr', answer.prs ?? []),
    knowledgeProposals: stillWaiting('knowledge', answer.knowledgeProposals ?? []),
  };
}

/** How many decisions the state's queue holds for this reader: the button's
 *  ring, before the sheet has read the queue for itself. */
function useDecisionsWaiting(): number {
  const { state } = useWorkspace();
  useDecided();
  const changes = stillWaiting('pr', state?.prs ?? []).filter((proposal) => proposal.canDecide !== false);
  const knowledge = stillWaiting('knowledge', state?.knowledgeProposals ?? []).filter((proposal) => proposal.canDecide !== false);
  return changes.length + knowledge.length;
}

/** How far down the list may sit and still count as its top: a rubber-band
 *  bounce, a pixel of rounding. */
const LIST_TOP = 8;

/**
 * The cards in an order that moves only when nobody is reading the middle
 * of it (note #775). Working agents lead, so the list re-sorts by itself as
 * turns start and end; a card that slid away under a finger would be the
 * card the tap opened instead of the one aimed at. So while the reader has a
 * finger on the list, or is scrolled down into it, every card keeps the place
 * it was drawn in (`agentSwitchHeld`), and the new order is drawn the moment
 * they let go at the top — where the working cards are, which is where a
 * change in who is working is looked for. Each card's own lines (its dot,
 * what it is doing) still move live; only the places hold.
 */
function useSteadyCards<T extends HomeAgent>(fresh: T[]) {
  const [hold, setHold] = useState<CardHold | null>(null);
  const cards = hold ? agentSwitchHeld(hold.ids, fresh) : fresh;
  const move = (change: Partial<Pick<CardHold, 'touching' | 'down'>>) => {
    const ids = cards.map((agent) => agent.id);
    setHold((was) => {
      const base = was ?? { ids, touching: false, down: false };
      const next = { ...base, ...change };
      if (!next.touching && !next.down) return null;
      return was === base && next.touching === base.touching && next.down === base.down ? was : next;
    });
  };
  const touch = (event: ReactTouchEvent<HTMLDivElement>) => move({ touching: event.touches.length > 0 });
  return {
    cards,
    listen: {
      onScroll: (event: ReactUIEvent<HTMLDivElement>) => move({ down: event.currentTarget.scrollTop > LIST_TOP }),
      onTouchStart: touch,
      onTouchEnd: touch,
      onTouchCancel: touch,
    },
  };
}

/** The places the cards are held in, and why (`useSteadyCards`). */
interface CardHold {
  ids: string[];
  touching: boolean;
  down: boolean;
}

function AgentSheet({ currentId, onClose, still, pages, moves, onPageBack }: {
  currentId?: string;
  onClose: () => void;
  still: boolean;
  /** The pages open over the sheet's own view, the top one last. */
  pages: PickerPage[];
  /** Where a move asked for inside the sheet goes (`AgentSwitch`). */
  moves: WindowMoves;
  /** Close the page on top. */
  onPageBack: () => void;
}) {
  const { agents, status } = useWorkspace();
  const { removed, departingRows, pendingCreates } = useFleet();
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const opened = useRef(location.pathname);
  const leave = useRef(onClose);
  const [leaving, setLeaving] = useState(false);
  const [query, setQuery] = useState('');
  const typed = useRef(query);
  useEffect(() => { typed.current = query; }, [query]);

  useEffect(() => { leave.current = onClose; });
  // Every way out the reader takes — Close, the dim, Back, Escape — plays the
  // exit first (note #713, the owner), through the shared shell (`Sheet`). A
  // second ask while it is already leaving is the same answer, not a second
  // exit.
  const dismiss = useCallback(() => setLeaving(true), []);
  // A PARTIAL leaf (`chrome/back-context`): Back dismisses it, but the
  // shared header must not come out over the chat's own — the sheet draws
  // its own Close, and the conversation above it is still being read.
  useBackClaim(dismiss, true, { covers: false });

  // An agent on its way out keeps its card until it has left (note #715),
  // even when a read that landed meanwhile no longer carries it.
  const leavingRows = [...departingRows.values()].filter((row) => !agents?.some((agent) => agent.id === row.id));
  const fleet = [...(agents ?? []), ...leavingRows].filter((agent) => !removed.has(agent.id));
  const others = agentSwitchStack(fleet, currentId);
  const searching = Boolean(query.trim());
  const { cards: shown, listen } = useSteadyCards(agentSwitchShown(others, query));
  const now = useNow(agentClockMoves(others));
  const paged = pages.length > 0;
  // A card is a door like every other row in here: the sheet decides where
  // it leads (a conversation leaves the sheet; an agent still setting up
  // opens as a page).
  const open = (agent: HomeAgent) => moves.to(pathOf(agentDoor(agent)), null, false, 0);
  // The page on top leaves its Back here, for Escape.
  const pageBack = useRef<(() => void) | null>(null);
  // What waits on the reader, over the cards — not over a search, which
  // asks for an agent by name and should find only that.
  const decisions = useDecisionQueue(true);
  const changes = searching ? [] : decisions?.prs ?? [];
  const knowledge = searching ? [] : decisions?.knowledgeProposals ?? [];
  const waiting = changes.length + knowledge.length > 0;
  const pending = searching ? [] : Array.from({ length: pendingCreates }, (_, index) => index);
  const empty = status === 'ready' && others.length === 0 && pending.length === 0 && !searching;

  // At a desk the search takes the focus, the launcher's own habit: the
  // reader can type a name the moment it opens. Elsewhere the card does, not
  // the first card in it — a sheet that opens with an agent under the focus
  // is one reflex Enter away from a switch nobody asked for (the same rule
  // `Scrim` keeps for its questions), and on a phone a focused field brings
  // up a keyboard over the very cards being chosen between. A sheet coming
  // back from a page has no search to take it.
  useEffect(() => {
    if (atDesk() && field.current && !still) field.current.focus();
    else card.current?.focus();
  }, [still]);
  // A page opened or closed: the card holds the focus, so Escape and Tab
  // start from the page now standing rather than from a row it hid.
  useEffect(() => {
    if (paged) card.current?.focus();
  }, [paged, pages.length]);
  // Escape is Back on a page — the page's own leaves first, then the page.
  // On the sheet's own view it first empties the search when there is one.
  const depth = useRef(pages.length);
  useEffect(() => { depth.current = pages.length; }, [pages.length]);
  const escape = useCallback(() => {
    if (depth.current) { pageBack.current?.(); return; }
    if (typed.current) { setQuery(''); return; }
    dismiss();
  }, [dismiss]);

  // The address moved, so the screen this sheet stands over is no longer the
  // one it opened on. Today every door out of it — a card — leaves the chat
  // route or re-keys it, and the sheet is unmounted by that; this is the
  // guard for the day one of them does not, because a sheet left standing
  // over the conversation it just opened is the worst way for that to be
  // noticed. No exit here: the conversation behind it has already changed,
  // and a sheet sliding away over a different one would be a second event.
  useEffect(() => {
    if (location.pathname !== opened.current) leave.current();
  }, [location.pathname]);

  const searchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Enter walks through the first card the search found — only once
    // something has been typed, so an Enter on an untouched sheet is still
    // nothing at all.
    if (event.key === 'Enter' && query.trim() && shown[0]) {
      event.preventDefault();
      open(shown[0]);
    }
  };

  return (
    <Sheet
      id="agentSwitchSheet"
      className={paged ? 'paged' : ''}
      labelledBy="agentSwitchTitle"
      leaving={leaving}
      still={still}
      onGone={() => leave.current()}
      onDim={dismiss}
      onEscape={escape}
      cardRef={card}
    >
      {/* The sheet's own view stays drawn under its pages, hidden, so Back
          finds it as it was left. Every door in it opens through the sheet
          (`WindowNavigation`). */}
      <div className="sheetlevel" hidden={paged}>
      <WindowNavigation level={0} moves={moves}>
        {/* The head: the search over the cards. The sheet's title is for a
            screen reader, where the cards say what this is to everyone
            else. */}
        <div className="agentsheethead">
          <h2 className="sr-only" id="agentSwitchTitle">Your agents</h2>
          <div className="filter agentsheetsearch">
            <Icon name="search" size={16} />
            <VoiceField onTranscript={setQuery}>
              <input
                ref={field}
                id="agentSwitchSearch"
                type="search"
                placeholder="Search agents"
                aria-label="Search agents"
                aria-controls="agentSwitchGrid"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={searchKey}
              />
            </VoiceField>
          </div>
          <button className="agentsheetclose" id="agentSwitchClose" type="button" aria-label="Close" onClick={dismiss}>
            <Svg name="x" size={18} />
          </button>
        </div>
        <div className="agentsheetlist" id="agentSwitchList" ref={body} {...listen}>
          {searching ? null : <UnreadMessages />}
          {waiting
            ? (
              <>
                <h2 className="homehead" id="agentSwitchDecisionsHead">Waiting for your decision</h2>
                <div className="card" id="agentSwitchDecisions">
                  {changes.map((pr) => <ProposalRow key={pr.id} pr={pr} />)}
                  {knowledge.map((proposal) => <KnowledgeProposalRow key={proposal.id} proposal={proposal} />)}
                </div>
                <h2 className="homehead" id="agentSwitchAgentsHead">Agents</h2>
              </>
            )
            : null}
          <div className="plates" id="agentSwitchGrid">
            {empty
              ? (
                <div className="agentemptycard" id="agentSwitchEmpty">
                  <EmptyState glyph="bot" tint="act" title="Start with an agent" body="Agents are teammates you can message with work. They share this workplace’s notes, code, knowledge and secrets, and can work on them together." />
                  <NewAgentDoor />
                </div>
              )
              : (
                <>
                  {shown.map((agent) => <AgentRow key={agent.id} agent={agent} now={now} />)}
                  {pending.map((index) => <PendingAgentRow key={index} />)}
                  {/* The way to make another agent (note #843): it stood on a
                      room's Agents shelf, after its cards, while there were
                      rooms. Not under a search, which asks for one by name. */}
                  {searching ? null : <NewAgentDoor />}
                </>
              )}
          </div>
          {searching && !shown.length
            ? <div className="empty" id="agentSwitchNone">{`Nobody called “${query.trim()}”.`}</div>
            : null}
          {searching ? null : <FreshChatsDoor agents={others} />}
          {searching ? null : <TeamAgents />}
        </div>
      </WindowNavigation>
      </div>
      {pages.map((page, index) => (
        <WindowPageView
          key={page.key}
          page={page}
          level={index + 1}
          top={index === pages.length - 1}
          moves={moves}
          onBack={onPageBack}
          onClose={dismiss}
          backRef={pageBack}
        />
      ))}
    </Sheet>
  );
}

/** What the entry under the sheet says about it (`picker-entry.ts`). */
function entryFor(pages: PickerPage[]): PickerEntry {
  return { standing: true, ...(pages.length ? { pages } : {}) };
}

/** The doors that LEAVE the sheet rather than open a page in it: a
 *  conversation. Switching to one is what the faces were always for, and
 *  a conversation is where this sheet itself lives. */
const LEAVES_SHEET: ReadonlySet<WorkspaceRouteKind> = new Set<WorkspaceRouteKind>(['chat', 'directMessage']);

/**
 * The button itself, for the composer's lead slot.
 *
 * Absent only in a personal workspace with nobody to switch TO: in a
 * workplace the way to make the first agent is behind it. The faces are
 * decorative: the label says in words what the stack says in pictures. It
 * wears the attention mark while something waits for the reader — an unread
 * reply from one of their agents, or a decision (`readerNeedsAttention`) —
 * which it wore for any ROOM with one until rooms left the product (note
 * #843).
 *
 * The sheet keeps its own pages (note #722, the owner: "rooms window has its
 * own internal navigation stack. If user traverse the content, it should be
 * rendered inside of the window"). What a row in it opens — a proposal, an
 * agent — opens INSIDE it, over the view it came from, and whatever that
 * page opens in turn opens over it; Back (the page's, the browser's, the
 * phone's, Escape) closes the page on top. Only a conversation leaves the
 * sheet. Every page is a browser entry of its own over the conversation's
 * (`picker-entry.ts`), so a reader who leaves from a page comes Back to it,
 * and a reload stands the sheet up again as it was.
 */
export function AgentSwitch({ currentId }: { currentId?: string }) {
  const { agents, notifications, state } = useWorkspace();
  const { removed } = useFleet();
  const navigate = useNavigate();
  const decisionsWaiting = useDecisionsWaiting();
  // What the entry asks the picker to open on, read once, at the mount.
  const location = useLocation();
  const arrival = pickerEntryOf(location.state);
  const [open, setOpen] = useState(() => arrival !== null);
  const fleet = (agents ?? []).filter((agent) => !removed.has(agent.id));
  const [pages, setPages] = useState<PickerPage[]>(() => arrival?.pages ?? []);
  // Coming back to a conversation the reader left from the sheet, or a
  // reload: the sheet stands again without its way in.
  const [returning, setReturning] = useState(() => arrival?.standing === true);
  // The newest of each, for the moves below, which outlive a render: two
  // pages opened in one tick must stack, not replace each other.
  const now = useRef({ pages, open });
  useEffect(() => { now.current = { pages, open }; });
  // The screen this button stands on. The sheet's entries — the one under
  // it, and every page it pushes over that — all have its address; an entry
  // with another one is a screen the reader walked to.
  const here = useRef(location.pathname);
  useEffect(() => { here.current = location.pathname; }, [location.pathname]);
  const onOurs = () => window.location.pathname === here.current && currentPickerEntry() !== null;

  // While the sheet is open, the entry under it says so — and again after
  // the router rewrites that entry (a REPLACE), which drops what it does not
  // know.
  useEffect(() => {
    if (!open) return;
    writePickerEntry(entryFor(now.current.pages));
  }, [open, location.key]);
  // Closed over pages: their entries are spent on the way out, and the
  // entry under them is cleared once the browser lands on it.
  const clearing = useRef(false);
  // The browser's (or the phone's) Back and Forward between the sheet's
  // own entries: the pages are what the entry landed on says they are.
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== here.current) return;
      if (clearing.current) {
        clearing.current = false;
        writePickerEntry(null);
        return;
      }
      const entry = currentPickerEntry();
      if (!entry) return;
      const next = entry.pages ?? [];
      now.current = { ...now.current, pages: next };
      setPages(next);
      // Forward onto a page after the sheet was put away stands it again.
      if (!now.current.open) { setReturning(true); setOpen(true); }
      writePickerEntry(entryFor(next));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Closing touches the history only while the browser still stands on one
  // of the sheet's entries: it is also closed BY walking out of it, when the
  // entry standing is the next screen's.
  const close = () => {
    const depth = now.current.pages.length;
    if (onOurs()) {
      if (depth) {
        clearing.current = true;
        window.history.go(-depth);
      } else writePickerEntry(null);
    }
    now.current = { ...now.current, pages: [], open: false };
    setPages([]);
    setOpen(false);
  };
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });

  const pushPage = (page: PickerPage) => {
    const next = [...now.current.pages, page];
    now.current = { ...now.current, pages: next };
    pushPickerEntry(entryFor(next));
    setPages(next);
  };
  const replaceTop = (page: PickerPage) => {
    const next = [...now.current.pages.slice(0, -1), page];
    now.current = { ...now.current, pages: next };
    writePickerEntry(entryFor(next));
    setPages(next);
  };
  /** Back to `level` (0: the sheet's own view), spending the entries over it. */
  const backTo = (level: number) => {
    const depth = now.current.pages.length - level;
    if (depth > 0) window.history.go(-depth);
  };
  const moving = useRef({ pushPage, replaceTop, backTo, navigate, pathname: location.pathname });
  useEffect(() => { moving.current = { pushPage, replaceTop, backTo, navigate, pathname: location.pathname }; });

  // Every move asked for inside the sheet — a row, a face, a link on a page,
  // a screen sending its reader on — comes here (`WindowNavigation`).
  const moves = useMemo<WindowMoves>(() => ({
    go: (delta) => window.history.go(delta),
    to: (path: Path, state: unknown, replace: boolean, level: number) => {
      const { pushPage: push, replaceTop: swap, backTo: back, navigate: leave, pathname } = moving.current;
      const address = createPath(path);
      const route = parseWorkspaceRoute(path.pathname, path.search);
      // Home: over Home, the sheet is put away; over a conversation, the
      // reader goes there, and the sheet with the conversation.
      if (path.pathname === '/' || route?.kind === 'recapChat') {
        if (pathname === '/') closeRef.current();
        else leave(address, { state, replace });
        return;
      }
      // The overview's old address — the agents, after a delete — is this
      // sheet's own view: back down to it. Its Workplace half is Home's
      // window; an old link to a room's notes is the notes screen (note #843).
      if (route?.kind === 'recapAgent') {
        const named = overviewArrival(new URLSearchParams(path.search));
        if (named.notes) {
          leave(workspaceRoutePath({ kind: 'notes', ...(route.orgId ? { orgId: route.orgId } : {}) })!, { state });
          return;
        }
        if (!named.agentSwitch) { leave(address, { state }); return; }
        back(0);
        return;
      }
      // A conversation, or an address the app does not know: the sheet's
      // pages stay in the history under it, for Back. The conversation the
      // sheet already stands over is reached by putting the sheet away.
      if (!route || LEAVES_SHEET.has(route.kind)) {
        if (path.pathname === pathname) closeRef.current();
        else leave(address, { state });
        return;
      }
      const page: PickerPage = { key: pageKey(), ...path, state: state ?? null };
      const pages = now.current.pages;
      // A page asked to be replaced takes the top page's place.
      if (level > 0 && level === pages.length && replace) swap(page);
      else push(page);
    },
  }), []);

  const others = agentSwitchStack(fleet, currentId);
  // In a workplace the door always stands: the way to make the first agent
  // is behind it. A personal workspace only puts it up with somebody to
  // switch to.
  if (!others.length && !state?.org) return null;
  const waiting = !open && readerNeedsAttention(agents, notifications, window.location.origin, decisionsWaiting);
  return (
    <>
      <button
        className={waiting ? 'chatagents attention' : 'chatagents'}
        id="agentChatSwitch"
        type="button"
        aria-label={waiting ? 'Your agents, something is waiting for you' : 'Your agents'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setReturning(false); setOpen(true); }}
      >
        {/* Faces only: this stack is a door, not a headcount (`roomFaceParts`).
            The list behind it says how many there are, and says it properly.
            With nobody else to show, the one agent there is. */}
        <RoomFaces agents={others.length ? others : fleet} counted={false} />
      </button>
      {open
        ? (
          <AgentSheet
            currentId={currentId}
            onClose={close}
            still={returning}
            pages={pages}
            moves={moves}
            onPageBack={() => backTo(pages.length - 1)}
          />
        )
        : null}
    </>
  );
}
