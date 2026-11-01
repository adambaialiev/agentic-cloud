#!/usr/bin/env node
/**
 * A second person joins the workplace through an invite link — the invite flow,
 * walked through the shipped UI the way the two people walk it, in two
 * browsers at once:
 *
 *   the owner, alone, makes an invite link on Home → the link listed on the
 *   workplace screen → Leo opens it signed out, sees whose door it is →
 *   creates his account there (name, address, password) → is asked to
 *   request access → waits on the admin → the owner finds the request on
 *   the Workplace window's request card and approves → Leo's page sees it, he is in,
 *   opens the workplace → Home as a member: both people, the team's agents
 *   (in the agents picker), no invite button of his own → and his workplace
 *   list, which also holds the unnamed workplace his account was made with.
 *
 * Home is the Chief of Staff's conversation, with the door to the Workplace
 * window, the workplace switch and the reader's picture in its header; the
 * request card is in the Workplace window (note #715) and the agents in the
 * picker by the message box — a room's, one level into it, until rooms left
 * the product (note #843).
 *
 * That last picture is the truth the flow carries today: the register route
 * makes a workplace for EVERY account and knows nothing of the link the
 * person arrived through, so a joiner ends up with a spare one. The fixture
 * models it so the picture shows it, rather than a tidier product than the
 * one that ships.
 */
import assert from 'node:assert/strict';
import { startMockWorkspace } from './support/mock-workspace.mjs';
import {
  assertRequestCount,
  hiddenOrAbsent,
  matchingRequests,
  normalizedText,
  repoRoot,
  runBrowserScenario,
  screenshotPathFor,
  textOf,
  waitForText,
  waitVisible,
} from './support/browser-simulation.mjs';
import { addressOf, assertFaces, backHome, openAgents, openPeople, signIn, tapByText, waitForAll } from './support/team-steps.mjs';

const slug = 'team-join';
const app = await startMockWorkspace(repoRoot, { world: 'team', stage: 'invite' });
const { member, invite } = app.team;
const owner = app.fixture.account;
const joinerName = `${member.firstName} ${member.lastName}`;

/** Milliseconds since `since`, for the per-step timing line. */
const timer = () => {
  const marks = [];
  let last = Date.now();
  return {
    mark(step) { const now = Date.now(); marks.push({ step, ms: now - last }); last = now; },
    marks,
  };
};
const clock = timer();

