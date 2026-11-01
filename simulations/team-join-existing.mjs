#!/usr/bin/env node
/**
 * The invite flow for a person who ALREADY has an account — and a workplace
 * of their own — when the link reaches them:
 *
 *   the owner makes an invite link → Leo opens it signed out, and the door
 *   opens on Sign in → he signs in right there with his address and
 *   password → the join screen, no setup gate in the way → Request to join
 *   → waiting → the owner approves → Leo's page sees it, he is in, opens the workplace
 *   → Home as a member → his switcher: the team's workplace, active, and
 *   his own beside it → and the link opened again, signed in, lands on the
 *   join screen at once, saying he already has access.
 *
 * `team-join` is the same road for a stranger with no account; this one is
 * what a colleague who already uses the product meets.
 *
 * Home is the Chief of Staff's conversation, with the workplace switch in
 * its header; the request card stands in its Workplace window (note #715).
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
import { addressOf, assertFaces, backHome, openPeople, signIn, tapByText, waitForAll } from './support/team-steps.mjs';

const slug = 'team-join-existing';
const app = await startMockWorkspace(repoRoot, { world: 'team', stage: 'invite-known' });
const { member, invite } = app.team;
const owner = app.fixture.account;
const joinerName = `${member.firstName} ${member.lastName}`;
const OWN_WORKPLACE = 'Okafor Design';

const marks = [];
let last = Date.now();
const mark = (step) => { const now = Date.now(); marks.push({ step, ms: now - last }); last = now; };

await runBrowserScenario({
  app,
  slug,
  screenshotPath: screenshotPathFor(slug),
  async run({ page, shoot, newPersona }) {
    // 1. The owner makes the link (pictured in full by `team-join`).
    await signIn(page, app, owner);
    await waitVisible(page, '#homeAccount');
    await page.click('#homeOrganizations');
    await waitVisible(page, '#workplaceMenuInvite');
    await page.click('#workplaceMenuInvite');
    const link = `${invite.webOrigin}/invite/${invite.token}`;
    // The cold one: this journey taps straight through from sign-in, so the
    // invite page's read and mint land while the app is still warming up.
    // `team-join` pictures Home first, which hides the same wait behind a
    // screenshot. Twice the budget, for the one wait that needs it.
    await waitVisible(page, '#inviteLinkCard .orgjoin-link', { timeout: 30_000 });
    assert.equal(await page.$eval('#inviteLinkCard input[aria-label="Shareable invite link"]', (input) => input.value), link);
    assert.deepEqual(app.world.snapshot().invites, [invite.token]);
    const door = `${app.origin}/invite/${invite.token}`;
    await page.goto(addressOf(app, '/workplace'), { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#orgInvites');
    mark('owner makes the link');

    // 2. Leo, signed out, opens the link: the door names the team.
    const leo = await newPersona();
    await leo.goto(door, { waitUntil: 'domcontentloaded' });
    await waitVisible(leo, '#authGate');
    assert.equal(normalizedText(await textOf(leo, '#authTitle')), 'Join your team’s Workspace.');
    await waitForAll(leo, '#authInvite', ['Your invite link is ready']);
    await waitVisible(leo, '#authEmailPanel');
    // The door opens on sign-up; he has an account, so he takes the one link
    // under the form that says so.
    await shoot('leo-invite-door', { page: leo });
    await leo.click('#authModeLink');
    await waitForText(leo, '#authEmailPanel h2', 'Sign in');
    assert.equal(normalizedText(await textOf(leo, '#authEmailPanel h2')), 'Sign in');
    await shoot('leo-invite-door-sign-in', { page: leo });
    await leo.type('#authEmail', member.mailbox);
    await leo.type('#authPassword', member.password);
    await shoot('leo-sign-in-filled', { page: leo });
    await leo.click('#authEmailButton');
    mark('leo signs in at the door');

    // 3. Signed in, he is at the join screen — not on his own Home, and not
    // behind any gate — and the request goes out.
    await waitVisible(leo, '#inviteScreen');
    assert.equal(await hiddenOrAbsent(leo, '#requiredSetup'), true, 'a setup gate caught a person who came to join');
    assert.equal(await hiddenOrAbsent(leo, '#screenHome'), true, 'Home was drawn instead of the join screen');
    assert.equal(await waitForText(leo, '#inviteTitle', app.fixture.organization.name), app.fixture.organization.name);
    assert.equal(normalizedText(await textOf(leo, '#inviteSub')), 'Join this workplace');
    await shoot('leo-request-to-join', { page: leo });
    await tapByText(leo, '.join-actions', 'Request to join');
    await leo.waitForFunction(() => {
      const sub = (document.querySelector('#inviteSub')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const status = document.querySelector('.join-status')?.textContent ?? '';
      if (sub !== 'Waiting for approval' || !status.includes('Request sent')) { window.joinPendingSince = 0; return false; }
      if (!window.joinPendingSince) window.joinPendingSince = Date.now();
      return Date.now() - window.joinPendingSince >= 750;
    }, { timeout: 15_000, polling: 100 });
    await shoot('leo-awaiting-approval', { page: leo });
    assert.deepEqual(app.world.snapshot().joinRequests, [{ requestId: `req_${member.username}`, status: 'pending' }]);
    mark('leo requests access');

    // 4. The owner approves from the request card in Home's Workplace window,
    // which the overview's old address opens (note #715).
    await page.goto(addressOf(app, '/overview'), { waitUntil: 'domcontentloaded' });
    await waitVisible(page, '#homeJoinRequests');
    await waitForAll(page, '#homeJoinRequests', [joinerName, member.username]);
    await shoot('owner-join-request');
    await page.click(`#homeJoinRequests button[aria-label="Approve ${joinerName}"]`);
    const approved = `${joinerName} approved as a member.`;
    assert.equal(await waitForText(page, '#banner', approved), approved);
    await page.waitForFunction(() => !document.querySelector('#homeJoinRequests'));
    assert.deepEqual(app.world.snapshot().members, [app.team.owner.userId, member.userId]);
    mark('owner approves');

    // 5. Leo's page sees it, he is in, opens the workplace: Home as a member.
    // Nothing to tap: the waiting page checks by itself, at once on return.
    await leo.bringToFront();
    assert.equal(await waitForText(leo, '#inviteSub', 'Access approved'), 'Access approved');
    await shoot('leo-has-access', { page: leo });
    await tapByText(leo, '.join-actions', 'Open workplace');
    await waitVisible(leo, '#screenHome');
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
    mark('leo opens the workplace');

    // 6. His switcher: the team's workplace now active, his own beside it.
    await leo.goto(`${app.origin}/workplaces?org=${app.fixture.organization.id}`, { waitUntil: 'domcontentloaded' });
    await waitVisible(leo, '#orgPickerList');
    await waitForAll(leo, '#orgPickerList', [app.fixture.organization.name, OWN_WORKPLACE]);
    assert.equal(await leo.$$eval('#orgPickerList .orgrow', (rows) => rows.length), 2);
    assert.ok((await leo.$eval('#orgPickerList .orgrow.current', (row) => row.textContent)).includes(app.fixture.organization.name), 'the team’s workplace is not the active one');
    await shoot('leo-two-workplaces', { page: leo });

    // 7. The link again, signed in: straight to the join screen, which says
    // he already has access — no sign-in, no second request.
    await leo.goto(door, { waitUntil: 'domcontentloaded' });
    await waitVisible(leo, '#inviteScreen');
    assert.equal(await hiddenOrAbsent(leo, '#authGate'), true, 'a signed-in person was asked to sign in again');
    assert.equal(await waitForText(leo, '#inviteSub', 'Access approved'), 'Access approved');
    await shoot('leo-link-again-signed-in', { page: leo });

    // The request contract, so UI/fixture drift is loud.
    assertRequestCount(app, 'POST', '/workspace/api/org/invites', 1);
    assert.deepEqual(assertRequestCount(app, 'POST', '/workspace/auth/email/login', 1)[0].body, { email: member.mailbox, password: member.password });
    assert.equal(matchingRequests(app, 'POST', '/workspace/auth/email/register').length, 0, 'an existing person was made a second account');
    const redeem = assertRequestCount(app, 'POST', `/workspace/api/org/invites/${invite.token}/redeem`, 1);
    assert.deepEqual(redeem.map((request) => [request.user, request.status]), [[member.username, 201]]);
    assertRequestCount(app, 'POST', `/workspace/api/org/join-requests/req_${member.username}/decision`, 1);
    assert.deepEqual(assertRequestCount(app, 'POST', '/workspace/api/org/active', 1)[0].body, { orgId: app.fixture.organization.id });
  },
});

console.log(`${slug}: a person with an account already joined through a link, on approval, and kept their own workplace beside the team's.`);
console.log(`  ${app.requests.length} same-origin Workspace requests answered by fixtures`);
for (const { step, ms } of marks) console.log(`  ${String(ms).padStart(6)} ms  ${step}`);
