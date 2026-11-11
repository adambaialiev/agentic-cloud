#!/usr/bin/env node
/**
 * The road after the first result, the day the team is real: the owner
 * writes a note and hands it to Ruby; Ruby asks Milo to check her wording
 * (a peer message in Milo's chat); the change comes back as a proposal card
 * in Ruby's chat; the owner reads the diff and approves; the site is live
 * and the note says so. Then Milo's knowledge proposal is published.
 *
 * What a pass means: from a plain note to a merged, deployed change, the
 * owner never left the Workspace, and every step was one tap on what the
 * screen offered.
 *
 * Home is the Chief of Staff's conversation since note #715: the agents, the
 * unread replies and the decisions waiting are in the agents picker (the
 * stack of faces by the message box), and the notes and sites in the
 * Workplace window (the Chief of Staff's name in its header). The agents and
 * notes were a ROOM's, one level into the picker, until rooms left the
 * product (note #843).
 */
import assert from 'node:assert/strict';
import { startMockWorkspace } from './support/mock-workspace.mjs';
import {
  assertRequestCount,
  normalizedText,
  repoRoot,
  runBrowserScenario,
  screenshotPathFor,
  textOf,
  waitForText,
  waitVisible,
} from './support/browser-simulation.mjs';
import { assertFaces, open, openAgents, openWorkplace, signIn, tapByText, waitForAll, waitForHeaderTitle } from './support/team-steps.mjs';

const slug = 'handoff-and-approval';
const app = await startMockWorkspace(repoRoot, { world: 'team', stage: 'joined' });
const { newNote, handoff, proposal, knowledgeProposal, milo } = app.team;
const ruby = app.fixture.agent;

