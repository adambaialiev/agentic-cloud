import type { WorkspaceAgentContext, WorkspaceChatFile, WorkspaceKnowledgeProposalRow, WorkspaceProposalRow } from './workspace-api.js';
import type { WorkspaceMailApproval } from './workspace-mail.js';

/** The longest message an agent sends to or receives from the Workspace Agent — `agentbuilt agent message`'s own cap. */
export const RECAP_MESSAGE_MAX = 4000;
/** The longest message the person types to the Workspace Agent: its screen shares the agent chat's box, so the same number (note #704). */
export const RECAP_OWNER_MESSAGE_MAX = 10_000;
/** The longest reason `agentbuilt agent stop` carries onto the stopped agent's chat row (note #462). */
export const STOP_REASON_MAX = 500;
/**
 * The id the Workspace Agent's conversation answers to on the chat-file
 * routes (`api/agents/<id>/chat/files/<file>`): the row renderer asks for a
 * picture by agent id, and this conversation has no agent id of its own in
 * the roster. A hyphenated word no real agent id can be.
 */
export const WORKSPACE_AGENT_CHAT_ID = 'workspace-agent';
/** The fresh-chat rule: a row that marks the space between two conversations rather than a message. Same words the room chat draws (note #429). */
export const RECAP_NEW_CHAT_DIVIDER = '─'.repeat(30);
/**
 * The first row of a fresh chat the platform started by itself (note #738):
 * what the person sees in one line, and — behind it — the handoff the agent
 * wrote, which is what its fresh conversation starts from.
 */
export const freshChatRowText = (percent: number, handoff: string) => `Started a fresh chat at ${percent}% full, carrying over what I'm following:\n${handoff}`;
export const FRESH_CHAT_ROW = /^Started a fresh chat at (\d+)% full, carrying over what I'm following:\n([\s\S]*)$/;
/** A file on a row: the screen's facts plus, stored only, where the bytes live. */
export interface RecapMessageFile extends WorkspaceChatFile { storagePath?: string }
/**
 * What a row is besides its role. `briefing` and `reaction` are retained only
 * for conversations written before automatic briefing reactions were removed
 * in note #496; new code writes only the fresh-chat divider.
 */
export type RecapMessageKind = 'new-chat-divider' | 'briefing' | 'reaction' | 'event' | 'quiet'
  /** The first run (note #726): the platform's own fixed lines in the Chief of Staff's voice — the greeting when Home first opens, and the sign-in ask under the person's first message. Neither is a reply a turn wrote. */
  | 'greeting' | 'signin-ask'
  /** The hello for a person who joined a workplace that already exists (note #820): fixed text, what is already in it. */
  | 'welcome';
/**
 * `event` (note #716) is one thing the platform noticed, the row that starts
 * an event turn; `quiet` is that turn's quiet answer — the agent's one line
 * of what it saw and did when the person need not hear. A `quiet` row is
 * never drawn in the chat (`hidden`), and neither is an event whose turn
 * stayed quiet and did nothing; both stay in the record, where the agent
 * reads them on its next turn and the Workplace window lists them.
 */
export interface RecapMessage {
  id: string; role: 'owner' | 'assistant' | 'agent' | 'action'; text: string; at: string; name?: string; href?: string; kind?: RecapMessageKind; files?: RecapMessageFile[]; mailApprovalId?: string; mailApproval?: WorkspaceMailApproval;
  /** Not drawn in the chat (note #716). */
  hidden?: true;
  /** An event turn's answer (note #716), quiet or told — what "Noticed lately" reads the outcome from. */
  event?: true;
  /** On an `event` row: an event turn has answered it. */
  answered?: true;
  /** On an event turn's answer: it could not run. */
  failed?: true;
}
/**
 * A proposal the Chief of Staff forwarded into its conversation (note #724),
 * as STORED on the row: a pointer only. What the card shows — title, room,
 * author, checks, state — is read fresh on every answer
 * (`WorkspaceForwardedProposal`), so a proposal merged an hour after it was
 * forwarded says Merged, never the Awaiting it said when it landed.
 */
export interface RecapForwardedProposalRef { kind: 'pr' | 'knowledge'; id: string }
/**
 * What `agentbuilt forward` found when it landed (note #752): `landed` is
 * false only outside a running request; `added` are the pointers the new row
 * carries, `alreadyShown` the ones the conversation already had a card for
 * since its last fresh chat — a proposal is never put in front of the person
 * twice, whether the Chief of Staff forwarded it or `pr ready` landed it.
 */
