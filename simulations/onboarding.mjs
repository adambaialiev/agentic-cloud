#!/usr/bin/env node
/**
 * The first experience (note #144, remade by note #726: "the Chief of Staff
 * runs the first ten minutes"), walked through the shipped UI the way a
 * newcomer walks it, with a picture of every screen on the way:
 *
 *   landing → sign up (name, address, password) → Home at once — the Chief
 *   of Staff's conversation, open on the platform's greeting with three
 *   starter answers under it (a reload lands on the same words) → a starter
 *   tapped: the person's words, the sign-in ask in the agent's voice, and
 *   the Claude / Codex card under it → Codex: ChatGPT's own sign-in page,
 *   the one-time code at once → the plan lands: back on Home, no banner,
 *   "Your ChatGPT plan is signed in." said in the chat → the first turn, by
 *   itself: "Brought in Juno.", "Brought in Ivy." (no room is opened since
 *   note #843), the team's progress card at the foot of the log moving from
 *   Starting… to Computer being built…, the plan reply → every agent ready,
 *   the card gone, the two agents in Home's agents picker.
 *
 * The first receipt is the Chief of Staff's own words, which the backend
 * still writes until stage 3 of note #843 takes rooms out of it. What the
 * SCREEN drew of rooms — the arriving card headed by the room's name, the
 * room as a tab of the picker with its agents in it — went with rooms
 * (note #843): the card is headed "Arriving", and the picker is one list.
 *
 * Nothing is furnished at founding (the owner's decision 3): no room, no
 * agent, no "Your team is arriving", no Continue — the account's default
 * workplace name is accepted when the plan lands, and the team is the Chief
 * of Staff's to bring in for the work the person named. No gate stands in
 * front of any of it: `/setup*` addresses are history.
 *
 * What is asserted is what the person sees at each step and the exact
 * request the UI sent, so the contract with the backend cannot drift: the
 * register body with its names, the one message to the Chief of Staff and
 * its client id, the sign-in provider, no naming write, no stepping-in
 * write, no room or agent made by hand, no cloud connected — and no second
 * workplace founded.
 */
import assert from 'node:assert/strict';
import { startMockWorkspace } from './support/mock-workspace.mjs';
import {
  assertRequestCount,
  LANDING_HEADLINE,
  matchingRequests,
  normalizedText,
  repoRoot,
  runBrowserScenario,
  screenshotPathFor,
  textOf,
  waitVisible,
} from './support/browser-simulation.mjs';
import { assertFaces, openAgents } from './support/team-steps.mjs';

const screenshotPath = screenshotPathFor('onboarding');
const app = await startMockWorkspace(repoRoot);
const { fixture } = app;
const { firstRun } = fixture;

/** The words of Home's log, as a person reads them. */
const logText = async (page) => normalizedText(await page.$eval('#recapChatLog', (node) => node.textContent ?? ''));
/** What the team card says for each agent, in order. */
const teamLines = (page) => page.$$eval('#firstRunTeam .crow[data-agent]', (rows) => rows.map((row) => ({
  agent: row.dataset.agent, status: row.className.replace('crow ', ''),
  name: row.querySelector('.name')?.textContent?.trim(), line: row.querySelector('.ctext')?.textContent?.trim(),
})));