await runBrowserScenario({
  app,
  slug,
  screenshotPath: screenshotPathFor(slug),
  async run({ page, shoot }) {
    // 1. A lived-in workplace: unread reply, a decision waiting, two agents,
    // two people. The replies, the decisions and the agents are the agents
    // picker's — they were a room's, one level into it, until note #843.
    await signIn(page, app, app.fixture.account);
    await openAgents(page);
    await waitVisible(page, '#unreadMessages');
    await waitForAll(page, '#unreadMessages', [milo.name]);
    await waitForAll(page, '#agentSwitchDecisions', [knowledgeProposal.title]);
    await waitForAll(page, '#agentSwitchGrid', [ruby.name, milo.name]);
    await assertFaces(page, '#agentSwitchGrid', 2, 'agent faces');
    await assertFaces(page, '#homeAccount', 1, 'the reader’s own picture');
    await shoot('home-lived-in', { fullPage: true });

    // 2. The note: written in plain words, from the Workplace window, where
    // the workplace's notes are since rooms left (note #843) — its Write a
    // note opens the notes screen with the box up.
    // The window is an index since note #960: its Notes row opens the notes
    // screen, whose Write a note puts the box up.
    await openWorkplace(page);
    await waitForAll(page, '#indexNotes', ['Notes', ' notes']);
    await page.click('#indexNotes');
    await waitForAll(page, '#notesList', ['Launch checklist', 'Working by Milo']);
    await shoot('workplace-notes', { fullPage: true });
    await page.click('#notesAddBtn');
    await waitVisible(page, '#screenNoteNew');
    await page.type('#noteText', newNote.text);
    await shoot('note-composer');
    await page.click('#saveNoteBtn');
    // Saving opens the note itself, unclaimed, ready to be handed over.
    await waitVisible(page, '#screenNote');
    assert.equal(await waitForHeaderTitle(page, newNote.title), newNote.title);
    await waitForAll(page, '#screenNote', [`Note #${newNote.number}`, 'Unclaimed']);
    assert.deepEqual(app.world.snapshot().notes.find((row) => row.number === newNote.number).work, { state: 'unclaimed' });

    // 3. Handing it over: the note's own row of ready agents, then the send
    // box with the sentence already written.
    await waitVisible(page, '#noteHands');
    await waitForAll(page, '#noteHands', [ruby.name, milo.name]);
    await assertFaces(page, '#noteHands', 2, 'the agents this note can go to');
    await shoot('note-with-hand-row', { fullPage: true });
    await tapByText(page, '#noteHands', ruby.name, 'button.handpick');
    await waitVisible(page, '#screenNoteSend');
    assert.equal(normalizedText(await textOf(page, '#noteSendTitle')), ruby.name);
    assert.equal(await page.$eval('#noteSendText', (box) => box.value), handoff.message);
    await shoot('handoff-send');
    await page.click('#noteSendBtn');
    const onIt = `${ruby.name} is on it — the answer lands in its chat.`;
    assert.equal(await waitForText(page, '#banner', onIt), onIt);
    await waitVisible(page, '#screenNote');
    await waitForAll(page, '#screenNote', [`Working by ${ruby.name}`]);
    await shoot('note-working-by-ruby', { banner: true });
    assert.equal(app.world.snapshot().notes.find((row) => row.number === newNote.number).work.state, 'working');

    // 4. Ruby's chat: the ask, her reply, and — after the work on her
    // machine — the proposal card. The reads are the clock.
    await page.goto(`${app.origin}/chat/${ruby.id}`, { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#screenAgentChat');
    await waitForAll(page, '#agentChatLog', [handoff.message, handoff.ack.slice(0, 40)]);
    await waitForAll(page, '#agentChatLog', ['Change proposal', 'Awaiting approval', proposal.title, 'Review and decide']);
    await shoot('ruby-chat-proposal-card');
    assert.equal(app.world.snapshot().proposal.status, 'open');
    assert.deepEqual(app.world.snapshot().notes.find((row) => row.number === newNote.number).work, { state: 'proposal', proposalNumber: proposal.number, proposalStatus: 'open' });

    // 5. Milo's chat: what Ruby asked him, drawn as a message from a peer,
    // and his answer.
    await page.goto(`${app.origin}/chat/${milo.id}`, { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#screenAgentChat');
    await page.waitForSelector('#agentChatLog .chatmsg.peer', { timeout: 10_000 });
    await waitForAll(page, '#agentChatLog', [ruby.name, 'Tell your team what you need', 'Get the finished work back']);
    await assertFaces(page, '#agentChatLog .chatmsg.peer', 1, 'the peer’s face');
    await shoot('milo-chat-peer-message');

    // 6. The decision: the card opens the proposal — write-up, checks, the
    // diff — and one tap merges it.
    await page.goto(`${app.origin}/chat/${ruby.id}`, { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#screenAgentChat');
    await page.waitForSelector('#agentChatLog button.chatmsg.platform', { timeout: 10_000 });
    await page.click('#agentChatLog button.chatmsg.platform');
    await waitVisible(page, '#screenPr');
    assert.equal(await waitForText(page, '#prTitle', proposal.title), proposal.title);
    await waitForAll(page, '#prPills', ['Waiting for you']);
    await waitForAll(page, '#prDecide', ['Approve & merge', 'Reject']);
    await waitForAll(page, '#prSummary', ['3 files changed']);
    await shoot('proposal-waiting-for-you', { fullPage: true });
    // The row under the decision asks for a REVIEW; it does not hand the
    // proposal away, which stays the author's either way (note #390). Read
    // off the shipped shell, because the words are the whole change — and
    // after the picture, so a build with the wrong words is still photographed
    // before the failure stops the run.
    assert.equal(await waitForText(page, '#prHandsHead', 'Ask for review'), 'Ask for review');
    await tapByText(page, '#prSummary', '3 files changed');
    await waitVisible(page, '#screenPrDiff');
    await waitForAll(page, '#prDiffBody', ['How it works', 'contact.js']);
    await shoot('proposal-diff', { fullPage: true });
    await page.click('#pageBack');
    await waitVisible(page, '#screenPr');
    await tapByText(page, '#prDecide', 'Approve & merge');
    await waitForAll(page, '#prPills', ['Merged']);
    await waitForAll(page, '#prDelivery', [proposal.delivery.checks[0].description]);
    await shoot('proposal-merged', { fullPage: true });
    assert.deepEqual(app.world.snapshot().proposal, { status: 'merged', live: true });

    // 7. Home again: the site is up and the note is live, side by side in
    // the Workplace window. Reached by the overview's old address, which
    // opens Home with its Workplace window (note #715).
    await open(page, app, '/overview', '#homeSheet #homeWorkplace');
    await waitForAll(page, '#homeWorkplace', ['Sites', 'Notes']);
    await shoot('home-after-merge', { fullPage: true });
    // Each a screen of its own since note #960.
    await page.click('#indexSites');
    await waitForAll(page, '#screenSites #sites', [app.team.site.name]);
    await open(page, app, '/notes', '#screenNotes');
    await waitForAll(page, '#notesList', [newNote.title, 'Live']);
    await open(page, app, '/', '#screenHome');

    // 8. Milo's knowledge proposal, from the decisions waiting in the agents
    // picker: read as it will look, then published.
    await openAgents(page);
    await tapByText(page, '#agentSwitchDecisions', knowledgeProposal.title, '[role="button"]');
    await waitVisible(page, '#screenKp');
    assert.equal(await waitForText(page, '#kpTitle', knowledgeProposal.title), knowledgeProposal.title);
    await waitForAll(page, '#kpBody', ['Say the outcome, not the feature']);
    await shoot('knowledge-proposal', { fullPage: true });
    await tapByText(page, '.decidebar', 'Approve & publish');
    await page.waitForFunction(() => document.body.textContent.includes('Published'), { timeout: 10_000 });
    assert.equal(app.world.snapshot().knowledgeProposal, 'approved');
    await open(page, app, `/knowledge/${knowledgeProposal.page}`, '#screenKnowledgePage');
    await waitForAll(page, '#kpageBody', ['One promise per sentence']);
    await shoot('knowledge-page-published', { fullPage: true });

    // The request contract, so UI/fixture drift is loud.
    const wrote = assertRequestCount(app, 'POST', '/workspace/api/notes', 1);
    assert.deepEqual(wrote[0].body, { text: newNote.text });
    const handed = assertRequestCount(app, 'POST', `/workspace/api/notes/${newNote.number}/handoff`, 1);
    assert.deepEqual(handed[0].body, { agentId: ruby.id, message: handoff.message });
    assert.equal(handed[0].status, 202);
    assertRequestCount(app, 'POST', `/workspace/api/agents/${ruby.id}/chat`, 0);
    const decided = assertRequestCount(app, 'POST', `/workspace/api/prs/${proposal.id}/decision`, 1);
    assert.deepEqual(decided[0].body, { decision: 'approve', headSha: proposal.headSha });
    const published = assertRequestCount(app, 'POST', `/workspace/api/knowledge/proposals/${knowledgeProposal.id}/decision`, 1);
    assert.deepEqual(published[0].body, { decision: 'approve' });
    assert.equal(app.world.snapshot().unread, 0, 'opening the chat marks the reply read');
  },
});

console.log(`${slug}: a note became a merged, deployed change and a published page, one tap at a time.`);
