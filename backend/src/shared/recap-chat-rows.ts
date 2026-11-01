import { FRESH_CHAT_ROW, type RecapMessage } from './workspace-recap-chat.js';

/**
 * How each row of the Chief of Staff's conversation is SHOWN (note #725).
 *
 * The stored rows are the agent's own record — every one of them goes back
 * into its next turn, word for word — so nothing here changes what is
 * stored. This decides only what the person sees, by one rule the owner
 * agreed on 2026-10-11: a row earns its place on screen when it is news to
 * the person or a decision for them. Everything else is the platform talking
 * to itself, and stays in the record only.
 *
 * What is left takes one of a few shapes:
 *  - `row`       — drawn as stored: the conversation itself (the person, the
 *                  Chief of Staff, an agent's answer), the decision cards
 *                  (forwarded proposals, email), the rules, the person's own
 *                  stop, and any receipt nobody here recognises — a new kind
 *                  of news must never disappear for want of a recogniser.
 *                  The person's message may carry an `unfinished` mark: the
 *                  ONE way every "this request did not complete" is said,
 *                  under the words that did not get done.
 *  - `did`       — one quiet line for what the Chief of Staff did on the
 *                  person's behalf ("Sent to Oscar"), the full message behind
 *                  a tap, tagged `own` when it acted without being asked.
 *  - `attention` — a hand-off that fell through, or a setting to fix: one
 *                  line with the one door that does something about it.
 *  - `remove-agent` — the Chief of Staff asked the person to remove an
 *                  agent: a decision, so a card.
 *  - `remove-room` — the same for deleting a room (note #740), with the
 *                  room's id from the row's door, so a rename meanwhile
 *                  still finds it.
 *  - `noticed`   — what the platform noticed and the agent spoke up about
 *                  (note #716's event rows): a small line above its reply.
 *  - `unfinished`— a failure with no message of the person's to stand
 *                  under (a turn reacting to an agent's answer).
 *  - `hidden`    — bookkeeping: the connection-restarted rows when the work
 *                  simply carried on, a fresh-chat ask folded into the send
 *                  it prepared, a second "went silent" row for the same
 *                  hand-off, a pre-note-#496 "A new briefing was written".
 *
 * The recognisers are anchored to the sentences the backend writes, which
 * `workspace-recap-chat.test.ts` round-trips through this module, so a
 * reworded sentence fails a test rather than quietly turning back into a
 * grey receipt. Pure: no DOM, nothing from the screen.
 */

/** A piece of a line: words, or an agent's name (the screen draws it as a name). */
export type RecapLinePart = string | { agent: string };

/** The one mark every request that did not complete wears (note #725). */
export interface RecapUnfinished {
  /** What the person reads: "Not finished", "Ran out of time — what was done is above". */
  reason: string;
  /** The button beside it, when pressing it can help: send the same words
   *  again, or ask the agent to carry on from what it recorded. Absent on
   *  any message but the person's newest, and on one that carried files
   *  (words alone cannot send those again). */
  retry?: 'resend' | 'continue';
}

export type RecapRowView =
  | { form: 'row'; unfinished?: RecapUnfinished }
  | { form: 'hidden' }
  | { form: 'did'; parts: RecapLinePart[]; body?: string; own?: true }
  | { form: 'attention'; parts: RecapLinePart[]; tone: 'warn' | 'plain'; door?: { to: 'chat'; agent: string } | { to: 'settings' } }
  | { form: 'remove-agent'; agent: string; reason?: string }
  | { form: 'remove-room'; room: string; roomId?: string; reason?: string }
  | { form: 'noticed'; text: string }
  | { form: 'unfinished'; reason: string };

/** Written by an event turn's receipts (note #716): "On its own: sent to Theo: …". */
const ON_ITS_OWN = 'On its own: ';

/**
 * The Chief of Staff's failed-turn replies: `WorkspaceRecapChat.turn` writes
 * these, and the screen reads them back as the unfinished mark. Stored rows
 * keep them word for word, so a new wording is a new constant beside the old.
 */
