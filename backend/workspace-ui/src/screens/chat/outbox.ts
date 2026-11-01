/**
 * Messages the reader has sent that are not on the record yet (note #658).
 *
 * A send used to live inside the composer: the words sat in a read-only box,
 * Send dimmed, and nothing reached the conversation until the server answered.
 * That answer is quick while the agent's machine stands, and it is the whole
 * of a machine rebuild when it does not — twenty-two seconds when a
 * workplace's cloud was replaced, measured on 2026-09-24. For all that time
 * the message looked unsent. A reader who stepped away and came back found
 * the words back in a live box and sent them again (two rows, seven
 * milliseconds apart), and the send that had gone left them there after the
 * agent had already answered.
 *
 * So a send is handed HERE the moment it is pressed. Its bubble is on the
 * transcript at once, the box is empty at once, and the request belongs to
 * the page session rather than to one screen: leaving the chat does not
 * orphan it, and coming back finds the bubble, never the words.
 *
 * The rules it keeps:
 *
 *  - ONE AT A TIME, IN ORDER, per conversation. The next message goes when
 *    the one before it has been answered, so the record reads the way the
 *    reader wrote it.
 *  - A REFUSAL GIVES THE WORDS BACK — the refused message and everything
 *    queued behind it, to the box they came from, with the server's reason
 *    (the composer's contract before this: a refused send leaves the words
 *    where they can go again). Sending a later message after an earlier one
 *    failed would reorder the conversation, so the later ones come back too.
 *  - A FAILURE THAT PROVES NOTHING IS NOT A REFUSAL. Only an answer our own
 *    server wrote says nothing was sent; a dropped connection or a gateway's
 *    error page may have landed after admission. That send waits a few
 *    seconds to be found on the record before its words come back — the one
 *    way to never show a message both sent and still in the box.
 *  - THE ROW REPLACES THE BUBBLE. A read that brings the reader's own row
 *    after the cursor they sent from, with the same words and files, is that
 *    send's answer, and the bubble goes in the same commit the row arrives
 *    in. A send answered but never matched stands down on its own shortly
 *    after, so a bubble can never outlive the message it stood for.
 */

import type { WorkspaceChatMessage } from '../../../../src/shared/workspace-api.js';
import { WorkspaceApiError } from '../../api/client.js';
import { filesOf } from './transcript.js';

/** `waiting` behind another send; `sending` now; `sent` and answered, until
 *  its row is read; `unsure` when the request failed in a way that proves
 *  nothing, until the record says which. */
export type OutgoingState = 'waiting' | 'sending' | 'sent' | 'unsure';

export interface OutgoingMessage {
  /** This page session's own handle: the bubble's key. */
  readonly id: string;
  /** Trimmed, exactly as the route records it. */
  readonly text: string;
  readonly files: readonly File[];
  /** When Send was pressed (epoch ms). */
  readonly sentAt: number;
  /** The newest seq the transcript held when Send was pressed: the row that
   *  answers this send is newer. */
  readonly after: number;
  readonly state: OutgoingState;
  /** Whole percent of the big files gone up in parts so far (note #943),
   *  while there are any; absent for a message with none. */
  readonly percent?: number;
}

/** Words and files handed back to the box they came from. */
export interface ReturnedDraft {
  text: string;
  files: File[];
}

export interface ChatOutboxOptions {
  /** Put one message on the record; resolves once the route has admitted it.
   *  `progress` hears a big file's parts go up (note #943). */
  deliver: (agentId: string, message: OutgoingMessage, progress: (sent: number, total: number) => void) => Promise<void>;
  /** Say why words came back. */
  refused: (reason: string) => void;
}

/** How long an answered send waits for a read to bring its row before its
 *  bubble stands down anyway. A mounted chat reads at once and at every poll;
 *  this is for the send whose screen was left. */
export const OUTBOX_ANSWERED_GRACE_MS = 15_000;
/** How long a send whose answer never arrived waits to be found on the record
 *  before its words go back to the box — two polls and a margin. */
export const OUTBOX_UNSURE_GRACE_MS = 7_000;
/** How far behind the reader's clock the server's may run and its row still
 *  answer their send. Only a guard against an OLD row with the same words on
 *  a conversation opened cold, where the cursor is still 0. */
const CLOCK_SLACK_MS = 60_000;

/** How recently the chat must have said the agent's machine is being
 *  rebuilt for that to still count — a read comes every few seconds while
 *  the chat is open, and a word from a screen since closed must not hold a
 *  send forever. */
const REBUILDING_FRESH_MS = 10_000;

/** What a failure that proves nothing is called in the banner. */
export const OUTBOX_UNSURE_REASON = 'Your message could not be sent just now. It is back in the box — send it again.';