await runBrowserScenario({
  app,
  screenshotPath,
  slug: 'onboarding',
  async run({ page, shoot }) {
    // 1. Arrive as a visitor. Since note #822 (the owner, 2026-10-28: only
    // the private copy is offered) the landing page's door is the copy's,
    // and nothing on it leads to sign-up; the sign-up card is reached the
    // way a copy reaches it, at its own address (the installer's first-account
    // link and every invite link open it).
    await page.goto(`${app.origin}/`, { waitUntil: 'domcontentloaded' });
    await waitVisible(page, 'h1');
    assert.match(normalizedText(await textOf(page, 'h1')), LANDING_HEADLINE);
    assert.equal(await page.$('a[href="/signup"]'), null, 'the landing page still links /signup');
    // Since note #924 no button jumps to it: the home page's way to start is
    // its How to start section, the line for an agent at its top.
    assert.ok(await page.$('#start #give-your-agent'), 'the landing page has no line for your own Agentic Cloud');
    assert.ok(await page.$('a[href="#start"]'), 'the landing page has no way to How to start');
    await page.goto(`${app.origin}/signup`, { waitUntil: 'domcontentloaded' });

    // 2. One card makes the account: their name, an address here, a password.
    await waitVisible(page, '#authEmailPanel');
    assert.equal(normalizedText(await textOf(page, '#authTitle')), 'Create your Workspace.');
    assert.equal(normalizedText(await textOf(page, '#authEmailPanel h2')), 'Create your account');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'authFirstName', 'the name comes first');
    await shoot('signup');
    await page.type('#authFirstName', fixture.account.firstName);
    await page.type('#authLastName', fixture.account.lastName);
    await page.type('#authMailbox', fixture.account.mailbox);
    await page.type('#authPassword', fixture.account.password);
    await page.type('#authPasswordConfirm', fixture.account.password);
    await page.waitForFunction(() => !document.querySelector('#authEmailButton')?.disabled, { timeout: 10_000 });
    await shoot('signup-filled');
    await page.click('#authEmailButton');

    // 3. Signed in at once — and on Home, the Chief of Staff's conversation,
    // with nothing in front of it (note #726): no gate, no cloud, no
    // subscription step, no team arriving. The first thing said is the
    // platform's greeting, in the agent's voice, with three starters under
    // it; a reload lands on the same words, said once.
    await waitVisible(page, '#screenHome');
    const orgQuery = `?org=${encodeURIComponent(fixture.organization.id)}`;
    const atHome = async () => {
      await page.waitForFunction(() => location.pathname === '/', { timeout: 10_000 })
        .catch(async () => assert.fail(`expected Home, the address is ${await page.evaluate(() => location.pathname + location.search)}`));
    };
    await atHome();
    const noGate = async (moment) => {
      assert.equal(await page.$('#requiredSetup'), null, `a setup gate is drawn ${moment}`);
      assert.equal(await page.$('#teamArriving'), null, `the retired arriving screen is drawn ${moment}`);
      assert.equal(await page.$('#nameWorkplaceForm'), null, `a naming form is drawn ${moment}`);
      assert.ok(!/Sign in a subscription|Your team is arriving|Fly|deploy token/i.test(await page.$eval('body', (node) => node.textContent ?? '')), `the old road's words are on screen ${moment}`);
    };
    await noGate('after signing up');
    assert.equal(normalizedText(await textOf(page, '#recapChatTitle')), 'Chief of Staff', 'Home did not open on the Chief of Staff’s conversation');
    await page.waitForFunction(() => document.querySelectorAll('#firstRunStarters .chatstarter').length === 3, { timeout: 10_000 });
    assert.ok((await logText(page)).includes(firstRun.greeting), `the greeting is not said: ${await logText(page)}`);
    assert.equal(await page.$('#screenHome .chatempty'), null, 'the empty-state words stand over a conversation with a row');
    assert.equal(await page.$('#firstRunSignIn'), null, 'the sign-in card is drawn before the person has said anything');
    const starters = await page.$$eval('#firstRunStarters .chatstarter', (nodes) => nodes.map((node) => node.textContent?.trim()));
    assert.ok(starters.includes(firstRun.starter), `the starters do not offer "${firstRun.starter}": ${starters.join(' | ')}`);
    // Under the greeting's own row, not at the foot of the log or over it.
    assert.ok(await page.$('#recapChatLog .chatmsg + #firstRunStarters'), 'the starters do not stand under the greeting');
    await shoot('home-greeting', { fullPage: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#screenHome');
    await page.waitForFunction(() => document.querySelectorAll('#firstRunStarters .chatstarter').length === 3, { timeout: 10_000 });
    assert.equal((await page.$$('#recapChatLog .chatmsg')).length, 1, 'a reload said the greeting again');
    await noGate('after a reload');

    // 4. A starter tapped: the words go as the person's own message. No
    // plan is signed in, so the answer is the sign-in ask in the agent's
    // voice, and the picker card under it — the two existing sign-in rows
    // and the line that says where the sign-in happens. The starters are
    // spent. A reload keeps all of it.
    const tapped = await page.evaluate((text) => {
      const button = [...document.querySelectorAll('#firstRunStarters .chatstarter')].find((node) => node.textContent?.trim() === text);
      button?.click();
      return Boolean(button);
    }, firstRun.starter);
    assert.ok(tapped, 'the starter could not be tapped');
    await waitVisible(page, '#firstRunSignIn');
    const asked = await logText(page);
    assert.ok(asked.includes(firstRun.starter), `the person's words are not in the log: ${asked}`);
    assert.ok(asked.includes(firstRun.ask), `the sign-in ask is not said: ${asked}`);
    assert.equal(await page.$('#firstRunStarters'), null, 'the starters stand after one was tapped');
    const signInRows = await page.$$eval('#firstRunSignIn .crow.open', (rows) => rows.map((row) => ({ provider: row.dataset.provider, name: row.querySelector('.name')?.textContent?.trim() })));
    assert.deepEqual(signInRows, [{ provider: 'claude', name: 'Claude' }, { provider: 'codex', name: 'Codex' }], 'the sign-in card does not offer both plans');
    assert.equal(normalizedText(await textOf(page, '#firstRunSignInWhere')), firstRun.where);
    // Right under the ask's own row.
    assert.ok(await page.evaluate((ask) => {
      const row = [...document.querySelectorAll('#recapChatLog .chatmsg')].find((node) => node.textContent?.includes(ask));
      return row?.nextElementSibling?.id === 'firstRunSignIn';
    }, firstRun.ask), 'the sign-in card does not stand under the ask');
    await shoot('home-ask', { fullPage: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#firstRunSignIn');
    assert.equal(await page.$('#firstRunStarters'), null, 'a reload brought the starters back');
    await noGate('after the ask');

    // 5. Codex, from the card: ChatGPT's own sign-in page, named for the
    // subscription, with the one-time code on screen at once — the backend
    // asks OpenAI for it directly, so no machine is started first
    // (2026-09-22).
    await page.click('#firstRunSignIn .crow[data-provider="codex"]');
    await waitVisible(page, '#screenSeatSignIn');
    await page.waitForFunction((want) => `${location.pathname}${location.search}` === want, { timeout: 10_000 }, `/seats/sign-in/chatgpt${orgQuery}`)
      .catch(async () => assert.fail(`expected the ChatGPT sign-in page, the address is ${await page.evaluate(() => location.pathname + location.search)}`));
    assert.equal(normalizedText(await textOf(page, '#seatSignInTitle')), 'Sign in to ChatGPT');
    await page.waitForFunction(
      (code) => document.querySelector('#seatSignInBody')?.textContent?.includes(code),
      { timeout: 10_000 },
      fixture.signin.userCode,
    );
    assert.ok(!normalizedText(await textOf(page, '#seatSignInBody')).includes('private computer'), 'the sign-in still waits for a machine');
    await shoot('sign-in-code');

    // 6. The plan lands (the approval happens on OpenAI's page, out of
    // sight; the screen's polls are the clock): back on Home, with no
    // banner and no Seats screen on the way — the chat says it, as a row
    // — and the sign-in card is gone. The person's words are the first
    // real request now, and the Chief of Staff's first turn starts by
    // itself.
    await waitVisible(page, '#screenHome');
    await atHome();
    await page.waitForFunction((receipt) => document.querySelector('#recapChatLog')?.textContent?.includes(receipt), { timeout: 15_000 }, firstRun.receipt);
    assert.equal(await page.$('#homeBanner'), null, 'a banner was drawn over the log when the plan landed');
    assert.equal(await page.$('#screenSeats'), null, 'the Seats screen was drawn on the way back to Home');
    await page.waitForFunction(() => !document.querySelector('#firstRunSignIn'), { timeout: 10_000 });
    assert.equal(app.journey().workplaceName, fixture.organization.defaultName, 'the account default did not become the workplace name');
    await shoot('home-signed-in', { fullPage: true });

    // 7. The first turn, read off the log as it grows: the room opened, each
    // agent brought in — and the team's progress card at the foot of the
    // log, under one heading, each agent's face and its line moving from
    // Starting… to Computer being built… (The card was headed by the room's
    // name, a card per room, until rooms left the screen — note #843.)
    const receipts = firstRun.agents.map((agent) => `Brought in ${agent.name}.`);
    for (const receipt of receipts) {
      await page.waitForFunction((text) => document.querySelector('#recapChatLog')?.textContent?.includes(text), { timeout: 30_000 }, receipt);
    }
    await page.waitForFunction((count) => document.querySelectorAll('#firstRunTeam .crow[data-agent]').length === count, { timeout: 30_000 }, firstRun.agents.length);
    assert.ok(await page.$('#recapChatLog #firstRunTeam'), 'the team card stands outside the log');
    assert.deepEqual(await page.$$eval('#firstRunTeam .arrivinghead', (nodes) => nodes.map((node) => node.textContent?.trim())), ['Arriving'], 'the card is not one card headed Arriving');
    const named = await teamLines(page);
    assert.deepEqual(named.map((row) => [row.agent, row.name]), firstRun.agents.map((agent) => [agent.id, agent.name]), `the card does not list the team in order: ${JSON.stringify(named)}`);
    assert.ok(named.every((row) => row.line === 'Starting…' || row.line === 'Computer being built…'), `an agent's line is not an arriving one: ${JSON.stringify(named)}`);
    await assertFaces(page, '#firstRunTeam', firstRun.agents.length, 'every arriving agent’s face on the team card');
    // The card is seen moving: a build under way for every agent, since
    // each starts planned on the read that first lists it.
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#firstRunTeam .crow[data-agent] .ctext')];
      return rows.length > 0 && rows.some((node) => node.textContent?.trim() === 'Computer being built…');
    }, { timeout: 30_000 });
    assert.equal(await page.$('#workspaceAgentArriving'), null, 'the card lists the Chief of Staff itself');
    await shoot('home-team-arriving', { fullPage: true });

    // 8. The reply: the plan, one job per agent. Then every computer is
    // built, the card goes, and the agents' own cards take over: the two of
    // them in Home's agents picker, the one list of every agent (it was the
    // room's tab, with the room as the picker's only tab, until note #843).
    await page.waitForFunction(() => document.querySelector('#recapChatLog')?.textContent?.includes("Here's the plan"), { timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector('#firstRunTeam'), { timeout: 60_000 });
    const settled = await logText(page);
    for (const receipt of receipts) assert.ok(settled.includes(receipt), `a receipt went with the card: ${receipt}`);
    assert.ok(settled.includes(firstRun.receipt), 'the plan’s receipt went with the card');
    await shoot('home-plan', { fullPage: true });
    await openAgents(page);
    await page.waitForFunction((count) => document.querySelectorAll('#agentSwitchGrid .crow[data-agent]').length === count, { timeout: 20_000 }, firstRun.agents.length);
    const rowNames = await page.$$eval('#agentSwitchGrid .crow[data-agent] .name', (nodes) => nodes.map((node) => node.textContent?.trim()));
    assert.deepEqual(rowNames, firstRun.agents.map((agent) => agent.name), 'the picker shows the two agents, in order');
    await page.waitForFunction(
      () => [...document.querySelectorAll('#agentSwitchGrid .crow[data-agent] .main .cline .ctext')].every((node) => !/Setting up|Waiting|queue|Starting|being built/.test(node.textContent || '')),
      { timeout: 20_000 },
    );
    await assertFaces(page, '#agentSwitchGrid', firstRun.agents.length, 'every agent’s face in the picker');
    await shoot('home-team-ready', { fullPage: true });

    // The request contract, so UI/fixture drift is loud.
    const { firstVisit, ...registered } = assertRequestCount(app, 'POST', '/workspace/auth/email/register', 1)[0].body;
    assert.deepEqual(registered, {
      mailbox: fixture.account.mailbox,
      password: fixture.account.password,
      firstName: fixture.account.firstName,
      lastName: fixture.account.lastName,
    });
    // Where the browser first came from rides along; opened directly, it names no site.
    assert.equal(firstVisit?.from, '');
    assert.match(firstVisit?.page ?? '', /^\//);
    assert.equal(matchingRequests(app, 'POST', '/workspace/api/org').length, 0, 'the workplace came with the account');
    assertRequestCount(app, 'POST', '/workspace/api/org/name', 0);
    // Nothing to step into (note #726): the arriving screen and its Continue are gone.
    assertRequestCount(app, 'POST', '/workspace/api/org/arrived', 0);
    assert.equal(matchingRequests(app, 'POST', '/workspace/api/rooms').length, 0, 'a room was made by hand');
    assert.equal(matchingRequests(app, 'POST', '/workspace/api/agents').length, 0, 'an agent was created by hand');
    // Nothing connected a cloud: there is none to connect.
    assertRequestCount(app, 'POST', '/workspace/api/org/fly', 0);
    // One tap on Codex, one sign-in: nothing to prepare, nothing to retry.
    assert.deepEqual(assertRequestCount(app, 'POST', '/workspace/api/org/signin', 1)[0].body, { provider: fixture.agent.cli });
    // One message to the Chief of Staff — the starter, as the person's own
    // words, with the client id every send carries — and nothing else
    // written to it: the first turn started by itself when the plan landed.
    const [sent] = assertRequestCount(app, 'POST', '/workspace/api/recap/chat', 1);
    assert.equal(sent.body?.text, firstRun.starter);
    assert.ok(typeof sent.body?.clientId === 'string' && sent.body.clientId.length > 0, 'the message carried no client id');
    assert.ok(matchingRequests(app, 'GET', '/workspace/api/recap/chat').length > 0, 'Home never read the Chief of Staff’s conversation');
    const cookies = await page.cookies();
    assert.equal(cookies.find((cookie) => cookie.name === 'acc_session')?.httpOnly, true);
    assert.equal(app.workspaceStage(), 'named');
    assert.equal(app.identityExists(), true);
  },
});

console.log('Onboarding simulation passed:');
console.log('  landing → sign up (with a name) → Home at once: the Chief of Staff’s greeting and three starters (no gate, no cloud, nothing furnished) → a starter tapped → the sign-in ask and the Claude / Codex card → ChatGPT’s sign-in page → the plan lands: back on Home, said in the chat → the first turn by itself: the room opened, two agents brought in, the team card moving, the plan reply → every agent ready, the two agents in the agents picker');
console.log(`  ${app.requests.length} same-origin Workspace requests answered by fixtures`);
console.log(`  screenshot: ${screenshotPath}`);
