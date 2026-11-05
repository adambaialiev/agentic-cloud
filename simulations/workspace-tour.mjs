#!/usr/bin/env node
/**
 * The tour: every screen of a Workspace a day after the first result, with
 * the team's work in it — read, not changed. Each stop asserts the title and
 * the one fact that proves the screen drew the fixture, and pictures it at
 * both widths. This is where the marketing screenshots come from.
 *
 * Home is the Chief of Staff's conversation (the Workspace Agent; note #715)
 * — what the person sees first — and two doors open the rest in windows
 * over it: the stack of faces by the message box opens the agents picker
 * (every agent, what waits on the reader), and the Chief of Staff's name
 * opens the Workplace window (the workplace's shelves, its notes among them).
 *
 * The picker's tabs were ROOMS — a room's agents, notes and briefing one
 * level in — and the rooms had a screen of their own, until rooms left the
 * product (note #843). Those stops went with them: the tour pictures the
 * picker's one list and the notes in the Workplace window instead.
 */
import assert from 'node:assert/strict';
import { startMockWorkspace } from './support/mock-workspace.mjs';
import {
  LANDING_HEADLINE,
  normalizedText,
  repoRoot,
  runBrowserScenario,
  screenshotPathFor,
  textOf,
  waitVisible,
} from './support/browser-simulation.mjs';
import { addressOf, assertFaces, backHome, headerTitle, open, openAgents, openPeople, openWorkplace, signIn, waitForAll } from './support/team-steps.mjs';

const slug = 'workspace-tour';
const app = await startMockWorkspace(repoRoot, { world: 'team', stage: 'settled' });
const { member, milo, proposal, knowledgeProposal, repo, site, newNote } = app.team;
const claudeSeat = app.team.seats.claude;
const ruby = app.fixture.agent;
const org = app.fixture.organization;

/**
 * The hairline under a screen's header runs the width of the WINDOW on a desk,
 * while the header itself stays in the reading column (note #542).
 *
 * Measured, never looked up: the rule is an absolutely positioned pseudo
 * element, and every way this can fail leaves the CSS on the element and
 * nothing on the screen. A `100vw` strip inside a clipping ancestor, a
 * `bottom` that misses the border by a pixel, or a border that was hidden
 * without the strip replacing it all read as "the class is there".
 */
