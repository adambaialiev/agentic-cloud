import { describe, expect, it } from 'vitest';
import { chatDayLabel, peerChatMessage, platformChatNotice } from './chat-notice.js';

/**
 * The recognisers behind the chat's platform rows, held to the same things
 * the legacy page's own tests hold them to (telegram-miniapp-page.test.ts):
 * a known event becomes a small receipt, an unknown one still says all of
 * its words, and no operational tail addressed to the AGENT reaches the
 * owner's screen.
 */

describe('a peer agent speaking', () => {
  it('is a message, not an event — under both wordings', () => {
    expect(peerChatMessage('[Platform] Message from agent Oscar: rebased on main')).toEqual({
      from: 'Oscar', text: 'rebased on main',
    });
    // The platform said "Handoff from agent X" until note #183, and those
    // rows are sitting in every existing chat.
    expect(peerChatMessage('Handoff from agent Mia: took the note')).toEqual({ from: 'Mia', text: 'took the note' });
  });

  it('leaves every other platform row to the receipt renderer', () => {
    expect(peerChatMessage('[Platform] Turn stopped by the user.')).toBeNull();
    expect(peerChatMessage('Your user APPROVED PR #4 ("x") in repo: a is merged into main.')).toBeNull();
  });
});

describe('the change-proposal ask', () => {
  const ask = '[Platform] PR #12 ("Move Home to React") in infinite-agents awaits your decision: '
    + 'slice-2 → main. 9 files, +870 −20 · checks passed. Nothing lands on your protected branch until you say so.';

  it('reads as a decision waiting on the reader, with the counts split for colour', () => {
    const notice = platformChatNotice(ask);
    expect(notice.icon).toBeNull();
    expect(notice.label).toBe('Change proposal');
    expect(notice.badge).toBe('Awaiting approval');
    expect(notice.tone).toBe('act');
    expect(notice.door).toBe('Review and decide');
    expect(notice.title).toBe('Move Home to React');
    expect(notice.meta).toBe('PR #12 · infinite-agents');
    // The counts come out as their own pieces so the card can paint them; a
    // rule loose enough to find them by sniffing the finished line would also
    // redden the hyphens in a branch name.
    expect(notice.detail).toEqual([
      'slice-2 → main · 9 files, ', ['+870', 'plus'], ' ', ['−20', 'minus'], ' · checks passed',
    ]);
  });

  it('keeps the whole line as one string when the counts are not in it', () => {
    const notice = platformChatNotice(ask.replace('9 files, +870 −20 · checks passed', 'checks passed'));
    expect(notice.detail).toBe('slice-2 → main · checks passed');
  });
});