export interface RecapForwardOutcome { landed: boolean; added: RecapForwardedProposalRef[]; alreadyShown: RecapForwardedProposalRef[] }
/** Whether `pr ready` landed its card in the Chief of Staff chat (note #752): a new row, a card already there, or no conversation to write to. */
export type RecapProposalReadyOutcome = 'added' | 'already' | 'none';
/** One forwarded proposal as the screen draws it: the row every other list
 *  draws for it, and the room it was proposed in. Absent `pr`/`knowledge`
 *  means it is gone (its repository or room was deleted). */
export interface WorkspaceForwardedProposal {
  kind: 'pr' | 'knowledge';
  id: string;
  pr?: WorkspaceProposalRow;
  knowledge?: WorkspaceKnowledgeProposalRow;
}
/**
 * The two fields note #724 adds to a row, declared apart from the row's own
 * declaration (TypeScript merges the two) so this change and note #716's
 * edits to that line do not collide.
 */
export interface RecapMessage {
  /** Stored: the proposals `agentbuilt forward` put on this action row — or, since note #752, the one `pr ready` landed by itself. */
  proposals?: RecapForwardedProposalRef[];
  /** Answered, never stored: those proposals as they stand now. */
  forwarded?: WorkspaceForwardedProposal[];
}
/**
 * A note receipt this conversation stored before note #623: "Created note: …",
 * "Archived note: …" and the rest, one card per note verb with a door to the
 * note. Nothing writes them now, and the ones already stored stay in the
 * record (the agent's own context) but are no longer shown.
 */
const NOTE_RECEIPT = /^(?:Created|Updated|Commented on|Archived|Restored) note: /;
export function isNoteReceipt(message: RecapMessage): boolean {
  return message.role === 'action' && !message.kind && !message.mailApprovalId
    && NOTE_RECEIPT.test(message.text) && Boolean(message.href?.includes('/notes/'));
}
/**
 * Note #753: one person's Chiefs of Staff in their different workplaces
 * talking to each other, when the person asks. Declared apart from the
 * conversation's own declaration (TypeScript merges the two), as note #724's
 * fields are, so this change and its neighbours' edits do not collide.
 */
