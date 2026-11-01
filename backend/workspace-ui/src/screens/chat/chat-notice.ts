/**
 * The words a stopped turn ends on, in the reader's own voice. Exported
 * because the Workspace Agent's conversation says them BEFORE the machine's
 * row arrives (note #453): the tap is answered at once, and the sentence
 * that stands in must not be a different sentence from the one that replaces
 * it — a line that rewords itself under the reader reads as two events.
 */
export const TURN_STOPPED = 'You stopped this turn';
/** The same stop done for the reader by their Workspace Agent (note #462) —
 *  the Chief of Staff, in the reader's words (note #715). The stored row
 *  keeps the platform's own name; this is what it says on screen. */
export const TURN_STOPPED_BY_WORKSPACE_AGENT = 'Chief of Staff stopped this turn';
/** The opening of the line a model or effort change by the Chief of Staff
 *  reads as (note #776); the stored row keeps the platform's own name. */
export const WORKSPACE_AGENT_CHANGED_RUNTIME = 'Chief of Staff changed the';

/**
 * What a platform row in the transcript actually SAYS, and who is speaking —
 * ported from the legacy `peerChatMessage` and `platformChatNotice`.
 *
 * Platform turns are addressed to the AGENT, so their stored text quite
 * properly includes authority boundaries and recovery commands. Printing that
 * payload to the owner leaks implementation prose into their messenger. These
 * recognisers are deliberately anchored to the platform's own emitted
 * sentences: known events become small receipts, and an unknown future event
 * still falls back to all of its words (minus the redundant [Platform] tag),
 * so presentation can never make a new kind of news disappear.
 *
 * Pure, and tested on its own: nothing here touches the DOM, and every string
 * it returns is drawn as TEXT by the row. The classes on a detail's pieces
 * come from the recogniser, never from the message.
 */

import type { IconName } from '../../ui/icons.js';
import { personName } from '../../ui/chief-of-staff.js';

/** A detail line is one string, or — when the recogniser found something
 *  worth colouring — pieces: a bare string, or a [text, class] pair. */
export type NoticeDetail = string | Array<string | [string, string]>;

export interface ChatNotice {
  /** Knowledge proposals keep the same receipt structure as other platform
   *  events, but wear the quieter, tighter treatment requested for them in
   *  chat (note #425). Kept as structure rather than inferred from `label`,
   *  so changing the visible eyebrow cannot silently change the card. */
  kind?: 'knowledge';
  /** A mark only when it earns the space. Generic, change-proposal and
   *  knowledge-proposal receipts deliberately omit one (note #448). */
  icon: IconName | null;
  label: string;
  badge: string;
  tone: '' | 'act' | 'ok' | 'mut' | 'warn' | 'note';
  title: string;
  detail: NoticeDetail;
  meta: string;
  /** What the door SAYS, when the row carries one. An ask is decided; an
   *  outcome is read — offering "Review and decide" over a merged change
   *  invites a tap on buttons that are not there. */
  door?: string;
  /** The quick note this receipt is ABOUT, when it names one. The row turns
   *  it into a door: the reader who sees "Picking up note #242" is reaching
   *  for that note (notes #263/#284), and until this the number was ink they
   *  had to go and look up. A card puts the door on its own line; a `quiet`
   *  row has no line to spare, so the phrase in its sentence is the link. */
  note?: string;
  /** Drawn as one quiet centred line instead of a card. The row paints the
   *  `title` alone: no icon tile, no eyebrow, no badge, no detail or meta —
   *  so those fields say what the event IS for anyone reading this file, and
   *  nothing on a quiet notice is ever furniture on the screen.
   *
   *  Two kinds of row qualify, and neither is news ARRIVING: an event the
   *  reader themselves caused (note #384), and the fresh-chat receipt that
   *  stands under the reset rule (note #394). A quiet line may still name a
   *  `note` — the phrase inside the sentence becomes the link, exactly as a
   *  note named in any other message does — but a row with a PROPOSAL behind
   *  it is news from elsewhere, and keeps its card. */
  quiet?: true;
}

const clean = (text: string): string => String(text ?? '').trim().replace(/^\[Platform\]\s*/, '');

/**
 * The words another agent sent this one, and who sent them — or null for
 * anything else on the platform channel (note #183).
 *
 * A peer message is stored on that channel because it arrives from outside
 * the conversation, but it is not an EVENT: nothing happened to the agent's
 * work, somebody spoke to it. Recognising it here rather than inside the
 * notice recogniser is the whole point — a notice is a receipt, and this
 * needs the message renderer instead.
 *
 * Both wordings are matched on purpose. The platform said "Handoff from
 * agent X" until that note, and those rows sit in every existing chat; a
 * reader scrolling back deserves the same message the new ones draw, which a
 * presentation-side recogniser gives for free and a stored-text change never
 * could.
 */