describe('the outcomes', () => {
  it('a merged change is worth LOOKING at, not deciding', () => {
    const notice = platformChatNotice(
      'Your user APPROVED PR #12 ("Move Home to React") in infinite-agents: slice-2 is merged into main.\n'
      + '\nThis is the outcome of the change proposal you opened; run `agentbuilt repo checks` next.',
    );
    expect(notice.badge).toBe('Merged');
    expect(notice.tone).toBe('ok');
    expect(notice.door).toBe('See what changed');
    expect(notice.detail).toBe('slice-2 → main');
    expect(notice.meta).toBe('PR #12 · infinite-agents');
  });

  it('a change merged by auto-merge says no person decided it (note #944)', () => {
    const notice = platformChatNotice(
      '[Platform] PR #12 ("Move Home to React") in agentic-cloud was APPROVED AUTOMATICALLY: slice-2 is merged into main.'
      + ' Auto-merge is on for your user (turned on by Adam at 1 Nov 2026, 15:02 UTC), so no person read it before it merged.'
      + ' Say so when you report it — never that your user approved it.'
      + '\n\nThis is the outcome of the change proposal you opened — not a new request from your user.',
    );
    expect(notice.badge).toBe('Merged automatically');
    expect(notice.tone).toBe('ok');
    expect(notice.door).toBe('See what changed');
    expect(notice.title).toBe('Move Home to React');
    expect(notice.detail).toBe('slice-2 → main · auto-merge, turned on by Adam at 1 Nov 2026, 15:02 UTC');
    expect(notice.meta).toBe('PR #12 · agentic-cloud');
  });

  it('a rejected change carries the reason and nothing to decide', () => {
    const notice = platformChatNotice(
      'Your user REJECTED PR #12 ("Move Home to React") in infinite-agents. Nothing was merged. '
      + 'Their reason: "too big" — address it and propose again.',
    );
    expect(notice.badge).toBe('Rejected');
    expect(notice.door).toBe('See the proposal');
    expect(notice.detail).toBe('Reason: too big');
  });

  it('a conflict says what it conflicts with', () => {
    const notice = platformChatNotice(
      'PR #12 ("Move Home") in infinite-agents could NOT be merged: slice-2 conflicts with main. Nothing was changed.',
    );
    expect(notice.badge).toBe('Conflict');
    expect(notice.tone).toBe('warn');
    expect(notice.detail).toBe('slice-2 conflicts with main');
  });

  it('a knowledge decision keeps its own verbs without an icon', () => {
    const live = platformChatNotice('Your user APPROVED knowledge proposal #7 ("Rooms").');
    expect(live.kind).toBe('knowledge');
    expect(live.icon).toBeNull();
    expect(live.badge).toBe('Live');
    expect(live.door).toBe('See what changed');
    const no = platformChatNotice('Your user REJECTED knowledge proposal #7 ("Rooms"). They said: "not yet".');
    expect(no.badge).toBe('Rejected');
    expect(no.detail).toBe('Reason: not yet');
  });
});

describe('rows whose full text is for the agent alone', () => {
  it('a fresh-chat handoff shows the receipt and the safe note number only', () => {
    const notice = platformChatNotice(
      'Fresh conversation. You reset the previous one yourself and left this handoff for exactly this moment: '
      + 'continue quick note #256, the token is sk-xyz.\n\nThis is your own note, addressed to you.',
    );
    expect(notice.title).toBe('Picking up note #256');
    expect(notice.icon).toBe('note');
    expect(notice.detail).toBe('');
    expect(JSON.stringify(notice)).not.toContain('sk-xyz');
    // The number the receipt names is the door it carries (notes #263/#284).
    expect(notice.note).toBe('256');
    // …and note #394: the row is a quiet line, so that door is the anchor
    // inside its sentence rather than a card's own verb.
    expect(notice.quiet).toBe(true);
    expect(notice.door).toBeUndefined();
  });

  it('a handoff naming no note still says only that work was picked up', () => {
    const notice = platformChatNotice(
      'Fresh conversation. You reset the previous one yourself and left this handoff for exactly this moment: '
      + 'the deploy is half done.',
    );
    expect(notice.title).toBe('Picking up saved work');
    expect(notice.icon).toBe('shadow');
    // No note named, no door to one.
    expect(notice.note).toBeUndefined();
    expect(notice.quiet).toBe(true);
  });

  // Note #394. A reset is a boundary the reader asked for, standing under the
  // rule that already marks it — so both wordings speak in the day rail's
  // voice, and nothing that would be furniture on a quiet line is set.
  it('says a fresh chat quietly, either way it is worded', () => {
    for (const tail of ['pick up quick note #256.', 'the deploy is half done.']) {
      const notice = platformChatNotice(
        'Fresh conversation. You reset the previous one yourself and left this handoff for exactly this moment: '
        + tail,
      );
      expect(notice.quiet).toBe(true);
      expect(notice.badge).toBe('');
      expect(notice.detail).toBe('');
      expect(notice.meta).toBe('');
      expect(notice.door).toBeUndefined();
    }
  });

  it('an unknown event keeps its human first paragraph and drops the command tail', () => {
    const notice = platformChatNotice(
      'Something new happened. It has a second sentence.\n\nThis is the outcome of the change proposal you opened; run x.',
    );
    // A generic event has no meaningful category mark. Note #448 removes the
    // robot and the redundant "Platform" eyebrow rather than replacing them
    // with different furniture.
    expect(notice.icon).toBeNull();
    expect(notice.label).toBe('');
    expect(notice.title).toBe('Something new happened.');
    expect(notice.detail).toBe('It has a second sentence.');
  });

  it('does not put the removed product word back into an empty generic update', () => {
    expect(platformChatNotice('')).toMatchObject({ icon: null, label: '', title: 'Update' });
  });
});

