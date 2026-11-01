#!/usr/bin/env node
import assert from 'node:assert/strict';
import { startMockWorkspace } from './support/mock-workspace.mjs';
import {
  assertFixtureWorkspaceHome,
  assertRequestCount,
  clearAndType,
  matchingRequests,
  normalizedText,
  readWorkspaceHome,
  repoRoot,
  runBrowserScenario,
  screenshotPathFor,
  textOf,
  waitForText,
  waitVisible,
  hiddenOrAbsent,
} from './support/browser-simulation.mjs';
import { openAuthenticatorLogin } from './support/team-steps.mjs';

const invalidCode = '000000';
const screenshotPath = screenshotPathFor('returning-signin');
const app = await startMockWorkspace(repoRoot, {
  existingIdentity: true,
  workspaceStage: 'room-created',
});

await runBrowserScenario({
  app,
  screenshotPath,
  slug: 'returning-signin',
  async run({ page, shoot }) {
    await openAuthenticatorLogin(page, app);
    // The panel's own name since email became the primary door (PR #854):
    // this is the authenticator login a returning owner asks for by name.
    assert.equal(normalizedText(await textOf(page, '#authLoginPanel h2')), 'Existing authenticator login');
    await shoot('sign-in');

    // A returning owner gets a specific inline refusal and can correct only
    // the rotating code; their username and the rest of the page stay put.
    await page.type('#authUsername', app.fixture.account.username);
    await page.type('#authCode', invalidCode);
    await page.click('#authLoginButton');
    assert.equal(
      await waitForText(page, '#authLoginError', 'Invalid username or one-time code.'),
      'Invalid username or one-time code.',
    );
    await shoot('sign-in-refused');
    await page.waitForFunction(() => !document.querySelector('#authLoginButton')?.disabled);
    assert.equal(await page.$eval('#authUsername', (input) => input.value), app.fixture.account.username);
    assert.equal(await page.$eval('#authLoginPanel', (panel) => panel.hidden), false);

    await clearAndType(page, '#authCode', app.fixture.account.totpCode);
    await page.click('#authLoginButton');
    assertFixtureWorkspaceHome(await readWorkspaceHome(page));

    // The session issued by the successful retry must be enough for a cold
    // document boot; the sign-in form should not flash back into the journey.
    await page.reload({ waitUntil: 'domcontentloaded' });
    assertFixtureWorkspaceHome(await readWorkspaceHome(page));
    assert.equal(await hiddenOrAbsent(page, '#authGate'), true);

    const logins = assertRequestCount(app, 'POST', '/workspace/auth/login', 2);
    assert.deepEqual(logins.map((request) => request.status), [400, 200]);
    assert.deepEqual(logins.map((request) => request.body), [
      { username: app.fixture.account.username, code: invalidCode },
      { username: app.fixture.account.username, code: app.fixture.account.totpCode },
    ]);
    // The signed-out 401 first; every later read (the shell asking the server
    // once the form finishes, and on any reload) is a 200.
    const sessionReads = matchingRequests(app, 'GET', '/workspace/auth/session');
    assert.ok(sessionReads.length >= 2, 'the shell did not read the session before and after signing in');
    assert.deepEqual(sessionReads.map((request) => request.status), [401, ...sessionReads.slice(1).map(() => 200)]);
    assert.ok(matchingRequests(app, 'GET', '/workspace/api/state').every((request) => request.session));
    assertRequestCount(app, 'POST', '/workspace/auth/recovery', 0);
    assertRequestCount(app, 'POST', '/workspace/api/org', 0);
    assertRequestCount(app, 'POST', '/workspace/api/rooms', 0);
    assert.equal(app.identityExists(), true);
    assert.equal(app.workspaceStage(), 'room-created');
  },
});

console.log('Returning sign-in simulation passed:');
console.log('  existing account → bad rotating code → inline retry → Workspace → authenticated reload');
console.log('  no workplace or room creation endpoint was touched');
console.log(`  screenshot: ${screenshotPath}`);