const NONE: readonly OutgoingMessage[] = Object.freeze([]);

/** An answer our own server wrote — which always means nothing was sent. A
 *  thrown fetch, or a proxy's page with no JSON body, may have landed. */
export function definiteRefusal(error: unknown): boolean {
  return error instanceof WorkspaceApiError
    && typeof (error.body as { error?: unknown } | null)?.error === 'string';
}

/** Whether this row is the record of that send. */
export function answers(row: WorkspaceChatMessage, message: OutgoingMessage): boolean {
  if (row.role !== 'owner' || !(row.seq > message.after)) return false;
  if ((row.text ?? '').trim() !== message.text) return false;
  if (filesOf(row).length !== message.files.length) return false;
  const at = row.at ? Date.parse(row.at) : Number.NaN;
  return !Number.isFinite(at) || at >= message.sentAt - CLOCK_SLACK_MS;
}

/**
 * Which rows answer which sends, one row to one send and oldest first: row
 * seq → message id. A message still waiting its turn cannot be on the record
 * yet, so it is never matched — two identical words sent in a row are two
 * sends, and each takes its own row.
 */
export function matchSends(
  list: readonly OutgoingMessage[],
  rows: readonly WorkspaceChatMessage[],
): Map<number, string> {
  const matched = new Map<number, string>();
  if (!list.length || !rows.length) return matched;
  for (const message of list) {
    if (message.state === 'waiting') continue;
    const row = rows.find((candidate) => !matched.has(candidate.seq) && answers(candidate, message));
    if (row) matched.set(row.seq, message.id);
  }
  return matched;
}

const joinDrafts = (first: ReturnedDraft, then: ReturnedDraft): ReturnedDraft => ({
  text: [first.text, then.text].filter(Boolean).join('\n\n'),
  files: [...first.files, ...then.files],
});

export class ChatOutbox {
  private readonly held = new Map<string, readonly OutgoingMessage[]>();
  private readonly listeners = new Set<() => void>();
  /** The mounted composer of each conversation, if one is. */
  private readonly takers = new Map<string, (draft: ReturnedDraft) => void>();
  /** Words given back while no composer was there to take them. */
  private readonly returned = new Map<string, ReturnedDraft>();
  private readonly pumping = new Set<string>();
  /** When each conversation's read last said its machine is being rebuilt. */
  private readonly rebuilding = new Map<string, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  private made = 0;
  private options: ChatOutboxOptions | null = null;

  /** How a message goes, and where a refusal is said — the session's API and
   *  the banner as they stand now. A send made before this is held until it
   *  comes. */
  connect(options: ChatOutboxOptions): void {
    this.options = options;
    for (const agentId of this.held.keys()) void this.pump(agentId);
  }

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The conversation's sends in flight, oldest first. The same array until
   *  something about them changes. */
  readonly list = (agentId: string): readonly OutgoingMessage[] => this.held.get(agentId) ?? NONE;

  send(agentId: string, draft: { text: string; files: File[]; after: number }): void {
    if (this.closed) return;
    this.made += 1;
    const message: OutgoingMessage = {
      id: `outgoing-${this.made}`,
      text: draft.text,
      files: draft.files,
      sentAt: Date.now(),
      after: draft.after,
      state: 'waiting',
    };
    this.write(agentId, [...this.list(agentId), message]);
    void this.pump(agentId);
  }

  /**
   * Retire the sends these rows are the record of. Called once the rows are
   * ON the page: the screen stops drawing a bubble in the same render its row
   * arrives in (`matchSends`), so retiring it afterwards changes nothing the
   * reader can see.
   */
  claim(agentId: string, rows: readonly WorkspaceChatMessage[]): void {
    const list = this.list(agentId);
    const found = new Set(matchSends(list, rows).values());
    if (!found.size) return;
    this.write(agentId, list.filter((message) => !found.has(message.id)));
    // A send that was unsure and is on the record after all lets the
    // messages queued behind it go.
    void this.pump(agentId);
  }

  /** Retire answered sends that a read made after their answer did not
   *  bring, and never will: `ids` were answered BEFORE that read began, and
   *  `rows` is what it brought. What it did bring is left to `claim`. */
  settle(agentId: string, ids: readonly string[], rows: readonly WorkspaceChatMessage[] = []): void {
    const list = this.list(agentId);
    const found = new Set(matchSends(list, rows).values());
    const kept = list.filter((message) => !(message.state === 'sent' && ids.includes(message.id) && !found.has(message.id)));
    if (kept.length !== list.length) this.write(agentId, kept);
  }