describe('the small receipts', () => {
  it('names the ones with no proposal behind them', () => {
    expect(platformChatNotice('Turn stopped by the user.').title).toBe('You stopped this turn');
    expect(platformChatNotice('Your user DELETED the site shop.').title).toBe('shop stopped serving');
    expect(platformChatNotice("Leo's machine has been idle a while, so it gets recycled tomorrow to keep costs down.").title)
      .toBe("Leo's machine gets recycled tomorrow");
    expect(platformChatNotice('Your user ALLOWED it: CI runs of infinite-agents on its protected branch now receive GH_TOKEN in their environment, so checks can push.').badge)
      .toBe('Allowed');
  });

  it('turns a grant made at once (note #739) into a receipt that names the keys, or the site', () => {
    // The exact words agent-service writes (tellOwnerCiSecretsGranted /
    // tellOwnerPublishLinked): the owner is told, not asked.
    const keys = platformChatNotice('Iris handed Growth\'s DEPLOY_TOKEN, FLY_TOKEN to approved checks in ship-it. Only runs on the protected branch receive them. '
      + 'Repositories → ship-it in the Workspace shows the grant; ask any agent to take a name back.');
    expect(keys).toMatchObject({ badge: 'Granted', title: 'Approved checks can use these secrets', detail: 'Growth\'s DEPLOY_TOKEN, FLY_TOKEN', meta: 'ship-it' });
    const linked = platformChatNotice('Juno linked ship-it to startup-game: from now on, approving a change to ship-it publishes it to startup-game '
      + 'as soon as its checks pass, with nobody deploying. Repositories → ship-it in the Workspace shows the link; ask any agent to go back to publishing by hand.');
    expect(linked).toMatchObject({ badge: 'On approval', title: 'Approved changes publish startup-game', meta: 'ship-it' });
  });

  it('turns the owner’s answer on publishing into a receipt, not the agent’s long instructions', () => {
    // The exact words agent-service wrote (decidePublishApproval, until note #739): the
    // agent needs the whole paragraph, the owner needs what they decided.
    const allowed = platformChatNotice('[Platform] Your user ALLOWED it: approved changes to ship-it now publish startup-game on their own, as you.'
      + ' After a run of .agentbuilt/ci.sh on the protected branch passes, the repo\'s .agentbuilt/deploy.sh runs on the same machine.');
    expect(allowed).toMatchObject({ badge: 'On approval', title: 'Approved changes publish startup-game', meta: 'ship-it' });
    const kept = platformChatNotice('[Platform] Your user chose to keep publishing ship-it by hand: approved changes do NOT go live on their own.');
    expect(kept).toMatchObject({ badge: 'By hand', title: 'Approved changes are published by hand', meta: 'ship-it' });
  });

  // Note #384. The reader stopped their own turn, watching the screen; a card
  // with a chip on it announces that back to them as news. Quiet is the whole
  // presentation, so the badge goes with the card rather than being drawn
  // somewhere quieter — nothing on a quiet notice is furniture.
  it('names the Workspace Agent — the Chief of Staff, in the reader\'s words (note #715) — when it did the stopping (note #462), with its reason on the same quiet line', () => {
    const plain = platformChatNotice('Turn stopped by Workspace Agent.');
    expect(plain).toMatchObject({ quiet: true, title: 'Chief of Staff stopped this turn', badge: '', detail: '', meta: '' });
    const why = platformChatNotice('[Platform] Turn stopped by Workspace Agent: note #456 changed, sending the new text.');
    expect(why.quiet).toBe(true);
    expect(why.title).toBe('Chief of Staff stopped this turn: note #456 changed, sending the new text.');
    expect(peerChatMessage('[Platform] Turn stopped by Workspace Agent.')).toBeNull();
    expect(plain.title).not.toBe('You stopped this turn');
  });

  it('says the Chief of Staff changed the model or effort (note #776) on one quiet line, with the pair and from when', () => {
    const both = platformChatNotice('Model and effort changed by Workspace Agent: sonnet at medium effort, from the next turn.');
    expect(both).toMatchObject({ quiet: true, title: 'Chief of Staff changed the model and effort: sonnet at medium effort, from the next turn', badge: '', detail: '', meta: '' });
    expect(platformChatNotice('[Platform] Effort changed by Workspace Agent: opus at max effort, from the next turn.').title)
      .toBe('Chief of Staff changed the effort: opus at max effort, from the next turn');
    expect(platformChatNotice('Producer asked for a schedule: "Take the next beat." every 8 minutes, 07:00–23:00 America/Los_Angeles, at most 120 turns a day. Approve or reject it under Schedule on this screen.'))
      .toMatchObject({ label: 'Schedule', badge: 'Awaiting approval', tone: 'act', title: 'Take the next beat.', meta: 'Proposed by Producer' });
    expect(platformChatNotice('Schedule approved: Producer wakes every 8 minutes, 07:00–23:00 UTC, no daily cap.'))
      .toMatchObject({ label: 'Schedule', badge: 'Approved', tone: 'ok' });
    expect(platformChatNotice('Schedule paused for today: Producer reached its daily cap (3 scheduled turns). It resumes at midnight UTC; Producer itself still answers you.'))
      .toMatchObject({ label: 'Schedule', badge: 'Paused', tone: 'warn' });
    expect(platformChatNotice('Schedule paused by you.')).toMatchObject({ badge: 'Paused', title: 'you' });
    expect(platformChatNotice('Model changed by Workspace Agent: gpt-6-luna at high effort, from the next turn.').title)
      .toBe('Chief of Staff changed the model: gpt-6-luna at high effort, from the next turn');
    expect(peerChatMessage('Model changed by Workspace Agent: opus at high effort, from the next turn.')).toBeNull();
  });

  it('the reader’s own stop is a quiet line, not a receipt', () => {
    const stopped = platformChatNotice('Turn stopped by the user.');
    expect(stopped.quiet).toBe(true);
    expect(stopped.title).toBe('You stopped this turn');
    expect(stopped.badge).toBe('');
    expect(stopped.detail).toBe('');
    expect(stopped.meta).toBe('');
    expect(stopped.door).toBeUndefined();
  });

  it('leaves every event that came from ELSEWHERE its card', () => {
    for (const text of [
      'Your user DELETED the site shop.',
      'Your user APPROVED PR #12 ("Move Home") in infinite-agents: slice-2 is merged into main.\n',
      "Leo's machine has been idle a while, so it gets recycled tomorrow to keep costs down.",
      'The deploy finished. It has a second sentence.',
    ]) expect(platformChatNotice(text).quiet).toBeUndefined();
  });
});

describe('the day divider', () => {
  it('names the near days and dates the rest', () => {
    const now = new Date('2026-09-02T12:00:00Z').getTime();
    expect(chatDayLabel(new Date(now).toISOString(), now)).toBe('Today');
    expect(chatDayLabel(new Date(now - 86_400_000).toISOString(), now)).toBe('Yesterday');
    expect(chatDayLabel(new Date(now - 5 * 86_400_000).toISOString(), now)).toMatch(/Aug/);
    // The year shows only once it is not this one's.
    expect(chatDayLabel('2025-12-01T12:00:00Z', now)).toMatch(/2025/);
  });
});
