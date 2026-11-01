#!/usr/bin/env node
/**
 * Pictures of the Claude sign-in from the Chief of Staff's card (the
 * paste-the-code ceremony the onboarding journey does not walk, since it
 * signs in ChatGPT). Not a check — the underscore keeps it out of the
 * runner — just the three moments, for looking at: the card under the ask,
 * the code screen, the code pasted.
 *
 *   node simulations/_claude-signin-shot.mjs --shots /tmp/claude-shots
 */
import { startMockWorkspace } from './support/mock-workspace.mjs';
import { repoRoot, runBrowserScenario, screenshotPathFor, waitVisible } from './support/browser-simulation.mjs';
const app = await startMockWorkspace(repoRoot);
const { fixture } = app;
await runBrowserScenario({ app, screenshotPath: screenshotPathFor('claude-signin'), slug: 'claude-signin', async run({ page, shoot }) {
  await page.goto(`${app.origin}/signup`, { waitUntil: 'domcontentloaded' });
  await waitVisible(page, '#authEmailPanel');
  await page.type('#authFirstName', fixture.account.firstName);
  await page.type('#authLastName', fixture.account.lastName);
  await page.type('#authMailbox', fixture.account.mailbox);
  await page.type('#authPassword', fixture.account.password);
  await page.type('#authPasswordConfirm', fixture.account.password);
  await page.waitForFunction(() => !document.querySelector('#authEmailButton')?.disabled, { timeout: 10_000 });
  await page.click('#authEmailButton');
  // Home at once (note #726): a starter tapped, and the sign-in card under the ask.
  await waitVisible(page, '#firstRunStarters .chatstarter');
  await page.evaluate((text) => [...document.querySelectorAll('#firstRunStarters .chatstarter')].find((node) => node.textContent?.trim() === text)?.click(), fixture.firstRun.starter);
  await waitVisible(page, '#firstRunSignIn');
  await shoot('sign-in-pick', { fullPage: true });
  await page.click('#firstRunSignIn .crow[data-provider="claude"]');
  await waitVisible(page, '#screenSeatSignIn');
  await page.waitForFunction(() => Boolean(document.querySelector('#seatSignInCopyLink')), { timeout: 10_000 });
  await shoot('sign-in-claude-code');
  await page.type('#screenSeatSignIn input[aria-label="Paste the sign-in code"]', 'abcdefghij#klmnopqrst');
  await shoot('sign-in-claude-pasted');
} });