  /** Where this conversation's refused words go while its composer is up —
   *  and any given back while it was not, at once. */
  takeReturned(agentId: string, taker: (draft: ReturnedDraft) => void): () => void {
    this.takers.set(agentId, taker);
    const waiting = this.returned.get(agentId);
    if (waiting) {
      this.returned.delete(agentId);
      taker(waiting);
    }
    return () => { if (this.takers.get(agentId) === taker) this.takers.delete(agentId); };
  }

  /**
   * What the chat's latest read said about a machine rebuild (note #658). A
   * send whose answer was lost while one runs may be waiting on it still —
   * the route answers only once the machine is built, and a rebuild can
   * outlast a gateway's patience — so its words are not handed back while
   * the chat keeps saying so.
   */
  noteRebuilding(agentId: string, rebuilding: boolean): void {
    if (rebuilding) this.rebuilding.set(agentId, Date.now());
    else this.rebuilding.delete(agentId);
  }

  /** Taking sends (again). A provider's effect opens it on every mount, so
   *  the rehearsal unmount of React's StrictMode does not leave it shut. */
  open(): void {
    this.closed = false;
  }

  /** The page session is over (sign-out): forget every unsent word, and let
   *  no answer that lands later speak into the next reader's session. */
  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.held.clear();
    this.returned.clear();
    this.takers.clear();
    this.rebuilding.clear();
  }

  private async pump(agentId: string): Promise<void> {
    if (this.pumping.has(agentId)) return;
    this.pumping.add(agentId);
    try {
      for (;;) {
        if (this.closed) return;
        const list = this.list(agentId);
        // Nothing overtakes a send whose fate is still open.
        if (list.some((message) => message.state === 'sending' || message.state === 'unsure')) return;
        const message = list.find((candidate) => candidate.state === 'waiting');
        const options = this.options;
        if (!message || !options) return;
        this.patch(agentId, message.id, 'sending');
        try {
          await options.deliver(agentId, message, (sent, total) => this.progress(agentId, message.id, sent, total));
        } catch (error) {
          if (this.closed) return;
          if (definiteRefusal(error)) {
            this.giveBack(agentId, message.id, error instanceof Error ? error.message : String(error));
          } else {
            this.patch(agentId, message.id, 'unsure');
            const expire = () => {
              const said = this.rebuilding.get(agentId);
              if (said !== undefined && Date.now() - said < REBUILDING_FRESH_MS) this.later(expire, OUTBOX_UNSURE_GRACE_MS);
              else this.giveBack(agentId, message.id, OUTBOX_UNSURE_REASON);
            };
            this.later(expire, OUTBOX_UNSURE_GRACE_MS);
          }
          continue;
        }
        // A read that raced the answer may have retired it already.
        this.patch(agentId, message.id, 'sent');
        this.later(() => this.settle(agentId, [message.id]), OUTBOX_ANSWERED_GRACE_MS);
      }
    } finally {
      this.pumping.delete(agentId);
    }
  }

  /** The message and everything queued behind it, back to the box. Nothing
   *  when the record already has it. */
  private giveBack(agentId: string, id: string, reason: string): void {
    const list = this.list(agentId);
    const at = list.findIndex((message) => message.id === id);
    if (at < 0) return;
    const back = list.slice(at);
    this.write(agentId, list.slice(0, at));
    const draft: ReturnedDraft = {
      text: back.map((message) => message.text).filter(Boolean).join('\n\n'),
      files: back.flatMap((message) => [...message.files]),
    };
    const taker = this.takers.get(agentId);
    if (taker) taker(draft);
    else {
      const earlier = this.returned.get(agentId);
      this.returned.set(agentId, earlier ? joinDrafts(earlier, draft) : draft);
    }
    this.options?.refused(reason);
  }

  /** A big file's parts going up: the bubble's percentage, written only
   *  when the whole number changes. */
  private progress(agentId: string, id: string, sent: number, total: number): void {
    if (!(total > 0)) return;
    const percent = Math.min(100, Math.floor((sent / total) * 100));
    const list = this.list(agentId);
    if (!list.some((message) => message.id === id && message.percent !== percent)) return;
    this.write(agentId, list.map((message) => (message.id === id ? { ...message, percent } : message)));
  }

  private patch(agentId: string, id: string, state: OutgoingState): void {
    const list = this.list(agentId);
    if (!list.some((message) => message.id === id && message.state !== state)) return;
    this.write(agentId, list.map((message) => (message.id === id ? { ...message, state } : message)));
  }

  private write(agentId: string, list: readonly OutgoingMessage[]): void {
    if (list.length) this.held.set(agentId, list);
    else this.held.delete(agentId);
    for (const listener of [...this.listeners]) listener();
  }

  private later(run: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) run();
    }, ms);
    this.timers.add(timer);
  }
}
