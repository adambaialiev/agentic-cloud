/** The private Home overview: workplace work plus this reader's chats. */

import type { WorkspaceAgentContext } from './workspace-api.js';

/**
 * The shape of a recap, shared so the card cannot disagree with the gate that
 * saved the text. It used to: the summarizer's ceiling was raised to 750
 * characters while the card went on budgeting 600, so every recap in between
 * was accepted by the backend and then cut off mid-sentence on screen with an
 * ellipsis. The card and the gate now read the same numbers.
 *
 * Since note #619 the briefing is BULLET POINTS, not paragraphs: the owner
 * asked for "a briefing, in bullet points" — three prose paragraphs on a phone
 * card read as an essay, and a briefing is the thing you skim. The prompt asks
 * for between RECAP_BULLETS_MIN and RECAP_BULLETS_MAX of them, about 100
 * words in all; asked for and never enforced (note #408). Saved text is one
 * bullet per line, with no marker stored; the card draws the list.
 */
export const RECAP_BULLETS_MIN = 3;
export const RECAP_BULLETS_MAX = 6;
/**
 * The size is asked for, not enforced (note #408): the prompt says about 100
 * words and what comes back is saved and drawn whole. A ceiling used to stand
 * here — 1,000 characters and 150 words, then 1,600 and 240 — and the models
 * wrote past it all afternoon: every answer was thrown away after a
 * one-to-three minute run, the card said "updating with recent activity…" for
 * the whole of it, and the words beneath never changed. A briefing longer
 * than asked is worth showing; one that never arrives is not. Only an answer
 * that is not a briefing at all (no JSON, no recap string, an empty one) is
 * rejected.
 */

/**
 * How many briefings the next one is written against (note #413). The point is
 * not a log: it is that a briefing written every few minutes should know what
 * it already told the reader, so it can carry the story forward instead of
 * saying the same three paragraphs in different words all afternoon.
 */
export const RECAP_HISTORY = 10;
/**
 * ...but a briefing rewritten a minute later is the SAME briefing over fresher
 * sources, not a second one. Production writes a new overview every 54 seconds
 * (median, measured over the settled runs of a working evening), so ten
 * consecutive saves reach back a median of fifteen minutes — a memory too
 * short to be worth carrying. The clock is therefore cut into windows this
 * wide and only the last briefing of each is kept, so ten of them always reach
 * back at least an hour and a half, and across a quiet day, days.
 *
 * The window is anchored to the CLOCK, not to the newest briefing kept: a
 * window measured from the head is pushed forward by every briefing that
 * replaces it, so at one a minute the head is replaced for ever and ten
 * windows never open. That is not a hypothetical — it is what the first
 * implementation of this did.
 */
export const RECAP_HISTORY_WINDOW_MS = 10 * 60 * 1000;
/**
 * Each remembered briefing is capped here. Since note #408 nothing bounds what
 * a model may return — `summarizeWorkspaceRecap` accepts up to 32,000
 * characters — and the whole prompt travels to the machine as ONE shell
 * argument, which Linux refuses past 128 KB. Ten unbounded briefings could
 * therefore break every recap rather than merely enlarging one. 2,000 is above
 * the longest briefing production has produced (1,646), so nothing real is cut.
 */
export const RECAP_HISTORY_MAX_CHARS = 2_000;

/** A briefing this reader has already been shown. */
export interface PreviousWorkspaceRecap {
  /** The words as they stood on the card. */
  text: string;
  /** When they were written. */
  at: string;
}

export type RecapSourceKind = 'proposal' | 'note' | 'knowledge' | 'turn' | 'message' | 'request';
export interface WorkspaceRecapSource {
  id: string;
  kind: RecapSourceKind;
  title: string;
  text: string;
  at: string;
  href: string;
  status?: string;
}
export interface SavedWorkspaceRecap {
  /** One bullet per line (note #619). Briefings saved before that are two or
   * three paragraphs on blank lines, and the card draws those as bullets too
   * until the reader asks for a fresh one. */
  text: string;
  /** When the words were written. */
  at: string;
  /** The newest activity the words cover: the timestamp of the freshest source
   * the summarizer was given. This is the honest freshness line — "written 17
   * minutes ago" says nothing about whether the last hour is in it. Absent on
   * overviews saved before the field existed. */
  through?: string;
  fingerprint: string;
}
/**
 * Why the last refresh produced nothing. Every one of these used to end as the
 * same `undefined`, so a card that had failed sixty times running read exactly
 * like one whose summary was a minute away: "refresh pending".
 */