export function peerChatMessage(text: string): { from: string; text: string } | null {
  const peer = clean(text).match(/^(?:Message|Handoff) from agent ([^:]+):\s*([\s\S]+)$/);
  return peer ? { from: personName(peer[1]!), text: peer[2]! } : null;
}

export function platformChatNotice(text: string): ChatNotice {
  const body = clean(text);

  // The REQUESTS, before the outcomes (note #146): these rows are the chat's
  // approve/reject ask, written by the backend when `pr create` / `knowledge
  // propose` runs. Their row carries `open`, which is what makes the card a
  // door; the words here only have to say what is being asked.
  const prAsk = body.match(/^PR #(\d+) \("([\s\S]+?)"\) in ([^\n]+?) awaits your decision: ([^\n]+?) → ([^\n]+?)\. ([^\n]+?)\. Nothing lands on your protected branch/);
  if (prAsk) {
    // "2 files, +87 −2 · checks passed". The two counts come out as their own
    // pieces so the card can paint them the green and red every other screen
    // gives them. Split HERE, where the sentence is already being parsed, and
    // never by sniffing the finished line: `−` is U+2212 in the template and
    // a hyphen in a branch, so a rule loose enough to find the count would
    // also redden the "-159" inside `note-159-card-press`.
    const stat = prAsk[6]!.match(/^([\s\S]*?)(\+\d+) (−\d+)([\s\S]*)$/);
    const head = `${prAsk[4]} → ${prAsk[5]} · `;
    return {
      icon: null, label: 'Change proposal', badge: 'Awaiting approval', tone: 'act',
      door: 'Review and decide',
      title: prAsk[2]!,
      detail: stat
        ? [head + stat[1]!, [stat[2]!, 'plus'], ' ', [stat[3]!, 'minus'], stat[4]!]
        : head + prAsk[6],
      meta: `PR #${prAsk[1]} · ${prAsk[3]}`,
    };
  }

  const kpAsk = body.match(/^Knowledge proposal #(\d+) \("([\s\S]+?)"\) awaits your decision — ([\s\S]+?)\. Nothing changes until you approve\./);
  if (kpAsk) {
    return {
      kind: 'knowledge',
      icon: null, label: 'Knowledge proposal', badge: 'Awaiting approval', tone: 'act',
      door: 'Review and decide',
      title: kpAsk[2]!, detail: kpAsk[3]!,
      meta: `Proposal #${kpAsk[1]}`,
    };
  }

  const merged = body.match(/^Your user APPROVED PR #(\d+) \("([\s\S]+?)"\) in ([^:\n]+): ([^\n]+?) is merged into ([^\n]+?)\.(?:\n|$)/);
  if (merged) {
    return {
      icon: null, label: 'Change proposal', badge: 'Merged', tone: 'ok',
      // The card that says a change landed is the one card a reader most
      // wants to open: behind it are the frozen diff of what landed and the
      // delivery line that says whether it reached production yet.
      door: 'See what changed',
      title: merged[2]!, detail: `${merged[4]} → ${merged[5]}`,
      meta: `PR #${merged[1]} · ${merged[3]}`,
    };
  }

  // Merged by auto-approve mode (note #944): the same card as a merge, but
  // its badge and line say no person decided it — the reader must never take
  // it for their own approval.
  const automatic = body.match(/^PR #(\d+) \("([\s\S]+?)"\) in ([^\n]+?) was APPROVED AUTOMATICALLY: ([^\n]+?) is merged into ([^\n]+?)\. Auto-approve mode is on in this workplace \(turned on by ([^\n]+?) at ([^\n)]+?)\)/);
  if (automatic) {
    return {
      icon: null, label: 'Change proposal', badge: 'Merged automatically', tone: 'ok',
      door: 'See what changed',
      title: automatic[2]!,
      detail: `${automatic[4]} → ${automatic[5]} · auto-approve mode, turned on by ${automatic[6]} at ${automatic[7]}`,
      meta: `PR #${automatic[1]} · ${automatic[3]}`,
    };
  }

  const rejected = body.match(/^Your user REJECTED PR #(\d+) \("([\s\S]+?)"\) in ([\s\S]+?)\. Nothing was merged\./);
  if (rejected) {
    const reason = body.match(/Their reason: "([\s\S]*?)" — address/);
    return {
      icon: null, label: 'Change proposal', badge: 'Rejected', tone: 'mut',
      door: 'See the proposal',
      title: rejected[2]!, detail: reason ? `Reason: ${reason[1]}` : '',
      meta: `PR #${rejected[1]} · ${rejected[3]}`,
    };
  }

  const conflict = body.match(/^PR #(\d+) \("([\s\S]+?)"\) in ([\s\S]+?) could NOT be merged: ([^\n]+?) conflicts with ([^\n]+?)\. Nothing was changed\./);
  if (conflict) {
    return {
      icon: null, label: 'Change proposal', badge: 'Conflict', tone: 'warn',
      door: 'See the proposal',
      title: conflict[2]!, detail: `${conflict[4]} conflicts with ${conflict[5]}`,
      meta: `PR #${conflict[1]} · ${conflict[3]}`,
    };
  }

  const knowledge = body.match(/^Your user (APPROVED|REJECTED) knowledge proposal #(\d+) \("([\s\S]+?)"\)\./);
  if (knowledge) {
    const live = knowledge[1] === 'APPROVED';
    const reason = live ? null : body.match(/They said: "([\s\S]*?)"(?:\.|$)/);
    return {
      kind: 'knowledge',
      icon: null, label: 'Knowledge proposal', badge: live ? 'Live' : 'Rejected', tone: live ? 'ok' : 'mut',
      door: live ? 'See what changed' : 'See the proposal',
      title: knowledge[3]!, detail: reason ? `Reason: ${reason[1]}` : '',
      meta: `Proposal #${knowledge[2]}`,
    };
  }

  const knowledgeConflict = body.match(/^Knowledge proposal #(\d+) could NOT be applied: ([\s\S]+?) changed after you wrote it,/);
  if (knowledgeConflict) {
    return {
      kind: 'knowledge',
      icon: null, label: 'Knowledge proposal', badge: 'Conflict', tone: 'warn',
      door: 'See the proposal',
      title: 'The page changed before approval',
      detail: `${knowledgeConflict[2]} needs to be updated and proposed again.`,
      meta: `Proposal #${knowledgeConflict[1]}`,
    };
  }

  // A fresh-chat handoff is the agent's private note to itself. The harness
  // needs every word; the owner only needs the clean-chat receipt — and, when
  // it resumes a quick note, that note's safe public number. Match the stable
  // opening rather than printing the handoff or its operational tail, so
  // neither old rows nor future wording changes leak it onto the screen.
  //
  // And it says it QUIETLY (note #394). A reset is a boundary in the
  // conversation, not news arriving from elsewhere: the reader either asked
  // for it or watched the agent say it was starting one, and the reset rule
  // is already drawn on the line above. A bordered card with an icon tile, an
  // uppercase eyebrow and the transcript's boldest line made the least
  // eventful row on the screen the one that pulls the eye hardest.
  const freshPrefix =
    'Fresh conversation. You reset the previous one yourself and left this handoff for exactly this moment:';
  if (body.startsWith(freshPrefix)) {
    // Limit the read to the handoff, before the platform's own tail, so
    // future operational wording cannot accidentally become display data.
    const handoff = body.slice(freshPrefix.length).split('\n\nThis is your own note,')[0]!;
    const note = handoff.match(/\b(?:quick\s+)?note\s+#(\d+)\b/i);
    if (note) {
      return {
        icon: 'note', label: 'Fresh chat', badge: '', tone: 'note',
        title: `Picking up note #${note[1]}`, detail: '', meta: '',
        note: note[1]!, quiet: true,
      };
    }
    return {
      icon: 'shadow', label: 'Fresh chat', badge: '', tone: '',
      title: 'Picking up saved work', detail: '', meta: '', quiet: true,
    };
  }

  // The one event on this channel the reader performed THEMSELVES, phone in
  // hand, watching the screen (note #384). A card gave their own tap the
  // weight of news arriving from elsewhere — icon tile, eyebrow, "Stopped"
  // chip — so the least surprising row in the conversation drew the eye
  // hardest. Quiet: the sentence alone, in the day rail's voice.
  if (body === 'Turn stopped by the user.') {
    return { icon: 'x', label: 'Turn', badge: '', tone: '', title: TURN_STOPPED, detail: '', meta: '', quiet: true };
  }
  // The same stop, done for the reader by their Workspace Agent with
  // `agentbuilt agent stop` (note #462). Named, because "You stopped this
  // turn" would be false on their screen; its reason, when it gave one,
  // rides the same quiet line — a quiet row shows its title alone.
  const byWorkspaceAgent = body.match(/^Turn stopped by Workspace Agent(?:\.|: ([\s\S]+))$/);
  if (byWorkspaceAgent) {
    const why = byWorkspaceAgent[1]?.trim();
    return {
      icon: 'x', label: 'Turn', badge: '', tone: '',
      title: why ? `${TURN_STOPPED_BY_WORKSPACE_AGENT}: ${why}` : TURN_STOPPED_BY_WORKSPACE_AGENT,
      detail: '', meta: '', quiet: true,
    };
  }

  // The reader's Chief of Staff changed what this agent runs on, because
  // they asked it to (`agentbuilt agent model`, note #776). Quiet, like the
  // stop above: the reader asked for it, and the chat header already shows
  // the new pair — the line says who changed it and from when.
  // Schedules (note #779): the ask and its outcomes, in the target agent's
  // chat. The ask is decided on the agent's screen, under Schedule.
  const scheduleAsk = body.match(/^([^\n]+?) (?:asked for a schedule|proposed a schedule for [^\n]+?): "([\s\S]+?)" ([^\n]+?)\. Approve or reject it under Schedule on this screen\.$/);
  if (scheduleAsk) {
    return {
      icon: null, label: 'Schedule', badge: 'Awaiting approval', tone: 'act',
      title: scheduleAsk[2]!, detail: scheduleAsk[3]!, meta: `Proposed by ${scheduleAsk[1]}`,
    };
  }
  const scheduleDecided = body.match(/^Schedule (approved|rejected): ([\s\S]+?)\.$/);
  if (scheduleDecided) {
    const approved = scheduleDecided[1] === 'approved';
    return {
      icon: null, label: 'Schedule', badge: approved ? 'Approved' : 'Rejected', tone: approved ? 'ok' : 'mut',
      title: scheduleDecided[2]!, detail: '', meta: '',
    };
  }
  const scheduleState = body.match(/^Schedule (paused|resumed|removed|proposal withdrawn)(?: for today)?(?::| by) ([\s\S]+?)\.?$/);
  if (scheduleState) {
    const paused = scheduleState[1] === 'paused';
    return {
      icon: null, label: 'Schedule', badge: scheduleState[1]!.charAt(0).toUpperCase() + scheduleState[1]!.slice(1), tone: paused ? 'warn' : 'ok',
      title: scheduleState[2]!.replace(/\.$/, ''), detail: '', meta: '',
    };
  }

  const runtimeChanged = body.match(/^(Model and effort|Model|Effort) changed by Workspace Agent: (\S+) at (\S+) effort, from the next turn\.$/);
  if (runtimeChanged) {
    return {
      icon: 'shadow', label: 'Model', badge: '', tone: '',
      title: `${WORKSPACE_AGENT_CHANGED_RUNTIME} ${runtimeChanged[1]!.toLowerCase()}: ${runtimeChanged[2]} at ${runtimeChanged[3]} effort, from the next turn`,
      detail: '', meta: '', quiet: true,
    };
  }

  // Granted at once (note #739): the owner is told, not asked. The exact
  // words agent-service writes (tellOwnerCiSecretsGranted / tellOwnerPublishLinked).
  const secretsGranted = body.match(/^(.+?) handed ([\s\S]+?) to approved checks in ([\s\S]+?)\. Only runs on the protected branch/);
  if (secretsGranted) {
    return {
      icon: 'key', label: 'CI secrets', badge: 'Granted', tone: 'ok',
      title: 'Approved checks can use these secrets', detail: secretsGranted[2]!, meta: secretsGranted[3]!,
    };
  }

  const publishLinked = body.match(/^(.+?) linked ([\s\S]+?) to ([\s\S]+?): from now on, approving a change to/);
  if (publishLinked) {
    return {
      icon: 'globe', label: 'Publishing', badge: 'On approval', tone: 'ok',
      title: `Approved changes publish ${publishLinked[3]}`, detail: 'Once their checks pass, with nobody deploying.', meta: publishLinked[2]!,
    };
  }

  // The four below are history: the owner's answers from when these were
  // asked. Nothing writes them since note #739, but old rows still read.
  const secretsKept = body.match(/^Your user DECLINED handing ([\s\S]+?) to CI runs of ([\s\S]+?)\. Do not re-ask/);
  if (secretsKept) {
    return {
      icon: 'key', label: 'CI secrets', badge: 'Kept private', tone: 'mut',
      title: 'Secrets were not shared with checks', detail: secretsKept[1]!, meta: secretsKept[2]!,
    };
  }

  const secretsAllowed = body.match(/^Your user ALLOWED it: CI runs of ([\s\S]+?) on its protected branch now receive ([\s\S]+?) in their environment,/);
  if (secretsAllowed) {
    return {
      icon: 'key', label: 'CI secrets', badge: 'Allowed', tone: 'ok',
      title: 'Approved checks can use these secrets', detail: secretsAllowed[2]!, meta: secretsAllowed[1]!,
    };
  }

  const publishAllowed = body.match(/^Your user ALLOWED it: approved changes to ([\s\S]+?) now publish ([\s\S]+?) on their own/);
  if (publishAllowed) {
    return {
      icon: 'globe', label: 'Publishing', badge: 'On approval', tone: 'ok',
      title: `Approved changes publish ${publishAllowed[2]}`, detail: 'Once their checks pass, with nobody deploying.', meta: publishAllowed[1]!,
    };
  }

  const publishKept = body.match(/^Your user chose to keep publishing ([\s\S]+?) by hand:/);
  if (publishKept) {
    return {
      icon: 'globe', label: 'Publishing', badge: 'By hand', tone: 'mut',
      title: 'Approved changes are published by hand', detail: '', meta: publishKept[1]!,
    };
  }

  const siteDeleted = body.match(/^Your user DELETED the site ([^.]+)\./);
  if (siteDeleted) {
    return {
      icon: 'globe', label: 'Site', badge: 'Deleted', tone: 'mut',
      title: `${siteDeleted[1]} stopped serving`, detail: 'Its address stays reserved to you.', meta: '',
    };
  }

  const deleteDecision = body.match(/^Your user (KEPT|DELETED) ([^—.]+?)(?:\s+—| from their workspace\.)/);
  if (deleteDecision) {
    const kept = deleteDecision[1] === 'KEPT';
    return {
      icon: 'archive', label: 'Delete request', badge: kept ? 'Kept' : 'Deleted', tone: 'mut',
      title: deleteDecision[2]!.trim() + (kept ? ' was kept' : ' was deleted'), detail: '', meta: '',
    };
  }

  const recycle = body.match(/^(.+?'s machine) has been idle a while, so it gets recycled ([^.]+) to keep costs down\./);
  if (recycle) {
    return {
      icon: 'drive', label: 'Machine', badge: 'Heads up', tone: '',
      title: `${recycle[1]} gets recycled ${recycle[2]}`, detail: 'Any message keeps it.', meta: '',
    };
  }

  // Known outcome prompts carry an agent-only second paragraph. If a wording
  // change misses the specific recogniser above, keep its human-facing first
  // paragraph while still removing the internal "run this command" tail.
  const visible = body.replace(/\n\nThis is the outcome of (?:the )?(?:change|knowledge) proposal[\s\S]*$/, '');
  const sentence = visible.match(/^([\s\S]*?[.!?])(?:\s+([\s\S]+))?$/);
  return {
    icon: null, label: '', badge: '', tone: '',
    title: sentence ? sentence[1]! : 'Update',
    detail: sentence && sentence[2] ? sentence[2] : (sentence ? '' : visible),
    meta: '',
  };
}

/** The badge's tone class. `act` is a thing waiting on the reader — the
 *  accent chip Home's queue wears, not an outcome's grey. */
export function badgeTone(tone: ChatNotice['tone']): string {
  return tone === 'ok' ? 'badge ok' : tone === 'warn' ? 'badge warn' : tone === 'act' ? 'badge' : 'badge mut';
}

/** A knowledge proposal's state is a coloured WORD, not a chip (note #425).
 *  Rejection is deliberately danger ink even though the rest of the rejected
 *  receipt stays muted: the outcome must not read like neutral metadata. */
export function noticeBadgeClass(notice: Pick<ChatNotice, 'kind' | 'badge' | 'tone'>): string {
  if (notice.kind !== 'knowledge') return badgeTone(notice.tone);
  if (notice.badge === 'Rejected' || notice.tone === 'warn') return 'chatnoticestatus danger';
  if (notice.tone === 'ok') return 'chatnoticestatus ok';
  if (notice.tone === 'act') return 'chatnoticestatus act';
  return 'chatnoticestatus mut';
}

/** Only three tones colour the CARD; the rest is the ordinary receipt. */
export function cardTone(tone: ChatNotice['tone']): string {
  return tone === 'ok' || tone === 'warn' || tone === 'note' ? `chatnotice ${tone}` : 'chatnotice';
}

/** The divider's word for a day: the near ones by name, the rest by date, and
 *  the year only once it is not this one's. */
export function chatDayLabel(at: string, now = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