await runBrowserScenario({
  app,
  slug,
  screenshotPath: screenshotPathFor(slug),
  async run({ page, shoot, newPersona }) {
    // 1. The owner, alone in the workplace, makes an invite link from the
    //    workplace menu on Home (note #620).
    await signIn(page, app, owner);
    await assertFaces(page, '#homeAccount', 1, 'the owner’s own picture');
    await shoot('owner-home-alone');
    // The people are one tap behind that picture (note #634).
    await page.click('#homeAccount');
    await waitVisible(page, '#accountMenu');
    await shoot('owner-account-menu');
    await page.click('#accountMenuPeople');
    await waitVisible(page, '#screenPeople');
    await waitForAll(page, '#people', [owner.displayName, 'You']);
    await assertFaces(page, '#people', 1, 'the only person here yet');
    await backHome(page);
    // The menu's door opens the invite page; arriving there makes the first
    // link, and the link stands on the page before anything is copied.
    await page.click('#homeOrganizations');
    await waitVisible(page, '#workplaceMenuInvite');
    await page.click('#workplaceMenuInvite');
    await waitVisible(page, '#screenInvite');
    // The copied link carries the public address; Leo opens the same path here.
    const link = `${invite.webOrigin}/invite/${invite.token}`;
    const door = `${app.origin}/invite/${invite.token}`;
    // The same invite-link row the workplace screen draws.
    await waitVisible(page, '#inviteLinkCard .orgjoin-link');
    assert.equal(await page.$eval('#inviteLinkCard input[aria-label="Shareable invite link"]', (input) => input.value), link);
    assert.equal(normalizedText(await textOf(page, '#inviteTitle')), 'Invite to this workplace');
    assert.deepEqual(app.world.snapshot().invites, [invite.token]);
    await shoot('owner-invite-page');
    await page.click('#inviteLinkCard .orgjoin-copy');
    assert.equal(await waitForText(page, '#inviteLinkCard .orgjoin-copy', 'Copied'), 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
    await shoot('owner-invite-link-copied');
    clock.mark('owner makes the link');

    // The workplace screen lists the link, ready to copy again or revoke.
    await page.goto(addressOf(app, '/workplace'), { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#orgInvites');
    await waitForAll(page, '#orgInvitesList', ['Invite link']);
    assert.equal(await page.$eval('#orgInvitesList input[aria-label="Shareable invite link"]', (input) => input.value), link);
    assert.ok(normalizedText(await textOf(page, '#orgJoinRequests')).includes('No pending requests.'));
    await shoot('owner-workplace-invite-links', { fullPage: true });

    // 2. Leo opens the link in his own browser, signed out: the door says
    // whose it is and what happens next, over the ordinary sign-in.
    const leo = await newPersona();
    await leo.goto(door, { waitUntil: 'domcontentloaded' });
    await waitVisible(leo, '#authGate');
    assert.equal(normalizedText(await textOf(leo, '#authTitle')), 'Join your team’s Workspace.');
    await waitForAll(leo, '#authInvite', ['Your invite link is ready']);
    await waitVisible(leo, '#authEmailPanel');
    // He has no account yet, and the door opens on exactly that: the same
    // one card a founder fills in — his name, an address here, a password —
    // with nothing to tap first and none of a founder's setup list under it.
    await waitVisible(leo, '#authFirstName');
    await waitForAll(leo, '#authInvite', ['Create your account below']);
    assert.equal(await hiddenOrAbsent(leo, '#authNeeds'), true, 'a joiner was shown the founder’s setup list');
    await shoot('leo-invite-door', { page: leo });
    await leo.type('#authFirstName', member.firstName);
    await leo.type('#authLastName', member.lastName);
    await leo.type('#authMailbox', member.mailbox);
    await leo.type('#authPassword', member.password);
    await leo.type('#authPasswordConfirm', member.password);
    await leo.waitForFunction(() => !document.querySelector('#authEmailButton')?.disabled, { timeout: 10_000 });
    await shoot('leo-create-account-filled', { page: leo });
    await leo.click('#authEmailButton');
    clock.mark('leo signs up');

    // 3. Signed in, he stays at the door he came through — the setup gate
    // his own new workplace is behind does not catch him — and the link
    // becomes a request; access waits on the admin.
    await waitVisible(leo, '#inviteScreen');
    assert.equal(await hiddenOrAbsent(leo, '#requiredSetup'), true, 'the setup gate caught a person who came to join');
    assert.equal(await waitForText(leo, '#inviteTitle', app.fixture.organization.name), app.fixture.organization.name);
    assert.equal(normalizedText(await textOf(leo, '#inviteSub')), 'Join this workplace');
    await shoot('leo-request-to-join', { page: leo });
    await tapByText(leo, '.join-actions', 'Request to join');
    // Redeeming rewrites the address with the new request id, and that
    // remounts the screen's own read: the pending state paints, blanks back
    // to "Opening your invite link" while the second read is in flight, and
    // paints again. Wait for the screen to HOLD the state rather than for
    // the first frame that shows it.
    await leo.waitForFunction(() => {
      const sub = (document.querySelector('#inviteSub')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const status = document.querySelector('.join-status')?.textContent ?? '';
      if (sub !== 'Waiting for approval' || !status.includes('Request sent')) {
        window.joinPendingSince = 0;
        return false;
      }
      if (!window.joinPendingSince) window.joinPendingSince = Date.now();
      return Date.now() - window.joinPendingSince >= 750;
    }, { timeout: 15_000, polling: 100 });
    assert.ok(normalizedText(await textOf(leo, '.join-status')).includes('Request sent'));
    await shoot('leo-awaiting-approval', { page: leo });
    assert.deepEqual(app.world.snapshot().joinRequests, [{ requestId: `req_${member.username}`, status: 'pending' }]);
    assert.deepEqual(app.world.snapshot().members, [app.team.owner.userId]);
    // The trap this used to be (found 2026-09-18): Back from here, or the
    // Workspace's front door, put a person who came to JOIN a team into the
    // setup gate of the unnamed workplace their account came with. Now there
    // is no Back behind the gate, and every address brings him to his request.
    assert.equal(await leo.$('#pageBack'), null, 'the join screen offers Back to a person with nowhere to go back to');
    await leo.goto(`${app.origin}/`, { waitUntil: 'domcontentloaded' });
    await waitVisible(leo, '#inviteScreen');
    assert.equal(await waitForText(leo, '#inviteSub', 'Waiting for approval'), 'Waiting for approval');
    assert.equal(await hiddenOrAbsent(leo, '#requiredSetup'), true, 'the front door put a waiting joiner behind the setup gate');
    assert.ok(new URL(leo.url()).pathname.endsWith(`/invite/${invite.token}`), `the front door led to ${leo.url()}`);
    await waitVisible(leo, '#joinOwnWorkplace');
    await shoot('leo-front-door-while-waiting', { page: leo });
    clock.mark('leo requests access');

    // 4. The owner finds the request in Home's Workplace window (the
    // overview's old address opens it, note #715) and
    // approves without hunting through settings.
    await page.goto(addressOf(app, '/overview'), { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#homeJoinRequests');
    await waitForAll(page, '#homeJoinRequests', [joinerName, member.username]);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#homeJoinRequests')?.closest('#homeWorkplace'))),
      true, 'the join request is not in the Workplace window');
    await shoot('owner-join-request');
    await page.click(`#homeJoinRequests button[aria-label="Approve ${joinerName}"]`);
    const approved = `${joinerName} approved as a member.`;
    assert.equal(await waitForText(page, '#banner', approved), approved);
    await page.waitForFunction(() => !document.querySelector('#homeJoinRequests'));
    await shoot('owner-approved', { banner: true });
    assert.deepEqual(app.world.snapshot().members, [app.team.owner.userId, member.userId]);
    clock.mark('owner approves');

    // 5. Leo's page sees it, he is in, and opens the workplace: Home as a member.
    // Nothing to tap: the waiting page checks by itself, at once on return.
    await leo.bringToFront();
    assert.equal(await waitForText(leo, '#inviteSub', 'Access approved'), 'Access approved');
    await shoot('leo-has-access', { page: leo });
    await tapByText(leo, '.join-actions', 'Open workplace');
    await waitVisible(leo, '#screenHome');
    assert.equal(await hiddenOrAbsent(leo, '#requiredSetup'), true, 'the team’s workplace put its new member behind a setup gate');
    // Both people, one tap behind Leo's own picture (note #634).
    await openPeople(leo);
    await waitForAll(leo, '#people', [joinerName, 'You', owner.displayName]);
    await assertFaces(leo, '#people', 2, 'both people');
    await backHome(leo);
    // The invitation lives in the workplace menu (note #620), admins only.
    await leo.click('#homeOrganizations');
    await waitVisible(leo, '#workplaceMenu');
    assert.equal(await hiddenOrAbsent(leo, '#workplaceMenuInvite'), true, 'a member must not be offered the invite door');
    await leo.keyboard.press('Escape');
    await leo.waitForSelector('#workplaceMenu', { hidden: true });
    await shoot('leo-home-as-member', { page: leo, fullPage: true });
    // The team's agents, in the picker's one list (note #843).
    await openAgents(leo);
    await waitForAll(leo, '#agentSwitchGrid', [app.fixture.agent.name, app.team.milo.name]);
    await assertFaces(leo, '#agentSwitchGrid', 2, 'the agents he can now see');
    await shoot('leo-home-team-agents', { page: leo, fullPage: true });
    clock.mark('leo opens the workplace');

    // 6. His workplace list: the team's, active — and the unnamed one his
    // account was made with, which nothing removed.
    await leo.goto(`${app.origin}/workplaces?org=${app.fixture.organization.id}`, { waitUntil: 'domcontentloaded' });
    await waitVisible(leo, '#orgPickerList');
    await waitForAll(leo, '#orgPickerList', [app.fixture.organization.name, `${member.firstName}’s workplace`]);
    assert.equal(await leo.$$eval('#orgPickerList .orgrow', (rows) => rows.length), 2, 'the joiner does not hold two workplaces');
    await shoot('leo-two-workplaces', { page: leo });

    // The request contract, so UI/fixture drift is loud.
    assertRequestCount(app, 'POST', '/workspace/api/org/invites', 1);
    assertRequestCount(app, 'GET', `/workspace/auth/invite/${invite.token}`, 1);
    const { firstVisit, ...registered } = assertRequestCount(app, 'POST', '/workspace/auth/email/register', 1)[0].body;
    assert.deepEqual(registered, {
      mailbox: member.mailbox, password: member.password, firstName: member.firstName, lastName: member.lastName,
    });
    assert.equal(firstVisit?.from, '', 'where the joiner\'s browser first came from rides along, naming no site');
    const redeem = assertRequestCount(app, 'POST', `/workspace/api/org/invites/${invite.token}/redeem`, 1);
    assert.deepEqual(redeem.map((request) => [request.user, request.status]), [[member.username, 201]]);
    const decision = assertRequestCount(app, 'POST', `/workspace/api/org/join-requests/req_${member.username}/decision`, 1);
    assert.deepEqual(decision.map((request) => [request.user, request.body]), [[owner.username, { decision: 'approve' }]]);
    const active = assertRequestCount(app, 'POST', '/workspace/api/org/active', 1);
    assert.deepEqual(active[0].body, { orgId: app.fixture.organization.id });
    assert.ok(matchingRequests(app, 'GET', '/workspace/api/state').every((request) => request.session));
    assert.equal(matchingRequests(app, 'POST', '/workspace/api/org').length, 0, 'no workplace was founded by hand');
  },
});

console.log(`${slug}: a second person joined through a link, on approval, and saw the team's agents.`);
console.log(`  ${app.requests.length} same-origin Workspace requests answered by fixtures`);
for (const { step, ms } of clock.marks) console.log(`  ${String(ms).padStart(6)} ms  ${step}`);
