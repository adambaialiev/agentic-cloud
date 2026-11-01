#!/usr/bin/env node
import assert from 'node:assert/strict';
import { startMockWorkspace } from './support/mock-workspace.mjs';
import {
  assertFixtureWorkspaceHome,
  assertRequestCount,
  clearAndType,
  matchingRequests,
  readWorkspaceHome,
  repoRoot,
  runBrowserScenario,
  screenshotPathFor,
  waitForText,
  waitVisible,
} from './support/browser-simulation.mjs';
import { openAuthenticatorLogin } from './support/team-steps.mjs';

const invalidRecoveryCode = 'NOT-A-RECOVERY-CODE';
// There is no banner after a recovery sign-in any more: PR #854 (note #467,
// "Make email the primary Workspace sign-in") took that notice out. What still
// has to be true is what this scenario is actually about — the code is spent,
// and a spent one cannot mint a second session — and `consumedRecoveryCodes`
// is where that is asserted, on the server's own count.

const screenshotPath = screenshotPathFor('recovery-access');
const app = await startMockWorkspace(repoRoot, {
  existingIdentity: true,
  workspaceStage: 'room-created',
});

const firstCodeAsTyped = app.fixture.recoveryCodes[0].toLowerCase().replaceAll('-', ' ');
const secondCodeAsTyped = app.fixture.recoveryCodes[1];

await runBrowserScenario({
  app,
  screenshotPath,
  slug: 'recovery-access',
  async run({ page, shoot }) {
    await openAuthenticatorLogin(page, app);

    // The recovery door carries the username across from sign-in, rejects a
    // bad code inline, then accepts a human-formatted version of a real code.
    await page.type('#authUsername', app.fixture.account.username);
    await page.click('#authRecoveryLink');
    await waitVisible(page, '#authRecoveryPanel');
    assert.equal(
      await page.$eval('#authRecoveryUsername', (input) => input.value),
      app.fixture.account.username,
    );
    await shoot('recovery-code-door');
    await page.type('#authRecoveryCode', invalidRecoveryCode);
    await page.click('#authRecoveryButton');
    assert.equal(
      await waitForText(page, '#authRecoveryError', 'Invalid username or recovery code.'),
      'Invalid username or recovery code.',
    );
    await page.waitForFunction(() => !document.querySelector('#authRecoveryButton')?.disabled);
    assert.deepEqual(app.consumedRecoveryCodes(), []);

    await clearAndType(page, '#authRecoveryCode', firstCodeAsTyped);
    await page.click('#authRecoveryButton');
    assertFixtureWorkspaceHome(await readWorkspaceHome(page));
    assert.equal(app.consumedRecoveryCodes().length, 1);
    await shoot('recovered-home', { fullPage: true });

    // Remove only browser session state, then prove that the spent code cannot
    // mint another session. A different unused code must still recover access.
    const context = page.browserContext();
    const cookies = await context.cookies();
    await context.deleteCookie(...cookies);
    await openAuthenticatorLogin(page, app);
    await page.type('#authUsername', app.fixture.account.username);
    await page.click('#authRecoveryLink');
    await waitVisible(page, '#authRecoveryPanel');
    await page.type('#authRecoveryCode', firstCodeAsTyped);
    await page.click('#authRecoveryButton');
    assert.equal(
      await waitForText(page, '#authRecoveryError', 'Invalid username or recovery code.'),
      'Invalid username or recovery code.',
    );
    await page.waitForFunction(() => !document.querySelector('#authRecoveryButton')?.disabled);
    assert.equal(app.consumedRecoveryCodes().length, 1);

    await clearAndType(page, '#authRecoveryCode', secondCodeAsTyped);
    await page.click('#authRecoveryButton');
    assertFixtureWorkspaceHome(await readWorkspaceHome(page));
    assert.equal(app.consumedRecoveryCodes().length, 2);

    const recoveries = assertRequestCount(app, 'POST', '/workspace/auth/recovery', 4);
    assert.deepEqual(recoveries.map((request) => request.status), [400, 200, 400, 200]);
    assert.deepEqual(recoveries.map((request) => request.body), [
      { username: app.fixture.account.username, recoveryCode: invalidRecoveryCode },
      { username: app.fixture.account.username, recoveryCode: firstCodeAsTyped },
      { username: app.fixture.account.username, recoveryCode: firstCodeAsTyped },
      { username: app.fixture.account.username, recoveryCode: secondCodeAsTyped },
    ]);
    // Each visit opens signed out (401); each recovery is followed by the
    // shell asking the server for the session it now has (200).
    assert.deepEqual(
      assertRequestCount(app, 'GET', '/workspace/auth/session', 4).map((request) => request.status),
      [401, 200, 401, 200],
    );
    // One per sign-in: the read as Home (the Chief of Staff's conversation)
    // opens. The agents picker is a window over Home (note #715), not a
    // screen of its own, so opening it reads no state again.
    assert.equal(matchingRequests(app, 'GET', '/workspace/api/state').length, 2);
    assert.ok(matchingRequests(app, 'GET', '/workspace/api/state').every((request) => request.session));
    assertRequestCount(app, 'POST', '/workspace/auth/login', 0);
    assertRequestCount(app, 'POST', '/workspace/api/org', 0);
    assertRequestCount(app, 'POST', '/workspace/api/rooms', 0);
  },
});

console.log('Recovery access simulation passed:');
console.log('  invalid recovery code → formatted valid code → cleared session → refused replay → second valid code');
console.log('  spent recovery material stayed spent while the existing workplace and room remained intact');
console.log(`  screenshot: ${screenshotPath}`);