export type WorkspaceRecapFailure =
  /** No machine, seat or credential of this reader's could run the summary. */
  | 'unavailable'
  /** The person stopped or steered the turn before it answered (Workspace Agent only). */
  | 'interrupted'
  /** The CLI itself refused — an unusable model or effort, a spent credential, a usage limit. */
  | 'model'
  /** The run passed its three-minute bound. */
  | 'timeout'
  /** The model answered, but not with a briefing: no JSON, no recap string, or an empty one. */
  | 'format';

export interface WorkspaceRecapAnswer {
  orgId: string;
  summary: SavedWorkspaceRecap | null;
  /** A briefing is being written for this reader right now. Since note #607
   * that only ever follows a press of the card's button: nothing else starts
   * one. */
  updating: boolean;
  /** The saved words no longer match the collected sources, the model or the
   * format. A fact, not a promise: nothing rewrites them until the reader asks. */
  stale: boolean;
  sources: WorkspaceRecapSource[];
  since: string;
  checkedAt: string;
  incomplete: boolean;
  /** Set when the reader's last press produced nothing and no newer one is running. */
  refreshFailed?: WorkspaceRecapFailure;
  /** The reader's Workspace Agent, as Home's plate draws it. */
  agent: WorkspaceAgentState;
}

/**
 * The Workspace Agent as the Workplace half shows it: one plate, like a room
 * agent's, over the briefing it wrote. `working` is the conversation's own
 * running marker — the agent has no ordinary turn registry — and `phase` is
 * the setup or thinking line for as long as a request runs. `waiting` names
 * the owner's agents whose replies the conversation is still collecting.
 * `started` is false until the person's first request reserves the machine.
 */
export interface WorkspaceAgentState {
  name: string;
  /** The workplace's durable shepherd/big-working-dog choice (note #582),
   * absent when the release carries no selected file. */
  avatarUrl?: string;
  started: boolean;
  working: boolean;
  phase?: string;
  /**
   * What it is thinking right now (note #452): the newest narration,
   * reasoning or tool call of the running turn, read off its machine every
   * few seconds. Only while `working`, and only once the turn has said
   * anything; the card draws it under the plate.
   */
  thinking?: string;
  waiting: string[];
  /** The last time a request ran, when one has. */
  lastActiveAt?: string;
  /** Its last reply, whole, as the conversation stored it (note #452). */
  lastReply?: { text: string; at: string };
  /** How full its conversation was at the end of its last measured turn. */
  context?: WorkspaceAgentContext;
}

/** A summarizer run: the text it produced, or why it produced none. */
export interface WorkspaceRecapRun {
  /** Safe, actionable explanation from the dedicated runtime; never CLI output. */
  detail?: string;
  text?: string;
  /** Files emitted by an acting Workspace Agent through ATTACH: lines. The
   *  backend stores them on the assistant row before anything reaches the UI. */
  files?: Array<{ fileName: string; contentType?: string; data: Uint8Array }>;
  failure?: WorkspaceRecapFailure;
  /**
   * The `unavailable` was the agent's machine refusing to wake (note #763):
   * a turn nobody typed may try once more when the machine is back, where
   * any other failure ends the turn.
   */
  wakeFailed?: true;
}

export interface WorkspaceRecapSettings {
  cli: 'codex' | 'claude';
  model: string;
  effort: string;
}
export interface WorkspaceRecapModel {
  cli: WorkspaceRecapSettings['cli'];
  value: string;
  label: string;
  available: boolean;
  /** As on an agent's own runtime answer: `heavy` is the level's own fact,
   *  carried through so both pickers warn with one rule (note #482). */
  efforts: Array<{ value: string; label: string; heavy?: boolean }>;
}
/**
 * The Workspace Agent's OWN screen (note #439). Every other agent has one —
 * what it is, what it thinks with, what it runs on — and the one agent a
 * person talks to most had none, because it is not a room agent and never
 * appears in the fleet. Its state is the very same `WorkspaceAgentState` the
 * plate on Home draws, read from the conversation, so the two screens can
 * never disagree about whether a request is running.
 */
export interface WorkspaceAgentDetailsAnswer {
  orgId: string;
  /** Durable agent record id, once the first request has reserved it. */
  agentId?: string;
  agent: WorkspaceAgentState;
  /** Its model and effort — the pair its conversation's header picks. */
  settings: WorkspaceRecapSettings | null;
  /** The machine its turns run on, as its record last observed the shape.
   *  Absent until the first request reserves one. */
  machine?: { cpuKind: string; cpus: number; memoryMb: number };
  /** When that machine was reserved. Absent for the same reason. */
  createdAt?: string;
}

export interface WorkspaceRecapSettingsAnswer {
  orgId: string;
  settings: WorkspaceRecapSettings | null;
  models: WorkspaceRecapModel[];
}