async function assertHeaderRuleSpansWindow(page, selector, what, borderSelector = selector) {
  const seen = await page.evaluate(([selector, borderSelector]) => {
    const el = document.querySelector(selector);
    const bordered = document.querySelector(borderSelector);
    if (!el || !bordered) return null;
    const box = el.getBoundingClientRect();
    const rule = getComputedStyle(el, '::after');
    const border = getComputedStyle(bordered);
    const own = getComputedStyle(el);
    return {
      window: window.innerWidth,
      // The CONTENT box, not the border box: a chat's header is as wide as
      // the window on a desk and carries the gutters as padding (note #547),
      // so the reading column is what is left once the padding is taken off.
      // For every other header the two are the same number.
      box: Math.round(box.width - parseFloat(own.paddingLeft) - parseFloat(own.paddingRight)),
      strip: Math.round(parseFloat(rule.width)),
      height: Math.round(parseFloat(rule.height)),
      colour: rule.backgroundColor,
      // The border stays in the box so nothing moves; it must not also paint,
      // or the column carries a second, darker line over the strip.
      borderWidth: border.borderBottomWidth,
      borderColour: border.borderBottomColor,
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  }, [selector, borderSelector]);
  assert.ok(seen, `${what}: ${selector} is not on this screen`);
  assert.equal(seen.strip, seen.window, `${what}: the rule is ${seen.strip}px in a ${seen.window}px window`);
  assert.equal(seen.height, 1, `${what}: the rule stands ${seen.height}px tall`);
  assert.ok(
    seen.box <= seen.window - 100,
    `${what}: the header's content is ${seen.box}px wide — it has left the reading column`,
  );
  assert.notEqual(seen.colour, 'rgba(0, 0, 0, 0)', `${what}: the rule is drawn in nothing`);
  assert.equal(seen.borderWidth, '1px', `${what}: the border left the box, so the header moved`);
  assert.equal(seen.borderColour, 'rgba(0, 0, 0, 0)', `${what}: the old line still paints under the new one`);
  // A strip as wide as the window must not become document width the reader
  // can scroll into. On a browser with classic scrollbars that is a
  // horizontal scrollbar on every screen.
  assert.equal(
    seen.documentWidth, seen.clientWidth,
    `${what}: the page scrolls ${seen.documentWidth - seen.clientWidth}px sideways`,
  );
}

await runBrowserScenario({
  app,
  slug,
  screenshotPath: screenshotPathFor(slug),
  async run({ page, shoot }) {
    // The public front door first, as a visitor sees it.
    await page.goto(`${app.origin}/`, { waitUntil: 'domcontentloaded' });
    await waitVisible(page, 'h1');
    // The site's own headline, as `src/pages/Landing.test.tsx` holds it.
    assert.match(normalizedText(await textOf(page, 'h1')), LANDING_HEADLINE);
    await shoot('landing', { fullPage: true });

    // Home: what the person sees first is the Chief of Staff's
    // conversation — its face and its name, the door to Workplace (note
    // #715 and the owner's follow-up) — no Workplace or Rooms buttons, the
    // reader's own picture at the far edge (note #634), the workplace
    // switch beside it.
    await signIn(page, app, app.fixture.account);
    assert.equal(normalizedText(await textOf(page, '#recapChatTitle')), 'Chief of Staff');
    await assertFaces(page, '#recapChatFace', 1, 'the Chief of Staff’s face');
    assert.equal(await page.$('#homeDoors'), null, 'the Workplace and Rooms buttons are still in the header');
    await assertFaces(page, '#homeAccount', 1, 'the reader’s own picture');
    await shoot('home', { fullPage: true });

    // The agents picker: the fleet, one list of every agent in the
    // workplace. It stood one level in, in a room, beside the notes and the
    // room's briefing, until rooms left the product (note #843) — the
    // briefing went with them, and the notes are the Workplace window's.
    await openAgents(page);
    await waitForAll(page, '#agentSwitchGrid', [ruby.name, milo.name]);
    // Nobody represented by a face on this screen is a grey circle: both
    // agents wear the product's own avatars, and the reader their picture
    // at the end of the header row (note #634).
    await assertFaces(page, '#agentSwitchGrid', 2, 'agent faces');
    await assertFaces(page, '#homeAccount', 1, 'the reader’s own picture');
    await shoot('agents-picker', { fullPage: true });
    // The Workplace window: what belongs to the whole workplace, its notes
    // among them.
    // An index since note #960: one row per shelf, each a screen of its own.
    await openWorkplace(page);
    await waitForAll(page, '#homeWorkplace', ['Notes', 'Sites', 'Knowledge', '2 pages']);
    await shoot('workplace-window', { fullPage: true });
    // The people moved from a deck on Home into the account menu's People
    // row (note #634), where both still wear their pictures. The menu is in
    // Home's header, under the window's dim: the window is closed first.
    await page.click('#homeSheetClose');
    await page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout: 10_000 });
    await openPeople(page);
    await waitForAll(page, '#people', [member.displayName]);
    await assertFaces(page, '#people', 2, 'people');
    await backHome(page);

    // Agents: details and conversations.
    await open(page, app, `/agents/${ruby.id}`, '#screenAgent');
    assert.equal(await headerTitle(page), ruby.name);
    await assertFaces(page, '#pageHead', 1, 'the agent’s own face');
    // Its facts say who drives it. The Room row that stood among them, a
    // door to moving the agent, went with rooms (note #843).
    await waitForAll(page, '#agentFacts', ['Driven by']);
    assert.ok(
      !(await page.$$eval('#agentFacts .drow > .k', (labels) => labels.map((label) => label.textContent?.trim()))).includes('Room'),
      'the agent’s facts still carry a Room row',
    );
    await waitForAll(page, '#agentPrs', [proposal.title]);
    await shoot('agent-ruby', { fullPage: true });
    await open(page, app, `/agents/${milo.id}`, '#screenAgent');
    assert.equal(await headerTitle(page), milo.name);
    await waitForAll(page, '#agentInfoAbout', ['brand-voice']);
    await shoot('agent-milo', { fullPage: true });
    await open(page, app, `/chat/${ruby.id}`, '#screenAgentChat');
    await waitForAll(page, '#agentChatLog', ['Merged', proposal.title]);
    // A message is read, not scanned, so it stands ABOVE the workhorse size
    // the app's chrome is set in (note #417). The stylesheet's own tests hold
    // the whole hierarchy; this is the one place the rule is read through a
    // real cascade, in a browser, on the screen the pictures come from.
    const [message, chrome] = await page.evaluate(() => [
      parseFloat(getComputedStyle(document.querySelector('#agentChatLog .chatmsg.agent')).fontSize),
      parseFloat(getComputedStyle(document.body).fontSize),
    ]);
    assert.ok(
      message > chrome,
      `a chat message is set at ${message}px, at or under the ${chrome}px the app's chrome is set in`,
    );
    await assertHeaderRuleSpansWindow(page, '.chathead', 'the chat');
    await shoot('chat-ruby');
    await open(page, app, `/chat/${milo.id}`, '#screenAgentChat');
    await page.waitForSelector('#agentChatLog .chatmsg.peer', { timeout: 10_000 });
    // A message from another agent arrives wearing that agent's face.
    await assertFaces(page, '#agentChatLog .chatmsg.peer', 1, 'the peer’s face');
    await shoot('chat-milo');

    // People and the workplace.
    await open(page, app, '/workplace/people', '#screenPeople');
    assert.equal(await headerTitle(page), 'People');
    await waitForAll(page, '#people', [app.fixture.account.displayName, 'You', member.displayName]);
    await assertFaces(page, '#people', 2, 'people');
    // The latest thing a person drove, and WHEN they drove it (note #385).
    // The stamp is its OWN line under the recap, not a tail on it, so the
    // plate's four-line clamp on that preview can never swallow it.
    await waitForAll(page, '#people', ['Approving what Ruby and Milo bring back.']);
    assert.equal(normalizedText(await textOf(page, '#people .crow .cago')), '12m ago');
    await shoot('people');
    await open(page, app, `/workplace/members/${member.userId}`, '#screenOrgMember');
    // Leo drives no agents: no Agents card at all, since an empty fact
    // reads as an error (note #1009). Who he is here closes the screen.
    await waitForAll(page, '#orgMemberAbout', ['Joined']);
    assert.equal(await page.$('#orgMemberAgents'), null);
    await shoot('member-leo');
    await open(page, app, '/workplace', '#screenOrg');
    assert.equal(await headerTitle(page), org.name);
    await waitForAll(page, '#orgPeopleCard', ['2 people']);
    await shoot('organization', { fullPage: true });

    // Notes, knowledge, the decision that landed.
    await open(page, app, '/notes', '#screenNotes');
    assert.equal(await headerTitle(page), 'Notes');
    await waitForAll(page, '#notesList', ['Launch checklist', 'Testimonials to collect', newNote.title]);
    await assertHeaderRuleSpansWindow(page, '.pagehead', 'the shared header');
    await shoot('notes', { fullPage: true });
    await open(page, app, '/notes/6', '#screenNote');
    await waitForAll(page, '#screenNote', [`Working by ${milo.name}`]);
    await shoot('note-working', { fullPage: true });
    await open(page, app, `/notes/${newNote.number}`, '#screenNote');
    await waitForAll(page, '#screenNote', ['Live']);
    await shoot('note-live', { fullPage: true });
    // The inbox, and one letter in it (note #509).
    await open(page, app, '/mail', '#screenMail');
    assert.equal(await headerTitle(page), 'Mail');
    await waitForAll(page, '#mailList', ['Priya Raman', 'The brief, and one photograph', 'Your September invoice']);
    await shoot('mail', { fullPage: true });
    await open(page, app, '/mail/mm_studio_brief', '#screenMailMessage');
    // What the SENDER attached, and no raw `.eml` row: note #517 took that
    // card off the message screen, and this harness still asked for it.
    await waitForAll(page, '#screenMailMessage', ['Priya', 'harborlight-brief.pdf']);
    await shoot('mail-message', { fullPage: true });

    await open(page, app, '/knowledge', '#screenKnowledge');
    await waitForAll(page, '#knowledgeList', ['Brand voice', knowledgeProposal.title]);
    await shoot('knowledge-list');
    await open(page, app, '/knowledge/brand-voice', '#screenKnowledgePage');
    await waitForAll(page, '#kpageBody', ['Say outcomes', 'Words we do not use']);
    await shoot('knowledge-page', { fullPage: true });
    await open(page, app, `/decisions/pr/${proposal.id}`, '#screenPr');
    await waitForAll(page, '#prPills', ['Merged']);
    await waitForAll(page, '#prDelivery', [proposal.delivery.checks[0].description]);
    await shoot('proposal-merged', { fullPage: true });

    // Code, the site, files, keys, subscriptions.
    await open(page, app, `/repositories/${repo.name}`, '#screenRepo');
    assert.equal(await headerTitle(page), repo.name);
    await waitForAll(page, '#repoOverview', [proposal.title]);
    await assertFaces(page, '#repoPeople', 2, 'the agents who wrote it');
    await shoot('repository', { fullPage: true });
    await page.click('#repoContentTab');
    await waitVisible(page, '#repoContent');
    await waitForAll(page, '#repoTree', ['README.md', 'site']);
    await shoot('repository-files', { fullPage: true });
    await open(page, app, `/sites/${site.name}`, '#screenSite');
    assert.equal(await headerTitle(page), site.name);
    await waitForAll(page, '#siteCard', [site.url.replace('https://', '')]);
    await shoot('site');
    await open(page, app, '/drive', '#screenDrive');
    assert.equal(await headerTitle(page), 'Drive');
    await waitForAll(page, '#driveItems', ['Brand assets', 'Launch checklist.pdf']);
    await shoot('drive');
    await open(page, app, `/drive/folders/${app.team.drive.folders[0].id}`, '#screenDrive');
    await waitForAll(page, '#driveItems', ['northstar-logo.svg', 'studio-photo.jpg']);
    await shoot('drive-folder');
    await open(page, app, '/secrets', '#screenSecrets');
    await waitForAll(page, '#secretsList', [app.team.secrets[0].name]);
    await shoot('secrets');
    await open(page, app, '/seats', '#screenSeats');
    assert.equal(await headerTitle(page), 'Your subscriptions');
    await waitForAll(page, '#seatsList', ['ChatGPT', 'Claude']);
    await shoot('seats');
    // The one screen that draws a window's PACE: the tick where an even
    // spend would stand by now, and the sentence saying how far off it this
    // window is (note #279). The week is being spent early and says when it
    // runs out; the five-hour window is level and says so.
    //
    // The screen paints before its seats arrive, so the usage is waited for
    // first and the header title read only once the seat is on the screen.
    await open(page, app, `/seats/${claudeSeat.seatId}`, '#screenSeat');
    await waitForAll(page, '#seatUsageCard', ['7 days', '61% used', '5 hours', '22% used']);
    assert.equal(await headerTitle(page), claudeSeat.label);
    await waitForAll(page, '#seatUsageCard', ['26% ahead of an even pace', 'gone in', 'Right on an even pace']);
    // A tick per window, not a line of words about one: a pace with no mark
    // on the meter is the defect no assertion on text would catch.
    assert.equal(await page.$$eval('#seatUsageCard .meter-pace', (marks) => marks.length), 2);
    await shoot('seat-pace', { fullPage: true });
    // The rooms screen stood here, the last stop, until rooms left the
    // product (note #843): its address opens Home now, and has nothing of
    // its own to picture.

    // The agents and the workplace are two different reading jobs (note
    // #404). The overview's old address with `half=agents` opens Home with
    // the agents picker — every agent, and nothing that belongs to the
    // workplace: repositories, knowledge and sites are the Workplace
    // window's (note #566), below Drive.
    await page.goto(`${addressOf(app, '/overview')}&half=agents`, { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#agentSwitchSheet #agentSwitchGrid');
    await waitForAll(page, '#agentSwitchGrid', [ruby.name, milo.name]);
    await assertFaces(page, '#agentSwitchGrid', 2, 'agent faces in the picker');
    await shoot('picker-agents', { fullPage: true });
    assert.equal(
      await page.$('#agentSwitchSheet #repos, #agentSwitchSheet #knowledge, #agentSwitchSheet #sitesCard, #agentSwitchSheet #notes'), null,
      'the agents picker draws a shelf that belongs to the workplace',
    );
    await openWorkplace(page);
    await waitForAll(page, '#homeWorkplace', ['Repositories', '1 repository', 'Knowledge', 'Sites', '1 site']);
    await shoot('workplace', { fullPage: true });
    await page.click('#indexRepositories');
    await waitForAll(page, '#screenRepositories', [repo.name]);
    await shoot('repositories', { fullPage: true });
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#homeSheet #indexSites');
    await page.click('#indexSites');
    await waitForAll(page, '#screenSites', [site.name]);
    await shoot('sites', { fullPage: true });

    // Nothing was written: the tour reads.
    const writes = app.requests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !request.path.startsWith('/workspace/auth/'));
    assert.deepEqual(writes.map((request) => `${request.method} ${request.path}`), ['POST /workspace/api/notifications/read'].filter(() => writes.length));
  },
});

console.log(`${slug}: every screen of the lived-in Workspace drew the team's work.`);