export const RECAP_TIMED_OUT = 'The agent took too long. Any actions it completed are recorded above; ask it to continue.';
export const RECAP_NO_ANSWER = 'The agent finished without an answer. Any actions it completed are recorded above.';
export const RECAP_NOT_FINISHED = 'This request could not finish. Your message is saved.';
export const RECAP_NO_MODEL = 'I could not run the selected model. Check the agent\'s model and your subscription, then try again.';
/** A turn whose person lost access to the workplace ends on this (`RecapChatError`). */
const ACCESS_CHANGED = 'Workplace access changed.';

/** What one row says on its own, before its neighbours are read. */
interface Fact {
  view: RecapRowView;
  /** A "Sent to X" line, for the fresh-chat ask in front of it to fold into. */
  sentTo?: string;
  /** "Asked X for a fresh chat." — folded into the send it prepared. */
  freshFor?: string;
  /** "X finished without sending a reply here." */
  silent?: string;
  /** Note #716's event saying the same thing a sweep later. */
  silentEvent?: string;
  /** A request that did not complete, to be said under the person's words. */
  failed?: RecapUnfinished;
}

/** Split "Theo: the note changed" into the name and what follows the colon. */
const nameAndReason = (text: string): { name: string; reason?: string } => {
  const at = text.indexOf(': ');
  return at < 0 ? { name: text } : { name: text.slice(0, at), reason: text.slice(at + 2) };
};