export interface RecapConversation {
  /**
   * The turn in flight carries the person's own words — their message, a
   * steer, or the replay of a turn of theirs a restart cut short. Only such
   * a turn may message another workplace (note #753): an event turn, a
   * reaction to an agent's answer, a handoff or a turn answering another
   * workplace never may.
   */
  byPerson?: true;
  /** Messages from this person's Chief of Staff in another workplace that no turn has taken yet. Set when the row lands; the turn that reads them moves them to `answeringCross` as it starts. */
  crossAsks?: RecapCrossAsk[];
  /** The asks the turn in flight is answering: when it ends, its reply — or why there is none — goes back to each asking workplace. */
  answeringCross?: RecapCrossAsk[];
  /** Messages this conversation sent to the person's Chief of Staff in another workplace whose answer has not come back yet. */
  crossPending?: RecapCrossWait[];
}
/** One message from the same person's Chief of Staff in another workplace (note #753). */
export interface RecapCrossAsk { orgId: string; name: string; rowId: string; at: string }
/** One message this conversation sent to another workplace, awaiting its answer (note #753). */
export interface RecapCrossWait { orgId: string; name: string; sentAt: string }
export interface RecapMessage {
  /** On an `agent` row: it came from the person's own Chief of Staff in that workplace (note #753), not from one of this workplace's agents. */
  fromOrgId?: string;
}
/** How a Chief of Staff in another workplace is named on the rows and waits here (note #753). */
export function crossChiefName(workplace: string): string {
  return `Chief of Staff in ${workplace}`;
}
/** A message sent to one of the owner's agents whose answer has not come back yet. `after` is the reply cursor of the retired forwarding (note #457); old records still carry it. */
export interface RecapDelivery {
  agentId: string; name: string; after?: number; sentAt: string; status: 'sending' | 'waiting';
  /** Sent in an event turn (note #716): its answer is a reaction the person never asked for, so it runs behind the same fence. */
  fromEvent?: true;
}
/** Private membership data. Never include in People, roster or org serializers. */
export interface RecapConversation {
  messages: RecapMessage[];
  receipts: string[];
  pending: RecapDelivery[];
  /**
   * Last stored row included in the native CLI conversation. Rows after it
   * are the delta for the next resumed turn; the native session already owns
   * everything before it. Cleared with the native pointer by Reset chat.
   */
  nativeCursor?: string;
  running?: string;
  phase?: string;
  /** What the running turn is thinking, as last read off its machine (note #452). Cleared with `running`. */
  thinking?: string;
  /** `agentbuilt chat new` was run during the request in flight: the divider lands when the turn ends. */
  resetAfterTurn?: true;
  /**
   * A fresh chat the platform is starting by itself (note #738): set when a
   * turn ends at or above `WORKSPACE_AGENT_FRESH_CHAT_PERCENT`, it makes the
   * next turn the HANDOFF turn, and stays while that turn runs. `percent` is
   * the reading that crossed the level; `through` the last row of the
   * conversation it ends — the divider goes under it, so whatever lands
   * during the handoff turn is the fresh chat's. A person's words, an
   * agent's answer or an event replace it with their own turn.
   */
  freshChat?: { percent: number; through?: string };
  /**
   * The person wrote again while a request ran (steering, the room chat's
   * contract): the running turn is interrupted and one replacement turn
   * answers everything they said since the last reply. Set until that
   * replacement turn starts.
   */
  steered?: true;
  /**
   * This request's turn already tried once more after its machine would not
   * wake (note #763): a second refusal ends in the row, as before.
   */
  wakeRetried?: true;
  /**
   * The request was cut short by a backend restart and is being picked up
   * again (note #455): the replacement turn is told its earlier turn was
   * interrupted and that the actions recorded since already happened. Set
   * until that turn starts.
   */
  replayed?: true;
  /**
   * One of the person's own room agents sent its answer into this
   * conversation and nothing has reacted to it yet (note #539). Set when the
   * row lands; the turn that reads it clears it as it starts. While a turn
   * is already running the flag is what carries a replacement turn after it,
   * exactly as `steered` does for the person's own words.
   */
  agentReplied?: true;
  /**
   * The platform noticed something and nothing has reacted yet (note #716):
   * set when the event rows land, cleared by the turn that reads them, and
   * — like `agentReplied` — what carries an event turn after a turn already
   * running.
   */
  eventing?: true;
  /**
   * The turn in flight is an EVENT turn: nobody wrote, so the CLI refuses
   * every change but the person's standing permissions. Set as the turn
   * starts, cleared when it ends or a turn with a person's words replaces it.
   */
  eventTurn?: true;
  /**
   * Agents whose awaited answer never came (the "finished without sending a
   * reply here" row), newest last, for a few days: the no-reply event and
   * the one door `ask-silent-agent` opens in an event turn.
   */
  silent?: Array<{ agentId: string; name: string; at: string; /** Its turn never reached an end — dropped at a restart (note #734). */ cut?: true }>;
  /**
   * The event rows the turn in flight took on as it started (note #716):
   * what its answer settles, and — when that answer is quiet and it did
   * nothing — what leaves the screen with it.
   */
  answering?: string[];
  /**
   * What the agents' answers waiting for a reaction were answering (note
   * #716): something the agent did on its own in an event turn, or anything
   * else. A reaction only to the first kind is fenced like an event turn.
   */
  repliedToEvent?: true;
  repliedToPerson?: true;
  /**
   * The first run (note #726). `greeted`: the fixed greeting row has been
   * written, once. `awaitingSeat`: the person has written while no plan was
   * signed in; their words wait as the first real request, the sign-in card
   * stands under the ask, and the plan landing starts the turn by itself.
   * `firstRun`: the turn in flight is that first one, asked to open a room
   * and bring a team in; it survives a restart with the turn and is cleared
   * when the turn ends.
   */
  greeted?: true;
  awaitingSeat?: true;
  firstRun?: true;
  /** @deprecated Rolling-deploy cleanup for a pre-note-496 automatic reaction. */
  reacting?: string;
  /** @deprecated No new briefing reaction is queued after note #496. */
  reactTo?: string;
}
export interface RecapChatAnswer {
  orgId: string;
  messages: RecapMessage[];
  working: boolean;
  /** Answered to a send that reached a running turn: it was steered, not refused. */
  steered?: boolean;
  phase?: string;
  /** What the running turn is thinking right now (note #452), when it has said anything yet. */
  thinking?: string;
  /**
   * The owner's agents whose replies this conversation is still collecting.
   * The transcript does NOT draw it (note #486): a person reads it as the
   * agent's state line, on Home's plate and on its own screen, and each
   * reply lands in the conversation as its own row when it arrives.
   */
  waiting: string[];
  /** Latest measured fill for the ring in the open conversation header. */
  context?: WorkspaceAgentContext;
  /** The same durable workplace dog Home's plate wears (note #582), absent
   * when the release carries no selected file. */
  avatarUrl?: string;
  /** The first run (note #726): the person has written and no plan is signed in yet — the screen draws the sign-in card under the ask. */
  awaitingSeat?: boolean;
}
/** POST api/recap/chat/stop — the same answer a room agent's Stop gives. */
export interface RecapChatStopAnswer { ok: true; stopped: boolean; name: string }
