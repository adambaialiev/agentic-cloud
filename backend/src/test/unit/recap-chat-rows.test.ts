import { describe, expect, it } from 'vitest';
import { recapRowViews } from '../../shared/recap-chat-rows.js';
import type { RecapMessage } from '../../shared/workspace-recap-chat.js';

const at = '2026-10-11T10:00:00.000Z';
let n = 0;
const owner = (text: string, extra: Partial<RecapMessage> = {}): RecapMessage => ({ id: `m${n++}`, role: 'owner', text, at, ...extra });
const reply = (text: string): RecapMessage => ({ id: `m${n++}`, role: 'assistant', text, at });
const action = (text: string, extra: Partial<RecapMessage> = {}): RecapMessage => ({ id: `m${n++}`, role: 'action', text, at, ...extra });
const answer = (name: string, text: string): RecapMessage => ({ id: `m${n++}`, role: 'agent', name, text, at });
const views = (...messages: RecapMessage[]) => recapRowViews(messages);

describe('how the Chief of Staff\'s rows are shown (note #725)', () => {
  it('draws the conversation itself and the decision cards as stored', () => {
    expect(views(
      owner('Where is Oscar?'),
      answer('Oscar', 'PR #1324 is ready.'),
      reply('Oscar is done.'),
      action('Forwarded PR #1324 in infinite-agents (Platform) — Back button', { proposals: [{ kind: 'pr', id: 'p1' }] }),
      action('Chief of Staff wants to reply to lena@example.com. Nothing will be sent until you approve it here.', { mailApprovalId: 'ma1' }),
      action('──────────', { kind: 'new-chat-divider' }),
      action('Turn stopped by the user.'),
    )).toEqual(Array(7).fill({ form: 'row' }));
  });

  it('keeps a receipt nobody recognises, so new news never disappears', () => {
    expect(views(action('Something brand new happened.'))).toEqual([{ form: 'row' }]);
  });

  it('says what it did for the person in one quiet line, the message behind a tap', () => {
    expect(views(action('Sent to Oscar: Adam asked for note #718. Claim it and read it with the picture.'))).toEqual([
      { form: 'did', parts: ['Sent to ', { agent: 'Oscar' }], body: 'Adam asked for note #718. Claim it and read it with the picture.' },
    ]);
    // The wording before note #457, still in older conversations.
    expect(views(action('Sent your request to Theo.'))).toEqual([{ form: 'did', parts: ['Sent to ', { agent: 'Theo' }] }]);
    expect(views(action('Stopped Oscar: note #718 changed. v1.2 broke. Its reply is no longer awaited.'))).toEqual([
      { form: 'did', parts: ['Stopped ', { agent: 'Oscar' }, ' — note #718 changed. v1.2 broke'] },
    ]);
    expect(views(action('Stopped Theo.'))).toEqual([{ form: 'did', parts: ['Stopped ', { agent: 'Theo' }] }]);
  });

  it('folds a fresh-chat ask into the send it prepared, and keeps one that prepared nothing', () => {
    expect(views(action('Asked Oscar for a fresh chat.'), action('Sent to Oscar: Take note #718.'))).toEqual([
      { form: 'hidden' },
      { form: 'did', parts: ['Sent to ', { agent: 'Oscar' }, ' · fresh chat first'], body: 'Take note #718.' },
    ]);
    // A hidden row between them does not part them.
    expect(views(action('Asked Oscar for a fresh chat.'), action('The connection restarted before this request finished. Any recorded actions above remain in place.'), action('Sent to Oscar: Go.'))[2])
      .toMatchObject({ parts: ['Sent to ', { agent: 'Oscar' }, ' · fresh chat first'] });
    expect(views(action('Asked Oscar for a fresh chat.'), action('Sent to Ben: Go.'))).toEqual([
      { form: 'did', parts: [{ agent: 'Oscar' }, ' starts a fresh chat'] },
      { form: 'did', parts: ['Sent to ', { agent: 'Ben' }], body: 'Go.' },
    ]);
  });

  it('tags what it did on its own, whatever the verb (note #716)', () => {
    expect(views(
      action('On its own: sent to Theo: Did the deploy finish?'),
      action('On its own: handed note #725 to Oscar: Let\'s not show the restart'),
      action('On its own: archived note #718: Back button'),
      action('On its own: asked Ben for a fresh chat.'),
      action('On its own: tidied something new.'),
    )).toEqual([
      { form: 'did', parts: ['Sent to ', { agent: 'Theo' }], body: 'Did the deploy finish?', own: true },
      { form: 'did', parts: ['Handed note #725 to ', { agent: 'Oscar' }, ' — Let\'s not show the restart'], own: true },
      { form: 'did', parts: ['Archived note #718 — Back button'], own: true },
      { form: 'did', parts: [{ agent: 'Ben' }, ' starts a fresh chat'], own: true },
      { form: 'did', parts: ['Tidied something new.'], own: true },
    ]);
  });

  it('makes the ask to remove an agent a decision', () => {
    expect(views(action('Asked the person to remove Oscar: its work is finished.'), action('Asked the person to remove Ben.'))).toEqual([
      { form: 'remove-agent', agent: 'Oscar', reason: 'its work is finished' },
      { form: 'remove-agent', agent: 'Ben' },
    ]);
    // An ask to delete a room (note #740) stored before rooms left the
    // product (note #843) has nothing left to decide: it is still recognised
    // as its own form, which the screen drops, so it never comes back as a
    // grey row nobody can act on.
    expect(recapRowViews([
      { id: 'r1', role: 'action', at: '2026-10-12T07:00:00.000Z', text: 'Asked the person to delete the room Growth lab: the launch is over.', href: '/workspace/rooms/room-9?org=o1' },
      { id: 'r2', role: 'action', at: '2026-10-12T07:00:01.000Z', text: 'Asked the person to delete the room Sales.' },
    ]).map((view) => view.form)).toEqual(['remove-room', 'remove-room']);
  });

  it('gives a hand-off that fell through the door that does something about it', () => {
    expect(views(
      action('Oscar finished without sending a reply here. Its own conversation has the details.'),
      action('Delivery to Ben could not be confirmed. Open the agent\'s conversation before sending again.'),
      action('Rosa is no longer available.'),
    )).toEqual([
      { form: 'attention', tone: 'warn', parts: [{ agent: 'Oscar' }, ' finished without answering'], door: { to: 'chat', agent: 'Oscar' } },
      { form: 'attention', tone: 'warn', parts: ['Not sure ', { agent: 'Ben' }, ' got the message'], door: { to: 'chat', agent: 'Ben' } },
      { form: 'attention', tone: 'plain', parts: [{ agent: 'Rosa' }, ' was removed before it answered'] },
    ]);
  });

  it('says a silent agent once, though the sweep notices it again (note #716)', () => {
    const event = action('Oscar finished without sending back the answer the Chief of Staff was waiting for.', { kind: 'event' });
    const silent = action('Oscar finished without sending a reply here. Its own conversation has the details.');
    expect(views(action('Sent to Oscar: Go.'), silent, reply('Oscar went quiet.'), event)[3]).toEqual({ form: 'hidden' });
    // A later hand-off to the same agent is a new wait: its silence is news.
    expect(views(silent, action('Sent to Oscar: Again.'), event)[2]).toMatchObject({ form: 'attention', parts: [{ agent: 'Oscar' }, ' finished without answering'] });
    // On its own, the event is the same line.
    expect(views(event)[0]).toMatchObject({ form: 'attention', door: { to: 'chat', agent: 'Oscar' } });
  });

  it('says a wait whose turn never reached an end was cut short, not finished — once (note #734)', () => {
    const cut = action('Mia stopped working without sending a reply here; its turn may have been cut short. Its own conversation has the details.');
    const event = action('Mia stopped working without sending back the answer the Chief of Staff was waiting for; its turn may have been cut short.', { kind: 'event' });
    const line = { form: 'attention', tone: 'warn', parts: [{ agent: 'Mia' }, ' stopped without answering — its turn may have been cut short'], door: { to: 'chat', agent: 'Mia' } };
    expect(views(action('Sent to Mia: Go.'), cut, event)).toEqual([expect.anything(), line, { form: 'hidden' }]);
    expect(views(event)[0]).toEqual(line);
  });

  it('draws the other things it noticed as a small line above its reply', () => {
    const text = 'Checks failed on proposal #1324 "Back button" by Oscar: ci/checks.';
    expect(views(action(text, { kind: 'event', href: '/decisions/pr/p1' }))).toEqual([{ form: 'noticed', text }]);
  });

  it('never shows a restart that the work simply carried on through — the row in the owner\'s screenshot', () => {
    const asked = owner('Which agent is working on back button problem?');
    expect(views(
      asked,
      action('The connection restarted before your request "Which agent is working on back button problem?" finished. Nothing had been recorded for it. Picking it up again now.'),
      action('The connection restarted before your request "Hand note #454 to Rosa" finished. The 1 action recorded above already happened. Picking it up again now.'),
      action('The connection restarted before Oscar\'s answer "Done" could be answered here. Nothing had been recorded for it. Picking it up again now.'),
      action('The connection restarted before Oscar\'s answer "Done" could be answered here, and that was too long ago to pick up safely. Nothing had been recorded for it. The answer is above; ask me about it if it still matters.'),
      action('The connection restarted before this request finished. Any recorded actions above remain in place.'),
    )).toEqual([{ form: 'row' }, ...Array(5).fill({ form: 'hidden' })]);
  });

  it('says a request that did not complete under the person\'s own words, with the button that helps', () => {
    const tooOld = 'The connection restarted before your request "Hand note #454 to Rosa" finished, and that was too long ago to pick up safely. Nothing had been recorded for it. Send it again if you still want it done.';
    const unreachable = 'The connection restarted before your request "Hand note #454 to Rosa" finished, and its machine did not answer, so it was not picked up again. Nothing had been recorded for it. Send it again if you still want it done.';
    for (const text of [tooOld, unreachable]) {
      expect(views(owner('Hand note #454 to Rosa'), action('Sent to Rosa: yours.'), action(text))).toEqual([
        { form: 'row', unfinished: { reason: 'Not finished', retry: 'resend' } },
        { form: 'did', parts: ['Sent to ', { agent: 'Rosa' }], body: 'yours.' },
        { form: 'hidden' },
      ]);
    }
    expect(views(owner('Write it up'), reply('The agent took too long. Any actions it completed are recorded above; ask it to continue.'))).toEqual([
      { form: 'row', unfinished: { reason: 'Ran out of time — what was done is above', retry: 'continue' } }, { form: 'hidden' },
    ]);
    expect(views(owner('Write it up'), reply('The agent finished without an answer. Any actions it completed are recorded above.'))[0])
      .toEqual({ form: 'row', unfinished: { reason: 'No answer came back', retry: 'resend' } });
    expect(views(owner('Write it up'), reply('This request could not finish. Your message is saved.'))[0])
      .toEqual({ form: 'row', unfinished: { reason: 'Not finished', retry: 'resend' } });
  });

  it('offers the button only where pressing it helps', () => {
    const failed = reply('This request could not finish. Your message is saved.');
    // Not on an older message: the person has moved on.
    expect(views(owner('First'), failed, owner('Second'), reply('Done.'))[0]).toEqual({ form: 'row', unfinished: { reason: 'Not finished' } });
    // Not on words that carried files: words alone cannot send those again.
    const withFile = owner('Read this', { files: [{ id: 'f1', fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 3 }] });
    expect(views(withFile, failed)[0]).toEqual({ form: 'row', unfinished: { reason: 'Not finished' } });
    // …though carrying on from what was recorded needs no files.
    expect(views(withFile, reply('The agent took too long. Any actions it completed are recorded above; ask it to continue.'))[0])
      .toMatchObject({ unfinished: { retry: 'continue' } });
  });

  it('marks the request the failed turn was carrying out, not one already answered', () => {
    const failed = reply('The agent took too long. Any actions it completed are recorded above; ask it to continue.');
    // A turn reacting to an agent's answer had no request of the person's.
    expect(views(owner('Ask Oscar'), reply('Asked.'), answer('Oscar', 'Done.'), failed)).toEqual([
      { form: 'row' }, { form: 'row' }, { form: 'row' }, { form: 'unfinished', reason: 'Ran out of time — what was done is above' },
    ]);
    // A steer: two messages answered as one, and the newest wears the mark.
    expect(views(owner('Do A'), owner('Actually B'), failed).slice(0, 2)).toEqual([{ form: 'row' }, { form: 'row', unfinished: { reason: 'Ran out of time — what was done is above', retry: 'continue' } }]);
    // Never across a fresh chat.
    expect(views(owner('Old'), action('──', { kind: 'new-chat-divider' }), failed)[2]).toEqual({ form: 'unfinished', reason: 'Ran out of time — what was done is above' });
  });

  it('sends the person to its settings when its model cannot run', () => {
    expect(views(owner('Hi'), reply('I could not run the selected model. Check the agent\'s model and your subscription, then try again.'))).toEqual([
      { form: 'row' },
      { form: 'attention', tone: 'warn', parts: ['I can\'t start: my model or your subscription isn\'t working'], door: { to: 'settings' } },
    ]);
  });

  it('leaves out the pre-note-#496 briefing notice but keeps the reaction it opened', () => {
    expect(views(action('A new briefing was written. Reading it.', { kind: 'briefing' }), reply('Two proposals wait for you.'))).toEqual([{ form: 'hidden' }, { form: 'row' }]);
  });

  it('leaves out the founder\'s stored greeting — the pane\'s empty state says it (note #967) — and keeps a joiner\'s welcome and the sign-in ask', () => {
    expect(views(
      { ...reply('Hi Samira, I\'m your Chief of Staff.'), kind: 'greeting' },
      owner('Put a waitlist page live for my idea.'),
      { ...reply('Got it. Sign it in below, and I\'ll start.'), kind: 'signin-ask' },
    )).toEqual([{ form: 'hidden' }, { form: 'row' }, { form: 'row' }]);
    expect(views({ ...reply('Hi Cara, welcome to Acme.'), kind: 'welcome' })).toEqual([{ form: 'row' }]);
  });
});