/** A receipt of something the Chief of Staff did: its words, without the event turn's prefix. */
function did(text: string, own: boolean): Fact | null {
  const tag = own ? { own: true as const } : {};
  const sent = text.match(/^Sent to ([^:\n]+): ([\s\S]+)$/);
  if (sent) return { view: { form: 'did', parts: ['Sent to ', { agent: sent[1]! }], body: sent[2]!, ...tag }, sentTo: sent[1]! };
  // The wording before note #457, still in older conversations.
  const oldSent = text.match(/^Sent your request to ([^\n]+?)\.$/);
  if (oldSent) return { view: { form: 'did', parts: ['Sent to ', { agent: oldSent[1]! }], ...tag }, sentTo: oldSent[1]! };
  const fresh = text.match(/^Asked ([^\n]+?) for a fresh chat\.$/);
  if (fresh) return { view: { form: 'did', parts: [{ agent: fresh[1]! }, ' starts a fresh chat'], ...tag }, freshFor: fresh[1]! };
  const stopped = text.match(/^Stopped ([\s\S]+?)\.(?: Its reply is no longer awaited\.)?$/);
  if (stopped) {
    const { name, reason } = nameAndReason(stopped[1]!);
    return { view: { form: 'did', parts: ['Stopped ', { agent: name }, ...(reason ? [` — ${reason}`] : [])], ...tag } };
  }
  // `agentbuilt agent model` (note #776): the agent, then the pair it runs on now.
  const set = text.match(/^Set ([^\n]+?) to (\S+) at (\S+) effort\.$/);
  if (set) return { view: { form: 'did', parts: ['Set ', { agent: set[1]! }, ` to ${set[2]} at ${set[3]} effort`], ...tag } };
  const handed = text.match(/^Handed note #(\d+) to ([^:\n]+): ([\s\S]+)$/);
  if (handed) return { view: { form: 'did', parts: [`Handed note #${handed[1]} to `, { agent: handed[2]! }, ` — ${handed[3]}`], ...tag } };
  const archived = text.match(/^Archived note #(\d+): ([\s\S]+)$/);
  if (archived) return { view: { form: 'did', parts: [`Archived note #${archived[1]} — ${archived[2]}`], ...tag } };
  return null;
}

function factOf(message: RecapMessage): Fact {
  const row: Fact = { view: { form: 'row' } };
  const text = message.text;
  if (message.role === 'assistant') {
    if (text === RECAP_TIMED_OUT) return { ...row, failed: { reason: 'Ran out of time — what was done is above', retry: 'continue' } };
    if (text === RECAP_NO_ANSWER) return { ...row, failed: { reason: 'No answer came back', retry: 'resend' } };
    if (text === RECAP_NOT_FINISHED || text === ACCESS_CHANGED) return { ...row, failed: { reason: 'Not finished', retry: 'resend' } };
    if (text === RECAP_NO_MODEL) {
      return { view: { form: 'attention', tone: 'warn', parts: ['I can\'t start: my model or your subscription isn\'t working'], door: { to: 'settings' } } };
    }
    return row;
  }
  if (message.role !== 'action' || message.mailApprovalId || message.proposals?.length || message.forwarded?.length) return row;
  if (message.kind === 'new-chat-divider') return row;
  // A fresh chat it started by itself (note #738): one line, and the
  // handoff it carried over behind a tap.
  const fresh = text.match(FRESH_CHAT_ROW);
  if (fresh) return { view: { form: 'did', parts: [`Started a fresh chat at ${fresh[1]}% full`], body: fresh[2]!, own: true } };
  // Before note #496 an automatic briefing reaction opened with this row;
  // the reaction itself is a reply and stays.
  if (message.kind === 'briefing') return { view: { form: 'hidden' } };
  if (message.kind === 'event') {
    const silent = text.match(/^([^\n]+?) finished without sending back the answer the Chief of Staff was waiting for\.$/);
    if (silent) return { view: silentLine(silent[1]!), silentEvent: silent[1]! };
    const cut = text.match(/^([^\n]+?) stopped working without sending back the answer the Chief of Staff was waiting for; its turn may have been cut short\.$/);
    if (cut) return { view: cutLine(cut[1]!), silentEvent: cut[1]! };
    return { view: { form: 'noticed', text } };
  }
  if (text.startsWith(ON_ITS_OWN)) {
    const rest = text.slice(ON_ITS_OWN.length);
    const capital = `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
    return did(capital, true) ?? { view: { form: 'did', parts: [capital], own: true } };
  }
  const receipt = did(text, false);
  if (receipt) return receipt;
  const remove = text.match(/^Asked the person to remove ([\s\S]+?)\.$/);
  if (remove) {
    const { name, reason } = nameAndReason(remove[1]!);
    return { view: { form: 'remove-agent', agent: name, ...(reason ? { reason } : {}) } };
  }
  const removeRoom = text.match(/^Asked the person to delete the room ([\s\S]+?)\.$/);
  if (removeRoom) {
    const { name, reason } = nameAndReason(removeRoom[1]!);
    const roomId = message.href?.match(/\/rooms\/([^/?#]+)/)?.[1];
    return { view: { form: 'remove-room', room: name, ...(roomId ? { roomId: decodeURIComponent(roomId) } : {}), ...(reason ? { reason } : {}) } };
  }
  const silent = text.match(/^([^\n]+?) finished without sending a reply here\. Its own conversation has the details\.$/);
  if (silent) return { view: silentLine(silent[1]!), silent: silent[1]! };
  // A wait whose turn never reached an end (note #734): not "finished".
  const cut = text.match(/^([^\n]+?) stopped working without sending a reply here; its turn may have been cut short\. Its own conversation has the details\.$/);
  if (cut) return { view: cutLine(cut[1]!), silent: cut[1]! };
  const unsure = text.match(/^Delivery to ([^\n]+?) could not be confirmed\./);
  if (unsure) return { view: { form: 'attention', tone: 'warn', parts: ['Not sure ', { agent: unsure[1]! }, ' got the message'], door: { to: 'chat', agent: unsure[1]! } } };
  const gone = text.match(/^([^\n]+?) is no longer available\.$/);
  if (gone) return { view: { form: 'attention', tone: 'plain', parts: [{ agent: gone[1]! }, ' was removed before it answered'] } };
  // The person's Chief of Staff in another workplace (note #753) that could
  // not answer, or whose answer never came: said, never a grey line.
  const crossFailed = text.match(/^Your (Chief of Staff in [^\n]+?) could not answer: ([\s\S]+)$/);
  if (crossFailed) return { view: { form: 'attention', tone: 'warn', parts: [{ agent: crossFailed[1]! }, ` could not answer: ${crossFailed[2]!}`] } };
  const crossSilent = text.match(/^No answer came from your (Chief of Staff in [^\n]+?)\. /);
  if (crossSilent) return { view: { form: 'attention', tone: 'warn', parts: [{ agent: crossSilent[1]! }, ' did not answer'] } };
  // The connection-restarted family (note #455), the row in the owner's
  // screenshot. Picked up again: the work simply carries on, so nothing is
  // said. Not picked up: the person's request was not done, which is said
  // under it. A restart during a reaction to an agent's answer, or with no
  // request to name, concerns nothing the person asked for.
  if (text.startsWith('The connection restarted before ')) {
    if (!text.startsWith('The connection restarted before your request "') || /Picking it up again now\.$/.test(text)) return { view: { form: 'hidden' } };
    return { ...row, failed: { reason: 'Not finished', retry: 'resend' } };
  }
  return row;
}

function silentLine(agent: string): RecapRowView {
  return { form: 'attention', tone: 'warn', parts: [{ agent }, ' finished without answering'], door: { to: 'chat', agent } };
}
function cutLine(agent: string): RecapRowView {
  return { form: 'attention', tone: 'warn', parts: [{ agent }, ' stopped without answering — its turn may have been cut short'], door: { to: 'chat', agent } };
}

/**
 * Every row's view, in order. The rows are the conversation as answered
 * (the backend has already left out what it never shows: quiet event-turn
 * answers, note receipts from before note #623).
 */
export function recapRowViews(messages: RecapMessage[]): RecapRowView[] {
  const facts = messages.map(factOf);
  const views = facts.map((fact) => fact.view);
  const lastOwner = messages.map((message) => message.role).lastIndexOf('owner');
  facts.forEach((fact, at) => {
    // A fresh-chat ask is the first half of a hand-off: when the next row
    // drawn is the send it prepared, it becomes that line's tail.
    if (fact.freshFor) {
      let next = at + 1;
      while (next < views.length && views[next]!.form === 'hidden') next++;
      const sent = facts[next];
      const view = views[next];
      const ownFresh = fact.view.form === 'did' && Boolean(fact.view.own);
      if (sent?.sentTo === fact.freshFor && view?.form === 'did' && Boolean(view.own) === ownFresh) {
        views[at] = { form: 'hidden' };
        views[next] = { ...view, parts: [...view.parts, ' · fresh chat first'] };
      }
    }
    // The sweep's no-reply event (note #716) is the same moment the wait's
    // own row already said, for the same hand-off: one row, not two.
    if (fact.silentEvent) {
      for (let back = at - 1; back >= 0; back--) {
        if (facts[back]!.sentTo === fact.silentEvent) break;
        if (facts[back]!.silent === fact.silentEvent) { views[at] = { form: 'hidden' }; break; }
      }
    }
    // A request that did not complete is said once, under the person's own
    // words — the newest of them since the last real reply, which is the
    // request the failed turn was carrying out. A failure with no such words
    // above it (a turn reacting to an agent's answer) says so on its own.
    if (fact.failed) {
      let anchor = -1;
      for (let back = at - 1; back >= 0; back--) {
        const message = messages[back]!;
        if (message.kind === 'new-chat-divider') break;
        if (message.role === 'owner') { anchor = back; break; }
        if (message.role === 'assistant' && !facts[back]!.failed && views[back]!.form === 'row') break;
      }
      if (anchor < 0) { views[at] = { form: 'unfinished', reason: fact.failed.reason }; return; }
      views[at] = { form: 'hidden' };
      const retry = anchor === lastOwner && (fact.failed.retry === 'continue' || !messages[anchor]!.files?.length) ? fact.failed.retry : undefined;
      views[anchor] = { form: 'row', unfinished: { reason: fact.failed.reason, ...(retry ? { retry } : {}) } };
    }
  });
  return views;
}
